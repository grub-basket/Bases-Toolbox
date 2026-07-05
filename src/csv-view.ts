import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { CsvImportPanel } from "./csv-import";
import { exportBaseCsv } from "./csv-export";
import { installMainTabAction, installSidebarAction } from "./view-refresh";

export const VIEW_TYPE_CSV = "bases-toolbox-csv";

/**
 * CSV import & export as a first-class tab (or sidebar / new window): the full
 * import mapping UI plus a one-click export of the open base. Same logic as the
 * import dialog and the export command, just hosted in a workspace leaf.
 */
export class CsvView extends ItemView {
  icon = "arrow-right-left";
  private plugin: BasesToolboxPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: BasesToolboxPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CSV;
  }

  getDisplayText(): string {
    return "CSV import / export";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    // NB: not the modal-width class — that would pin the tab to the left.
    root.addClass("bases-toolbox-csv-view");
    const inner = root.createDiv({ cls: "bases-toolbox-csv-view-inner" });

    // Export — one-shot against the open base.
    const ex = inner.createDiv({ cls: "bases-toolbox-csv-section" });
    this.heading(ex, "file-up", "Export a base to CSV");
    ex.createDiv({
      cls: "bases-toolbox-fr-info",
      text: "Writes the base you're viewing (or the first open base) to a clean CSV next to its .base file — wikilinks unwrapped, lists joined — and copies it to the clipboard.",
    });
    const exBtn = ex.createEl("button", { cls: "mod-cta", text: "Export open base as CSV" });
    exBtn.addEventListener("click", () => void exportBaseCsv(this.plugin));

    // Import — the full mapping UI.
    const im = inner.createDiv({ cls: "bases-toolbox-csv-section" });
    this.heading(im, "file-down", "Import CSV as notes");
    new CsvImportPanel(this.plugin).render(im);

    installMainTabAction(this);
    installSidebarAction(this);
  }

  private heading(parent: HTMLElement, icon: string, text: string): void {
    const h = parent.createDiv({ cls: "bases-toolbox-csv-heading" });
    setIcon(h.createSpan({ cls: "bases-toolbox-csv-heading-icon" }), icon);
    h.createSpan({ text });
  }
}

/** Opens (or reveals) the CSV import/export tab. */
export async function openCsvView(plugin: BasesToolboxPlugin): Promise<void> {
  const { workspace } = plugin.app;
  let leaf = workspace.getLeavesOfType(VIEW_TYPE_CSV)[0];
  if (!leaf) {
    leaf = workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_CSV, active: true });
  }
  await workspace.revealLeaf(leaf);
}
