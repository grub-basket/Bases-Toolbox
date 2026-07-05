import { ItemView, Modal, Notice, Setting, TFile, WorkspaceLeaf } from "obsidian";
import type BasesToolboxPlugin from "./main";
import {
  FolderCsvData,
  basePaths,
  folderCsvToText,
  folderPaths,
  scanBaseCsv,
  scanFolderCsv,
} from "./csv-export";
import { ListInputSuggest } from "./suggest";
import { installMainTabAction, installSidebarAction } from "./view-refresh";

export const VIEW_TYPE_CSV_EXPORT = "bases-toolbox-csv-export";

const PREVIEW_ROWS = 50;

type ExportMode = "base" | "folder";

/**
 * CSV export with two sources, chosen by a tab:
 *  - From a base: pick a .base file (no need to open it); exports the notes in
 *    the folders it references, using the base's columns.
 *  - From a folder: pick any folder; unions every frontmatter key found.
 * Both preview, then Copy-for-Excel or write a .csv. Rendered into a dialog or
 * a workspace leaf.
 */
class CsvExportPanel {
  private plugin: BasesToolboxPlugin;
  private mode: ExportMode = "base";
  private basePath = "";
  private folder = "/";
  private recursive = true;

  private data: FolderCsvData = { columns: [], rows: [] };
  private scanned = false;
  private note = "";
  private outDir = "";
  private outStem = "export";

  private controlsEl: HTMLElement | null = null;
  private resultsEl: HTMLElement | null = null;

  constructor(plugin: BasesToolboxPlugin) {
    this.plugin = plugin;
  }

  private get app() {
    return this.plugin.app;
  }

  render(root: HTMLElement): void {
    const tabs = root.createDiv({ cls: "bases-toolbox-doctor-tabs" });
    const mkTab = (label: string, mode: ExportMode) => {
      const t = tabs.createDiv({ cls: "bases-toolbox-doctor-tab", text: label });
      if (this.mode === mode) t.addClass("is-active");
      t.addEventListener("click", () => {
        if (this.mode === mode) return;
        this.mode = mode;
        this.scanned = false;
        this.renderControls();
        this.resultsEl?.empty();
        tabs.findAll(".bases-toolbox-doctor-tab").forEach((el) => el.removeClass("is-active"));
        t.addClass("is-active");
      });
    };
    mkTab("From a base", "base");
    mkTab("From a folder", "folder");

    this.controlsEl = root.createDiv();
    this.resultsEl = root.createDiv();
    this.renderControls();
  }

  private renderControls(): void {
    const root = this.controlsEl;
    if (!root) return;
    root.empty();

    if (this.mode === "base") {
      root.createDiv({
        cls: "bases-toolbox-fr-info",
        text: "Pick a base — this exports the notes in the folders it references, using the base's columns. (For a base's exact live filtered results with formula columns, open it and run “Export active base results as CSV”.)",
      });
      new Setting(root)
        .setName("Base")
        .setDesc("Type to filter. Any .base file in the vault.")
        .addText((t) => {
          t.setValue(this.basePath).setPlaceholder("Folder/My Base.base");
          new ListInputSuggest(this.plugin, t.inputEl, () => basePaths(this.plugin));
          t.onChange((v) => (this.basePath = v.trim()));
        });
      new Setting(root).addButton((b) =>
        b.setButtonText("Scan base").setCta().onClick(() => void this.scanBase())
      );
    } else {
      root.createDiv({
        cls: "bases-toolbox-fr-info",
        text: "Pick a folder — every note's frontmatter becomes a row, with a column for each key found across the folder. No base needed.",
      });
      new Setting(root)
        .setName("Folder")
        .setDesc('Type to filter. "/" exports the whole vault.')
        .addText((t) => {
          t.setValue(this.folder);
          new ListInputSuggest(this.plugin, t.inputEl, () => folderPaths(this.plugin));
          t.onChange((v) => (this.folder = v.trim() || "/"));
        });
      new Setting(root)
        .setName("Include subfolders")
        .addToggle((t) => t.setValue(this.recursive).onChange((v) => (this.recursive = v)));
      new Setting(root).addButton((b) =>
        b.setButtonText("Scan folder").setCta().onClick(() => {
          this.data = scanFolderCsv(this.plugin, this.folder, this.recursive);
          this.note = "";
          this.outDir = this.folder === "/" ? "" : `${this.folder.replace(/\/+$/, "")}/`;
          this.outStem = this.folder === "/" ? "vault" : (this.folder.split("/").pop() ?? "folder");
          this.scanned = true;
          this.renderResults();
        })
      );
    }
  }

  private async scanBase(): Promise<void> {
    if (!this.basePath || !(this.app.vault.getAbstractFileByPath(this.basePath) instanceof TFile)) {
      new Notice("Pick a .base file first.");
      return;
    }
    const { data, folders, approximate } = await scanBaseCsv(this.plugin, this.basePath);
    this.data = data;
    this.note = approximate
      ? "This base has filters beyond folder scope — the export is a best-effort superset of the notes in its folders."
      : folders.length
        ? `Scoped to: ${folders.join(", ")}.`
        : "Whole-vault base.";
    const slash = this.basePath.lastIndexOf("/");
    this.outDir = slash === -1 ? "" : this.basePath.slice(0, slash + 1);
    this.outStem = this.basePath.slice(slash + 1).replace(/\.base$/, "");
    this.scanned = true;
    this.renderResults();
  }

  private renderResults(): void {
    const root = this.resultsEl;
    if (!root) return;
    root.empty();
    if (!this.scanned) return;
    if (!this.data.rows.length) {
      root.createDiv({ cls: "bases-toolbox-fr-info", text: "No notes found to export." });
      return;
    }

    if (this.note) root.createDiv({ cls: "bases-toolbox-fr-info", text: this.note });
    root.createDiv({
      cls: "bases-toolbox-fr-info",
      text: `${this.data.rows.length.toLocaleString()} rows × ${this.data.columns.length + 1} columns.`,
    });

    const wrap = root.createDiv({ cls: "bases-toolbox-export-table-wrap" });
    const table = wrap.createEl("table", { cls: "bases-toolbox-export-table" });
    const head = table.createEl("tr");
    for (const h of ["file name", ...this.data.columns]) head.createEl("th", { text: h, attr: { title: h } });
    for (const row of this.data.rows.slice(0, PREVIEW_ROWS)) {
      const tr = table.createEl("tr");
      tr.createEl("td", { text: row.name, attr: { title: row.name } });
      for (const k of this.data.columns) {
        const v = row.fm[k] === undefined ? "" : String(row.fm[k]);
        tr.createEl("td", { text: v, attr: { title: v } });
      }
    }
    if (this.data.rows.length > PREVIEW_ROWS) {
      root.createDiv({
        cls: "bases-toolbox-fr-info",
        text: `Preview shows the first ${PREVIEW_ROWS}; export includes all ${this.data.rows.length.toLocaleString()}.`,
      });
    }

    const bar = root.createDiv({ cls: "bases-toolbox-frv-bar" });
    bar.createEl("button", { cls: "mod-cta", text: "Copy for Excel" }).addEventListener("click", () =>
      void this.copyTsv()
    );
    bar.createEl("button", { text: "Write .csv to vault" }).addEventListener("click", () =>
      void this.writeCsv()
    );
  }

  private async copyTsv(): Promise<void> {
    try {
      await navigator.clipboard.writeText(folderCsvToText(this.data, "\t"));
      new Notice("Copied — paste into Excel or Sheets.");
    } catch {
      new Notice("Couldn't reach the clipboard — try “Write .csv to vault” instead.");
    }
  }

  private async writeCsv(): Promise<void> {
    const csv = folderCsvToText(this.data, ",");
    const outPath = `${this.outDir}${this.outStem} export.csv`;
    const existing = this.app.vault.getAbstractFileByPath(outPath);
    if (existing instanceof TFile) await this.app.vault.modify(existing, csv);
    else await this.app.vault.create(outPath, csv);
    let onClip = true;
    try {
      await navigator.clipboard.writeText(csv);
    } catch {
      onClip = false;
    }
    new Notice(
      `Exported ${this.data.rows.length.toLocaleString()} rows → "${outPath}"${onClip ? " (also copied)" : ""}.`
    );
  }
}

/** CSV export as a dialog. */
export class CsvExportModal extends Modal {
  private plugin: BasesToolboxPlugin;

  constructor(plugin: BasesToolboxPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.setText("Export to CSV");
    this.modalEl.addClass("bases-toolbox-csv-modal");
    new CsvExportPanel(this.plugin).render(this.contentEl);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** CSV export as a first-class tab / sidebar / window. */
export class CsvExportView extends ItemView {
  icon = "file-up";
  private plugin: BasesToolboxPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: BasesToolboxPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CSV_EXPORT;
  }

  getDisplayText(): string {
    return "Export to CSV";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("bases-toolbox-csv-view");
    const inner = root.createDiv({ cls: "bases-toolbox-csv-view-inner" });
    new CsvExportPanel(this.plugin).render(inner);
    installMainTabAction(this);
    installSidebarAction(this);
  }
}

/** Opens (or reveals) the CSV export tab. */
export async function openCsvExportView(plugin: BasesToolboxPlugin): Promise<void> {
  const { workspace } = plugin.app;
  let leaf = workspace.getLeavesOfType(VIEW_TYPE_CSV_EXPORT)[0];
  if (!leaf) {
    leaf = workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_CSV_EXPORT, active: true });
  }
  await workspace.revealLeaf(leaf);
}
