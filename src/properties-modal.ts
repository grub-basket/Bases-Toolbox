import { Modal, Notice, Setting, TFile, TFolder, normalizePath, setIcon, stringifyYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { folderPaths } from "./csv-export";
import { getPropertyType } from "./scan";
import { ListInputSuggest, attachAllowedSuggest, attachPropertySuggest } from "./suggest";

type PropType = "text" | "number" | "checkbox" | "date" | "datetime" | "multitext" | "tags" | "aliases";

const TYPE_LABELS: Record<PropType, string> = {
  text: "Text",
  number: "Number",
  checkbox: "Checkbox",
  date: "Date",
  datetime: "Date & time",
  multitext: "List",
  tags: "Tags",
  aliases: "Aliases",
};

const LIST_TYPES = new Set<PropType>(["multitext", "tags", "aliases"]);

interface Row {
  key: string;
  type: PropType;
  /** Scalar/list value as text (lists are ";"/newline separated). */
  text: string;
  /** Checkbox value. */
  bool: boolean;
}

function inferType(app: BasesToolboxPlugin["app"], key: string, value: unknown): PropType {
  const assigned = getPropertyType(app, key) as PropType | null;
  if (assigned && assigned in TYPE_LABELS) return assigned;
  if (Array.isArray(value)) return "multitext";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  return "text";
}

function valueToText(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join("; ");
  if (value === null || value === undefined) return "";
  return String(value);
}

function parseRow(row: Row): unknown {
  if (row.type === "checkbox") return row.bool;
  if (LIST_TYPES.has(row.type)) {
    const items = row.text
      .split(/[;\n]/)
      .map((s) => s.trim())
      .map((s) => (row.type === "tags" ? s.replace(/^#/, "") : s))
      .filter(Boolean);
    return items;
  }
  if (row.type === "number") {
    const n = Number(row.text.trim());
    return row.text.trim() === "" || Number.isNaN(n) ? null : n;
  }
  return row.text; // text / date / datetime — plain string
}

type Target = { kind: "edit"; file: TFile } | { kind: "create"; folder: string };

/**
 * A roomy form for a note's properties — edit an existing note (with rename) or
 * create a new one — as an alternative to Obsidian's cramped inline / Bases
 * popup editor. Type-aware value widgets, allowed-value autocomplete, add/remove.
 */
export class PropertiesModal extends Modal {
  private plugin: BasesToolboxPlugin;
  private target: Target;
  private nameInput: HTMLInputElement | null = null;
  private folderInput: HTMLInputElement | null = null;
  private bodyInput: HTMLTextAreaElement | null = null;
  private rowsEl: HTMLElement | null = null;
  private rows: Row[] = [];
  private originalKeys: string[] = [];
  private running = false;

  constructor(plugin: BasesToolboxPlugin, target: Target) {
    super(plugin.app);
    this.plugin = plugin;
    this.target = target;
  }

  onOpen(): void {
    this.modalEl.addClass("bases-toolbox-props-modal");
    const editing = this.target.kind === "edit";
    this.titleEl.setText(editing ? "Edit properties" : "New note with properties");
    const { contentEl } = this;

    // Seed rows from the note's frontmatter (edit) or empty (create).
    if (this.target.kind === "edit") {
      const fm = (this.app.metadataCache.getFileCache(this.target.file)?.frontmatter ?? {}) as Record<
        string,
        unknown
      >;
      for (const [k, v] of Object.entries(fm)) {
        if (k === "position") continue;
        this.originalKeys.push(k);
        const type = inferType(this.app, k, v);
        this.rows.push({ key: k, type, text: valueToText(v), bool: v === true });
      }
    }

    // File name.
    new Setting(contentEl)
      .setName("File name")
      .setDesc(editing ? "Rename the note (without .md)." : "Name for the new note (without .md).")
      .addText((t) => {
        t.setPlaceholder("Note name");
        if (this.target.kind === "edit") t.setValue(this.target.file.basename);
        this.nameInput = t.inputEl;
      });

    // Create-only: target folder + optional body.
    if (this.target.kind === "create") {
      new Setting(contentEl)
        .setName("Folder")
        .setDesc('Where to create it. Blank = vault root. Type to autocomplete.')
        .addText((t) => {
          t.setValue(this.target.kind === "create" ? this.target.folder : "");
          new ListInputSuggest(this.plugin, t.inputEl, () => folderPaths(this.plugin));
          this.folderInput = t.inputEl;
        });
    }

    contentEl.createDiv({ cls: "bases-toolbox-props-heading", text: "Properties" });
    this.rowsEl = contentEl.createDiv({ cls: "bases-toolbox-props-rows" });
    this.renderRows();

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("+ Add property").onClick(() => {
        this.rows.push({ key: "", type: "text", text: "", bool: false });
        this.renderRows();
      })
    );

    if (this.target.kind === "create") {
      new Setting(contentEl)
        .setName("Body (optional)")
        .setDesc("Markdown below the properties.")
        .addTextArea((t) => {
          this.bodyInput = t.inputEl;
        });
    }

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText(editing ? "Save" : "Create note")
          .setCta()
          .onClick(() => void this.save())
      )
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderRows(): void {
    const root = this.rowsEl;
    if (!root) return;
    root.empty();
    if (!this.rows.length) {
      root.createDiv({ cls: "bases-toolbox-fr-info", text: "No properties yet — add one below." });
    }
    this.rows.forEach((row, i) => this.renderRow(root, row, i));
  }

  private renderRow(root: HTMLElement, row: Row, index: number): void {
    const el = root.createDiv({ cls: "bases-toolbox-props-row" });

    const name = el.createEl("input", { type: "text", cls: "bases-toolbox-props-key", attr: { placeholder: "property" } });
    name.value = row.key;
    attachPropertySuggest(this.plugin, name);
    name.addEventListener("input", () => {
      row.key = name.value.trim();
    });
    // When you leave the name, adopt that property's assigned type if we have one.
    name.addEventListener("change", () => {
      const t = getPropertyType(this.app, row.key) as PropType | null;
      if (t && t in TYPE_LABELS && !LIST_TYPES.has(row.type) && row.text === "") {
        row.type = t;
        this.renderRows();
      }
    });

    const typeSel = el.createEl("select", { cls: "dropdown bases-toolbox-props-type" });
    for (const t of Object.keys(TYPE_LABELS) as PropType[]) {
      typeSel.createEl("option", { value: t, text: TYPE_LABELS[t] });
    }
    typeSel.value = row.type;
    typeSel.addEventListener("change", () => {
      row.type = typeSel.value as PropType;
      this.renderRows();
    });

    // Value widget depends on the type.
    if (row.type === "checkbox") {
      const cb = el.createEl("input", { type: "checkbox", cls: "bases-toolbox-props-check" });
      cb.checked = row.bool;
      cb.addEventListener("change", () => (row.bool = cb.checked));
    } else if (LIST_TYPES.has(row.type)) {
      const ta = el.createEl("textarea", {
        cls: "bases-toolbox-props-val",
        attr: { placeholder: "one per line or ; separated", rows: "2" },
      });
      ta.value = row.text;
      ta.addEventListener("input", () => (row.text = ta.value));
    } else {
      const val = el.createEl("input", {
        type: row.type === "date" ? "date" : row.type === "datetime" ? "datetime-local" : "text",
        cls: "bases-toolbox-props-val",
        attr: { placeholder: row.type === "number" ? "0" : "value" },
      });
      val.value = row.text;
      if (row.type === "text") attachAllowedSuggest(this.plugin, val, () => row.key);
      val.addEventListener("input", () => (row.text = val.value));
    }

    const del = el.createEl("button", { cls: "bases-toolbox-props-del", attr: { "aria-label": "Remove property" } });
    setIcon(del, "x");
    del.addEventListener("click", () => {
      this.rows.splice(index, 1);
      this.renderRows();
    });
  }

  /** Frontmatter object from the current rows (skips unnamed rows). */
  private buildFrontmatter(): Record<string, unknown> {
    const fm: Record<string, unknown> = {};
    for (const row of this.rows) {
      if (!row.key) continue;
      fm[row.key] = parseRow(row);
    }
    return fm;
  }

  private async save(): Promise<void> {
    if (this.running) return;
    const name = (this.nameInput?.value ?? "").trim();
    if (!name) {
      new Notice("Give the note a file name.");
      return;
    }
    if (/[\\/:*?"<>|]/.test(name)) {
      new Notice('A file name can\'t contain \\ / : * ? " < > |');
      return;
    }
    this.running = true;
    try {
      if (this.target.kind === "create") await this.doCreate(name);
      else await this.doEdit(this.target.file, name);
      this.close();
    } catch (e) {
      new Notice(`Failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.running = false;
    }
  }

  private async doCreate(name: string): Promise<void> {
    const folder = normalizePath((this.folderInput?.value ?? "").trim());
    if (folder && !(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
      await this.app.vault.createFolder(folder);
    }
    const path = folder ? `${folder}/${name}.md` : `${name}.md`;
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice(`"${path}" already exists.`);
      return;
    }
    const fm = this.buildFrontmatter();
    const body = (this.bodyInput?.value ?? "").trim();
    const content =
      (Object.keys(fm).length ? `---\n${stringifyYaml(fm)}---\n` : "") + (body ? `\n${body}\n` : "");
    const file = await this.app.vault.create(path, content);
    await this.app.workspace.getLeaf(true).openFile(file);
    new Notice(`Created "${path}".`);
  }

  private async doEdit(file: TFile, name: string): Promise<void> {
    // Rename first if the name changed.
    if (name !== file.basename) {
      const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
      const newPath = `${dir}${name}.md`;
      if (this.app.vault.getAbstractFileByPath(newPath)) {
        new Notice(`"${newPath}" already exists — properties saved, note not renamed.`);
      } else {
        await this.app.fileManager.renameFile(file, newPath);
      }
    }

    const fm = this.buildFrontmatter();
    const currentKeys = new Set(Object.keys(fm));
    await this.app.fileManager.processFrontMatter(file, (existing) => {
      // Remove properties the user deleted, keep any we don't manage (position).
      for (const k of this.originalKeys) {
        if (!currentKeys.has(k) && k in existing) delete existing[k];
      }
      for (const [k, v] of Object.entries(fm)) existing[k] = v;
    });
    new Notice(`Saved ${currentKeys.size} propert${currentKeys.size === 1 ? "y" : "ies"}.`);
  }
}

/** Opens the modal to edit the active note's properties. */
export function editActiveNoteProperties(plugin: BasesToolboxPlugin): void {
  const file = plugin.app.workspace.getActiveFile();
  if (!file || file.extension !== "md") {
    new Notice("Open a markdown note first.");
    return;
  }
  new PropertiesModal(plugin, { kind: "edit", file }).open();
}

/** Opens the modal to create a new note. */
export function createNoteWithProperties(plugin: BasesToolboxPlugin, folder = ""): void {
  new PropertiesModal(plugin, { kind: "create", folder }).open();
}
