import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { PinValuesModal } from "./allowed-values";
import { openFindReplaceView } from "./find-replace-view";
import { PropertyUsage } from "./scan";

export const VIEW_TYPE_PROPERTY_INDEX = "bases-toolbox-property-index";

const MAX_VALUES_SHOWN = 100;
const MAX_FILES_SHOWN = 60;

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
  private expandedValues = new Set<string>();
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

    this.addAction("picture-in-picture-2", "Open in a main tab", () => void this.openInMainTab());
    const toolbar = root.createDiv({ cls: "bases-toolbox-index-toolbar" });
    const searchEl = toolbar.createEl("input", {
      type: "search",
      placeholder: "Filter properties…",
      cls: "bases-toolbox-index-search",
    });
    const popoutBtn = toolbar.createSpan({ cls: "bases-toolbox-index-btn clickable-icon" });
    setIcon(popoutBtn, "picture-in-picture-2");
    popoutBtn.setAttribute("aria-label", "Open the property index in a main tab");
    popoutBtn.addEventListener("click", () => void this.openInMainTab());
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

    const props = this.plugin.propertyCache.get().filter(
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
      header
        .createSpan({ cls: "bases-toolbox-index-prop-count", text: String(usage.count) })
        .setAttribute("aria-label", `${usage.count} file${usage.count === 1 ? "" : "s"} have this property`);
      const frBtn = header.createSpan({ cls: "bases-toolbox-index-btn clickable-icon" });
      setIcon(frBtn, "replace");
      frBtn.setAttribute("aria-label", "Find & replace values");
      frBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void openFindReplaceView(this.plugin, usage.name);
      });
      const copyBtn = header.createSpan({ cls: "bases-toolbox-index-btn clickable-icon" });
      setIcon(copyBtn, "copy");
      copyBtn.setAttribute("aria-label", "Copy property name");
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(usage.name);
      });
      const searchBtn = header.createSpan({ cls: "bases-toolbox-index-btn clickable-icon" });
      setIcon(searchBtn, "search");
      searchBtn.setAttribute("aria-label", "Show in All properties view");
      searchBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.openInAllProperties(usage.name);
      });
      const pinBtn = header.createSpan({ cls: "bases-toolbox-index-btn clickable-icon" });
      setIcon(pinBtn, "pin");
      const pinned = !!this.plugin.settings.allowedValues[usage.name.toLowerCase()];
      if (pinned) pinBtn.addClass("bases-toolbox-pin-active");
      pinBtn.setAttribute(
        "aria-label",
        pinned ? "Allowed values pinned — edit" : "Pin allowed values"
      );
      pinBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        new PinValuesModal(this.plugin, usage).open();
      });

      header.addEventListener("click", () => {
        if (this.expanded.has(key)) this.expanded.delete(key);
        else this.expanded.add(key);
        this.renderList();
      });

      if (this.expanded.has(key)) this.renderValues(row, usage);
    }
  }

  /**
   * Reveals Obsidian's core "All properties" view and pre-fills its search
   * with the property name. The search field is undocumented DOM, so this
   * degrades to just revealing the view if the input can't be found.
   */
  private async openInAllProperties(name: string): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType("all-properties")[0];
    if (!leaf) {
      const internal = (
        this.app as unknown as {
          internalPlugins?: { getEnabledPluginById?: (id: string) => unknown };
        }
      ).internalPlugins?.getEnabledPluginById?.("properties");
      if (!internal) {
        new Notice("Enable the core “Properties view” plugin first.");
        return;
      }
      const right = workspace.getRightLeaf(false);
      if (!right) return;
      await right.setViewState({ type: "all-properties", active: true });
      leaf = right;
      // Give the freshly created view a beat to build its DOM.
      await new Promise((r) => window.setTimeout(r, 150));
    }
    await workspace.revealLeaf(leaf);
    const input = leaf.view.containerEl.querySelector<HTMLInputElement>('input[type="search"]');
    if (input) {
      input.value = name;
      input.dispatchEvent(new Event("input"));
      input.focus();
    }
  }

  private renderValues(row: HTMLElement, usage: PropertyUsage): void {
    const valuesEl = row.createDiv({ cls: "bases-toolbox-index-values" });
    const sorted = [...usage.values.entries()].sort((a, b) => b[1] - a[1]);
    for (const [display, count] of sorted.slice(0, MAX_VALUES_SHOWN)) {
      const vkey = `${usage.name}\u0000${display}`;
      const files = usage.valueFiles.get(display) ?? [];
      const valueRow = valuesEl.createDiv({ cls: "bases-toolbox-index-value" });

      const twisty = valueRow.createSpan({ cls: "bases-toolbox-index-btn clickable-icon" });
      setIcon(twisty, this.expandedValues.has(vkey) ? "chevron-down" : "chevron-right");
      twisty.setAttribute("aria-label", "Show files with this value");
      const toggle = () => {
        if (this.expandedValues.has(vkey)) this.expandedValues.delete(vkey);
        else this.expandedValues.add(vkey);
        this.renderList();
      };
      twisty.addEventListener("click", (e) => {
        e.stopPropagation();
        toggle();
      });

      valueRow.createSpan({ cls: "bases-toolbox-index-value-text", text: display });
      valueRow
        .createSpan({ cls: "bases-toolbox-index-prop-count", text: String(count) })
        .setAttribute("aria-label", `${count} file${count === 1 ? "" : "s"} have this value`);

      const openBtn = valueRow.createSpan({ cls: "bases-toolbox-index-btn clickable-icon" });
      setIcon(openBtn, "file");
      openBtn.setAttribute(
        "aria-label",
        files.length === 1 ? "Open the file with this value" : `Open a file with this value (${files.length})`
      );
      openBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (files.length === 1) void this.openFile(files[0], e);
        else if (files.length > 1) {
          if (!this.expandedValues.has(vkey)) toggle();
          else this.valueContextMenu(e, files);
        }
      });

      const replBtn = valueRow.createSpan({ cls: "bases-toolbox-index-btn clickable-icon" });
      setIcon(replBtn, "replace");
      replBtn.setAttribute("aria-label", "Replace this value");
      replBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void openFindReplaceView(this.plugin, usage.name, display);
      });

      valueRow.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.valueContextMenu(e, files);
      });

      if (this.expandedValues.has(vkey)) {
        const filesEl = valuesEl.createDiv({ cls: "bases-toolbox-index-files" });
        for (const f of files.slice(0, MAX_FILES_SHOWN)) {
          const fileRow = filesEl.createDiv({ cls: "bases-toolbox-index-file" });
          const openIcon = fileRow.createSpan({ cls: "bases-toolbox-index-btn clickable-icon" });
          setIcon(openIcon, "file");
          openIcon.setAttribute("aria-label", "Open file");
          openIcon.addEventListener("click", (e) => void this.openFile(f, e));
          const link = fileRow.createSpan({ cls: "bases-toolbox-index-file-link", text: f.path });
          link.addEventListener("click", (e) => void this.openFile(f, e));
          fileRow.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            this.fileContextMenu(e, f);
          });
        }
        if (files.length > MAX_FILES_SHOWN) {
          filesEl.createDiv({
            cls: "bases-toolbox-index-empty",
            text: `…and ${files.length - MAX_FILES_SHOWN} more files.`,
          });
        }
      }
    }
    if (sorted.length > MAX_VALUES_SHOWN) {
      valuesEl.createDiv({
        cls: "bases-toolbox-index-empty",
        text: `…and ${sorted.length - MAX_VALUES_SHOWN} more values.`,
      });
    }
  }

  /** Opens a file; cmd/ctrl/middle-click opens it in a new tab. */
  private async openFile(file: TFile, e?: MouseEvent): Promise<void> {
    const newTab = !!e && (e.ctrlKey || e.metaKey || e.button === 1);
    await this.app.workspace.getLeaf(newTab ? "tab" : false).openFile(file);
  }

  private fileContextMenu(e: MouseEvent, file: TFile): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("Open").setIcon("file").onClick(() => void this.app.workspace.getLeaf(false).openFile(file))
    );
    menu.addItem((i) =>
      i.setTitle("Open in new tab").setIcon("plus").onClick(() => void this.app.workspace.getLeaf("tab").openFile(file))
    );
    menu.addItem((i) =>
      i.setTitle("Open to the right").setIcon("separator-vertical").onClick(() => void this.app.workspace.getLeaf("split").openFile(file))
    );
    menu.addItem((i) =>
      i
        .setTitle("Open below")
        .setIcon("separator-horizontal")
        .onClick(() => void this.app.workspace.getLeaf("split", "horizontal").openFile(file))
    );
    menu.showAtMouseEvent(e);
  }

  private valueContextMenu(e: MouseEvent, files: TFile[]): void {
    if (!files.length) return;
    const menu = new Menu();
    for (const f of files.slice(0, 20)) {
      menu.addItem((i) =>
        i.setTitle(f.basename).setIcon("file").onClick(() => void this.app.workspace.getLeaf(false).openFile(f))
      );
    }
    if (files.length > 20) menu.addItem((i) => i.setTitle(`…and ${files.length - 20} more`).setDisabled(true));
    menu.showAtMouseEvent(e);
  }

  /** Opens the property index as a main-area tab (from the header action). */
  private async openInMainTab(): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_PROPERTY_INDEX, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}
