import { ItemView, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { FindReplaceModal } from "./find-replace";
import { PropertyUsage, scanProperties } from "./scan";

export const VIEW_TYPE_PROPERTY_INDEX = "bases-toolbox-property-index";

const MAX_VALUES_SHOWN = 100;

/**
 * A searchable index of every frontmatter property in the vault, built from
 * the metadata cache. This sidesteps the Bases filter dropdown "forgetting"
 * properties: as long as any file carries the property, it shows up here.
 */
export class PropertyIndexView extends ItemView {
  icon = "table-properties";
  private plugin: BasesToolboxPlugin;
  private search = "";
  private expanded = new Set<string>();
  private listEl: HTMLElement | null = null;
  private refresh = debounce(() => this.renderList(), 1500, true);

  constructor(leaf: WorkspaceLeaf, plugin: BasesToolboxPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_PROPERTY_INDEX;
  }

  getDisplayText(): string {
    return "Property index";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("bases-toolbox-index");

    const searchEl = root.createEl("input", {
      type: "search",
      placeholder: "Filter properties…",
      cls: "bases-toolbox-index-search",
    });
    searchEl.addEventListener("input", () => {
      this.search = searchEl.value.toLowerCase();
      this.renderList();
    });

    this.listEl = root.createDiv({ cls: "bases-toolbox-index-list" });
    this.renderList();

    this.registerEvent(this.app.metadataCache.on("resolved", () => this.refresh()));
  }

  private renderList(): void {
    const listEl = this.listEl;
    if (!listEl) return;
    listEl.empty();

    const props = scanProperties(this.app).filter(
      (p) => !this.search || p.name.toLowerCase().includes(this.search)
    );
    if (!props.length) {
      listEl.createDiv({ cls: "bases-toolbox-index-empty", text: "No properties found." });
      return;
    }

    for (const usage of props) {
      const key = usage.name.toLowerCase();
      const row = listEl.createDiv({ cls: "bases-toolbox-index-prop" });

      const header = row.createDiv({ cls: "bases-toolbox-index-prop-header" });
      header.createSpan({ cls: "bases-toolbox-index-prop-name", text: usage.name });
      if (usage.type) header.createSpan({ cls: "bases-toolbox-index-prop-type", text: usage.type });
      header.createSpan({ cls: "bases-toolbox-index-prop-count", text: String(usage.count) });
      const frBtn = header.createSpan({ cls: "bases-toolbox-index-btn clickable-icon" });
      setIcon(frBtn, "replace");
      frBtn.setAttribute("aria-label", "Find & replace values");
      frBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        new FindReplaceModal(this.plugin, usage).open();
      });
      const copyBtn = header.createSpan({ cls: "bases-toolbox-index-btn clickable-icon" });
      setIcon(copyBtn, "copy");
      copyBtn.setAttribute("aria-label", "Copy property name");
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(usage.name);
      });

      header.addEventListener("click", () => {
        if (this.expanded.has(key)) this.expanded.delete(key);
        else this.expanded.add(key);
        this.renderList();
      });

      if (this.expanded.has(key)) this.renderValues(row, usage);
    }
  }

  private renderValues(row: HTMLElement, usage: PropertyUsage): void {
    const valuesEl = row.createDiv({ cls: "bases-toolbox-index-values" });
    const sorted = [...usage.values.entries()].sort((a, b) => b[1] - a[1]);
    for (const [display, count] of sorted.slice(0, MAX_VALUES_SHOWN)) {
      const valueRow = valuesEl.createDiv({ cls: "bases-toolbox-index-value" });
      valueRow.createSpan({ cls: "bases-toolbox-index-value-text", text: display });
      valueRow.createSpan({ cls: "bases-toolbox-index-prop-count", text: String(count) });
      const btn = valueRow.createSpan({ cls: "bases-toolbox-index-btn clickable-icon" });
      setIcon(btn, "replace");
      btn.setAttribute("aria-label", "Replace this value");
      btn.addEventListener("click", () => {
        new FindReplaceModal(this.plugin, usage, display).open();
      });
    }
    if (sorted.length > MAX_VALUES_SHOWN) {
      valuesEl.createDiv({
        cls: "bases-toolbox-index-empty",
        text: `…and ${sorted.length - MAX_VALUES_SHOWN} more values.`,
      });
    }
  }
}
