import { FileSystemAdapter, Modal, Notice, Platform, Setting, TFile } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { ChangeRecord } from "./types";
import { PropertyUsage, findKey, getPropertyType } from "./scan";

/**
 * Deleting/renaming a property from the Property Index. Deletes remove the
 * frontmatter key (from all files, one value's files, or a single file), log to
 * the history/revert engine (so they're undoable), AND append a durable JSONL
 * audit record per file. The audit is one growing file PER PROPERTY NAME, in a
 * `deletions/` subfolder of the plugin dir — out of the vault's note space.
 *
 * Because deletions are undoable, the audit isn't purely append-only: when a
 * deletion is restored, its records are pruned back out of the JSONL.
 */

export type DeleteScope = "property" | "value" | "file";

/** One line of the deletion audit (serialized as JSON, one per file). */
export interface DeletionRecord {
  property: string;
  /** Which granularity triggered it. */
  scope: DeleteScope;
  /** For value-scoped deletes, the value that was targeted. */
  value?: string;
  /** ISO-8601 UTC. */
  deletedAt: string;
  /** Epoch millis — also the key that links a record to its history entry. */
  deletedAtEpoch: number;
  filePath: string;
  fileName: string;
  /** Stable id from an id-like frontmatter key, if the note had one. */
  fileId: string | null;
  oldValue: unknown;
  propertyType: string | null;
  vault: string;
}

const ID_KEYS = ["id", "uid", "uuid", "guid"];

function fileIdOf(fm: Record<string, unknown>): string | null {
  for (const k of ID_KEYS) {
    const key = findKey(fm, k);
    if (key !== null && fm[key] != null && fm[key] !== "") return String(fm[key]);
  }
  return null;
}

const cloneVal = (v: unknown): unknown => (Array.isArray(v) ? v.slice() : v);

/* ---------- audit storage (one JSONL per property) ---------- */

function deletionsDir(plugin: BasesToolboxPlugin): string {
  return `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}/deletions`;
}

/** Filesystem-safe file stem for a property name. */
function safeName(name: string): string {
  // Matching control chars 0x00–0x1f is deliberate here — we're stripping them
  // (plus the illegal filename chars) out of the audit filename.
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim() || "_";
}

function propertyAuditPath(plugin: BasesToolboxPlugin, property: string): string {
  return `${deletionsDir(plugin)}/${safeName(property)}.jsonl`;
}

/** Absolute on-disk path of a property's audit file (desktop only). */
export function absPropertyAuditPath(plugin: BasesToolboxPlugin, property: string): string | null {
  const adapter = plugin.app.vault.adapter;
  return adapter instanceof FileSystemAdapter
    ? adapter.getFullPath(propertyAuditPath(plugin, property))
    : null;
}

async function appendAudit(plugin: BasesToolboxPlugin, property: string, records: DeletionRecord[]): Promise<void> {
  const adapter = plugin.app.vault.adapter;
  const dir = deletionsDir(plugin);
  if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
  const path = propertyAuditPath(plugin, property);
  const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  if (await adapter.exists(path)) await adapter.append(path, text);
  else await adapter.write(path, text);
}

/**
 * Removes audit records for a restored deletion: matches on the op's epoch and
 * the restored file paths. Rewrites the property's JSONL without them (leaving
 * an empty file if nothing remains — we truncate rather than delete on disk).
 */
export async function pruneDeletionAudit(
  plugin: BasesToolboxPlugin,
  property: string,
  opEpoch: number,
  paths: Set<string>
): Promise<void> {
  const adapter = plugin.app.vault.adapter;
  const path = propertyAuditPath(plugin, property);
  if (!(await adapter.exists(path))) return;
  const kept: string[] = [];
  for (const line of (await adapter.read(path)).split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as DeletionRecord;
      if (r.deletedAtEpoch === opEpoch && r.property === property && paths.has(r.filePath)) continue;
    } catch {
      // keep unparseable lines rather than lose data
    }
    kept.push(line);
  }
  await adapter.write(path, kept.length ? kept.join("\n") + "\n" : "");
}

/* ---------- delete ---------- */

export interface DeleteResult {
  property: string;
  count: number;
  records: DeletionRecord[];
  absPath: string | null;
}

/** Removes `property` from each given file; logs history + appends the audit. */
export async function deletePropertyFromFiles(
  plugin: BasesToolboxPlugin,
  property: string,
  files: TFile[],
  opts: { scope: DeleteScope; value?: string; type?: string | null } = { scope: "property" }
): Promise<DeleteResult> {
  const changes: ChangeRecord[] = [];
  const records: DeletionRecord[] = [];
  const ts = Date.now();
  const iso = new Date(ts).toISOString();
  const type = opts.type ?? getPropertyType(plugin.app, property);

  for (const file of new Set(files)) {
    await plugin.app.fileManager.processFrontMatter(file, (fm) => {
      const key = findKey(fm, property);
      if (key === null) return;
      const oldValue = cloneVal(fm[key]);
      const fileId = fileIdOf(fm);
      delete fm[key];
      changes.push({ path: file.path, property, oldValue, deleted: true });
      records.push({
        property,
        scope: opts.scope,
        ...(opts.value !== undefined ? { value: opts.value } : {}),
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
      property,
      find: opts.value ?? null,
      replace: "(deleted)",
      timestamp: ts,
      changes,
      source: "property index delete",
    });
    await appendAudit(plugin, property, records);
  }
  return { property, count: changes.length, records, absPath: absPropertyAuditPath(plugin, property) };
}

/** Convenience: delete a property from every file it appears in. */
export function deletePropertyEverywhere(plugin: BasesToolboxPlugin, usage: PropertyUsage): Promise<DeleteResult> {
  return deletePropertyFromFiles(plugin, usage.name, usage.files, { scope: "property", type: usage.type });
}

/* ---------- rename ---------- */

/**
 * Renames a property across every file. When a file already has the target
 * property, the old key is folded away (target value wins) — the same outcome
 * as Obsidian's native rename. Fully logged, so a rename is undoable: the old
 * key's value is captured on every change.
 */
export async function renamePropertyEverywhere(
  plugin: BasesToolboxPlugin,
  usage: PropertyUsage,
  newName: string
): Promise<{ renamed: number; merged: number }> {
  const changes: ChangeRecord[] = [];
  let renamed = 0;
  let merged = 0;
  const ts = Date.now();

  for (const file of usage.files) {
    await plugin.app.fileManager.processFrontMatter(file, (fm) => {
      const oldKey = findKey(fm, usage.name);
      if (oldKey === null) return;
      const value = cloneVal(fm[oldKey]);
      const targetKey = findKey(fm, newName);
      // Always record the removal of the old key (captures oldValue for undo).
      changes.push({ path: file.path, property: usage.name, oldValue: value, deleted: true });
      if (targetKey !== null && targetKey !== oldKey) {
        // Target exists → fold: drop old, keep the target's value.
        delete fm[oldKey];
        merged++;
      } else {
        changes.push({ path: file.path, property: newName, oldValue: undefined, newValue: value, created: true });
        delete fm[oldKey];
        fm[newName] = value;
        renamed++;
      }
    });
  }

  if (changes.length) {
    await plugin.addHistoryEntry({
      property: `${usage.name} → ${newName}`,
      find: null,
      replace: "renamed property",
      timestamp: ts,
      changes,
      source: "property index rename",
    });
  }
  return { renamed, merged };
}

/* ---------- system helpers ---------- */

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

export function revealInSystem(absPath: string): boolean {
  const shell = electronShell();
  if (shell?.showItemInFolder) {
    shell.showItemInFolder(absPath);
    return true;
  }
  return false;
}

export function openInDefaultApp(absPath: string): boolean {
  const shell = electronShell();
  if (shell?.openPath) {
    void shell.openPath(absPath);
    return true;
  }
  return false;
}

/* ---------- UI ---------- */

/** Generic confirm dialog (reused for delete + "open many tabs"). */
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

/** Single-line text prompt (used for rename). */
export class PromptModal extends Modal {
  constructor(
    plugin: BasesToolboxPlugin,
    private opts: { title: string; body?: string; initial: string; confirmText: string; onSubmit: (v: string) => void }
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText(this.opts.title);
    if (this.opts.body) this.contentEl.createEl("p", { text: this.opts.body });
    let value = this.opts.initial;
    const submit = () => {
      const v = value.trim();
      if (!v) return;
      this.close();
      this.opts.onSubmit(v);
    };
    new Setting(this.contentEl).addText((t) => {
      t.setValue(this.opts.initial).onChange((v) => (value = v));
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      });
      window.setTimeout(() => t.inputEl.select(), 0);
    });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText(this.opts.confirmText).setCta().onClick(submit));
  }
}

/** Reads a property's audit and lets the user open/reveal/copy it. */
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
            if (!openInDefaultApp(this.absPath!)) new Notice("Couldn't open the file on this platform.");
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
 * the export modal. Notices already use theme variables, so it reads well in
 * light and dark; the button picks up the accent color via CSS.
 */
export function notifyDeletion(
  plugin: BasesToolboxPlugin,
  result: DeleteResult,
  descriptor: string
): void {
  const frag = createFragment((f) => {
    f.createSpan({ text: `Deleted ${descriptor}. Undo via history.` });
    f.createEl("br");
    const btn = f.createEl("button", { cls: "bases-toolbox-del-open", text: "Open export…" });
    btn.addEventListener("click", () => new DeletionExportModal(plugin, result.absPath, result.records).open());
  });
  new Notice(frag, 0);
}
