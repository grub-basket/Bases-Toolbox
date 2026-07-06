import { Modal, Notice, Setting, TFile, parseYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { baseFileForCell } from "./base-detect";
import { parseReplacement } from "./find-replace";
import { findKey, getPropertyType } from "./scan";

interface ResolvedCell {
  file: TFile;
  key: string;
}

const LIST_TYPES = new Set(["multitext", "tags", "aliases"]);

function eligible(el: EventTarget | null): HTMLElement | null {
  if (!(el instanceof HTMLElement)) return null;
  const editable =
    el.instanceOf(HTMLInputElement) || el.instanceOf(HTMLTextAreaElement) || el.isContentEditable;
  if (!editable) return null;
  if (!el.closest(".bases-td, .metadata-property")) return null;
  return el;
}

let lastFocused: HTMLElement | null = null;

/** Track the last focused cell/property editor — the command palette steals focus. */
export function installCellZoomTracking(plugin: BasesToolboxPlugin): void {
  plugin.registerDomEvent(
    activeDocument,
    "focusin",
    (e: FocusEvent) => {
      const el = eligible(e.target);
      if (el) lastFocused = el;
    },
    { capture: true }
  );
  plugin.register(() => (lastFocused = null));
}

/**
 * Maps a Bases table cell back to (file, property): the row's file-name link
 * carries the full path in data-href, and the cell's column index lines up
 * with the active view's `order` array in the .base file.
 */
async function resolveBasesCell(
  plugin: BasesToolboxPlugin,
  td: HTMLElement
): Promise<ResolvedCell | null> {
  const app = plugin.app;
  const row = td.closest(".bases-tr");
  const href = row?.querySelector("[data-href]")?.getAttribute("data-href");
  const file = href ? app.vault.getAbstractFileByPath(href) : null;
  if (!(file instanceof TFile)) return null;

  const embed = td.closest(".bases-embed");
  // For a standalone base, derive the .base file from the base LEAF that owns
  // this cell — not getActiveFile(), which can point at a different leaf when
  // the base isn't the focused view. Fall back to getActiveFile() if no owning
  // leaf matches.
  const baseFile = embed
    ? app.metadataCache.getFirstLinkpathDest(
        (embed.getAttribute("src") ?? "").split("#")[0],
        app.workspace.getActiveFile()?.path ?? ""
      )
    : baseFileForCell(app, td) ?? app.workspace.getActiveFile();
  if (!(baseFile instanceof TFile) || baseFile.extension !== "base") return null;

  let doc: Record<string, unknown>;
  try {
    doc = (parseYaml(await app.vault.read(baseFile)) ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  const views = Array.isArray(doc.views) ? (doc.views as Record<string, unknown>[]) : [];
  const scope = (embed ?? td.closest(".view-content")) as HTMLElement | null;
  const viewLabel = scope?.querySelector(".bases-toolbar-views-menu")?.textContent?.trim();
  // If the toolbar label exists but matches no view, DON'T guess views[0] —
  // a wrong guess here would write to the wrong property.
  const view = views.find((v) => v.name === viewLabel) ?? (viewLabel ? undefined : views[0]);
  if (!view) return null;
  const order = Array.isArray(view.order) ? (view.order as unknown[]) : [];

  const index = row ? Array.from(row.querySelectorAll(".bases-td")).indexOf(td) : -1;
  const rawKey = order[index];
  if (typeof rawKey !== "string") return null;
  let key: string = rawKey;
  if (key.startsWith("file.") || key.startsWith("formula.")) {
    new Notice("That column is computed — only note properties can be edited.");
    return null;
  }
  if (key.startsWith("note.")) key = key.slice(5);
  return { file, key };
}

async function resolveTarget(plugin: BasesToolboxPlugin): Promise<ResolvedCell | null> {
  const el =
    eligible(activeDocument.activeElement) ?? (lastFocused?.isConnected ? lastFocused : null);
  if (!el) return null;
  const td = el.closest<HTMLElement>(".bases-td");
  if (td) return resolveBasesCell(plugin, td);
  const prop = el.closest<HTMLElement>(".metadata-property");
  const key = prop?.getAttribute("data-property-key");
  const file = plugin.app.workspace.getActiveFile();
  if (key && file) return { file, key };
  return null;
}

export async function openCellZoom(plugin: BasesToolboxPlugin): Promise<void> {
  const target = await resolveTarget(plugin);
  if (!target) {
    new Notice("Click into a Bases cell or property value first, then run Zoom.");
    return;
  }
  new CellZoomModal(plugin, target).open();
}

class CellZoomModal extends Modal {
  private plugin: BasesToolboxPlugin;
  private target: ResolvedCell;
  private wasArray = false;
  private textarea: HTMLTextAreaElement | null = null;

  constructor(plugin: BasesToolboxPlugin, target: ResolvedCell) {
    super(plugin.app);
    this.plugin = plugin;
    this.target = target;
  }

  onOpen(): void {
    this.titleEl.setText(`${this.target.key} — ${this.target.file.basename}`);
    const { contentEl } = this;

    const fm = this.app.metadataCache.getFileCache(this.target.file)?.frontmatter ?? {};
    const key = findKey(fm, this.target.key) ?? this.target.key;
    const cur = (fm as Record<string, unknown>)[key];
    if (cur !== null && typeof cur === "object" && !Array.isArray(cur)) {
      // Nested objects would round-trip through String() as garbage.
      contentEl.createDiv({
        cls: "bases-toolbox-fr-warning",
        text: "This property holds a nested object — zoom editing would destroy its structure, so it's disabled here.",
      });
      return;
    }
    this.wasArray = Array.isArray(cur);
    const text = Array.isArray(cur)
      ? cur.map((v) => String(v ?? "")).join("\n")
      : cur === null || cur === undefined
        ? ""
        : String(cur);

    this.textarea = contentEl.createEl("textarea", { cls: "bases-toolbox-zoom-textarea" });
    this.textarea.value = text;
    this.textarea.focus();
    this.textarea.setSelectionRange(text.length, text.length);
    this.textarea.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void this.save();
    });

    const type = getPropertyType(this.app, this.target.key);
    if (this.wasArray || LIST_TYPES.has(type ?? "")) {
      contentEl.createDiv({ cls: "bases-toolbox-fr-info", text: "List property: one item per line." });
    }

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Save").setCta().onClick(() => void this.save()))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }

  private async save(): Promise<void> {
    const raw = this.textarea?.value ?? "";
    const type = getPropertyType(this.app, this.target.key);
    let value: unknown;
    if (this.wasArray || LIST_TYPES.has(type ?? "")) {
      value = raw
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (type === "number" || type === "checkbox") {
      value = parseReplacement(raw, type);
    } else {
      value = raw === "" ? null : raw; // preserve newlines for long text
    }
    await this.app.fileManager.processFrontMatter(this.target.file, (fm) => {
      const key = findKey(fm, this.target.key) ?? this.target.key;
      fm[key] = value;
    });
    new Notice(`Saved ${this.target.key} in ${this.target.file.basename}.`);
    this.close();
  }
}
