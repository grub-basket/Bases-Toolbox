import { Modal, Notice, Setting, TFile } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { parseReplacement } from "./find-replace";
import { findKey, getPropertyType, parseValueForProperty, valueToDisplay } from "./scan";
import { ChangeRecord } from "./types";

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
  const view = plugin.app.workspace.activeLeaf?.view as unknown as {
    getViewType?: () => string;
    file?: TFile;
    controller?: { results?: unknown };
  };
  if (view?.getViewType?.() !== "bases") return null;
  const results = view.controller?.results;
  if (!(results instanceof Map)) return null;
  const files = [...results.keys()].filter(
    (f): f is TFile => f instanceof TFile && f.extension === "md"
  );
  return { files, name: view.file?.basename ?? "base" };
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
        });
      });

    this.newNameSetting = new Setting(contentEl).setName("New property name").addText((t) => {
      t.setPlaceholder("property-name");
      this.nameInputEl = t.inputEl;
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
        });
      });

    const valueSetting = new Setting(contentEl).setName("Value").addTextArea((t) => {
      t.setPlaceholder("New value");
      this.valueEl = t.inputEl;
    });
    this.valueDescEl = valueSetting.descEl;
    this.updateValueDesc();

    contentEl.createDiv({
      cls: "bases-toolbox-fr-warning",
      text: "Logged in Find & replace history — the operation can be reverted from there.",
    });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(`Apply to ${n} file${n === 1 ? "" : "s"}`)
        .setCta()
        .onClick(() => void this.apply())
    );
  }

  private setNewNameVisible(show: boolean): void {
    if (this.newNameSetting) this.newNameSetting.settingEl.style.display = show ? "" : "none";
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
          const value = this.nextValue(cur, existed, setValue, items);
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
      if (changes.length) {
        await this.plugin.addHistoryEntry({
          property,
          find: null,
          replace: rawValue,
          timestamp: Date.now(),
          changes,
          source: `bulk edit: ${this.baseName}`,
        });
      }
      new Notice(
        `${property}: ${this.mode} applied in ${changes.length} of ${this.files.length} files.`
      );
      this.close();
    } finally {
      this.running = false;
    }
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
