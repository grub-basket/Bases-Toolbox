import { ButtonComponent, Debouncer, DropdownComponent, FileSystemAdapter, Menu, Modal, Notice, Platform, Setting, TFile, TFolder, ToggleComponent, debounce, normalizePath, parseYaml, setIcon, stringifyYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { folderPaths } from "./csv-export";
import { findKey } from "./scan";
import { ChangeRecord } from "./types";
import { ListInputSuggest } from "./suggest";
import { JsonStore } from "./store";
import { ConfirmModal } from "./property-delete";
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
  /** Update-mode conflict override for this column (undefined = follow the
   * global "when a property already has a different value" choice). */
  conflict?: "imported" | "existing";
}

type CollisionPolicy = "suffix" | "skip" | "overwrite" | "update";

/** Update mode: what happens when a property already holds a DIFFERENT value. */
type UpdateConflict = "imported" | "existing";

/**
 * A saved importer setup — everything except the pasted data — so a recurring
 * import (a provider roster re-imported every month) is one pick instead of
 * redoing the whole mapping. Column settings are matched to the current sheet
 * BY HEADER, and the filename column is remembered by header too, so a
 * re-exported sheet whose column order shifted still lines up.
 */
export interface ImportPreset {
  name: string;
  folder: string;
  template: string;
  collision: CollisionPolicy;
  updateConflict: UpdateConflict;
  makeBase: boolean;
  baseName: string;
  omitEmpty: boolean;
  inputFormat: InputFormat;
  filenameHeader: string;
  columns: ColumnConfig[];
}

/**
 * An in-progress import saved to disk so a crash / accidental close / mid-import
 * error doesn't lose the pasted data AND the whole column mapping — the actual
 * work. Cleared on a successful import; offered back on reopen.
 */
interface ImportDraft {
  text: string;
  folder: string;
  template: string;
  collision: CollisionPolicy;
  makeBase: boolean;
  baseName: string;
  omitEmpty: boolean;
  inputFormat: InputFormat;
  filenameCol: number;
  columns: ColumnConfig[];
  savedAt: number;
  updateConflict?: UpdateConflict;
  /** Row indices deselected in the row picker. */
  excludedRows?: number[];
}

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
  private updateConflict: UpdateConflict = "imported";
  private conflictSetting: Setting | null = null;
  private conflictDd: DropdownComponent | null = null;
  /** Row indices deselected in the row picker (reset when the data changes). */
  private excludedRows = new Set<number>();
  private rowsEl: HTMLElement | null = null;
  private rowSearch = "";
  private rowsOpen = true;
  /** Signature of the text at the last parse — ANY change invalidates the row
   * selection (indices only mean anything against the exact pasted data; a
   * stale deselection silently thinning a fresh paste is worse than re-ticking). */
  private lastRowSig = "";
  /** Preset chosen before any data was pasted — applied at first parse. */
  private pendingPreset: ImportPreset | null = null;
  private presetNameEl: HTMLInputElement | null = null;
  private presetDd: DropdownComponent | null = null;
  private makeBase = true;
  private baseNameEl: HTMLInputElement | null = null;
  private baseNameSetting: Setting | null = null;
  /** Live "will create / will reuse" hint under the base-name field. */
  private refreshBaseHint: () => void = () => {};
  private selectAllEl: HTMLInputElement | null = null;
  private importBtn: ButtonComponent | null = null;
  private progressEl: HTMLProgressElement | null = null;
  private running = false;
  // Component refs kept so a restored draft can update the visible controls.
  private collisionDd: DropdownComponent | null = null;
  private formatDd: DropdownComponent | null = null;
  private makeBaseToggle: ToggleComponent | null = null;
  private omitToggle: ToggleComponent | null = null;
  private restoreBarEl: HTMLElement | null = null;
  /** Suppresses draft autosave while a restore is being applied. */
  private restoring = false;
  private draftStore: JsonStore<Partial<ImportDraft>>;
  private scheduleDraftSave: Debouncer<[], void>;

  constructor(plugin: BasesToolboxPlugin, onDone?: () => void) {
    this.plugin = plugin;
    this.onDone = onDone;
    this.draftStore = new JsonStore<Partial<ImportDraft>>(plugin, "import-drafts/last.json", () => ({}));
    this.scheduleDraftSave = debounce(() => void this.saveDraftNow(), 800, false);
  }

  /** Captures the current form state into the draft file. */
  private async saveDraftNow(): Promise<void> {
    if (this.restoring) return;
    const text = this.taEl?.value ?? "";
    if (!text.trim()) return; // nothing worth saving
    const draft: ImportDraft = {
      text,
      folder: this.folderEl?.value ?? "",
      template: this.templateEl?.value ?? "",
      collision: this.collision,
      makeBase: this.makeBase,
      baseName: this.baseNameEl?.value ?? "",
      omitEmpty: this.omitEmpty,
      inputFormat: this.inputFormat,
      filenameCol: this.filenameCol,
      columns: this.columns,
      savedAt: Date.now(),
      updateConflict: this.updateConflict,
      excludedRows: [...this.excludedRows],
    };
    await this.draftStore.save(draft);
  }

  private async clearDraft(): Promise<void> {
    this.scheduleDraftSave.cancel(); // drop any queued save so it can't resurrect the draft
    await this.draftStore.save({});
  }

  /** If a saved draft exists, shows a restore bar above the form. */
  private async offerRestore(container: HTMLElement): Promise<void> {
    const draft = await this.draftStore.load();
    if (!draft.text || !draft.text.trim()) return;
    if (this.taEl?.value.trim()) return; // user already typing — don't nag
    this.restoreBarEl?.remove();
    const bar = container.createDiv({ cls: "bases-toolbox-import-restore" });
    this.restoreBarEl = bar;
    const rows = (draft.text.match(/\n/g)?.length ?? 0) + 1;
    const when = draft.savedAt ? new Date(draft.savedAt).toLocaleString() : "earlier";
    bar.createSpan({ text: `Unfinished import from ${when} (~${rows} lines). ` });
    const restore = bar.createEl("button", { cls: "mod-cta", text: "Restore" });
    restore.addEventListener("click", () => this.restoreDraft(draft as ImportDraft));
    const dismiss = bar.createEl("button", { text: "Discard" });
    dismiss.addEventListener("click", () => void (async () => {
      await this.draftStore.save({});
      bar.remove();
    })());
  }

  /**
   * Restore, but never silently clobber work in progress. If the importer
   * already has (different) content — e.g. the user ignored the bar and started
   * a new/retried import — confirm before replacing it. When the field is empty
   * (the common "just reopened" case) it applies straight away.
   */
  private restoreDraft(d: ImportDraft): void {
    const current = this.taEl?.value.trim() ?? "";
    if (current && current !== d.text.trim()) {
      new ConfirmModal(this.plugin, {
        title: "Replace the current import?",
        body: "You've already started an import here. Restoring the saved draft will replace what's in the importer now.",
        confirmText: "Replace with saved draft",
        danger: true,
        onConfirm: () => this.applyDraft(d),
      }).open();
      return;
    }
    this.applyDraft(d);
  }

  /** Applies a saved draft back into the live form. */
  private applyDraft(d: ImportDraft): void {
    this.restoring = true;
    try {
      if (this.taEl) this.taEl.value = d.text;
      if (this.folderEl) this.folderEl.value = d.folder;
      if (this.templateEl) this.templateEl.value = d.template;
      if (this.baseNameEl) this.baseNameEl.value = d.baseName;
      this.collision = d.collision;
      this.collisionDd?.setValue(d.collision);
      this.updateConflict = d.updateConflict ?? "imported";
      this.conflictDd?.setValue(this.updateConflict);
      this.conflictSetting?.settingEl.toggle(d.collision === "update");
      this.inputFormat = d.inputFormat;
      this.formatDd?.setValue(d.inputFormat);
      this.makeBase = d.makeBase;
      this.makeBaseToggle?.setValue(d.makeBase);
      this.baseNameSetting?.settingEl.toggle(d.makeBase);
      this.omitEmpty = d.omitEmpty;
      this.omitToggle?.setValue(d.omitEmpty);
      this.lastHeaderKey = ""; // force a column rebuild for this text
      this.parse(d.text);
      // Overlay the saved column mapping onto the freshly-parsed columns when the
      // shape matches (same headers), so renamed props / chosen types come back.
      if (
        d.columns.length === this.columns.length &&
        d.columns.every((c, i) => c.header === this.columns[i].header)
      ) {
        this.columns = d.columns;
        this.filenameCol = Math.min(d.filenameCol, this.columns.length - 1);
        this.renderMapping();
        this.renderPreview();
      }
      // Row selection comes back too — parse() cleared it (row indices are
      // only meaningful against this exact text, which the draft carries).
      this.excludedRows = new Set((d.excludedRows ?? []).filter((i) => i < this.rows.length));
      this.renderRows();
      this.refreshBaseHint();
      this.restoreBarEl?.remove();
      this.restoreBarEl = null;
    } finally {
      this.restoring = false;
    }
  }

  private get app() {
    return this.plugin.app;
  }

  render(contentEl: HTMLElement): void {
    this.renderPresetBar(contentEl);
    const ta = contentEl.createEl("textarea", {
      cls: "bases-toolbox-csv-input",
      attr: { placeholder: "Paste a CSV/TSV table, or a list (records separated by blank lines), or drop a file below…" },
    });
    this.taEl = ta;
    ta.addEventListener("input", () => this.parse(ta.value));

    // Autosave the whole form (input text + mapping config) so a crash / close
    // doesn't lose the work. One listener on the container catches every text
    // input, select and checkbox; parse()/renderMapping cover the rest.
    contentEl.addEventListener("input", () => this.scheduleDraftSave());
    contentEl.addEventListener("change", () => this.scheduleDraftSave());
    // Offer to restore a previous unfinished import (async — inserts a bar).
    void this.offerRestore(contentEl);

    new Setting(contentEl)
      .setName("Input format")
      .setDesc(
        "Table = CSV/TSV with a header row. List = records separated by blank lines (each record's lines become columns you name below) — e.g. pasted title/URL pairs."
      )
      .addDropdown((dd) => {
        this.formatDd = dd;
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
    this.rowsEl = contentEl.createDiv();
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
      .addToggle((t) => {
        this.omitToggle = t;
        t.setValue(this.omitEmpty).onChange((v) => (this.omitEmpty = v));
      });

    new Setting(contentEl)
      .setName("If a note already exists")
      .setDesc("Collision policy against existing vault notes and duplicate rows. “Update” maps the imported columns onto the existing note\u2019s properties (blank cells never clear a value, the body is untouched) — re-import a sheet with new columns to enrich notes in place. Undoable from history.")
      .addDropdown((dd) => {
        this.collisionDd = dd;
        dd.addOption("suffix", "Create with -2, -3 suffix");
        dd.addOption("skip", "Skip the row");
        dd.addOption("overwrite", "Overwrite the note");
        dd.addOption("update", "Update the note — merge properties, keep the body");
        dd.setValue(this.collision);
        dd.onChange((v) => {
          this.collision = v as CollisionPolicy;
          this.conflictSetting?.settingEl.toggle(v === "update");
          this.renderMapping(); // shows/hides the per-column conflict control
          this.renderRows(); // the status chips describe the policy
        });
      });

    this.conflictSetting = new Setting(contentEl)
      .setName("When a property already has a different value")
      .setDesc(
        "Update mode only. “Imported wins” replaces it with the sheet's value; “keep existing” only fills properties that are missing or empty — so a hand-corrected field survives the next roster import. Override per column in the table above."
      )
      .addDropdown((dd) => {
        this.conflictDd = dd;
        dd.addOption("imported", "Imported value wins");
        dd.addOption("existing", "Keep existing — only fill empty");
        dd.setValue(this.updateConflict);
        dd.onChange((v) => (this.updateConflict = v as UpdateConflict));
      });
    this.conflictSetting.settingEl.toggle(this.collision === "update");

    new Setting(contentEl)
      .setName("Create a .base file")
      .setDesc("Adds a table view over the imported folder with the included columns.")
      .addToggle((t) => {
        this.makeBaseToggle = t;
        t.setValue(this.makeBase).onChange((v) => {
          this.makeBase = v;
          // Only offer the base-name field when a base will actually be created.
          this.baseNameSetting?.settingEl.toggle(v);
          this.refreshBaseHint();
        });
      });

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
    this.folderEl?.addEventListener("input", () => this.renderRows());
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
      // A preset picked before any data was pasted applies now, onto the
      // freshly-built columns.
      if (this.pendingPreset) {
        const p = this.pendingPreset;
        this.pendingPreset = null;
        this.applyPresetMapping(p);
      }
    }
    // Row indices only mean anything against the text they were picked on —
    // any text change (even same-count re-pastes) resets the selection.
    if (trimmed !== this.lastRowSig) {
      this.lastRowSig = trimmed;
      this.excludedRows.clear();
    }
    this.previewRow = Math.min(this.previewRow, this.rows.length - 1);
    this.renderRows();
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
    this.scheduleDraftSave();
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
    const headings = ["CSV column", "Property", "Type", "Filename"];
    if (this.collision === "update") headings.push("On conflict");
    for (const h of headings) head.createEl("th", { text: h });

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
        this.renderRows(); // row names come from this column
      });
      if (this.collision === "update") {
        const sel = tr.createEl("td").createEl("select", { cls: "dropdown" });
        const opts: [string, string][] = [
          ["", "(global)"],
          ["imported", "imported wins"],
          ["existing", "keep existing"],
        ];
        for (const [v, label] of opts) {
          const o = sel.createEl("option", { text: label });
          o.value = v;
        }
        sel.value = col.conflict ?? "";
        sel.setAttribute("aria-label", "Conflict override for this column");
        sel.addEventListener("change", () => {
          col.conflict = (sel.value || undefined) as ColumnConfig["conflict"];
        });
      }
    });
    this.updateSelectAll();
    this.scheduleDraftSave();
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
        // Conflict policy: with "keep existing" (globally or per column), a
        // property that already holds a real value is left alone — only
        // missing/empty ones fill in.
        const empty =
          cur === undefined || cur === null || cur === "" || (Array.isArray(cur) && cur.length === 0);
        if ((col.conflict ?? this.updateConflict) === "existing" && !empty) continue;
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
  private rawWriter(): {
    write: (absPath: string, data: string) => Promise<void>;
    reconcile: ((vaultPath: string) => Promise<void>) | null;
  } | null {
    if (!Platform.isDesktopApp) return null;
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    const req = (window as unknown as { require?: (m: string) => unknown }).require;
    const fs = req?.("fs") as
      | {
          promises?: { writeFile?: (p: string, d: string) => Promise<void> };
          statSync?: (p: string) => unknown;
        }
      | undefined;
    const writeFile = fs?.promises?.writeFile;
    if (!writeFile) return null;
    // reconcileFileCreation is what Obsidian's own file watcher calls to register
    // a new file. Calling it ourselves forces reliable, immediate indexing —
    // otherwise the raw writes rely on the OS watcher, which lags and can stall
    // at a PARTIAL result (files present on disk but missing from the base).
    // Undocumented internal, so feature-detected; if absent we fall back to the
    // watcher (the previous behaviour).
    const rec = (adapter as unknown as {
      reconcileFileCreation?: (real: string, vault: string, stat: unknown) => Promise<void>;
    }).reconcileFileCreation;
    const statSync = fs?.statSync;
    const reconcile =
      rec && statSync
        ? async (vaultPath: string) => {
            const full = adapter.getFullPath(vaultPath);
            await rec.call(adapter, full, vaultPath, statSync(full));
          }
        : null;
    return { write: (absPath, data) => writeFile(absPath, data), reconcile };
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

  /* ---------- presets (recurring imports) ---------- */

  /**
   * Preset picker: the whole importer setup (folder, mapping, policies — not
   * the pasted data) saved under a name and reapplied in one pick. Built for
   * the "same provider roster every month" routine.
   */
  private renderPresetBar(contentEl: HTMLElement): void {
    const s = new Setting(contentEl)
      .setName("Preset")
      .setDesc(
        "Save this setup (folder, column mapping, policies) under a name — e.g. one per provider — and reapply it next time. Columns match by header, so a re-exported sheet lines up even if its column order changed."
      );
    s.addDropdown((dd) => {
      this.presetDd = dd;
      this.refreshPresetDd("");
      dd.onChange((name) => {
        const p = this.plugin.settings.importPresets.find((x) => x.name === name);
        if (p) this.applyPreset(p);
      });
    });
    s.addText((t) => {
      t.setPlaceholder("Name (e.g. Acme roster)");
      this.presetNameEl = t.inputEl;
    });
    s.addButton((b) =>
      b
        .setButtonText("Save")
        .setTooltip("Save the current setup under this name (a same-named preset is replaced)")
        .onClick(() => void this.savePreset())
    );
    s.addExtraButton((b) =>
      b.setIcon("trash-2").setTooltip("Delete the selected preset").onClick(() => this.deletePreset())
    );
  }

  /** Rebuild the preset dropdown's options and select `selected`. */
  private refreshPresetDd(selected: string): void {
    const dd = this.presetDd;
    if (!dd) return;
    dd.selectEl.empty();
    const presets = this.plugin.settings.importPresets;
    dd.addOption("", presets.length ? "Apply a preset…" : "No presets saved yet");
    for (const p of presets) dd.addOption(p.name, p.name);
    dd.setValue(selected);
  }

  private async savePreset(): Promise<void> {
    // Name from the field, falling back to the selected preset (= update it).
    const name = this.presetNameEl?.value.trim() || this.presetDd?.getValue() || "";
    if (!name) {
      new Notice("Give the preset a name first.");
      return;
    }
    const preset: ImportPreset = {
      name,
      folder: this.folderEl?.value ?? "",
      template: this.templateEl?.value ?? "",
      collision: this.collision,
      updateConflict: this.updateConflict,
      makeBase: this.makeBase,
      baseName: this.baseNameEl?.value ?? "",
      omitEmpty: this.omitEmpty,
      inputFormat: this.inputFormat,
      filenameHeader: this.headers[this.filenameCol] ?? "",
      // Deep-copied so later edits in this session don't mutate the saved copy.
      columns: this.columns.map((c) => ({ ...c })),
    };
    const list = this.plugin.settings.importPresets;
    const i = list.findIndex((x) => x.name === name);
    if (i >= 0) list[i] = preset;
    else list.push(preset);
    await this.plugin.savePluginData();
    this.refreshPresetDd(name);
    new Notice(`Preset “${name}” ${i >= 0 ? "updated" : "saved"}.`);
  }

  /** Apply a preset's scalars now; the column mapping applies when data exists
   * (or is queued for the first parse when the importer is still empty). */
  private applyPreset(p: ImportPreset): void {
    if (this.folderEl) this.folderEl.value = p.folder;
    if (this.templateEl) this.templateEl.value = p.template;
    if (this.baseNameEl) this.baseNameEl.value = p.baseName;
    this.collision = p.collision;
    this.collisionDd?.setValue(p.collision);
    this.updateConflict = p.updateConflict;
    this.conflictDd?.setValue(p.updateConflict);
    this.conflictSetting?.settingEl.toggle(p.collision === "update");
    this.makeBase = p.makeBase;
    this.makeBaseToggle?.setValue(p.makeBase);
    this.baseNameSetting?.settingEl.toggle(p.makeBase);
    this.omitEmpty = p.omitEmpty;
    this.omitToggle?.setValue(p.omitEmpty);
    this.inputFormat = p.inputFormat;
    this.formatDd?.setValue(p.inputFormat);
    if (this.presetNameEl) this.presetNameEl.value = p.name;
    this.refreshBaseHint();
    if (this.headers.length) {
      this.applyPresetMapping(p);
      this.renderRows(); // chips reflect the preset's folder + policy
    } else {
      this.pendingPreset = p;
      new Notice(`Preset “${p.name}” applied — paste the sheet and the column mapping follows.`);
    }
  }

  /** Overlay a preset's per-column settings onto the current sheet, by header. */
  private applyPresetMapping(p: ImportPreset): void {
    const norm = (h: string) => h.trim().toLowerCase();
    for (const col of this.columns) {
      const pc = p.columns.find((x) => norm(x.header) === norm(col.header));
      if (!pc) continue;
      col.include = pc.include;
      col.propName = pc.propName;
      col.type = pc.type;
      col.conflict = pc.conflict;
    }
    const fi = this.headers.findIndex((h) => norm(h) === norm(p.filenameHeader));
    if (fi >= 0) this.filenameCol = fi;
    this.renderMapping();
    this.renderPreview();
    // Surface drift between the saved sheet and this one — the roster changed.
    const missing = p.columns.filter(
      (x) => x.include && !this.headers.some((h) => norm(h) === norm(x.header))
    );
    const extra = this.headers.filter((h) => !p.columns.some((x) => norm(x.header) === norm(h)));
    const parts: string[] = [];
    if (missing.length) parts.push(`saved columns not in this sheet: ${missing.map((x) => x.header).join(", ")}`);
    if (extra.length) parts.push(`new columns not in the preset: ${extra.join(", ")}`);
    new Notice(
      `Preset “${p.name}” applied.${parts.length ? ` Heads-up — ${parts.join("; ")}.` : ""}`,
      parts.length ? 10000 : 4000
    );
  }

  private deletePreset(): void {
    const name = this.presetDd?.getValue() ?? "";
    if (!name) {
      new Notice("Pick the preset to delete from the dropdown first.");
      return;
    }
    new ConfirmModal(this.plugin, {
      title: `Delete preset “${name}”?`,
      body: "Only the saved setup is deleted — nothing in your vault changes.",
      confirmText: "Delete preset",
      danger: true,
      onConfirm: () => void (async () => {
        const list = this.plugin.settings.importPresets;
        const i = list.findIndex((x) => x.name === name);
        if (i >= 0) list.splice(i, 1);
        await this.plugin.savePluginData();
        this.refreshPresetDd("");
        new Notice(`Preset “${name}” deleted.`);
      })(),
    }).open();
  }

  /* ---------- row picker ---------- */

  /** Row indices matching the current row-filter text (all rows when blank). */
  private matchingRowIndices(): number[] {
    const q = this.rowSearch.trim().toLowerCase();
    const out: number[] = [];
    this.rows.forEach((row, i) => {
      if (!q || row.some((cell) => cell.toLowerCase().includes(q))) out.push(i);
    });
    return out;
  }

  /**
   * The row picker: choose exactly which rows import. Collapsible (a 12k-row
   * sheet shouldn't dominate the form), searchable (the filter matches any
   * cell), with All/None/Invert acting on the FILTERED set — so "filter to one
   * provider, None, clear filter" style slicing works. Each row carries a chip
   * saying what the import will do to it (new / update / overwrite / skip /
   * suffix) against the current target folder.
   */
  private renderRows(): void {
    const root = this.rowsEl;
    if (!root) return;
    root.empty();
    if (!this.rows.length) return;
    const total = this.rows.length;
    const selected = total - [...this.excludedRows].filter((i) => i < total).length;

    const details = root.createEl("details", { cls: "bases-toolbox-csv-rows" });
    details.open = this.rowsOpen;
    details.addEventListener("toggle", () => (this.rowsOpen = details.open));
    const summary = details.createEl("summary", { cls: "bases-toolbox-csv-rows-summary" });
    summary.createSpan({
      text:
        selected === total
          ? `Rows to import: all ${total}`
          : `Rows to import: ${selected} of ${total} selected`,
    });

    const bar = details.createDiv({ cls: "bases-toolbox-csv-rows-bar" });
    const matches = () => this.matchingRowIndices();
    const filtered = () => this.rowSearch.trim() !== "";
    const btn = (label: string, fn: () => void, aria: string) => {
      const b = bar.createEl("button", { text: label });
      b.setAttribute("aria-label", aria);
      b.addEventListener("click", () => {
        fn();
        this.scheduleDraftSave();
        this.renderRows();
      });
    };
    btn("All", () => matches().forEach((i) => this.excludedRows.delete(i)),
      "Select every row the filter matches");
    btn("None", () => matches().forEach((i) => this.excludedRows.add(i)),
      "Deselect every row the filter matches");
    btn("Invert", () => matches().forEach((i) => {
        if (this.excludedRows.has(i)) this.excludedRows.delete(i);
        else this.excludedRows.add(i);
      }),
      "Invert the selection of the rows the filter matches");
    const search = bar.createEl("input", {
      type: "search",
      attr: { placeholder: "Filter rows (matches any cell)…", "aria-label": "Filter rows" },
    });
    search.value = this.rowSearch;
    search.addEventListener("input", () => {
      this.rowSearch = search.value;
      this.renderRows();
      // Re-focus: the rebuild replaced the input mid-typing.
      const el = root.querySelector<HTMLInputElement>("input[type=search]");
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
    if (filtered()) {
      bar.createSpan({
        cls: "bases-toolbox-fr-info",
        text: "All / None / Invert act on the filtered rows.",
      });
    }

    const listEl = details.createDiv({ cls: "bases-toolbox-csv-rowlist" });
    const folder = normalizePath(this.folderEl?.value.trim() || "CSV Import");
    const CHIP: Record<CollisionPolicy, string> = {
      suffix: "exists → “-2” copy",
      skip: "exists → skipped",
      overwrite: "exists → overwrite",
      update: "exists → update",
    };
    const idxs = matches();
    const CAP = 300;
    for (const i of idxs.slice(0, CAP)) {
      const row = this.rows[i];
      const line = listEl.createDiv({ cls: "bases-toolbox-csv-rowline" });
      const cb = line.createEl("input", { type: "checkbox" });
      cb.checked = !this.excludedRows.has(i);
      cb.addEventListener("change", () => {
        if (cb.checked) this.excludedRows.delete(i);
        else this.excludedRows.add(i);
        this.scheduleDraftSave();
        // Update only the summary count — rebuilding 300 rows per tick is rude.
        const sel = total - [...this.excludedRows].filter((x) => x < total).length;
        summary.setText(
          sel === total ? `Rows to import: all ${total}` : `Rows to import: ${sel} of ${total} selected`
        );
      });
      const name = sanitizeFilename(row[this.filenameCol] ?? `note-${i + 1}`);
      line.createSpan({ cls: "bases-toolbox-csv-rowname", text: name });
      const cells = this.columns
        .map((c, ci) => (c.include && ci !== this.filenameCol ? (row[ci] ?? "").trim() : ""))
        .filter(Boolean)
        .slice(0, 3)
        .join(" · ");
      line.createSpan({ cls: "bases-toolbox-csv-rowcells", text: cells.slice(0, 80) });
      const exists = this.app.vault.getAbstractFileByPath(`${folder}/${name}.md`) instanceof TFile;
      line.createSpan({
        cls: `bases-toolbox-csv-rowchip ${exists ? "is-existing" : "is-new"}`,
        text: exists ? CHIP[this.collision] : "new",
      });
    }
    if (idxs.length > CAP) {
      listEl.createDiv({
        cls: "bases-toolbox-fr-info",
        text: `Showing the first ${CAP} of ${idxs.length} matching rows — All/None/Invert still act on all ${idxs.length}; narrow the filter to see the rest.`,
      });
    }
    if (!idxs.length) {
      listEl.createDiv({ cls: "bases-toolbox-fr-info", text: "No rows match the filter." });
    }
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
    if (this.rows.length && this.rows.every((_, i) => this.excludedRows.has(i))) {
      new Notice("Every row is deselected — tick at least one row to import.");
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
      const deselected = [...this.excludedRows].filter((i) => i < this.rows.length).length;
      for (const [idx, row] of this.rows.entries()) {
        if (this.excludedRows.has(idx)) continue; // left out in the row picker
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
      const raw = this.rawWriter();
      const adapter = this.app.vault.adapter;
      if (raw && adapter instanceof FileSystemAdapter) {
        // Raw-write NEW files with a bounded WORKER POOL — the key to the speedup.
        // A chunked `await Promise.all(batch)` fully drains the microtask queue
        // between batches, which lets Obsidian's file watcher (a macrotask) run
        // and index that batch inline — that indexing, not the write, is what
        // made the "fast" path slow. A worker pool keeps writes continuously in
        // flight so the microtask queue never empties, starving the watcher until
        // every file is on disk (measured: 3000 files in ~0.4s vs ~8s chunked).
        // No progress bumps mid-pool for the same reason (a DOM touch yields too).
        let next = 0;
        const worker = async () => {
          while (next < createJobs.length) {
            const job = createJobs[next++];
            await raw.write(adapter.getFullPath(job.path), job.content);
            created++;
          }
        };
        const RAW_POOL = 128; // in-flight writes: fast, bounded well under FD limits
        await Promise.all(Array.from({ length: Math.min(RAW_POOL, createJobs.length) }, worker));

        // Now force RELIABLE indexing. The OS watcher lags and can stall at a
        // partial result (files on disk but missing from the base); calling
        // reconcileFileCreation ourselves registers every file immediately
        // (~1ms each, measured). Progress bumps are fine here — we WANT the
        // indexing to run. Frontmatter values still parse async afterward, so
        // rows appear right away and cells fill in a moment later.
        if (raw.reconcile) {
          for (let i = 0; i < createJobs.length; i++) {
            try {
              await raw.reconcile(createJobs[i].path);
            } catch {
              /* one file failing to reconcile just leaves it to the watcher */
            }
            if ((i + 1) % 200 === 0) reportProgress(done + i + 1);
          }
          deferredIndex = false; // reconciled ourselves — no lingering index lag
        } else {
          deferredIndex = createJobs.length > 0; // no reconcile API → watcher (laggy)
        }
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
        (deselected ? `, ${deselected} deselected` : "") +
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
      void this.clearDraft(); // import succeeded — the draft is no longer needed
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

/**
 * Peeks at the saved import draft (without opening the importer) so the plugin
 * can proactively flag a recoverable import on startup. Returns null when there
 * is nothing worth recovering.
 */
export async function importDraftInfo(
  plugin: BasesToolboxPlugin
): Promise<{ rows: number; savedAt: number } | null> {
  const store = new JsonStore<Partial<ImportDraft>>(plugin, "import-drafts/last.json", () => ({}));
  const draft = await store.load();
  if (!draft.text || !draft.text.trim()) return null;
  return { rows: (draft.text.match(/\n/g)?.length ?? 0) + 1, savedAt: draft.savedAt ?? 0 };
}

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
