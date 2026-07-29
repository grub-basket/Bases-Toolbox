import { ButtonComponent, FileSystemAdapter, Menu, Modal, Notice, Platform, Setting, TFile, TFolder, normalizePath, parseYaml, setIcon, stringifyYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { folderPaths } from "./csv-export";
import { findKey } from "./scan";
import { ChangeRecord } from "./types";
import { ListInputSuggest } from "./suggest";
import {
  CSV_TYPES,
  CsvType,
  cellToValue,
  countAmbiguousDates,
  guessType,
  parseCSV,
  parseList,
  sanitizeFilename,
  toPropertyName,
} from "./csv-core";

type InputFormat = "auto" | "table" | "list";

/** Lucide icon per importer property type, for the type dropdown. */
const CSV_TYPE_ICONS: Record<string, string> = {
  text: "type",
  number: "hash",
  date: "calendar",
  boolean: "square-check",
  list: "list",
  link: "link",
};

interface ColumnConfig {
  header: string;
  include: boolean;
  propName: string;
  type: CsvType;
}

type CollisionPolicy = "suffix" | "skip" | "overwrite" | "update";

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
  private inputFormat: InputFormat = "auto";

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
  /** Live "will create / will reuse" hint under the base-name field. */
  private refreshBaseHint: () => void = () => {};
  private selectAllEl: HTMLInputElement | null = null;
  private importBtn: ButtonComponent | null = null;
  private progressEl: HTMLProgressElement | null = null;
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
      attr: { placeholder: "Paste a CSV/TSV table, or a list (records separated by blank lines), or drop a file below…" },
    });
    this.taEl = ta;
    ta.addEventListener("input", () => this.parse(ta.value));

    new Setting(contentEl)
      .setName("Input format")
      .setDesc(
        "Table = CSV/TSV with a header row. List = records separated by blank lines (each record's lines become columns you name below) — e.g. pasted title/URL pairs."
      )
      .addDropdown((dd) => {
        dd.addOption("auto", "Auto-detect");
        dd.addOption("table", "Table (CSV / TSV)");
        dd.addOption("list", "List (blank-line records)");
        dd.setValue(this.inputFormat);
        dd.onChange((v) => {
          this.inputFormat = v as InputFormat;
          this.lastHeaderKey = ""; // force a column rebuild for the new format
          if (this.taEl) this.parse(this.taEl.value);
        });
      });

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
      .setDesc("Collision policy against existing vault notes and duplicate rows. “Update” maps the imported columns onto the existing note\u2019s properties (blank cells never clear a value, the body is untouched) — re-import a sheet with new columns to enrich notes in place. Undoable from history.")
      .addDropdown((dd) => {
        dd.addOption("suffix", "Create with -2, -3 suffix");
        dd.addOption("skip", "Skip the row");
        dd.addOption("overwrite", "Overwrite the note");
        dd.addOption("update", "Update the note — merge properties, keep the body");
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
          this.refreshBaseHint();
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

    // Live hint so the reuse-vs-create outcome is clear BEFORE importing (the
    // completion Notice says the same thing after the fact).
    const baseHint = contentEl.createDiv({ cls: "bases-toolbox-fr-info bases-toolbox-import-basehint" });
    this.refreshBaseHint = () => {
      if (!this.makeBase) {
        baseHint.toggle(false);
        return;
      }
      baseHint.toggle(true);
      const folder = normalizePath(this.folderEl?.value.trim() || "CSV Import");
      const folderName = folder.split("/").pop() ?? folder;
      const name = sanitizeFilename(this.baseNameEl?.value.trim() || folderName) || folderName;
      const exists = this.app.vault.getAbstractFileByPath(`${folder}/${name}.base`);
      baseHint.setText(
        exists
          ? `A base “${name}.base” already exists in “${folder}” — it’ll be reused (not overwritten); the imported notes just join it.`
          : `Will create “${name}.base” in “${folder}”.`
      );
    };
    this.baseNameEl?.addEventListener("input", this.refreshBaseHint);
    this.folderEl?.addEventListener("input", this.refreshBaseHint);
    this.refreshBaseHint();

    new Setting(contentEl).addButton((b) => {
      b.setButtonText("Import").setCta().setDisabled(true).onClick(() => void this.doImport());
      this.importBtn = b;
    });

    // Progress bar, shown only while an import runs.
    this.progressEl = contentEl.createEl("progress", { cls: "bases-toolbox-csv-progress" });
    this.progressEl.hide();
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

  /** Whether to parse the current text as a blank-line list vs a CSV/TSV table. */
  private useListFormat(trimmed: string): boolean {
    if (this.inputFormat === "list") return true;
    if (this.inputFormat === "table") return false;
    // Auto: a list when the delimiter sniff finds no real table (single column)
    // AND the text has blank-line-separated blocks.
    const csvCols = parseCSV(trimmed)[0]?.length ?? 1;
    return csvCols < 2 && /\r?\n[ \t]*\r?\n/.test(trimmed);
  }

  private parse(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      this.lastHeaderKey = "";
      this.setStatus("Waiting for input…", false);
      return;
    }

    const list = this.useListFormat(trimmed);
    let headers: string[];
    let rows: string[][];
    if (list) {
      ({ headers, rows } = parseList(trimmed));
      if (!rows.length) {
        this.lastHeaderKey = "";
        this.setStatus("No list records found — separate records with a blank line.", false);
        return;
      }
    } else {
      const parsed = parseCSV(trimmed);
      if (parsed.length < 2) {
        this.lastHeaderKey = "";
        this.setStatus("Need at least a header row and one data row.", false);
        return;
      }
      headers = parsed[0];
      rows = parsed.slice(1);
    }

    this.headers = headers;
    this.rows = rows;
    // Key includes the mode so flipping table↔list rebuilds the column config.
    const headerKey = JSON.stringify([list, headers]);
    if (headerKey !== this.lastHeaderKey) {
      this.lastHeaderKey = headerKey;
      this.columns = headers.map((h, i) => ({
        header: h,
        include: true,
        propName: toPropertyName(h),
        type: guessType(h, rows.slice(0, 5).map((r) => r[i] ?? "")),
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
    const ambiguousSuffix = ambiguous
      ? ` ⚠ ${ambiguous} ambiguous date${ambiguous === 1 ? "" : "s"} (M/D vs D/M) will be read as US M/D/YYYY.`
      : "";
    this.setStatus(
      list
        ? `${rows.length} record${rows.length === 1 ? "" : "s"} detected as a list (${headers.length} column${headers.length === 1 ? "" : "s"}). Name the columns below.${ambiguousSuffix}`
        : `${rows.length} row${rows.length === 1 ? "" : "s"} detected.${ambiguousSuffix}`,
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

    // Bulk type controls: set every column to one type at once, or re-run the
    // auto-detection (which doubles as "undo" a bulk override).
    const bulk = root.createDiv({ cls: "bases-toolbox-csv-bulk" });
    bulk.createSpan({ text: "Set all columns to:" });
    this.typeDropdown(bulk, null, (t) => {
      this.columns.forEach((c) => (c.type = t));
      this.renderMapping();
      this.renderPreview();
    });
    const redetect = bulk.createEl("button", { text: "Re-detect types" });
    redetect.setAttribute("aria-label", "Re-run automatic type detection on every column");
    redetect.addEventListener("click", () => {
      this.columns.forEach((c, i) => {
        c.type = guessType(c.header, this.rows.slice(0, 5).map((r) => r[i] ?? ""));
      });
      this.renderMapping();
      this.renderPreview();
    });

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
      this.typeDropdown(tr.createEl("td"), col.type, (t) => {
        col.type = t;
        this.renderMapping();
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

  /**
   * Update-mode merge: maps the included columns onto an existing note's
   * frontmatter. The body is never touched, a blank cell never clears an
   * existing value, and every change is recorded so the whole import is
   * revertible from history. Existing keys match case-insensitively (findKey),
   * same as the rest of the plugin's frontmatter surgery.
   */
  private async mergeIntoExisting(file: TFile, row: string[]): Promise<ChangeRecord[]> {
    const changes: ChangeRecord[] = [];
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      for (const [i, col] of this.columns.entries()) {
        if (!col.include || !col.propName) continue;
        const value = cellToValue(row[i] ?? "", col.type);
        if (value === null) continue; // blank cell → leave whatever is there
        const key = findKey(fm, col.propName) ?? col.propName;
        const cur = Object.prototype.hasOwnProperty.call(fm, key) ? fm[key] : undefined;
        if (JSON.stringify(cur) === JSON.stringify(value)) continue; // already right
        changes.push({
          path: file.path,
          property: col.propName,
          oldValue: cur === undefined ? undefined : Array.isArray(cur) ? cur.slice() : cur,
          newValue: Array.isArray(value) ? value.slice() : value,
          ...(cur === undefined ? { created: true } : {}),
        });
        fm[key] = value;
      }
    });
    return changes;
  }

  /**
   * Update-mode base refresh: appends the included property columns to the
   * reused base's views so newly-imported columns actually show. Only views
   * with an explicit `order` are touched (fabricating one would hide the
   * other columns), and both bare and `note.`-prefixed spellings are treated
   * as already-present. Returns how many columns were added.
   */
  private async addColumnsToBase(basePath: string): Promise<number> {
    const baseFile = this.app.vault.getAbstractFileByPath(basePath);
    if (!(baseFile instanceof TFile)) return 0;
    let added = 0;
    try {
      const doc = (parseYaml(await this.app.vault.read(baseFile)) ?? {}) as Record<string, unknown>;
      const views = (Array.isArray(doc.views) ? doc.views : []) as Record<string, unknown>[];
      const props = this.columns.filter((c) => c.include && c.propName).map((c) => c.propName);
      const addedNames = new Set<string>();
      for (const view of views) {
        if (!Array.isArray(view.order)) continue;
        const order = view.order as unknown[];
        for (const p of props) {
          if (order.includes(p) || order.includes(`note.${p}`)) continue;
          order.push(p);
          addedNames.add(p);
        }
      }
      if (addedNames.size) await this.app.vault.modify(baseFile, stringifyYaml(doc));
      added = addedNames.size;
    } catch (e) {
      console.error("[Bases Toolbox] Could not add imported columns to the base.", e);
    }
    return added;
  }

  /**
   * An icon dropdown for choosing a property type. A native <select> can't
   * render SVG icons in its options, so this is a clickable pill (icon + label)
   * that opens an Obsidian Menu — each type shown with its own icon, the current
   * one checked. `current` is null for the "set all" control (shows a neutral
   * placeholder and never marks a selection).
   */
  private typeDropdown(
    parent: HTMLElement,
    current: CsvType | null,
    onPick: (t: CsvType) => void
  ): void {
    const pill = parent.createDiv({ cls: "bases-toolbox-csv-type" });
    const icon = pill.createSpan({ cls: "bases-toolbox-csv-type-icon" });
    setIcon(icon, current ? CSV_TYPE_ICONS[current] : "list-plus");
    pill.createSpan({ cls: "bases-toolbox-csv-type-label", text: current ?? "set type…" });
    setIcon(pill.createSpan({ cls: "bases-toolbox-csv-type-chev" }), "chevron-down");
    pill.setAttribute("aria-label", "Property type");
    pill.addEventListener("click", (e) => {
      const menu = new Menu();
      for (const t of CSV_TYPES) {
        menu.addItem((item) => {
          item
            .setTitle(t)
            .setIcon(CSV_TYPE_ICONS[t])
            .setChecked(t === current)
            .onClick(() => onPick(t));
        });
      }
      menu.showAtMouseEvent(e);
    });
  }

  /**
   * A raw-filesystem writer for NEW files, or null when unavailable.
   *
   * `vault.create` indexes each file inline (build a TFile, fire events, parse
   * frontmatter) — the real cost of a big import. Writing straight to disk and
   * letting Obsidian's watcher index the notes afterward makes the WRITE phase
   * ~36× faster (measured), so a 12k-row import stops blocking for minutes: the
   * files land in ~a second and the base fills in as indexing catches up in the
   * background. Desktop only (mobile has no Node fs → falls back to the vault).
   * New files only — overwrite/update touch already-indexed files and stay on
   * the vault path.
   *
   * The catch that makes or breaks it: the writes must be issued in LARGE
   * concurrent chunks (see RAW_WRITE_CHUNK). With small chunks the loop yields
   * between each batch, the watcher grabs the main thread to index, and the
   * speedup vanishes.
   */
  private rawWriter(): ((absPath: string, data: string) => Promise<void>) | null {
    if (!Platform.isDesktopApp) return null;
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) return null;
    const req = (window as unknown as { require?: (m: string) => unknown }).require;
    const fs = req?.("fs") as { promises?: { writeFile?: (p: string, d: string) => Promise<void> } } | undefined;
    const writeFile = fs?.promises?.writeFile;
    return writeFile ? (absPath, data) => writeFile(absPath, data) : null;
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
    // Disable the button + show progress so a slow import can't be double-fired.
    this.importBtn?.setDisabled(true);
    const total = this.rows.length;
    if (this.progressEl) {
      this.progressEl.max = total;
      this.progressEl.value = 0;
      this.progressEl.show();
    }
    const progressNotice = new Notice(`[Bases Toolbox] Importing 0/${total}…`, 0);
    const reportProgress = (done: number) => {
      if (this.progressEl) this.progressEl.value = done;
      progressNotice.setMessage(`[Bases Toolbox] Importing ${done}/${total}…`);
    };
    try {
      const folder = normalizePath(this.folderEl?.value.trim() || "CSV Import");
      if (!(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
        await this.app.vault.createFolder(folder);
      }

      // PHASE 1 — resolve every row serially into a job (cheap: name probing,
      // frontmatter build). Keeping this serial makes suffixing deterministic
      // (the "Alpha, Alpha, Alpha-2" set-probe collision) and lets phase 2 run
      // the expensive disk writes concurrently without racing on names.
      type Job =
        | { kind: "create"; path: string; content: string }
        | { kind: "overwrite"; file: TFile; content: string }
        | { kind: "update"; file: TFile; row: string[] };
      const usedNames = new Set<string>();
      const jobs: Job[] = [];
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
          if (this.collision === "update") {
            const existing = this.app.vault.getAbstractFileByPath(`${folder}/${name}.md`);
            if (existing instanceof TFile) {
              usedNames.add(name);
              jobs.push({ kind: "update", file: existing, row });
              continue;
            }
          }
          if (this.collision === "overwrite") existingHit = true;
          else if (this.collision !== "update") {
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
          jobs.push({ kind: "overwrite", file: existing, content });
        } else {
          jobs.push({ kind: "create", path, content });
        }
      }

      // PHASE 2 — execute the writes. New files are the bulk of an import and
      // take the raw-burst fast path (see rawWriter); mutations go through the
      // vault. Counters/pushes are safe: JS is single-threaded, so ++ never races.
      let created = 0;
      let overwritten = 0;
      let updated = 0;
      let deferredIndex = false;
      const updateChanges: ChangeRecord[] = [];
      let done = 0;
      const bump = (n: number) => {
        done += n;
        reportProgress(done);
      };

      // Mutations (update-merge, overwrite) touch already-indexed files, so they
      // go through the vault; modest concurrency over independent files.
      const mutateJobs = jobs.filter((j) => j.kind !== "create");
      const MUTATE_CONC = 16;
      for (let i = 0; i < mutateJobs.length; i += MUTATE_CONC) {
        const chunk = mutateJobs.slice(i, i + MUTATE_CONC);
        await Promise.all(
          chunk.map(async (job) => {
            if (job.kind === "update") {
              const rowChanges = await this.mergeIntoExisting(job.file, job.row);
              if (rowChanges.length) {
                updateChanges.push(...rowChanges);
                updated++;
              }
            } else if (job.kind === "overwrite") {
              await this.app.vault.modify(job.file, job.content);
              overwritten++;
            }
          })
        );
        bump(chunk.length);
      }

      const createJobs = jobs.filter(
        (j): j is Extract<typeof j, { kind: "create" }> => j.kind === "create"
      );
      const rawWrite = this.rawWriter();
      const adapter = this.app.vault.adapter;
      if (rawWrite && adapter instanceof FileSystemAdapter) {
        // Raw-write NEW files with a bounded WORKER POOL — the key to the speedup.
        // A chunked `await Promise.all(batch)` fully drains the microtask queue
        // between batches, which lets Obsidian's file watcher (a macrotask) run
        // and index that batch inline — that indexing, not the write, is what
        // made the "fast" path slow. A worker pool keeps writes continuously in
        // flight so the microtask queue never empties, starving the watcher until
        // every file is on disk (measured: 3000 files in ~0.4s vs ~8s chunked).
        // Indexing then happens in the background while the base fills in. No
        // progress bumps mid-pool for the same reason (a DOM touch yields too).
        deferredIndex = createJobs.length > 0;
        let next = 0;
        const worker = async () => {
          while (next < createJobs.length) {
            const job = createJobs[next++];
            await rawWrite(adapter.getFullPath(job.path), job.content);
            created++;
          }
        };
        const RAW_POOL = 128; // in-flight writes: fast, bounded well under FD limits
        await Promise.all(Array.from({ length: Math.min(RAW_POOL, createJobs.length) }, worker));
        bump(createJobs.length);
      } else {
        // Mobile / no adapter: vault.create indexes inline, so this can't burst —
        // just run it concurrently for the modest overlap win.
        const CONC = 16;
        for (let i = 0; i < createJobs.length; i += CONC) {
          const chunk = createJobs.slice(i, i + CONC);
          await Promise.all(chunk.map((job) => this.app.vault.create(job.path, job.content)));
          created += chunk.length;
          bump(chunk.length);
        }
      }

      let baseNote = "";
      let basePath = "";
      if (this.makeBase) {
        const folderName = folder.split("/").pop() ?? folder;
        // Blank name → default to the folder name. Sanitise either way so a typed
        // name can't smuggle in path separators or illegal characters.
        const baseName = sanitizeFilename(this.baseNameEl?.value.trim() || folderName) || folderName;
        basePath = `${folder}/${baseName}.base`;
        // Non-destructive: if a base with this name already exists in the folder,
        // reuse it (the imported notes join it via the folder filter) rather than
        // overwrite it or spawn a "-2" duplicate. Just report which happened.
        if (this.app.vault.getAbstractFileByPath(basePath)) {
          // Update mode: the whole point is re-importing new columns onto an
          // existing folder+base, so surface those columns in the base too.
          const added = this.collision === "update" ? await this.addColumnsToBase(basePath) : 0;
          baseNote = added
            ? `, base "${baseName}" gained ${added} column${added === 1 ? "" : "s"}`
            : `, base "${baseName}" already existed`;
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
      // Updates are undoable in one step from the bulk file change history.
      if (updateChanges.length) {
        await this.plugin.addHistoryEntry({
          property: "CSV update",
          find: null,
          replace: `merged imported columns into ${updated} note${updated === 1 ? "" : "s"}`,
          timestamp: Date.now(),
          changes: updateChanges,
          source: "csv import update",
        });
      }
      progressNotice.hide();
      const summary =
        `Imported ${created} note${created === 1 ? "" : "s"} into "${folder}"` +
        (updated ? `, updated ${updated} existing` : "") +
        (overwritten ? `, overwrote ${overwritten}` : "") +
        (skipped ? `, skipped ${skipped}` : "") +
        baseNote +
        ".";
      // When new notes were raw-written, Obsidian still has to index them (that's
      // the real floor) — it happens in the background and the base fills in as it
      // goes. Keep the notice PERSISTENT so that message doesn't vanish first.
      // Large vault.create imports also get a persistent notice (the big base
      // takes a moment to render). Small imports auto-dismiss.
      const big = created + updated + overwritten > 500;
      const persistent = deferredIndex || big;
      const summaryFull = deferredIndex
        ? summary +
          " The notes are written — Obsidian is now indexing them in the background, so your base will keep filling in over the next moments."
        : big
          ? summary + " A base this large can take a moment to finish rendering."
          : summary;
      const baseFile = basePath ? this.app.vault.getAbstractFileByPath(basePath) : null;
      // Auto-open the base when the import made/reused one — the user lands
      // straight on their data. New tab, so the importer view isn't clobbered.
      if (this.makeBase && baseFile instanceof TFile) {
        void this.app.workspace.getLeaf("tab").openFile(baseFile);
      }
      if (baseFile instanceof TFile) {
        new Notice(
          createFragment((f) => {
            f.createSpan({ text: `[Bases Toolbox] ${summaryFull}` });
            const btn = f.createEl("button", { cls: "bases-toolbox-notice-btn", text: "Open base" });
            btn.addEventListener("click", () => void this.app.workspace.getLeaf("tab").openFile(baseFile));
          }),
          persistent ? 0 : 15000
        );
      } else {
        new Notice(`[Bases Toolbox] ${summaryFull}`, persistent ? 0 : undefined);
      }
      this.onDone?.();
    } catch (e) {
      progressNotice.hide();
      new Notice(`[Bases Toolbox] Import failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.running = false;
      this.importBtn?.setDisabled(false);
      this.progressEl?.hide();
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
