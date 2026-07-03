import { Modal, Notice, Setting, TFile } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { parseReplacement } from "./find-replace";
import { findKey } from "./scan";
import { ChangeRecord } from "./types";

/**
 * Migrates Dataview inline fields (`Key:: value` lines and `[key:: value]`
 * spans) into real frontmatter properties, so Bases can see them.
 *
 * Prior art: the "Dataview to Properties" plugin covers the basic case
 * (https://github.com/tsunemaru/dataview-to-properties); this version adds
 * scoping, a dry-run preview, and logs the frontmatter side to the plugin's
 * history so it can be reverted.
 */

interface FoundField {
  key: string;
  value: string;
  /** Whole-line field vs bracketed inline span. */
  line: boolean;
}

const LINE_FIELD = /^([A-Za-z][\w /-]{0,80})::\s*(.+)$/;
const BRACKET_FIELD = /\[([^[\]:()]{1,80})::\s*([^\]]*)\]/g;

function findFields(body: string, includeBracketed: boolean): FoundField[] {
  const out: FoundField[] = [];
  for (const line of body.split("\n")) {
    const m = line.trim().match(LINE_FIELD);
    if (m && !m[1].startsWith("http")) out.push({ key: m[1].trim(), value: m[2].trim(), line: true });
  }
  if (includeBracketed) {
    for (const m of body.matchAll(BRACKET_FIELD)) {
      out.push({ key: m[1].trim(), value: m[2].trim(), line: false });
    }
  }
  return out;
}

function bodyOf(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export class InlineFieldMigratorModal extends Modal {
  private plugin: BasesToolboxPlugin;
  private folderEl: HTMLInputElement | null = null;
  private bracketed = true;
  private removeLines = false;
  private overwrite = false;
  private resultsEl: HTMLElement | null = null;
  private found: Map<TFile, FoundField[]> = new Map();
  private applyBtnSetting: Setting | null = null;
  private running = false;

  constructor(plugin: BasesToolboxPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.setText("Migrate inline fields to properties");
    const { contentEl } = this;
    this.modalEl.addClass("bases-toolbox-csv-modal");

    new Setting(contentEl)
      .setName("Folder scope")
      .setDesc("Only notes under this folder. Leave empty for the whole vault.")
      .addText((t) => {
        t.setPlaceholder("e.g. Projects");
        this.folderEl = t.inputEl;
      });

    new Setting(contentEl)
      .setName("Include bracketed fields")
      .setDesc("Also migrate [key:: value] spans inside lines, not just whole-line fields.")
      .addToggle((t) => t.setValue(this.bracketed).onChange((v) => (this.bracketed = v)));

    new Setting(contentEl)
      .setName("Remove migrated fields from note bodies")
      .setDesc(
        "Whole-line fields are deleted; bracketed spans are replaced by their value. NOT revertible (the frontmatter side is — via history). Off = safe default."
      )
      .addToggle((t) => t.setValue(this.removeLines).onChange((v) => (this.removeLines = v)));

    new Setting(contentEl)
      .setName("Overwrite existing properties")
      .setDesc("If a note already has the property in frontmatter, replace it. Off = skip those fields.")
      .addToggle((t) => t.setValue(this.overwrite).onChange((v) => (this.overwrite = v)));

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Scan").setCta().onClick(() => void this.scan())
    );
    this.resultsEl = contentEl.createDiv();
  }

  private scopedFiles(): TFile[] {
    const folder = this.folderEl?.value.trim().replace(/\/+$/, "") ?? "";
    const files = this.app.vault.getMarkdownFiles();
    return folder ? files.filter((f) => f.path.startsWith(folder + "/")) : files;
  }

  private async scan(): Promise<void> {
    const root = this.resultsEl;
    if (!root) return;
    root.empty();
    root.createDiv({ cls: "bases-toolbox-fr-info", text: "Scanning…" });

    this.found.clear();
    for (const file of this.scopedFiles()) {
      const body = bodyOf(await this.app.vault.cachedRead(file));
      if (!body.includes("::")) continue;
      const fields = findFields(body, this.bracketed);
      if (fields.length) this.found.set(file, fields);
    }

    root.empty();
    const totalFields = [...this.found.values()].reduce((a, b) => a + b.length, 0);
    if (!totalFields) {
      root.createDiv({ cls: "bases-toolbox-fr-info", text: "No inline fields found in scope." });
      return;
    }
    root.createDiv({
      cls: "bases-toolbox-fr-info",
      text: `${totalFields} field${totalFields === 1 ? "" : "s"} in ${this.found.size} file${this.found.size === 1 ? "" : "s"}:`,
    });
    const list = root.createDiv({ cls: "bases-toolbox-pin-list" });
    let shown = 0;
    for (const [file, fields] of this.found) {
      for (const f of fields) {
        if (++shown > 60) break;
        list.createDiv({
          cls: "bases-toolbox-index-empty",
          text: `${file.basename}: ${f.key} = ${f.value}${f.line ? "" : "  (bracketed)"}`,
        });
      }
      if (shown > 60) break;
    }
    if (totalFields > 60)
      list.createDiv({ cls: "bases-toolbox-index-empty", text: `…and ${totalFields - 60} more.` });

    this.applyBtnSetting?.settingEl.remove();
    this.applyBtnSetting = new Setting(root).addButton((b) =>
      b
        .setButtonText(`Migrate ${totalFields} field${totalFields === 1 ? "" : "s"}`)
        .setCta()
        .onClick(() => void this.apply())
    );
  }

  private async apply(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const changes: ChangeRecord[] = [];
      let skipped = 0;
      for (const [file, fields] of this.found) {
        const migrated: FoundField[] = [];
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          for (const f of fields) {
            const key = findKey(fm, f.key);
            if (key !== null && !this.overwrite) {
              skipped++;
              continue;
            }
            const value = parseReplacement(f.value, null);
            const cur = key !== null ? fm[key] : undefined;
            if (key !== null && JSON.stringify(cur) === JSON.stringify(value)) {
              migrated.push(f); // already identical — safe to clean the body
              continue;
            }
            changes.push({
              path: file.path,
              property: f.key,
              oldValue: key !== null ? cur : undefined,
              newValue: value,
              ...(key !== null ? {} : { created: true }),
            });
            fm[key ?? f.key] = value;
            migrated.push(f);
          }
        });

        if (this.removeLines && migrated.length) {
          await this.app.vault.process(file, (content) => {
            let next = content;
            for (const f of migrated) {
              if (f.line) {
                next = next
                  .split("\n")
                  .filter((line) => {
                    const m = line.trim().match(LINE_FIELD);
                    return !(m && m[1].trim() === f.key && m[2].trim() === f.value);
                  })
                  .join("\n");
              } else {
                next = next.split(`[${f.key}:: ${f.value}]`).join(f.value);
              }
            }
            return next;
          });
        }
      }

      if (changes.length) {
        await this.plugin.addHistoryEntry({
          property: "(inline fields)",
          find: null,
          replace: "migrated to frontmatter",
          timestamp: Date.now(),
          changes,
          source: "inline-field migration",
        });
      }
      new Notice(
        `Migrated ${changes.length} field${changes.length === 1 ? "" : "s"}` +
          (skipped ? `, skipped ${skipped} already-set` : "") +
          ". Frontmatter side is revertible from history."
      );
      this.close();
    } finally {
      this.running = false;
    }
  }
}
