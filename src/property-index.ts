import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { PinValuesModal } from "./allowed-values";
import { openFindReplaceView } from "./find-replace-view";
import { PropertyUsage } from "./scan";
import {
  ConfirmModal,
  DeleteResult,
  PromptModal,
  deletePropertyFromFiles,
  notifyDeletion,
  renamePropertyEverywhere,
} from "./property-delete";

/** Above this many, opening every file in a tab gets a confirm first. */
const MANY_TABS = 12;

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

      // Less-common actions (open-all / rename / delete) live in a ⋯ menu so
      // the header doesn't overflow the narrow panel.
      const moreBtn = header.createSpan({ cls: "bases-toolbox-index-btn clickable-icon" });
      setIcon(moreBtn, "more-horizontal");
      moreBtn.setAttribute("aria-label", "More actions (open all, rename, delete)");
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.propertyMenu(e, usage);
      });

      header.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.propertyMenu(e, usage);
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
          else this.valueContextMenu(e, files, usage, display);
        }
      });

      const replBtn = valueRow.createSpan({ cls: "bases-toolbox-index-btn clickable-icon" });
      setIcon(replBtn, "replace");
      replBtn.setAttribute("aria-label", "Replace this value");
      replBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void openFindReplaceView(this.plugin, usage.name, display);
      });

      const copyValBtn = valueRow.createSpan({ cls: "bases-toolbox-index-btn clickable-icon" });
      setIcon(copyValBtn, "clipboard-copy");
      copyValBtn.setAttribute("aria-label", "Copy this value");
      copyValBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(display);
      });

      const delValBtn = valueRow.createSpan({ cls: "bases-toolbox-index-btn bases-toolbox-index-del clickable-icon" });
      setIcon(delValBtn, "trash-2");
      delValBtn.setAttribute("aria-label", `Delete “${usage.name}” from the ${files.length} file${files.length === 1 ? "" : "s"} with this value`);
      delValBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.confirmDelete(usage.name, files, "value", display, usage.type);
      });

      valueRow.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.valueContextMenu(e, files, usage, display);
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
          const delFileBtn = fileRow.createSpan({ cls: "bases-toolbox-index-btn bases-toolbox-index-del clickable-icon" });
          setIcon(delFileBtn, "trash-2");
          delFileBtn.setAttribute("aria-label", `Delete “${usage.name}” from this file`);
          delFileBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.confirmDelete(usage.name, [f], "file", undefined, usage.type);
          });
          fileRow.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            this.fileContextMenu(e, f, usage);
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

  /**
   * Opens a file in a new tab by default (the index is a browsing surface, so
   * clicking shouldn't replace whatever you're reading). Alt/option-click
   * reuses the current tab for the occasional in-place open.
   */
  private async openFile(file: TFile, e?: MouseEvent): Promise<void> {
    const sameTab = !!e && e.altKey;
    await this.app.workspace.getLeaf(sameTab ? false : "tab").openFile(file);
  }

  /** ⋯ menu for a property: open-all, rename, delete. */
  private propertyMenu(e: MouseEvent, usage: PropertyUsage): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle(`Open all ${usage.count} file${usage.count === 1 ? "" : "s"} in new tabs`)
        .setIcon("external-link")
        .onClick(() => void this.openAllInTabs(usage.files))
    );
    menu.addItem((i) =>
      i
        .setTitle("Rename property…")
        .setIcon("pencil")
        .onClick(() => this.promptRename(usage))
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle(`Delete from all ${usage.count} file${usage.count === 1 ? "" : "s"}`)
        .setIcon("trash-2")
        .onClick(() => this.confirmDelete(usage.name, usage.files, "property", undefined, usage.type))
    );
    menu.showAtMouseEvent(e);
  }

  private promptRename(usage: PropertyUsage): void {
    new PromptModal(this.plugin, {
      title: `Rename “${usage.name}”`,
      body: `Renames the property across all ${usage.count} file${usage.count === 1 ? "" : "s"}. If a file already has the new name, the old value is folded away (kept value wins). Undoable from history.`,
      initial: usage.name,
      confirmText: "Rename",
      onSubmit: (newName) =>
        void (async () => {
          if (newName.toLowerCase() === usage.name.toLowerCase()) return;
          const { renamed, merged } = await renamePropertyEverywhere(this.plugin, usage, newName);
          this.plugin.propertyCache.markDirty();
          this.renderList();
          new Notice(
            `Renamed “${usage.name}” → “${newName}” in ${renamed} file${renamed === 1 ? "" : "s"}` +
              (merged ? `, folded into an existing property in ${merged}.` : ".")
          );
        })(),
    }).open();
  }

  /** Confirms, deletes at the given scope, then notifies with the export link. */
  private confirmDelete(
    name: string,
    files: TFile[],
    scope: "property" | "value" | "file",
    value: string | undefined,
    type: string | null
  ): void {
    const n = new Set(files).size;
    const where =
      scope === "file"
        ? "this file"
        : scope === "value"
          ? `the ${n} file${n === 1 ? "" : "s"} with value “${value}”`
          : `all ${n} file${n === 1 ? "" : "s"}`;
    new ConfirmModal(this.plugin, {
      title: `Delete “${name}”?`,
      body: `Removes “${name}” from ${where}. Undoable from find & replace history; every removal is logged to deletions/${name}.jsonl.`,
      confirmText: "Delete property",
      danger: true,
      onConfirm: () =>
        void (async () => {
          const result: DeleteResult = await deletePropertyFromFiles(this.plugin, name, files, { scope, value, type });
          this.plugin.propertyCache.markDirty();
          this.renderList();
          if (result.count)
            notifyDeletion(this.plugin, result, `“${name}” from ${result.count} file${result.count === 1 ? "" : "s"}`);
          else new Notice("Nothing to delete — no files still had that property.");
        })(),
    }).open();
  }

  /** Opens every given file in its own new tab (confirming past a threshold). */
  private async openAllInTabs(files: TFile[]): Promise<void> {
    const unique = [...new Set(files)];
    if (!unique.length) return;
    const run = async () => {
      for (const f of unique) await this.app.workspace.getLeaf("tab").openFile(f);
    };
    if (unique.length > MANY_TABS) {
      new ConfirmModal(this.plugin, {
        title: "Open many tabs",
        body: `This opens ${unique.length} files, each in a new tab. Continue?`,
        confirmText: `Open ${unique.length} tabs`,
        onConfirm: () => void run(),
      }).open();
      return;
    }
    await run();
  }

  private fileContextMenu(e: MouseEvent, file: TFile, usage?: PropertyUsage): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("Open in new tab").setIcon("file").onClick(() => void this.app.workspace.getLeaf("tab").openFile(file))
    );
    menu.addItem((i) =>
      i.setTitle("Open in current tab").setIcon("file").onClick(() => void this.app.workspace.getLeaf(false).openFile(file))
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
    if (usage) {
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle(`Delete “${usage.name}” from this file`)
          .setIcon("trash-2")
          .onClick(() => this.confirmDelete(usage.name, [file], "file", undefined, usage.type))
      );
    }
    menu.showAtMouseEvent(e);
  }

  private valueContextMenu(e: MouseEvent, files: TFile[], usage?: PropertyUsage, value?: string): void {
    if (!files.length) return;
    const menu = new Menu();
    if (files.length > 1) {
      menu.addItem((i) =>
        i
          .setTitle(`Open all ${files.length} in new tabs`)
          .setIcon("external-link")
          .onClick(() => void this.openAllInTabs(files))
      );
    }
    if (value !== undefined) {
      menu.addItem((i) =>
        i.setTitle("Copy value").setIcon("clipboard-copy").onClick(() => void navigator.clipboard.writeText(value))
      );
    }
    menu.addSeparator();
    for (const f of files.slice(0, 20)) {
      menu.addItem((i) =>
        i.setTitle(f.basename).setIcon("file").onClick(() => void this.app.workspace.getLeaf("tab").openFile(f))
      );
    }
    if (files.length > 20) menu.addItem((i) => i.setTitle(`…and ${files.length - 20} more`).setDisabled(true));
    if (usage) {
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle(`Delete “${usage.name}” from ${files.length} file${files.length === 1 ? "" : "s"}`)
          .setIcon("trash-2")
          .onClick(() => this.confirmDelete(usage.name, files, "value", value, usage.type))
      );
    }
    menu.showAtMouseEvent(e);
  }

  /** Opens the property index as a main-area tab (from the header action). */
  private async openInMainTab(): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_PROPERTY_INDEX, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}
