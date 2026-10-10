import { Modal, Notice, Setting, TFile } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { activeBaseView } from "./base-detect";
import { parseReplacement } from "./find-replace";
import { LIST_TYPES, findKey, getPropertyType, isUnsafeKey, parseValueForProperty, valueToDisplay } from "./scan";
import { ChangeRecord, HistoryEntry } from "./types";
import { noticeWithUndo } from "./history";
import { hasPropertyRefs, resolvePropertyRefs } from "./property-refs";
import { attachPropertySuggest, attachValueSuggest } from "./suggest";

const NEW_PROPERTY = "__bt_new_property__";

type BulkMode = "set" | "set-missing" | "append" | "remove" | "delete";

/**
 * Reads the current result set of the active Bases view via its controller —
 * undocumented internals, probed defensively so a core change degrades to a
 * clear notice instead of wrong behavior.
 */
export function activeBaseResults(
  plugin: BasesToolboxPlugin
): { files: TFile[]; name: string } | null {
  // Prefer the FOCUSED base, but fall back to the open base view — so the
  // command still works when it's triggered from the launcher / sidebar / a
  // command-palette selection (which can leave a non-base view focused) or when
  // the base is sitting in another tab. The modal shows the base name + file
  // count, so the user always sees which base it will operate on.
  const view = activeBaseView(plugin.app);
  if (!view) return null;
  const results = view.controller?.results;
  if (!(results instanceof Map)) return null;
  const files = [...results.keys()].filter(
    (f): f is TFile => f instanceof TFile && f.extension === "md"
  );
  return { files, name: view.file.basename };
}

export function openBulkEdit(plugin: BasesToolboxPlugin): void {
  const target = activeBaseResults(plugin);
  if (!target) {
    new Notice(
      "Open a base first — bulk edit works on the active base view's results. (If a base IS open, Obsidian's internals may have changed; tell the plugin author.)"
    );
    return;
  }
  if (!target.files.length) {
    new Notice("The base has no markdown results to edit.");
    return;
  }
  new BulkEditModal(plugin, target.files, target.name).open();
}

export class BulkEditModal extends Modal {
  private plugin: BasesToolboxPlugin;
  private files: TFile[];
  private baseName: string;
  private property = "";
  private mode: BulkMode = "set";
  private valueDescEl: HTMLElement | null = null;
  private running = false;
  private newNameSetting: Setting | null = null;
  private nameInputEl: HTMLInputElement | null = null;
  private valueEl: HTMLTextAreaElement | null = null;
  private refPreviewEl: HTMLElement | null = null;

  constructor(plugin: BasesToolboxPlugin, files: TFile[], baseName: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.files = files;
    this.baseName = baseName;
  }

  private existingProperties(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const file of this.files) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
      for (const key of Object.keys(fm)) {
        if (key === "position") continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  }

  onOpen(): void {
    const n = this.files.length;
    this.titleEl.setText(`Bulk edit: ${this.baseName} (${n} file${n === 1 ? "" : "s"})`);
    const { contentEl } = this;

    const props = [...this.existingProperties().entries()].sort((a, b) => a[0].localeCompare(b[0]));
    this.property = props[0]?.[0] ?? NEW_PROPERTY;

    new Setting(contentEl)
      .setName("Property")
      .setDesc("Set this property on every file in the base's current results.")
      .addDropdown((dd) => {
        for (const [name, count] of props) dd.addOption(name, `${name} (${count}/${n})`);
        dd.addOption(NEW_PROPERTY, "New property…");
        dd.setValue(this.property);
        dd.onChange((v) => {
          this.property = v;
          this.setNewNameVisible(v === NEW_PROPERTY);
          this.updateRefPreview();
        });
      });

    this.newNameSetting = new Setting(contentEl).setName("New property name").addText((t) => {
      t.setPlaceholder("property-name");
      this.nameInputEl = t.inputEl;
      // A property that exists elsewhere in the vault (just not in this base).
      attachPropertySuggest(this.plugin, t.inputEl);
    });
    this.setNewNameVisible(this.property === NEW_PROPERTY);

    new Setting(contentEl)
      .setName("Mode")
      .setDesc("Append and Remove treat the property as a list.")
      .addDropdown((dd) => {
        dd.addOption("set", "Set (replace the value)");
        dd.addOption("set-missing", "Set only if missing");
        dd.addOption("append", "Append items");
        dd.addOption("remove", "Remove items");
        dd.addOption("delete", "Delete the property");
        dd.setValue(this.mode);
        dd.onChange((v) => {
          this.mode = v as BulkMode;
          this.updateValueDesc();
          this.updateRefPreview();
        });
      });

    const valueSetting = new Setting(contentEl).setName("Value").addTextArea((t) => {
      t.setPlaceholder("New value");
      this.valueEl = t.inputEl;
      // Existing values of the chosen property; one item per line, so only the
      // line under the caret is completed.
      attachValueSuggest(
        this.plugin,
        t.inputEl,
        () => (this.property === NEW_PROPERTY ? (this.nameInputEl?.value.trim() ?? "") : this.property),
        { list: "\n", limit: 100 }
      );
    });
    this.valueDescEl = valueSetting.descEl;
    this.updateValueDesc();

    contentEl.createDiv({
      cls: "bases-toolbox-bulk-refhint",
      text: "Tip: {{other property}} copies each note's own value, e.g. {{startTime}}. Add a date format to reformat it: {{startTime:HH:mm}}. Notes where that property is empty are skipped.",
    });
    this.refPreviewEl = contentEl.createDiv({ cls: "bases-toolbox-bulk-refpreview" });
    this.valueEl?.addEventListener("input", () => this.updateRefPreview());
    this.updateRefPreview();

    contentEl.createDiv({
      cls: "bases-toolbox-fr-warning",
      text: "Logged in Frontmatter (properties & values) History — the operation can be reverted from there.",
    });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(`Apply to ${n} file${n === 1 ? "" : "s"}`)
        .setCta()
        .onClick(() => void this.apply())
    );
  }

  /** When the value holds {{references}}, show what the first note would get
   * and how many notes will be skipped for lack of the source property. */
  private updateRefPreview(): void {
    const el = this.refPreviewEl;
    if (!el) return;
    el.empty();
    const raw = this.valueEl?.value ?? "";
    if (this.mode === "delete" || !hasPropertyRefs(raw)) return;
    let example: { name: string; value: string } | null = null;
    const skipped = new Map<string, number>();
    const target = this.property === NEW_PROPERTY ? (this.nameInputEl?.value.trim() ?? "") : this.property;
    for (const file of this.files) {
      const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
      // Mirrors apply(): "set only if missing" never touches a note that
      // already has the property, so it's neither an example nor a skip.
      if (this.mode === "set-missing" && target && findKey(fm, target) !== null) continue;
      const r = resolvePropertyRefs(raw, fm);
      if (!r.ok) skipped.set(r.missing, (skipped.get(r.missing) ?? 0) + 1);
      else example ??= { name: file.basename, value: valueToDisplay(r.value) };
    }
    if (example) el.createDiv({ text: `Example — ${example.name}: ${example.value}` });
    for (const [name, n] of skipped) {
      el.createDiv({
        cls: "bases-toolbox-bulk-refskip",
        text: `${n} of ${this.files.length} file${this.files.length === 1 ? "" : "s"} will be skipped (no ${name}).`,
      });
    }
  }

  private setNewNameVisible(show: boolean): void {
    this.newNameSetting?.settingEl.setCssStyles({ display: show ? "" : "none" });
  }

  private updateValueDesc(): void {
    this.valueDescEl?.setText(
      this.mode === "set"
        ? "Applied to all files. Empty clears the property. For list properties: one item per line."
        : this.mode === "set-missing"
          ? "Applied only to files where the property is missing. One value for all."
          : this.mode === "delete"
            ? "The property is removed entirely from every file (value box is ignored). Revertible."
            : this.mode === "append"
          ? "One item per line. Added to each file's existing list (duplicates skipped); a scalar value becomes the first list item."
          : "One item per line. Matching items are removed from each file's list; a matching scalar value is cleared."
    );
  }

  private async apply(): Promise<void> {
    if (this.running) return;
    const property =
      this.property === NEW_PROPERTY ? (this.nameInputEl?.value.trim() ?? "") : this.property;
    if (!property) {
      new Notice("Give the new property a name first.");
      return;
    }
    if (isUnsafeKey(property)) {
      new Notice(`"${property}" is a reserved name and can't be used as a property.`);
      return;
    }
    const rawValue = this.valueEl?.value ?? "";
    const items = rawValue
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => parseReplacement(line, getPropertyType(this.app, property)));
    if ((this.mode === "append" || this.mode === "remove") && !items.length) {
      new Notice(`Nothing to ${this.mode} — enter one item per line.`);
      return;
    }
    // {{property}} references are filled in per note, from that note's own
    // frontmatter; delete mode ignores the value box entirely.
    const usesRefs = this.mode !== "delete" && hasPropertyRefs(rawValue);
    const skippedFor = new Map<string, number>();
    this.running = true;
    try {
      const setValue = parseValueForProperty(this.app, property, rawValue);
      const changes: ChangeRecord[] = [];
      for (const file of this.files) {
        let record: ChangeRecord | null = null;
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          const key = findKey(fm, property);
          const existed = key !== null;
          const cur = existed ? fm[key as string] : undefined;
          let fileSet = setValue;
          let fileItems = items;
          if (usesRefs) {
            // Nothing to fill on a note that keeps its value anyway.
            if (this.mode === "set-missing" && existed) return;
            const r = this.resolveRefs(fm, property, rawValue);
            if ("missing" in r) {
              skippedFor.set(r.missing, (skippedFor.get(r.missing) ?? 0) + 1);
              return;
            }
            fileSet = r.setValue;
            fileItems = r.items;
            if ((this.mode === "append" || this.mode === "remove") && !fileItems.length) return;
          }
          const value = this.nextValue(cur, existed, fileSet, fileItems);
          if (value === SKIP) return;
          if (this.mode === "delete") {
            record = { path: file.path, property, oldValue: Array.isArray(cur) ? cur.slice() : cur, deleted: true };
            delete fm[key as string];
            return;
          }
          if (existed && JSON.stringify(cur) === JSON.stringify(value)) return; // no-op
          record = {
            path: file.path,
            property,
            oldValue: existed ? (Array.isArray(cur) ? cur.slice() : cur) : undefined,
            newValue: Array.isArray(value) ? value.slice() : value,
            ...(existed ? {} : { created: true }),
          };
          fm[key ?? property] = value;
        });
        if (record) changes.push(record);
      }
      const skips = [...skippedFor].map(([name, n]) => `${n} with no ${name}`);
      const message =
        `${property}: ${this.mode} applied in ${changes.length} of ${this.files.length} files.` +
        (skips.length ? ` Skipped ${skips.join(", ")}.` : "");
      if (changes.length) {
        const entry: HistoryEntry = {
          property,
          find: null,
          replace: rawValue,
          timestamp: Date.now(),
          changes,
          source: `bulk edit: ${this.baseName}`,
        };
        await this.plugin.addHistoryEntry(entry);
        noticeWithUndo(this.plugin, message, entry);
      } else {
        new Notice(message);
      }
      this.close();
    } finally {
      this.running = false;
    }
  }

  /**
   * The value (set modes) and items (append/remove) for ONE note, with its
   * {{property}} references filled in from that note's frontmatter. A value
   * that is exactly one reference keeps the source's type (a list stays a
   * list); text becomes a value of the target property's type, as typed text
   * would. Returns `missing` when a referenced property is absent or empty.
   */
  private resolveRefs(
    fm: Record<string, unknown>,
    property: string,
    rawValue: string
  ): { setValue: unknown; items: unknown[] } | { missing: string } {
    const type = getPropertyType(this.app, property);
    // Fit the resolved value to the TARGET's type, as typed text would be: a
    // scalar into a list property becomes a one-item list, a list into a typed
    // scalar property becomes its items as text, a number into a text property
    // becomes "5". Only an untyped (e.g. brand-new) target keeps the raw value.
    const isList = LIST_TYPES.has(type ?? "");
    const typed = !!type && type !== "unknown";
    const coerce = (v: unknown): unknown => {
      if (typeof v === "string") return parseValueForProperty(this.app, property, v);
      if (isList) return Array.isArray(v) ? v : [String(v)];
      if (typed) {
        const text = Array.isArray(v) ? v.map((x) => String(x)).join(", ") : String(v);
        return parseValueForProperty(this.app, property, text);
      }
      return v;
    };
    if (this.mode === "set" || this.mode === "set-missing") {
      const r = resolvePropertyRefs(rawValue, fm);
      if (!r.ok) return { missing: r.missing };
      return { setValue: coerce(r.value), items: [] };
    }
    // append / remove: one item per line, each line resolved on its own; a
    // line that is a single reference to a list contributes all its items.
    const items: unknown[] = [];
    for (const line of rawValue.split("\n").map((s) => s.trim()).filter(Boolean)) {
      const r = resolvePropertyRefs(line, fm);
      if (!r.ok) return { missing: r.missing };
      if (Array.isArray(r.value)) items.push(...r.value);
      else if (typeof r.value === "string") items.push(parseReplacement(r.value, type));
      else items.push(r.value);
    }
    return { setValue: null, items };
  }

  /** Computes the new value for one file, or SKIP when nothing changes. */
  private nextValue(
    cur: unknown,
    existed: boolean,
    setValue: unknown,
    items: unknown[]
  ): unknown {
    if (this.mode === "set") {
      // "empty clears" must not CREATE a null property on files that lack it
      if (!existed && setValue === null) return SKIP;
      return setValue;
    }
    if (this.mode === "set-missing") return existed ? SKIP : setValue;
    if (this.mode === "delete") return existed ? null : SKIP; // value unused; SKIP when absent
    if (this.mode === "append") {
      const base = Array.isArray(cur) ? cur.slice() : !existed || cur === null ? [] : [cur];
      let added = false;
      for (const item of items) {
        if (!base.some((x) => valueToDisplay(x) === valueToDisplay(item))) {
          base.push(item);
          added = true;
        }
      }
      return added ? base : SKIP;
    }
    // remove
    if (!existed || cur === null) return SKIP;
    if (Array.isArray(cur)) {
      const filtered = cur.filter(
        (x) => !items.some((i) => valueToDisplay(i) === valueToDisplay(x))
      );
      if (filtered.length === cur.length) return SKIP;
      return filtered.length ? filtered : null;
    }
    return items.some((i) => valueToDisplay(i) === valueToDisplay(cur)) ? null : SKIP;
  }
}

const SKIP = Symbol("skip");
