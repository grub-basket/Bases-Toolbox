import { ItemView, WorkspaceLeaf } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { CsvImportPanel } from "./csv-import";
import { installMainTabAction, installSidebarAction } from "./view-refresh";

export const VIEW_TYPE_CSV_IMPORT = "bases-toolbox-csv-import";

/** CSV import as a first-class tab / sidebar / window (same UI as the dialog). */
export class CsvImportView extends ItemView {
  icon = "file-down";
  private plugin: BasesToolboxPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: BasesToolboxPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CSV_IMPORT;
  }

  getDisplayText(): string {
    return "Import CSV as notes";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("bases-toolbox-csv-view");
    const inner = root.createDiv({ cls: "bases-toolbox-csv-view-inner" });
    new CsvImportPanel(this.plugin).render(inner);
    installMainTabAction(this);
    installSidebarAction(this);
  }
}

/** Opens (or reveals) the CSV import tab. */
export async function openCsvImportView(plugin: BasesToolboxPlugin): Promise<void> {
  const { workspace } = plugin.app;
  let leaf = workspace.getLeavesOfType(VIEW_TYPE_CSV_IMPORT)[0];
  if (!leaf) {
    leaf = workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_CSV_IMPORT, active: true });
  }
  await workspace.revealLeaf(leaf);
}
