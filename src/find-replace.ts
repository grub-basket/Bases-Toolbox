import { FuzzySuggestModal } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { openFindReplaceView } from "./find-replace-view";
import { EMPTY_DISPLAY, PropertyUsage, valueToDisplay } from "./scan";

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
    void openFindReplaceView(this.plugin, item.name);
  }
}

/** Applies the replacement to one frontmatter value; handles list properties. */
export function replaceIn(
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

