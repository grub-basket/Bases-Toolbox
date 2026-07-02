import { FuzzySuggestModal, Modal, Notice, Setting } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { EMPTY_DISPLAY, PropertyUsage, findKey, valueToDisplay } from "./scan";
import { ChangeRecord } from "./types";

/** Sentinel for the "match every value" dropdown option. */
const ALL_VALUES = "__bt_all_values__";

export class PropertySuggestModal extends FuzzySuggestModal<PropertyUsage> {
  private plugin: BasesToolboxPlugin;
  private items: PropertyUsage[];

  constructor(plugin: BasesToolboxPlugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.items = plugin.propertyCache.get();
    this.setPlaceholder("Pick a property to find & replace…");
  }

  getItems(): PropertyUsage[] {
    return this.items;
  }

  getItemText(item: PropertyUsage): string {
    return `${item.name} (${item.count} file${item.count === 1 ? "" : "s"})`;
  }

  onChooseItem(item: PropertyUsage): void {
    new FindReplaceModal(this.plugin, item).open();
  }
}

export class FindReplaceModal extends Modal {
  private plugin: BasesToolboxPlugin;
  private usage: PropertyUsage;
  private find: string;
  private replace = "";
  private infoEl: HTMLElement | null = null;
  private replaceInfoEl: HTMLElement | null = null;
  private running = false;

  constructor(plugin: BasesToolboxPlugin, usage: PropertyUsage, presetFind?: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.usage = usage;
    this.find = presetFind ?? ALL_VALUES;
  }

  onOpen(): void {
    this.titleEl.setText(`Find & replace: ${this.usage.name}`);
    const { contentEl } = this;

    new Setting(contentEl)
      .setName("Find")
      .setDesc("Which current values to replace.")
      .addDropdown((dd) => {
        dd.addOption(ALL_VALUES, `All values (${this.usage.count} files)`);
        const sorted = [...this.usage.values.entries()].sort((a, b) => b[1] - a[1]);
        for (const [display, count] of sorted) {
          dd.addOption(display, `${display} (${count})`);
        }
        dd.setValue(this.find);
        dd.onChange((v) => {
          this.find = v;
          this.updateInfo();
        });
      });

    new Setting(contentEl)
      .setName("Replace with")
      .setDesc('New value for every match. Leave empty to clear the value.')
      .addText((t) => {
        t.setPlaceholder("New value");
        t.onChange((v) => {
          this.replace = v;
          this.updateReplaceInfo();
        });
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void this.apply();
        });
      });

    this.replaceInfoEl = contentEl.createDiv({ cls: "bases-toolbox-fr-info" });
    this.infoEl = contentEl.createDiv({ cls: "bases-toolbox-fr-info" });
    this.updateInfo();
    this.updateReplaceInfo();

    contentEl.createDiv({
      cls: "bases-toolbox-fr-warning",
      text: "This edits frontmatter across your vault. The previous values are logged in “Find & replace history”, where each operation can be reverted.",
    });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Replace")
        .setCta()
        .onClick(() => void this.apply())
    );
  }

  private matchCount(): number {
    if (this.find === ALL_VALUES) return this.usage.count;
    return this.usage.values.get(this.find) ?? 0;
  }

  private updateInfo(): void {
    if (!this.infoEl) return;
    const n = this.matchCount();
    this.infoEl.setText(
      this.find !== ALL_VALUES && n === 0
        ? `“${this.find}” no longer exists as a value of ${this.usage.name} — nothing will change.`
        : `${n} file${n === 1 ? "" : "s"} will be checked for changes.`
    );
  }

  /** Tells the user whether the replacement value already exists for this property. */
  private updateReplaceInfo(): void {
    if (!this.replaceInfoEl) return;
    if (this.replace.trim() === "") {
      this.replaceInfoEl.setText("Empty replacement clears the value.");
      return;
    }
    const display = valueToDisplay(parseReplacement(this.replace, this.usage.type));
    const count = this.usage.values.get(display) ?? 0;
    this.replaceInfoEl.setText(
      count
        ? `“${display}” is an existing value of ${this.usage.name} (${count} file${count === 1 ? "" : "s"}) — matches will merge into it.`
        : `“${display}” is a new value for ${this.usage.name}.`
    );
  }

  private async apply(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const find = this.find === ALL_VALUES ? null : this.find;
      const replacement = parseReplacement(this.replace, this.usage.type);
      const changes: ChangeRecord[] = [];

      for (const file of this.usage.files) {
        let oldValue: unknown;
        let newValue: unknown;
        let changed = false;
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          const key = findKey(fm, this.usage.name);
          if (key === null) return;
          const cur = fm[key];
          const next = replaceIn(cur, find, replacement);
          if (!next.changed) return;
          oldValue = Array.isArray(cur) ? cur.slice() : cur;
          newValue = Array.isArray(next.value) ? next.value.slice() : next.value;
          fm[key] = next.value;
          changed = true;
        });
        if (changed)
          changes.push({ path: file.path, property: this.usage.name, oldValue, newValue });
      }

      if (changes.length) {
        await this.plugin.addHistoryEntry({
          property: this.usage.name,
          find,
          replace: this.replace,
          timestamp: Date.now(),
          changes,
        });
      }
      new Notice(
        `${this.usage.name}: updated ${changes.length} of ${this.usage.files.length} file${
          this.usage.files.length === 1 ? "" : "s"
        }.`
      );
      this.close();
    } finally {
      this.running = false;
    }
  }
}

/** Applies the replacement to one frontmatter value; handles list properties. */
function replaceIn(
  cur: unknown,
  find: string | null,
  replacement: unknown
): { changed: boolean; value: unknown } {
  if (Array.isArray(cur)) {
    if (find === null) {
      // Global override collapses the list to the single new value.
      const value = replacement === null ? null : [replacement];
      return { changed: JSON.stringify(cur) !== JSON.stringify(value), value };
    }
    let changed = false;
    const mapped = cur.map((item) => {
      if (valueToDisplay(item) !== find) return item;
      changed = true;
      return replacement;
    });
    // Replacing may create duplicates (e.g. two tags merged into one); dedupe.
    const value = mapped.filter(
      (item, i) => item !== null && mapped.findIndex((o) => valueToDisplay(o) === valueToDisplay(item)) === i
    );
    return { changed, value };
  }
  if (find !== null && valueToDisplay(cur) !== find) return { changed: false, value: cur };
  const same =
    valueToDisplay(cur) === valueToDisplay(replacement) && typeof cur === typeof replacement;
  return { changed: !same, value: replacement };
}

/**
 * Coerces the typed replacement to the property's assigned type when known,
 * with a conservative heuristic fallback. Empty input clears the value.
 */
export function parseReplacement(raw: string, type: string | null): unknown {
  const t = raw.trim();
  if (t === "" || t === EMPTY_DISPLAY) return null;
  if (type === "number") {
    const n = Number(t);
    return Number.isNaN(n) ? t : n;
  }
  if (type === "checkbox") return t === "true";
  if (type && type !== "unknown") return t; // text, date, aliases, tags… stay strings
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true") return true;
  if (t === "false") return false;
  return t;
}

