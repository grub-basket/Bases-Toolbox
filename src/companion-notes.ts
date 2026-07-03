import { ButtonComponent, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import type BasesToolboxPlugin from "./main";

/**
 * Companion notes for non-Markdown files: Bases only reads frontmatter from
 * .md files, so images, PDFs, audio, and other attachments are invisible to
 * it. This creates a small companion note per file — named `<file>.<ext>.md`
 * — whose frontmatter replicates the file's metadata (name, extension, size,
 * created, modified, path) plus a link to the file, making every attachment
 * queryable in a base. Companions live adjacent to their file by default, or
 * in a designated folder (mirroring the source structure).
 *
 * Re-running REFRESHES the `file-*` properties of existing companions while
 * preserving any properties the user added — it never deletes or overwrites
 * user data. (Pattern borrowed from Stashpad's importer: non-note files get
 * a linking note; metadata comes from `TFile.stat`.)
 */

interface CompanionPlan {
  file: TFile;
  companionPath: string;
  existing: TFile | null;
}

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
      text: "Bases can't read properties from non-Markdown files. Companions are small notes (one per file, named <file>.<ext>.md) carrying the file's metadata as frontmatter plus a link — so attachments become queryable in a base. Re-running refreshes the file-* properties and never touches properties you added.",
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

  private destinationFor(file: TFile, dest: string): string {
    if (!dest) {
      const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
      return `${dir}${file.name}.md`;
    }
    return normalizePath(`${dest}/${file.path}.md`);
  }

  private async scan(): Promise<void> {
    const root = this.resultsEl;
    if (!root) return;
    root.empty();

    const folder = this.folderEl?.value.trim().replace(/^\/+|\/+$/g, "") ?? "";
    const exts = new Set(
      (this.extsEl?.value ?? "")
        .split(/[\s,;]+/)
        .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
        .filter(Boolean)
    );
    const dest = this.destEl?.value.trim().replace(/^\/+|\/+$/g, "") ?? "";

    this.plans = [];
    for (const file of this.app.vault.getFiles()) {
      if (file.extension === "md") continue;
      // Never companion a file DERIVED from a note (e.g. "X.md.edtz", an
      // encrypted shadow another plugin made of a companion) — companioning
      // derivatives cascades forever between two plugins' watchers.
      if (file.name.includes(".md.")) continue;
      if (folder && !file.path.startsWith(folder + "/")) continue;
      if (exts.size && !exts.has(file.extension.toLowerCase())) continue;
      if (dest && file.path.startsWith(dest + "/")) continue; // don't companion the companions' folder
      const companionPath = this.destinationFor(file, dest);
      const existing = this.app.vault.getAbstractFileByPath(companionPath);
      this.plans.push({
        file,
        companionPath,
        existing: existing instanceof TFile ? existing : null,
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
      await this.plugin.savePluginData();

      let created = 0;
      let refreshed = 0;
      for (const plan of this.plans) {
        const props = fileProps(plan.file);
        if (plan.existing) {
          // refresh file-* metadata; user-added properties are untouched
          await this.app.fileManager.processFrontMatter(plan.existing, (fm) => {
            Object.assign(fm, props);
          });
          refreshed++;
        } else {
          await this.ensureParent(plan.companionPath);
          const target = this.app.vault.getAbstractFileByPath(plan.companionPath);
          if (target) continue; // raced into existence — next run refreshes it
          const file = await this.app.vault.create(plan.companionPath, `![[${plan.file.path}]]\n`);
          await this.app.fileManager.processFrontMatter(file, (fm) => {
            Object.assign(fm, props);
          });
          created++;
        }
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

  private async ensureParent(path: string): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (!dir) return;
    if (this.app.vault.getAbstractFileByPath(dir) instanceof TFolder) return;
    await this.app.vault.createFolder(dir).catch(() => undefined);
  }
}
