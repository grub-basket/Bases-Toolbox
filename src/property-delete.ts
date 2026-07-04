import { FileSystemAdapter, Modal, Notice, Platform, Setting } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { ChangeRecord } from "./types";
import { PropertyUsage, findKey, getPropertyType } from "./scan";

/**
 * Deleting a property from the Property Index: removes the frontmatter key from
 * every file that carries it, logs the change to the history/revert engine (so
 * it's undoable), AND appends a durable JSONL audit record per file so there's
 * a permanent, out-of-band trail of what was removed. The audit lives next to
 * the plugin's data so it survives even if history is trimmed.
 */

/** One line of the deletion audit (serialized as JSON, one per file). */
export interface DeletionRecord {
  property: string;
  /** ISO-8601 UTC, human/tool-friendly. */
  deletedAt: string;
  /** Epoch millis, for sorting/joins. */
  deletedAtEpoch: number;
  /** Path at the moment of deletion (files move; this is a snapshot). */
  filePath: string;
  fileName: string;
  /** A stable id from an id-like frontmatter key, if the note had one. */
  fileId: string | null;
  /** The value that was removed. */
  oldValue: unknown;
  /** Assigned Obsidian property widget type, if known. */
  propertyType: string | null;
  vault: string;
}

/** Frontmatter keys we treat as a note's stable identifier, in priority order. */
const ID_KEYS = ["id", "uid", "uuid", "guid"];

function fileIdOf(fm: Record<string, unknown>): string | null {
  for (const k of ID_KEYS) {
    const key = findKey(fm, k);
    if (key !== null && fm[key] != null && fm[key] !== "") return String(fm[key]);
  }
  return null;
}

const cloneVal = (v: unknown): unknown => (Array.isArray(v) ? v.slice() : v);

/** Vault-relative path of the append-only audit log. */
function auditPath(plugin: BasesToolboxPlugin): string {
  return `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}/deleted-properties.jsonl`;
}

/** Absolute on-disk path (desktop only — mobile has no real filesystem path). */
export function absAuditPath(plugin: BasesToolboxPlugin): string | null {
  const adapter = plugin.app.vault.adapter;
  return adapter instanceof FileSystemAdapter ? adapter.getFullPath(auditPath(plugin)) : null;
}

async function appendAudit(plugin: BasesToolboxPlugin, records: DeletionRecord[]): Promise<void> {
  const path = auditPath(plugin);
  const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const adapter = plugin.app.vault.adapter;
  if (await adapter.exists(path)) await adapter.append(path, text);
  else await adapter.write(path, text);
}

/** Electron shell, lazily and safely (absent on mobile / if unavailable). */
function electronShell(): { showItemInFolder?: (p: string) => void; openPath?: (p: string) => Promise<string> } | null {
  if (!Platform.isDesktopApp) return null;
  try {
    const req = (window as unknown as { require?: (m: string) => unknown }).require;
    const electron = req?.("electron") as { shell?: ReturnType<typeof electronShell> } | undefined;
    return electron?.shell ?? null;
  } catch {
    return null;
  }
}

/** Reveal a file in Finder / File Explorer. Returns false if it couldn't. */
export function revealInSystem(absPath: string): boolean {
  const shell = electronShell();
  if (shell?.showItemInFolder) {
    shell.showItemInFolder(absPath);
    return true;
  }
  return false;
}

/** Open a file with the OS default app. Returns false if it couldn't. */
export function openInDefaultApp(plugin: BasesToolboxPlugin, relPath: string, absPath: string): boolean {
  const shell = electronShell();
  if (shell?.openPath) {
    void shell.openPath(absPath);
    return true;
  }
  const openWith = (plugin.app as unknown as { openWithDefaultApp?: (p: string) => void }).openWithDefaultApp;
  if (typeof openWith === "function") {
    openWith.call(plugin.app, relPath);
    return true;
  }
  return false;
}

/**
 * Removes `usage.name` from every file that has it. Returns how many files were
 * changed plus the audit records and the audit file's absolute path.
 */
export async function deletePropertyEverywhere(
  plugin: BasesToolboxPlugin,
  usage: PropertyUsage
): Promise<{ count: number; records: DeletionRecord[]; absPath: string | null }> {
  const changes: ChangeRecord[] = [];
  const records: DeletionRecord[] = [];
  const ts = Date.now();
  const iso = new Date(ts).toISOString();
  const type = usage.type ?? getPropertyType(plugin.app, usage.name);

  for (const file of usage.files) {
    await plugin.app.fileManager.processFrontMatter(file, (fm) => {
      const key = findKey(fm, usage.name);
      if (key === null) return;
      const oldValue = cloneVal(fm[key]);
      const fileId = fileIdOf(fm);
      delete fm[key];
      changes.push({ path: file.path, property: usage.name, oldValue, deleted: true });
      records.push({
        property: usage.name,
        deletedAt: iso,
        deletedAtEpoch: ts,
        filePath: file.path,
        fileName: file.name,
        fileId,
        oldValue,
        propertyType: type,
        vault: plugin.app.vault.getName(),
      });
    });
  }

  if (changes.length) {
    await plugin.addHistoryEntry({
      property: usage.name,
      find: null,
      replace: "(deleted)",
      timestamp: ts,
      changes,
      source: "property index delete",
    });
    await appendAudit(plugin, records);
  }
  return { count: changes.length, records, absPath: absAuditPath(plugin) };
}

/* ---------- UI ---------- */

/** Generic confirm dialog (also reused for "open many tabs"). */
export class ConfirmModal extends Modal {
  constructor(
    plugin: BasesToolboxPlugin,
    private opts: { title: string; body: string; confirmText: string; danger?: boolean; onConfirm: () => void }
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText(this.opts.title);
    this.contentEl.createEl("p", { text: this.opts.body });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => {
        b.setButtonText(this.opts.confirmText).onClick(() => {
          this.close();
          this.opts.onConfirm();
        });
        // setWarning() can silently no-op in this Obsidian build; add the class.
        if (this.opts.danger) b.buttonEl.addClass("mod-warning");
        else b.setCta();
      });
  }
}

/** Reads the audit and lets the user open/reveal/copy it. */
export class DeletionExportModal extends Modal {
  constructor(
    private plugin: BasesToolboxPlugin,
    private absPath: string | null,
    private records: DeletionRecord[]
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText("Deletion export");
    const { contentEl } = this;

    if (this.absPath) {
      const p = contentEl.createEl("p", { cls: "bases-toolbox-del-path" });
      p.createSpan({ text: "Saved to: " });
      p.createEl("code", { text: this.absPath });
    } else {
      contentEl.createEl("p", {
        text: "Audit written next to the plugin data. (No filesystem path available on this platform.)",
      });
    }

    contentEl.createEl("p", {
      cls: "bases-toolbox-fr-info",
      text: `${this.records.length} record${this.records.length === 1 ? "" : "s"} just appended (most recent):`,
    });
    const pre = contentEl.createEl("pre", { cls: "bases-toolbox-del-preview" });
    pre.setText(this.records.slice(0, 8).map((r) => JSON.stringify(r, null, 2)).join("\n"));

    const row = new Setting(contentEl);
    if (this.absPath) {
      row.addButton((b) =>
        b
          .setButtonText("Open in default app")
          .setCta()
          .onClick(() => {
            if (!openInDefaultApp(this.plugin, auditPath(this.plugin), this.absPath!))
              new Notice("Couldn't open the file on this platform.");
          })
      );
      row.addButton((b) =>
        b.setButtonText(Platform.isMacOS ? "Reveal in Finder" : "Reveal in file explorer").onClick(() => {
          if (!revealInSystem(this.absPath!)) new Notice("Reveal isn't available on this platform.");
        })
      );
      row.addButton((b) =>
        b.setButtonText("Copy path").onClick(() => {
          void navigator.clipboard.writeText(this.absPath!);
          new Notice("Path copied.");
        })
      );
    }
  }
}

/**
 * Persistent, theme-aware toast confirming a deletion, with a button that opens
 * the export modal. Notices already use theme variables, so this reads well in
 * both light and dark; the button picks up the accent color via CSS.
 */
export function notifyDeletion(
  plugin: BasesToolboxPlugin,
  propertyName: string,
  count: number,
  absPath: string | null,
  records: DeletionRecord[]
): void {
  const frag = createFragment((f) => {
    f.createSpan({
      text: `Deleted “${propertyName}” from ${count} file${count === 1 ? "" : "s"}. Undo via history.`,
    });
    f.createEl("br");
    const btn = f.createEl("button", { cls: "bases-toolbox-del-open", text: "Open export…" });
    btn.addEventListener("click", () => new DeletionExportModal(plugin, absPath, records).open());
  });
  new Notice(frag, 0);
}
