import { ButtonComponent, Modal, Notice, Setting, TFolder, normalizePath, stringifyYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { CSV_TYPES, CsvType, cellToValue, guessType, parseCSV, sanitizeFilename, toPropertyKey } from "./csv-core";

interface ColumnConfig {
  header: string;
  include: boolean;
  propName: string;
  type: CsvType;
}

export class CsvImportModal extends Modal {
  private plugin: BasesToolboxPlugin;
  private headers: string[] = [];
  private rows: string[][] = [];
  private columns: ColumnConfig[] = [];
  private filenameCol = 0;
  private mappingEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private folderEl: HTMLInputElement | null = null;
  private importBtn: ButtonComponent | null = null;
  private running = false;

  constructor(plugin: BasesToolboxPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.setText("Import CSV as notes");
    this.modalEl.addClass("bases-toolbox-csv-modal");
    const { contentEl } = this;

    const ta = contentEl.createEl("textarea", {
      cls: "bases-toolbox-csv-input",
      attr: { placeholder: "Paste CSV/TSV here, or pick a file below…" },
    });
    ta.addEventListener("input", () => this.parse(ta.value));

    new Setting(contentEl).setName("Or pick a file").addButton((b) =>
      b.setButtonText("Choose CSV file").onClick(() => {
        const input = createEl("input", { type: "file", attr: { accept: ".csv,.tsv,.txt" } });
        input.addEventListener("change", () => {
          const file = input.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            ta.value = String(reader.result ?? "");
            this.parse(ta.value);
          };
          reader.readAsText(file);
        });
        input.click();
      })
    );

    this.statusEl = contentEl.createDiv({ cls: "bases-toolbox-fr-info", text: "Waiting for CSV input…" });
    this.mappingEl = contentEl.createDiv();

    new Setting(contentEl)
      .setName("Target folder")
      .setDesc("Created if it doesn't exist. One note per CSV row.")
      .addText((t) => {
        t.setValue("CSV Import");
        this.folderEl = t.inputEl;
      });

    new Setting(contentEl)
      .setName("Create a .base file")
      .setDesc("Adds a table view over the imported folder with the included columns.")
      .addToggle((t) => {
        // State is mirrored onto the DOM so it's read fresh at import time.
        t.setValue(true);
        t.toggleEl.dataset.btChecked = "1";
        t.onChange((v) => (t.toggleEl.dataset.btChecked = v ? "1" : ""));
      });

    new Setting(contentEl).addButton((b) => {
      b.setButtonText("Import").setCta().setDisabled(true).onClick(() => void this.doImport());
      this.importBtn = b;
    });
  }

  private parse(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      this.setStatus("Waiting for CSV input…", false);
      return;
    }
    const rows = parseCSV(trimmed);
    if (rows.length < 2) {
      this.setStatus("Need at least a header row and one data row.", false);
      return;
    }
    this.headers = rows[0];
    this.rows = rows.slice(1);
    this.columns = this.headers.map((h, i) => ({
      header: h,
      include: true,
      propName: toPropertyKey(h),
      type: guessType(h, this.rows.slice(0, 5).map((r) => r[i] ?? "")),
    }));
    this.filenameCol = 0;
    this.renderMapping();
    this.setStatus(`${this.rows.length} row${this.rows.length === 1 ? "" : "s"} detected.`, true);
  }

  private setStatus(msg: string, ready: boolean): void {
    this.statusEl?.setText(msg);
    this.importBtn?.setDisabled(!ready);
    if (!ready && this.mappingEl) this.mappingEl.empty();
  }

  private renderMapping(): void {
    const root = this.mappingEl;
    if (!root) return;
    root.empty();
    const table = root.createEl("table", { cls: "bases-toolbox-csv-table" });
    const head = table.createEl("tr");
    for (const h of ["Include", "CSV column", "Property", "Type", "Filename"]) {
      head.createEl("th", { text: h });
    }
    this.columns.forEach((col, i) => {
      const tr = table.createEl("tr");
      const inc = tr.createEl("td").createEl("input", { type: "checkbox" });
      inc.checked = col.include;
      inc.addEventListener("change", () => (col.include = inc.checked));
      tr.createEl("td", { text: col.header });
      const name = tr.createEl("td").createEl("input", { type: "text" });
      name.value = col.propName;
      name.addEventListener("input", () => (col.propName = name.value.trim()));
      const sel = tr.createEl("td").createEl("select");
      for (const t of CSV_TYPES) sel.createEl("option", { text: t, value: t });
      sel.value = col.type;
      sel.addEventListener("change", () => (col.type = sel.value as CsvType));
      const radio = tr.createEl("td").createEl("input", {
        type: "radio",
        attr: { name: "bt-filename-col" },
      });
      radio.checked = i === this.filenameCol;
      radio.addEventListener("change", () => (this.filenameCol = i));
    });
  }

  private async doImport(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const folder = normalizePath((this.folderEl?.value.trim() || "CSV Import"));
      if (!(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
        await this.app.vault.createFolder(folder);
      }
      const seen = new Map<string, number>();
      let created = 0;
      for (const [idx, row] of this.rows.entries()) {
        const fm: Record<string, unknown> = {};
        for (const [i, col] of this.columns.entries()) {
          if (!col.include || !col.propName) continue;
          const value = cellToValue(row[i] ?? "", col.type);
          if (value !== null) fm[col.propName] = value;
        }
        let base = sanitizeFilename(row[this.filenameCol] ?? `note-${idx + 1}`);
        const bump = (name: string) => {
          const n = (seen.get(name) ?? 0) + 1;
          seen.set(name, n);
          return n === 1 ? name : `${name} ${n}`;
        };
        let name = bump(base);
        while (this.app.vault.getAbstractFileByPath(`${folder}/${name}.md`)) name = bump(base);
        const body = Object.keys(fm).length ? `---\n${stringifyYaml(fm)}---\n` : "";
        await this.app.vault.create(`${folder}/${name}.md`, body);
        created++;
      }

      const makeBase = (this.contentEl.querySelector("[data-bt-checked]") as HTMLElement | null)
        ?.dataset.btChecked === "1";
      if (makeBase) {
        const folderName = folder.split("/").pop() ?? folder;
        const basePath = `${folder}/${folderName}.base`;
        if (!this.app.vault.getAbstractFileByPath(basePath)) {
          const order = ["file.name", ...this.columns.filter((c) => c.include && c.propName).map((c) => c.propName)];
          const baseDoc = {
            filters: { and: [`file.inFolder("${folder}")`, 'file.ext == "md"'] },
            views: [{ type: "table", name: "Table", order }],
          };
          await this.app.vault.create(basePath, stringifyYaml(baseDoc));
        }
      }
      new Notice(`Imported ${created} note${created === 1 ? "" : "s"} into "${folder}".`);
      this.close();
    } catch (e) {
      new Notice(`Import failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.running = false;
    }
  }
}
