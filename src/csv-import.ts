import { ButtonComponent, Modal, Notice, Setting, TFile, TFolder, normalizePath, stringifyYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { folderPaths } from "./csv-export";
import { ListInputSuggest } from "./suggest";
import {
  CSV_TYPES,
  CsvType,
  cellToValue,
  countAmbiguousDates,
  guessType,
  parseCSV,
  sanitizeFilename,
  toPropertyName,
} from "./csv-core";

interface ColumnConfig {
  header: string;
  include: boolean;
  propName: string;
  type: CsvType;
}

type CollisionPolicy = "suffix" | "skip" | "overwrite";

/**
 * The CSV-import UI, rendered into any container (a modal or a workspace tab).
 * `onDone` fires after a successful import — the modal closes; the tab stays.
 */
class CsvImportPanel {
  private plugin: BasesToolboxPlugin;
  private onDone?: () => void;
  private headers: string[] = [];
  private rows: string[][] = [];
  private columns: ColumnConfig[] = [];
  private filenameCol = 0;
  /** Column config survives data-row edits; only a header change rebuilds it. */
  private lastHeaderKey = "";
  private previewRow = 0;

  private taEl: HTMLTextAreaElement | null = null;
  private mappingEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private folderEl: HTMLInputElement | null = null;
  private templateEl: HTMLTextAreaElement | null = null;
  private omitEmpty = false;
  private collision: CollisionPolicy = "suffix";
  private makeBase = true;
  private baseNameEl: HTMLInputElement | null = null;
  private baseNameSetting: Setting | null = null;
  private selectAllEl: HTMLInputElement | null = null;
  private importBtn: ButtonComponent | null = null;
  private running = false;

  constructor(plugin: BasesToolboxPlugin, onDone?: () => void) {
    this.plugin = plugin;
    this.onDone = onDone;
  }

  private get app() {
    return this.plugin.app;
  }

  render(contentEl: HTMLElement): void {
    const ta = contentEl.createEl("textarea", {
      cls: "bases-toolbox-csv-input",
      attr: { placeholder: "Paste CSV/TSV here, or drop a file below…" },
    });
    this.taEl = ta;
    ta.addEventListener("input", () => this.parse(ta.value));

    // A single drop zone that's also click-to-choose — the usual pattern.
    const drop = contentEl.createDiv({ cls: "bases-toolbox-csv-drop" });
    drop.createDiv({ cls: "bases-toolbox-csv-drop-main", text: "Drop a CSV/TSV file here, or click to choose" });
    drop.createDiv({
      cls: "bases-toolbox-csv-drop-sub",
      text: "Accepts .csv, .tsv, and .txt (comma- or tab-separated). Spreadsheets (.xlsx, .numbers, .ods) must be exported to CSV first.",
    });
    const pick = () => {
      const input = createEl("input", { type: "file", attr: { accept: ".csv,.tsv,.txt" } });
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (file) this.loadFile(file);
      });
      input.click();
    };
    drop.addEventListener("click", pick);
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.addClass("is-dragover");
    });
    drop.addEventListener("dragleave", () => drop.removeClass("is-dragover"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.removeClass("is-dragover");
      const file = e.dataTransfer?.files?.[0];
      if (file) this.loadFile(file);
    });

    this.statusEl = contentEl.createDiv({ cls: "bases-toolbox-fr-info", text: "Waiting for CSV input…" });
    this.mappingEl = contentEl.createDiv();
    this.previewEl = contentEl.createDiv();

    new Setting(contentEl)
      .setName("Target folder")
      .setDesc(
        "Created if it doesn't exist — use / for subfolders (e.g. Areas/Books). " +
          "One note per CSV row. Type to autocomplete."
      )
      .addText((t) => {
        t.setValue("CSV Import");
        this.folderEl = t.inputEl;
        new ListInputSuggest(this.plugin, t.inputEl, () => folderPaths(this.plugin));
      });

    new Setting(contentEl)
      .setName("Note body template")
      .setDesc(
        createFragment((f) => {
          f.appendText("Optional Markdown placed below the frontmatter. Write ");
          f.createEl("code", { text: "{{Column Header}}" });
          f.appendText(
            " to insert that column's value for each row — the name must match a CSV header exactly (case-sensitive, spaces allowed). Any column works, even ones you didn't include as a property; an unknown placeholder becomes empty. Which column becomes each note's title is set by the “Filename” radio in the column table below."
          );
        })
      )
      .addTextArea((t) => {
        t.setPlaceholder("e.g. Imported from {{Source}} on {{Date}}");
        this.templateEl = t.inputEl;
      });

    new Setting(contentEl)
      .setName("Omit empty values")
      .setDesc("Blank cells leave the property out of that note entirely.")
      .addToggle((t) => t.setValue(this.omitEmpty).onChange((v) => (this.omitEmpty = v)));

    new Setting(contentEl)
      .setName("If a note already exists")
      .setDesc("Collision policy against existing vault notes and duplicate rows.")
      .addDropdown((dd) => {
        dd.addOption("suffix", "Create with -2, -3 suffix");
        dd.addOption("skip", "Skip the row");
        dd.addOption("overwrite", "Overwrite the note");
        dd.setValue(this.collision);
        dd.onChange((v) => (this.collision = v as CollisionPolicy));
      });

    new Setting(contentEl)
      .setName("Create a .base file")
      .setDesc("Adds a table view over the imported folder with the included columns.")
      .addToggle((t) =>
        t.setValue(this.makeBase).onChange((v) => {
          this.makeBase = v;
          // Only offer the base-name field when a base will actually be created.
          this.baseNameSetting?.settingEl.toggle(v);
        })
      );

    this.baseNameSetting = new Setting(contentEl)
      .setName("Base file name")
      .setDesc("Leave blank to name it after the folder. A “.base” extension is added automatically.")
      .addText((t) => {
        t.setPlaceholder("Leave blank to name after folder");
        this.baseNameEl = t.inputEl;
      });
    this.baseNameSetting.settingEl.toggle(this.makeBase);

    new Setting(contentEl).addButton((b) => {
      b.setButtonText("Import").setCta().setDisabled(true).onClick(() => void this.doImport());
      this.importBtn = b;
    });
  }

  /** Loads a dropped/picked file into the textarea, rejecting binary spreadsheets. */
  private loadFile(file: File): void {
    if (/\.(xlsx?|numbers|ods|gsheet|sheet)$/i.test(file.name)) {
      new Notice(
        `“${file.name}” is a spreadsheet, not a CSV. Export it to CSV or TSV (File → Export / Save As) and drop that.`
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const ta = this.taEl;
      if (!ta) return;
      ta.value = String(reader.result ?? "");
      this.parse(ta.value);
    };
    reader.readAsText(file);
  }

  private parse(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      this.lastHeaderKey = "";
      this.setStatus("Waiting for CSV input…", false);
      return;
    }
    const rows = parseCSV(trimmed);
    if (rows.length < 2) {
      this.lastHeaderKey = "";
      this.setStatus("Need at least a header row and one data row.", false);
      return;
    }
    this.headers = rows[0];
    this.rows = rows.slice(1);
    const headerKey = JSON.stringify(this.headers);
    if (headerKey !== this.lastHeaderKey) {
      this.lastHeaderKey = headerKey;
      this.columns = this.headers.map((h, i) => ({
        header: h,
        include: true,
        propName: toPropertyName(h),
        type: guessType(h, this.rows.slice(0, 5).map((r) => r[i] ?? "")),
      }));
      this.filenameCol = 0;
      this.renderMapping();
    }
    this.previewRow = Math.min(this.previewRow, this.rows.length - 1);
    this.renderPreview();

    const ambiguous = this.columns.reduce((total, col, i) => {
      if (col.type !== "date") return total;
      return total + countAmbiguousDates(this.rows.map((r) => r[i] ?? ""));
    }, 0);
    this.setStatus(
      `${this.rows.length} row${this.rows.length === 1 ? "" : "s"} detected.` +
        (ambiguous
          ? ` ⚠ ${ambiguous} ambiguous date${ambiguous === 1 ? "" : "s"} (M/D vs D/M) will be read as US M/D/YYYY.`
          : ""),
      true
    );
  }

  private setStatus(msg: string, ready: boolean): void {
    this.statusEl?.setText(msg);
    this.importBtn?.setDisabled(!ready);
    if (!ready) {
      this.mappingEl?.empty();
      this.previewEl?.empty();
    }
  }

  private includedCount(): number {
    return this.columns.filter((c) => c.include && c.propName).length;
  }

  private updateSelectAll(): void {
    if (!this.selectAllEl) return;
    const n = this.columns.filter((c) => c.include).length;
    this.selectAllEl.checked = n === this.columns.length;
    this.selectAllEl.indeterminate = n > 0 && n < this.columns.length;
  }

  private renderMapping(): void {
    const root = this.mappingEl;
    if (!root) return;
    root.empty();
    const table = root.createEl("table", { cls: "bases-toolbox-csv-table" });
    const head = table.createEl("tr");
    const selectAllTh = head.createEl("th");
    this.selectAllEl = selectAllTh.createEl("input", { type: "checkbox" });
    this.selectAllEl.checked = true;
    this.selectAllEl.setAttribute("aria-label", "Include all columns");
    this.selectAllEl.addEventListener("change", () => {
      const on = this.selectAllEl?.checked ?? true;
      this.columns.forEach((c) => (c.include = on));
      this.renderMapping();
      this.renderPreview();
    });
    for (const h of ["CSV column", "Property", "Type", "Filename"]) head.createEl("th", { text: h });

    this.columns.forEach((col, i) => {
      const tr = table.createEl("tr");
      const inc = tr.createEl("td").createEl("input", { type: "checkbox" });
      inc.checked = col.include;
      inc.addEventListener("change", () => {
        col.include = inc.checked;
        this.updateSelectAll();
        this.renderPreview();
      });
      const nameTd = tr.createEl("td");
      nameTd.createDiv({ text: col.header });
      // sample value under the original column name makes type choices obvious
      nameTd.createDiv({
        cls: "bases-toolbox-index-empty",
        text: this.rows[0]?.[i]?.slice(0, 40) ?? "",
      });
      const name = tr.createEl("td").createEl("input", {
        type: "text",
        attr: { placeholder: "Property Name" },
      });
      name.value = col.propName;
      name.addEventListener("input", () => {
        col.propName = name.value.trim();
        this.renderPreview();
      });
      const sel = tr.createEl("td").createEl("select");
      for (const t of CSV_TYPES) sel.createEl("option", { text: t, value: t });
      sel.value = col.type;
      sel.addEventListener("change", () => {
        col.type = sel.value as CsvType;
        this.renderPreview();
      });
      const radio = tr.createEl("td").createEl("input", {
        type: "radio",
        attr: { name: "bt-filename-col" },
      });
      radio.checked = i === this.filenameCol;
      radio.addEventListener("change", () => {
        this.filenameCol = i;
        this.renderPreview();
      });
    });
    this.updateSelectAll();
  }

  /** Builds one row's frontmatter object from the current column config. */
  private rowToFm(row: string[]): Record<string, unknown> {
    const fm: Record<string, unknown> = {};
    for (const [i, col] of this.columns.entries()) {
      if (!col.include || !col.propName) continue;
      const value = cellToValue(row[i] ?? "", col.type);
      if (value === null && this.omitEmpty) continue;
      fm[col.propName] = value;
    }
    return fm;
  }

  private rowBody(row: string[]): string {
    const template = this.templateEl?.value ?? "";
    if (!template.trim()) return "";
    return template.replace(/\{\{([^}]+)\}\}/g, (_, name: string) => {
      const i = this.headers.findIndex((h) => h.trim() === name.trim());
      return i === -1 ? "" : (row[i] ?? "");
    });
  }

  private renderPreview(): void {
    const root = this.previewEl;
    if (!root || !this.rows.length) return;
    root.empty();
    if (!this.includedCount()) {
      root.createDiv({ cls: "bases-toolbox-fr-warning", text: "No columns included — nothing to import." });
      this.importBtn?.setDisabled(true);
      return;
    }
    this.importBtn?.setDisabled(false);

    const row = this.rows[this.previewRow];
    const nav = root.createDiv({ cls: "bases-toolbox-csv-preview-nav" });
    const prev = nav.createEl("button", { text: "←" });
    prev.disabled = this.previewRow === 0;
    prev.addEventListener("click", () => {
      this.previewRow--;
      this.renderPreview();
    });
    nav.createSpan({
      cls: "bases-toolbox-fr-info",
      text: ` Preview row ${this.previewRow + 1} of ${this.rows.length} `,
    });
    const next = nav.createEl("button", { text: "→" });
    next.disabled = this.previewRow >= this.rows.length - 1;
    next.addEventListener("click", () => {
      this.previewRow++;
      this.renderPreview();
    });

    const filename = sanitizeFilename(row[this.filenameCol] ?? `note-${this.previewRow + 1}`);
    const fm = this.rowToFm(row);
    const body = this.rowBody(row);
    root.createEl("pre", {
      cls: "bases-toolbox-csv-preview",
      text:
        `# ${filename}.md\n` +
        (Object.keys(fm).length ? `---\n${stringifyYaml(fm)}---\n` : "") +
        (body ? `\n${body}\n` : ""),
    });
  }

  private async doImport(): Promise<void> {
    if (this.running) return;
    if (!this.includedCount()) {
      new Notice("Include at least one column first.");
      return;
    }
    this.running = true;
    try {
      const folder = normalizePath(this.folderEl?.value.trim() || "CSV Import");
      if (!(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
        await this.app.vault.createFolder(folder);
      }

      // Set-probe suffixing: the naive counter approach collides on
      // Alpha, Alpha, Alpha-2 (two files named Alpha-2). Probe until free,
      // against both this batch and existing vault files.
      const usedNames = new Set<string>();
      let created = 0;
      let overwritten = 0;
      let skipped = 0;
      for (const [idx, row] of this.rows.entries()) {
        const base = sanitizeFilename(row[this.filenameCol] ?? `note-${idx + 1}`);
        let name = base;
        const taken = (n: string) =>
          usedNames.has(n) || !!this.app.vault.getAbstractFileByPath(`${folder}/${n}.md`);

        let existingHit = false;
        if (taken(name)) {
          if (this.collision === "skip") {
            skipped++;
            continue;
          }
          if (this.collision === "overwrite") existingHit = true;
          else {
            let n = 2;
            while (taken(`${base}-${n}`)) n++;
            name = `${base}-${n}`;
          }
        }
        usedNames.add(name);

        const fm = this.rowToFm(row);
        const body = this.rowBody(row);
        const content =
          (Object.keys(fm).length ? `---\n${stringifyYaml(fm)}---\n` : "") +
          (body ? `\n${body}\n` : "");
        const path = `${folder}/${name}.md`;
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existingHit && existing instanceof TFile) {
          await this.app.vault.modify(existing, content);
          overwritten++;
        } else {
          await this.app.vault.create(path, content);
          created++;
        }
      }

      let baseNote = "";
      if (this.makeBase) {
        const folderName = folder.split("/").pop() ?? folder;
        // Blank name → default to the folder name. Sanitise either way so a typed
        // name can't smuggle in path separators or illegal characters.
        const baseName = sanitizeFilename(this.baseNameEl?.value.trim() || folderName) || folderName;
        const basePath = `${folder}/${baseName}.base`;
        // Non-destructive: if a base with this name already exists in the folder,
        // reuse it (the imported notes join it via the folder filter) rather than
        // overwrite it or spawn a "-2" duplicate. Just report which happened.
        if (this.app.vault.getAbstractFileByPath(basePath)) {
          baseNote = `, base "${baseName}" already existed`;
        } else {
          const order = [
            "file.name",
            ...this.columns.filter((c) => c.include && c.propName).map((c) => c.propName),
          ];
          const baseDoc = {
            filters: { and: [`file.inFolder("${folder}")`, 'file.ext == "md"'] },
            views: [{ type: "table", name: "Table", order }],
          };
          await this.app.vault.create(basePath, stringifyYaml(baseDoc));
          baseNote = `, base "${baseName}"`;
        }
      }
      new Notice(
        `Imported ${created} note${created === 1 ? "" : "s"} into "${folder}"` +
          (overwritten ? `, overwrote ${overwritten}` : "") +
          (skipped ? `, skipped ${skipped}` : "") +
          baseNote +
          "."
      );
      this.onDone?.();
    } catch (e) {
      new Notice(`Import failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.running = false;
    }
  }
}

export { CsvImportPanel };

/** CSV import as a dialog — thin wrapper over the shared panel. */
export class CsvImportModal extends Modal {
  private plugin: BasesToolboxPlugin;

  constructor(plugin: BasesToolboxPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.setText("Import CSV as notes");
    this.modalEl.addClass("bases-toolbox-csv-modal");
    new CsvImportPanel(this.plugin, () => this.close()).render(this.contentEl);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
