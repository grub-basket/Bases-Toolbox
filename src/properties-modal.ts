import {
  FuzzySuggestModal,
  ItemView,
  Modal,
  Notice,
  Setting,
  TFile,
  TFolder,
  normalizePath,
  setIcon,
  stringifyYaml,
} from "obsidian";
import type BasesToolboxPlugin from "./main";
import { folderPaths, readBaseInfo } from "./csv-export";
import { getPropertyType } from "./scan";
import { ListInputSuggest, attachAllowedSuggest, attachPropertySuggest } from "./suggest";

/** Fuzzy note picker → returns the chosen file so a value can get a [[wikilink]]. */
class LinkPicker extends FuzzySuggestModal<TFile> {
  constructor(
    private plugin: BasesToolboxPlugin,
    private onPick: (file: TFile) => void
  ) {
    super(plugin.app);
    this.setPlaceholder("Link to a note…");
  }
  getItems(): TFile[] {
    return this.plugin.app.vault.getMarkdownFiles();
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    this.onPick(f);
  }
}

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

type Target =
  | { kind: "edit"; file: TFile }
  /** `keys` pre-seeds empty rows (e.g. a base view's columns); `note` labels the source. */
  | { kind: "create"; folder: string; keys?: string[]; note?: string };

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

    // Seed rows from the note's frontmatter (edit), the base view's columns
    // (create-from-base), or nothing (plain create).
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
    } else if (this.target.keys?.length) {
      for (const k of this.target.keys) {
        const type = inferType(this.app, k, undefined);
        this.rows.push({ key: k, type, text: "", bool: false });
      }
    }

    if (this.target.kind === "create" && this.target.note) {
      contentEl.createDiv({ cls: "bases-toolbox-fr-info", text: this.target.note });
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

    // Internal-link insert — a note picker that appends a [[wikilink]] to the
    // value (a new line for lists, a space for text). Not for boolean/number.
    if (row.type === "text" || LIST_TYPES.has(row.type)) {
      const linkBtn = el.createEl("button", {
        cls: "bases-toolbox-props-link",
        attr: { "aria-label": "Insert a link to a note" },
      });
      setIcon(linkBtn, "link");
      linkBtn.addEventListener("click", () =>
        new LinkPicker(this.plugin, (f) => {
          const md = `[[${this.app.metadataCache.fileToLinktext(f, "", true)}]]`;
          const sep = LIST_TYPES.has(row.type) ? "\n" : " ";
          row.text = row.text.trim() ? `${row.text.trimEnd()}${sep}${md}` : md;
          this.renderRows();
        }).open()
      );
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

type BaseViewLike = { getViewType?: () => string; file?: TFile };
const isBaseView = (v: unknown): v is Required<BaseViewLike> =>
  !!v && (v as BaseViewLike).getViewType?.() === "bases" && (v as BaseViewLike).file instanceof TFile;

/**
 * If a base is open, borrow its current view's editable columns (dropping the
 * computed file./formula. ones that can't be typed into a new note) and the
 * folder it scopes to, so a new note slots straight into the base like a row.
 */
async function basePrefill(
  plugin: BasesToolboxPlugin
): Promise<{ folder: string; keys: string[]; note: string } | null> {
  const app = plugin.app;
  let view: unknown = app.workspace.getActiveViewOfType(ItemView);
  if (!isBaseView(view)) view = app.workspace.getLeavesOfType("bases").map((l) => l.view).find(isBaseView) ?? null;
  if (!isBaseView(view)) return null;

  const info = await readBaseInfo(plugin, view.file.path);
  if (!info.views.length) return null;
  const label = activeDocument
    .querySelector(".workspace-leaf.mod-active .bases-toolbar-views-menu")
    ?.textContent?.trim();
  const byLabel = info.views.findIndex((v) => v.name === label);
  const chosen = info.views[byLabel >= 0 ? byLabel : 0];

  const clauses = [...info.baseFilters, ...chosen.filters];
  const folders = clauses.flatMap((c) =>
    [...c.matchAll(/inFolder\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1].replace(/^\/+|\/+$/g, ""))
  );
  const keys = chosen.order
    .filter((k) => !k.startsWith("file.") && !k.startsWith("formula."))
    .map((k) => k.replace(/^note\./, ""));

  const where = folders[0] || "the vault root";
  const note =
    `Borrowing the “${chosen.name}” view of ${view.file.basename}. New note goes in ${where}.` +
    (folders.length > 1 ? ` (This base spans ${folders.length} folders — using the first.)` : "");
  return { folder: folders[0] ?? "", keys, note };
}

/** Opens the modal to create a new note. When a base is open, pre-fills it from
 * the base's current view + folder so the note slots straight in. */
export async function createNoteWithProperties(plugin: BasesToolboxPlugin, folder = ""): Promise<void> {
  const prefill = await basePrefill(plugin);
  if (prefill) {
    new PropertiesModal(plugin, {
      kind: "create",
      folder: prefill.folder || folder,
      keys: prefill.keys,
      note: prefill.note,
    }).open();
  } else {
    new PropertiesModal(plugin, { kind: "create", folder }).open();
  }
}
