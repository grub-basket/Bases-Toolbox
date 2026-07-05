import { ItemView, Modal, Notice, Setting, TFile, WorkspaceLeaf } from "obsidian";
import type BasesToolboxPlugin from "./main";
import {
  BaseInfo,
  FolderCsvData,
  basePaths,
  folderCsvToText,
  folderPaths,
  nonMdFilesInScope,
  readBaseInfo,
  scanBaseView,
  scanFolderCsv,
  subfoldersOf,
} from "./csv-export";
import { createOrRefreshCompanion } from "./companion-notes";
import { ListInputSuggest } from "./suggest";
import { installMainTabAction, installSidebarAction } from "./view-refresh";

export const VIEW_TYPE_CSV_EXPORT = "bases-toolbox-csv-export";

const PREVIEW_ROWS = 50;
const MAX_FILES_LISTED = 40;

type ExportMode = "base" | "folder";

/**
 * CSV export with two sources, chosen by a tab:
 *  - From a base: pick a .base file (no need to open it), pick which view, see
 *    its filters/columns, and export the notes it covers.
 *  - From a folder: pick a folder, optionally ignore subfolders, and companion
 *    any non-markdown files so they're exportable too.
 */
class CsvExportPanel {
  private plugin: BasesToolboxPlugin;
  private mode: ExportMode = "base";

  // base mode
  private basePath = "";
  private baseInfo: BaseInfo | null = null;
  private viewIndex = 0;
  private baseDetailsEl: HTMLElement | null = null;

  // folder mode
  private folder = "/";
  private recursive = true;
  private ignored = new Set<string>();
  private nonMd: TFile[] = [];
  private folderDetailsEl: HTMLElement | null = null;

  // shared
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
        tabs.findAll(".bases-toolbox-doctor-tab").forEach((el) => el.removeClass("is-active"));
        t.addClass("is-active");
        this.renderControls();
        this.resultsEl?.empty();
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
    if (this.mode === "base") this.renderBaseControls(root);
    else this.renderFolderControls(root);
  }

  /* ---------- base mode ---------- */

  private renderBaseControls(root: HTMLElement): void {
    root.createDiv({
      cls: "bases-toolbox-fr-info",
      text: "Pick a base — load it to choose a view and see what it covers. (For a base's exact live filtered results with formula columns, open it and run “Export active base results as CSV”.)",
    });
    new Setting(root)
      .setName("Base")
      .setDesc("Type to filter. Any .base file in the vault.")
      .addText((t) => {
        t.setValue(this.basePath).setPlaceholder("Folder/My Base.base");
        new ListInputSuggest(this.plugin, t.inputEl, () => basePaths(this.plugin));
        t.onChange((v) => {
          this.basePath = v.trim();
          this.baseInfo = null;
          this.baseDetailsEl?.empty();
        });
      });
    new Setting(root).addButton((b) =>
      b.setButtonText("Load base").setCta().onClick(() => void this.loadBase())
    );
    this.baseDetailsEl = root.createDiv();
    if (this.baseInfo) this.renderBaseDetails();
  }

  private async loadBase(): Promise<void> {
    if (!this.basePath || !(this.app.vault.getAbstractFileByPath(this.basePath) instanceof TFile)) {
      new Notice("Pick a .base file first.");
      return;
    }
    this.baseInfo = await readBaseInfo(this.plugin, this.basePath);
    this.viewIndex = 0;
    this.renderBaseDetails();
  }

  private renderBaseDetails(): void {
    const el = this.baseDetailsEl;
    const info = this.baseInfo;
    if (!el || !info) return;
    el.empty();

    if (info.baseFilters.length) {
      el.createDiv({ cls: "bases-toolbox-fr-info", text: `Base filters: ${info.baseFilters.join("  ·  ")}` });
    }
    if (!info.views.length) {
      el.createDiv({ cls: "bases-toolbox-fr-info", text: "This base has no views to export." });
      return;
    }

    if (info.views.length > 1) {
      new Setting(el)
        .setName("View")
        .setDesc("This base has several views — pick which one to export.")
        .addDropdown((dd) => {
          info.views.forEach((v, i) => dd.addOption(String(i), `${v.name} (${v.order.length || 1} cols)`));
          dd.setValue(String(this.viewIndex));
          dd.onChange((v) => {
            this.viewIndex = Number(v);
            this.renderBaseDetails();
          });
        });
    }

    const view = info.views[this.viewIndex] ?? info.views[0];
    const card = el.createDiv({ cls: "bases-toolbox-export-viewcard" });
    card.createDiv({ cls: "bases-toolbox-export-viewname", text: `View: ${view.name}` });
    if (view.filters.length) {
      card.createDiv({ cls: "bases-toolbox-fr-info", text: `View filters: ${view.filters.join("  ·  ")}` });
    }
    card.createDiv({
      cls: "bases-toolbox-fr-info",
      text: `Columns: ${(view.order.length ? view.order : ["file.name"]).join(", ")}`,
    });

    new Setting(el).addButton((b) =>
      b.setButtonText("Export this view").setCta().onClick(() => void this.exportBaseView())
    );
  }

  private async exportBaseView(): Promise<void> {
    const { data, folders, approximate } = await scanBaseView(this.plugin, this.basePath, this.viewIndex);
    this.data = data;
    this.note = approximate
      ? "This view has filters beyond folder scope — the export is a best-effort superset of the notes in its folders."
      : folders.length
        ? `Scoped to: ${folders.join(", ")}.`
        : "Whole-vault base.";
    const slash = this.basePath.lastIndexOf("/");
    this.outDir = slash === -1 ? "" : this.basePath.slice(0, slash + 1);
    const stem = this.basePath.slice(slash + 1).replace(/\.base$/, "");
    const view = this.baseInfo?.views[this.viewIndex];
    this.outStem = this.baseInfo && this.baseInfo.views.length > 1 && view ? `${stem} - ${view.name}` : stem;
    this.scanned = true;
    this.renderResults();
  }

  /* ---------- folder mode ---------- */

  private renderFolderControls(root: HTMLElement): void {
    root.createDiv({
      cls: "bases-toolbox-fr-info",
      text: "Pick a folder — every note's frontmatter becomes a row, with a column per key found. Load it to ignore subfolders or companion non-markdown files first.",
    });
    new Setting(root)
      .setName("Folder")
      .setDesc('Type to filter. "/" is the whole vault.')
      .addText((t) => {
        t.setValue(this.folder);
        new ListInputSuggest(this.plugin, t.inputEl, () => folderPaths(this.plugin));
        t.onChange((v) => (this.folder = v.trim() || "/"));
      });
    new Setting(root)
      .setName("Include subfolders")
      .addToggle((t) => t.setValue(this.recursive).onChange((v) => (this.recursive = v)));
    new Setting(root).addButton((b) =>
      b.setButtonText("Load folder").setCta().onClick(() => this.loadFolder())
    );
    this.folderDetailsEl = root.createDiv();
  }

  private loadFolder(): void {
    this.ignored.clear();
    this.renderFolderDetails();
  }

  private renderFolderDetails(): void {
    const el = this.folderDetailsEl;
    if (!el) return;
    el.empty();

    const ignore = [...this.ignored];
    const subs = this.recursive ? subfoldersOf(this.plugin, this.folder) : [];
    this.nonMd = nonMdFilesInScope(this.plugin, this.folder, this.recursive, ignore);

    if (subs.length) {
      el.createDiv({ cls: "bases-toolbox-fr-info", text: "Ignore these subfolders:" });
      const box = el.createDiv({ cls: "bases-toolbox-export-ignore" });
      for (const s of subs) {
        const row = box.createDiv({ cls: "bases-toolbox-frv-row" });
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = this.ignored.has(s);
        cb.addEventListener("change", () => {
          if (cb.checked) this.ignored.add(s);
          else this.ignored.delete(s);
          this.renderFolderDetails();
        });
        row.createSpan({ cls: "bases-toolbox-frv-path", text: s });
      }
    }

    if (this.nonMd.length) {
      el.createDiv({
        cls: "bases-toolbox-fr-info bases-toolbox-export-nonmd-note",
        text: `${this.nonMd.length} non-markdown file${this.nonMd.length === 1 ? "" : "s"} here won't be exported (images, PDFs, etc.). Generate companion notes to make them queryable — then re-load and they're included.`,
      });
      const list = el.createDiv({ cls: "bases-toolbox-export-nonmd-list" });
      for (const f of this.nonMd.slice(0, MAX_FILES_LISTED)) {
        list.createDiv({ cls: "bases-toolbox-export-nonmd-item", text: f.path });
      }
      if (this.nonMd.length > MAX_FILES_LISTED) {
        list.createDiv({ cls: "bases-toolbox-index-empty", text: `…and ${this.nonMd.length - MAX_FILES_LISTED} more.` });
      }
      new Setting(el).addButton((b) =>
        b
          .setButtonText(`Generate companions for these (${this.nonMd.length})`)
          .onClick(() => void this.generateCompanions())
      );
    }

    new Setting(el).addButton((b) =>
      b
        .setButtonText("Scan & preview")
        .setCta()
        .onClick(() => {
          this.data = scanFolderCsv(this.plugin, this.folder, this.recursive, [...this.ignored]);
          this.note = this.ignored.size ? `Ignoring: ${[...this.ignored].join(", ")}.` : "";
          this.outDir = this.folder === "/" ? "" : `${this.folder.replace(/\/+$/, "")}/`;
          this.outStem = this.folder === "/" ? "vault" : (this.folder.split("/").pop() ?? "folder");
          this.scanned = true;
          this.renderResults();
        })
    );
  }

  private async generateCompanions(): Promise<void> {
    const dest = this.plugin.settings.companionsFolder;
    let created = 0;
    let refreshed = 0;
    for (const f of this.nonMd) {
      const r = await createOrRefreshCompanion(this.plugin, f, dest);
      if (r === "created") created++;
      else refreshed++;
    }
    new Notice(
      `Companions: created ${created}${refreshed ? `, refreshed ${refreshed}` : ""}. Re-load the folder to include them.`
    );
    this.renderFolderDetails();
  }

  /* ---------- shared results ---------- */

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
