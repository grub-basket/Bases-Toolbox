import { ButtonComponent, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { findKey } from "./scan";
import { ChangeRecord } from "./types";

/**
 * Companion notes for non-Markdown files: Bases only reads frontmatter from
 * .md files, so images, PDFs, audio, and other attachments are invisible to
 * it. This creates a small companion note per file — named `<file>.<ext>.md`
 * — whose frontmatter replicates the file's metadata plus a link to the file,
 * making every attachment queryable in a base. Companions live adjacent to
 * their file by default, or in a designated folder (mirroring the source
 * structure). Re-running REFRESHES the `file-*` properties while preserving
 * any properties the user added. An optional auto mode companions newly
 * added files (armed after startup so Obsidian's create-replay doesn't look
 * like a giant drop — pattern from Stashpad's importer).
 */

function toLocalDatetime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The metadata properties a companion carries; refreshed on every run. */
function fileProps(file: TFile): Record<string, unknown> {
  return {
    "companion-of": `[[${file.path}]]`,
    "file-name": file.basename,
    "file-ext": file.extension,
    "file-size": file.stat.size,
    "file-created": toLocalDatetime(file.stat.ctime),
    "file-modified": toLocalDatetime(file.stat.mtime),
    "file-path": file.path,
  };
}

export function parseExts(raw: string): Set<string> {
  return new Set(
    raw
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
      .filter(Boolean)
  );
}

/** Whether this file should get a companion under the given filters. */
export function companionEligible(
  file: TFile,
  folder: string,
  exts: Set<string>,
  dest: string
): boolean {
  if (file.extension === "md") return false;
  // Never companion a file DERIVED from a note (e.g. "X.md.edtz" — the Edit
  // History plugin's version file for a companion) — companioning
  // derivatives cascades forever between two plugins' watchers.
  if (file.name.includes(".md.")) return false;
  if (folder && !file.path.startsWith(folder + "/")) return false;
  if (exts.size && !exts.has(file.extension.toLowerCase())) return false;
  if (dest && file.path.startsWith(dest + "/")) return false;
  return true;
}

export function companionPathFor(file: TFile, dest: string): string {
  if (!dest) {
    const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
    return `${dir}${file.name}.md`;
  }
  return normalizePath(`${dest}/${file.path}.md`);
}

async function ensureParent(plugin: BasesToolboxPlugin, path: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (!dir) return;
  if (plugin.app.vault.getAbstractFileByPath(dir) instanceof TFolder) return;
  await plugin.app.vault.createFolder(dir).catch(() => undefined);
}

/** Creates a companion, or refreshes the file-* properties of an existing one. */
export async function createOrRefreshCompanion(
  plugin: BasesToolboxPlugin,
  file: TFile,
  dest: string
): Promise<"created" | "refreshed"> {
  const path = companionPathFor(file, dest);
  const props = fileProps(file);
  const existing = plugin.app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await plugin.app.fileManager.processFrontMatter(existing, (fm) => {
      Object.assign(fm, props);
    });
    return "refreshed";
  }
  await ensureParent(plugin, path);
  const note = await plugin.app.vault.create(path, `![[${file.path}]]\n`);
  await plugin.app.fileManager.processFrontMatter(note, (fm) => {
    Object.assign(fm, props);
  });
  return "created";
}

/* ---------- auto mode ---------- */

export function installCompanionAuto(plugin: BasesToolboxPlugin): void {
  let armed = false;
  // Obsidian replays a `create` event for every existing file on startup;
  // arm only after that storm has passed (Stashpad importer lesson).
  plugin.app.workspace.onLayoutReady(() => window.setTimeout(() => (armed = true), 3000));
  plugin.registerEvent(
    plugin.app.vault.on("create", (file) => {
      if (!armed || !plugin.settings.companionAuto) return;
      if (!(file instanceof TFile)) return;
      const dest = plugin.settings.companionsFolder;
      if (!companionEligible(file, "", parseExts(plugin.settings.companionExts), dest)) return;
      void createOrRefreshCompanion(plugin, file, dest);
    })
  );
}

/* ---------- companion modal ---------- */

interface CompanionPlan {
  file: TFile;
  companionPath: string;
  existing: boolean;
}

export class CompanionNotesModal extends Modal {
  private plugin: BasesToolboxPlugin;
  private folderEl: HTMLInputElement | null = null;
  private extsEl: HTMLInputElement | null = null;
  private destEl: HTMLInputElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private plans: CompanionPlan[] = [];
  private createBtn: ButtonComponent | null = null;
  private running = false;

  constructor(plugin: BasesToolboxPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.setText("Companion notes for non-Markdown files");
    const { contentEl } = this;

    contentEl.createDiv({
      cls: "bases-toolbox-fr-info",
      text: "Companions are small notes (one per file, named <file>.<ext>.md) carrying the file's metadata as frontmatter plus a link — so attachments become queryable in a base. Re-running refreshes the file-* properties and never touches properties you added.",
    });

    new Setting(contentEl)
      .setName("Folder scope")
      .setDesc("Only files under this folder. Leave empty for the whole vault.")
      .addText((t) => {
        t.setPlaceholder("e.g. Attachments");
        this.folderEl = t.inputEl;
      });

    new Setting(contentEl)
      .setName("Extensions")
      .setDesc("Only these extensions (comma/space separated). Leave empty for every non-Markdown file.")
      .addText((t) => {
        t.setPlaceholder("e.g. png, jpg, pdf");
        t.setValue(this.plugin.settings.companionExts);
        this.extsEl = t.inputEl;
      });

    new Setting(contentEl)
      .setName("Companion destination")
      .setDesc("Leave empty to create companions adjacent to their files (default). A folder path here collects them instead, mirroring the source structure.")
      .addText((t) => {
        t.setPlaceholder("(adjacent)");
        t.setValue(this.plugin.settings.companionsFolder);
        this.destEl = t.inputEl;
      });

    const buttons = new Setting(contentEl);
    buttons.addButton((b) => b.setButtonText("Scan").setCta().onClick(() => void this.scan()));
    buttons.addButton((b) => {
      b.setButtonText("Create / refresh").setDisabled(true).onClick(() => void this.apply());
      this.createBtn = b;
    });

    this.resultsEl = contentEl.createDiv();
  }

  private async scan(): Promise<void> {
    const root = this.resultsEl;
    if (!root) return;
    root.empty();

    const folder = this.folderEl?.value.trim().replace(/^\/+|\/+$/g, "") ?? "";
    const exts = parseExts(this.extsEl?.value ?? "");
    const dest = this.destEl?.value.trim().replace(/^\/+|\/+$/g, "") ?? "";

    this.plans = [];
    for (const file of this.app.vault.getFiles()) {
      if (!companionEligible(file, folder, exts, dest)) continue;
      const companionPath = companionPathFor(file, dest);
      this.plans.push({
        file,
        companionPath,
        existing: this.app.vault.getAbstractFileByPath(companionPath) instanceof TFile,
      });
    }

    const fresh = this.plans.filter((p) => !p.existing).length;
    const refresh = this.plans.length - fresh;
    root.createDiv({
      cls: "bases-toolbox-fr-info",
      text: this.plans.length
        ? `${this.plans.length} file${this.plans.length === 1 ? "" : "s"} in scope: ${fresh} new companion${fresh === 1 ? "" : "s"} to create, ${refresh} existing to refresh.`
        : "No non-Markdown files in scope.",
    });
    const list = root.createDiv({ cls: "bases-toolbox-pin-list" });
    for (const plan of this.plans.slice(0, 40)) {
      list.createDiv({
        cls: "bases-toolbox-index-empty",
        text: `${plan.file.path} → ${plan.companionPath}${plan.existing ? "  (refresh)" : ""}`,
      });
    }
    if (this.plans.length > 40)
      list.createDiv({ cls: "bases-toolbox-index-empty", text: `…and ${this.plans.length - 40} more.` });

    this.createBtn?.setDisabled(!this.plans.length);
  }

  private async apply(): Promise<void> {
    if (this.running || !this.plans.length) return;
    this.running = true;
    try {
      const dest = this.destEl?.value.trim().replace(/^\/+|\/+$/g, "") ?? "";
      this.plugin.settings.companionsFolder = dest;
      this.plugin.settings.companionExts = this.extsEl?.value.trim() ?? "";
      await this.plugin.savePluginData();

      let created = 0;
      let refreshed = 0;
      for (const plan of this.plans) {
        const result = await createOrRefreshCompanion(this.plugin, plan.file, dest);
        if (result === "created") created++;
        else refreshed++;
      }
      new Notice(
        `Companions: created ${created}, refreshed ${refreshed}. Delete a companion note to remove it — the original file is never touched.`
      );
      this.close();
    } catch (e) {
      new Notice(`Companion creation failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running = false;
    }
  }
}

/* ---------- metadata stamp for Markdown notes ---------- */

/**
 * Snapshots the CURRENT filesystem metadata of Markdown notes into durable
 * frontmatter properties — because ctime/mtime get destroyed by syncs,
 * copies, and migrations, while frontmatter travels with the note forever.
 * Set-if-missing by default; logged to history and revertible.
 */
export class MetadataStampModal extends Modal {
  private plugin: BasesToolboxPlugin;
  private folderEl: HTMLInputElement | null = null;
  private createdEl: HTMLInputElement | null = null;
  private modifiedEl: HTMLInputElement | null = null;
  private overwrite = false;
  private running = false;

  constructor(plugin: BasesToolboxPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.setText("Stamp file metadata into note properties");
    const { contentEl } = this;

    contentEl.createDiv({
      cls: "bases-toolbox-fr-info",
      text: "Writes each Markdown note's CURRENT created/modified times into frontmatter properties — a durable snapshot, since filesystem timestamps get destroyed by syncs and migrations while frontmatter travels with the note. Existing values are kept unless you opt into overwriting. Logged to history and revertible.",
    });

    new Setting(contentEl)
      .setName("Folder scope")
      .setDesc("Only notes under this folder. Leave empty for the whole vault.")
      .addText((t) => {
        t.setPlaceholder("e.g. Projects");
        this.folderEl = t.inputEl;
      });

    new Setting(contentEl)
      .setName("Created-time property")
      .setDesc("Leave empty to skip stamping created time.")
      .addText((t) => {
        t.setValue("created");
        this.createdEl = t.inputEl;
      });

    new Setting(contentEl)
      .setName("Modified-time property")
      .setDesc("Leave empty to skip stamping modified time.")
      .addText((t) => {
        t.setValue("modified");
        this.modifiedEl = t.inputEl;
      });

    new Setting(contentEl)
      .setName("Overwrite existing values")
      .setDesc("Off (default): notes that already have the property keep their value — only missing ones are stamped.")
      .addToggle((t) => t.setValue(this.overwrite).onChange((v) => (this.overwrite = v)));

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Stamp").setCta().onClick(() => void this.apply())
    );
  }

  private async apply(): Promise<void> {
    if (this.running) return;
    const folder = this.folderEl?.value.trim().replace(/^\/+|\/+$/g, "") ?? "";
    const createdProp = this.createdEl?.value.trim() ?? "";
    const modifiedProp = this.modifiedEl?.value.trim() ?? "";
    if (!createdProp && !modifiedProp) {
      new Notice("Name at least one property to stamp.");
      return;
    }
    this.running = true;
    try {
      const changes: ChangeRecord[] = [];
      const files = this.app.vault
        .getMarkdownFiles()
        .filter((f) => !folder || f.path.startsWith(folder + "/"));
      for (const file of files) {
        const stamps: [string, string][] = [];
        if (createdProp) stamps.push([createdProp, toLocalDatetime(file.stat.ctime)]);
        if (modifiedProp) stamps.push([modifiedProp, toLocalDatetime(file.stat.mtime)]);
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          for (const [prop, value] of stamps) {
            const key = findKey(fm, prop);
            const existed = key !== null;
            if (existed && !this.overwrite) continue;
            const cur = existed ? fm[key as string] : undefined;
            if (existed && cur === value) continue;
            changes.push({
              path: file.path,
              property: prop,
              oldValue: existed ? cur : undefined,
              newValue: value,
              ...(existed ? {} : { created: true }),
            });
            fm[key ?? prop] = value;
          }
        });
      }
      if (changes.length) {
        await this.plugin.addHistoryEntry({
          property:
            createdProp && modifiedProp ? `${createdProp} + ${modifiedProp}` : createdProp || modifiedProp,
          find: null,
          replace: "stamped from file metadata",
          timestamp: Date.now(),
          changes,
          source: "metadata stamp",
        });
      }
      new Notice(
        `Stamped ${changes.length} propert${changes.length === 1 ? "y" : "ies"} across ${files.length} note${files.length === 1 ? "" : "s"}. Revertible from history.`
      );
      this.close();
    } finally {
      this.running = false;
    }
  }
}
