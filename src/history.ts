import { Notice, TFile, TFolder, parseYaml, stringifyYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { pruneDeletionAudit } from "./property-delete";
import { findKey } from "./scan";
import { ChangeRecord, HistoryEntry, ViewOpUndo } from "./types";

export type SkipReason = "edited since" | "property missing" | "file missing" | "path reused";

export interface RevertReport {
  restored: number;
  /** Property gone from the file (deleted or renamed) — left alone. */
  propertyMissing: number;
  /** Value edited again since the operation — left alone. */
  valueChanged: number;
  /** File deleted or moved. */
  fileMissing: number;
  /** Every file that was NOT reverted, with why — for the UI to surface. */
  skipped: { path: string; property: string; reason: SkipReason }[];
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface RevertOptions {
  /** Restrict the revert to these file paths (undefined = all). */
  paths?: Set<string>;
  /** Also overwrite files whose value drifted (was edited again) since. */
  force?: boolean;
}

/** True when the change is still "in effect" in this frontmatter (no drift). */
export function changeInEffect(fm: Record<string, unknown>, change: ChangeRecord): boolean {
  const key = findKey(fm, change.property);
  if (change.deleted) return key === null; // deletion still holds
  if (key === null) return false; // property gone (renamed/removed)
  if (change.newValue === undefined) return true; // legacy record: assume yes
  return sameValue(fm[key], change.newValue);
}

/**
 * Best-effort revert: a file is only restored when the operation's change is
 * still in effect (unless `force`). Renamed properties, re-edited values, and
 * missing files are skipped and counted, not clobbered. A `paths` subset
 * reverts only those files; the entry is marked reverted only on a full pass.
 */
/**
 * Restores whole-file snapshots (note merges). Overwrites modified files and
 * recreates removed ones. A removed file whose path is now occupied again is
 * counted as a conflict (fileMissing) rather than clobbered. All-or-nothing:
 * merge reverts don't support a file subset.
 */
async function revertSnapshots(
  plugin: BasesToolboxPlugin,
  entry: HistoryEntry
): Promise<RevertReport> {
  const report: RevertReport = { restored: 0, propertyMissing: 0, valueChanged: 0, fileMissing: 0, skipped: [] };
  const vault = plugin.app.vault;
  // Recreate the parent folder if it was deleted since the merge — otherwise
  // vault.create rejects and (uncaught) would abort the whole revert mid-way.
  const ensureFolder = async (filePath: string): Promise<void> => {
    const dir = filePath.slice(0, filePath.lastIndexOf("/"));
    if (dir && !(vault.getAbstractFileByPath(dir) instanceof TFolder)) {
      await vault.createFolder(dir).catch(() => undefined);
    }
  };
  for (const snap of entry.fileSnapshots ?? []) {
    const existing = vault.getAbstractFileByPath(snap.path);
    if (snap.kind === "removed" && existing) {
      report.fileMissing++; // path reused since the merge — don't clobber
      report.skipped.push({ path: snap.path, property: "(note)", reason: "path reused" });
      continue;
    }
    // Per-snapshot try/catch so one failure doesn't abort the rest of the revert.
    try {
      if (existing instanceof TFile) {
        await vault.modify(existing, snap.content);
      } else {
        // removed note, or kept note moved/deleted since — recreate at its path.
        await ensureFolder(snap.path);
        await vault.create(snap.path, snap.content);
      }
      report.restored++;
    } catch {
      report.fileMissing++;
      report.skipped.push({ path: snap.path, property: "(note)", reason: "file missing" });
    }
  }
  // Mark reverted only if every snapshot was restored (no conflicts/failures).
  if (report.fileMissing === 0) entry.revertedAt = Date.now();
  await plugin.saveHistory();
  return report;
}

type ViewNode = Record<string, unknown> & { name?: unknown };

const viewNameOf = (v: ViewNode): string => (typeof v.name === "string" ? v.name : "");

/**
 * Undo ONE base-view operation by applying its inverse to the file as it is
 * now, so later changes to the same base survive. Refuses (rather than
 * guesses) when the view it needs has been renamed or removed since — the
 * same "don't clobber newer work" stance as the property-level revert.
 */
async function revertViewOp(
  plugin: BasesToolboxPlugin,
  entry: HistoryEntry,
  undo: ViewOpUndo
): Promise<RevertReport> {
  const report: RevertReport = {
    restored: 0,
    propertyMissing: 0,
    valueChanged: 0,
    fileMissing: 0,
    skipped: [],
  };
  const skip = (reason: SkipReason): RevertReport => {
    if (reason === "file missing") report.fileMissing++;
    else report.valueChanged++;
    report.skipped.push({ path: undo.path, property: "(view)", reason });
    return report;
  };

  const file = plugin.app.vault.getAbstractFileByPath(undo.path);
  if (!(file instanceof TFile)) return skip("file missing");

  const raw = await plugin.app.vault.read(file);
  let doc: Record<string, unknown>;
  try {
    doc = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  } catch {
    return skip("file missing"); // unparseable now — don't overwrite it
  }
  const views: ViewNode[] = Array.isArray(doc.views) ? (doc.views as ViewNode[]) : [];

  /** Locate a view by name, preferring the remembered index when it matches. */
  const locate = (name: string, index?: number): number => {
    if (index !== undefined && views[index] && viewNameOf(views[index]) === name) return index;
    return views.findIndex((v) => viewNameOf(v) === name);
  };

  switch (undo.op) {
    case "rename": {
      const i = locate(undo.currentName ?? "", undo.index);
      if (i < 0) return skip("edited since"); // renamed again / deleted since
      // Don't collide with a view that now holds the old name.
      if (views.some((v, j) => j !== i && viewNameOf(v) === undo.previousName)) {
        return skip("edited since");
      }
      views[i].name = undo.previousName;
      break;
    }
    case "remove": {
      const i = locate(undo.name ?? "", undo.index);
      if (i < 0) return skip("edited since"); // already gone / renamed
      views.splice(i, 1);
      break;
    }
    case "insert": {
      if (!undo.node) return skip("edited since");
      const node = { ...undo.node } as ViewNode;
      // If its name was taken in the meantime, don't clobber — suffix it.
      const taken = new Set(views.map(viewNameOf));
      let name = viewNameOf(node);
      if (name && taken.has(name)) {
        let n = 2;
        let candidate = `${name} restored`;
        while (taken.has(candidate)) candidate = `${name} restored ${n++}`;
        node.name = candidate;
        name = candidate;
      }
      const at = Math.min(Math.max(undo.index ?? views.length, 0), views.length);
      views.splice(at, 0, node);
      break;
    }
    case "move": {
      const from = undo.fromIndex ?? -1;
      const to = undo.toIndex ?? -1;
      if (from < 0 || from >= views.length || to < 0 || to >= views.length) {
        return skip("edited since");
      }
      // Only move it back if the view still at `from` is the one we moved.
      if (undo.name && viewNameOf(views[from]) !== undo.name) return skip("edited since");
      const [moved] = views.splice(from, 1);
      views.splice(to, 0, moved);
      break;
    }
  }

  doc.views = views;
  await plugin.app.vault.modify(file, stringifyYaml(doc));
  report.restored = 1;
  entry.revertedAt = Date.now();
  await plugin.saveHistory();
  return report;
}

export async function revertEntry(
  plugin: BasesToolboxPlugin,
  entry: HistoryEntry,
  opts: RevertOptions = {}
): Promise<RevertReport> {
  // Surgical view undo wins over the whole-file snapshot: it leaves later
  // changes to the same base alone. Pre-0.1.53 entries have no viewUndo and
  // still fall back to the snapshot restore below.
  if (entry.viewUndo) return revertViewOp(plugin, entry, entry.viewUndo);
  if (entry.fileSnapshots?.length) return revertSnapshots(plugin, entry);
  const report: RevertReport = { restored: 0, propertyMissing: 0, valueChanged: 0, fileMissing: 0, skipped: [] };
  // Paths whose deleted-property change we actually restored — used to prune the
  // deletion audit so a restored deletion doesn't linger in the JSONL.
  const restoredDeletions: string[] = [];
  for (const change of entry.changes) {
    if (opts.paths && !opts.paths.has(change.path)) continue;
    const file = plugin.app.vault.getAbstractFileByPath(change.path);
    if (!(file instanceof TFile)) {
      report.fileMissing++;
      report.skipped.push({ path: change.path, property: change.property, reason: "file missing" });
      continue;
    }
    await plugin.app.fileManager.processFrontMatter(file, (fm) => {
      const key = findKey(fm, change.property);
      if (!opts.force && !changeInEffect(fm, change)) {
        if (key === null && !change.deleted) {
          report.propertyMissing++;
          report.skipped.push({ path: change.path, property: change.property, reason: "property missing" });
        } else {
          report.valueChanged++;
          report.skipped.push({ path: change.path, property: change.property, reason: "edited since" });
        }
        return;
      }
      if (change.created) {
        if (key !== null) delete fm[key];
      } else if (change.deleted) {
        fm[key ?? change.property] = change.oldValue;
        restoredDeletions.push(change.path);
      } else {
        if (key === null) {
          // force-restoring onto a renamed/removed property re-adds it
          fm[change.property] = change.oldValue;
        } else fm[key] = change.oldValue;
      }
      report.restored++;
    });
  }
  // Mark reverted only after a full pass with no drift-skips left — otherwise
  // the entry stays active so the user can retry (e.g. force-revert the
  // drifted files). Missing files can't be retried and don't block marking.
  if (!opts.paths && report.valueChanged + report.propertyMissing === 0) {
    entry.revertedAt = Date.now();
  }
  // Restoring a property-index deletion prunes its rows from the audit JSONL.
  if (entry.source === "property index delete" && restoredDeletions.length) {
    await pruneDeletionAudit(plugin, entry.property, entry.timestamp, new Set(restoredDeletions));
  }
  await plugin.saveHistory();
  return report;
}

export function reportNotice(entry: HistoryEntry, r: RevertReport): void {
  if (entry.fileSnapshots?.length) {
    const total = entry.fileSnapshots.length;
    new Notice(
      `Reverted merge: restored ${r.restored} of ${total} note${total === 1 ? "" : "s"}` +
        (r.fileMissing ? ` (${r.fileMissing} skipped — a note now occupies that path)` : "") +
        "."
    );
    return;
  }
  const skipped: string[] = [];
  if (r.valueChanged) skipped.push(`${r.valueChanged} edited since`);
  if (r.propertyMissing) skipped.push(`${r.propertyMissing} property missing`);
  if (r.fileMissing) skipped.push(`${r.fileMissing} file missing`);
  new Notice(
    `Reverted “${entry.property}” in ${r.restored} of ${entry.changes.length} file${
      entry.changes.length === 1 ? "" : "s"
    }${skipped.length ? ` (skipped: ${skipped.join(", ")})` : ""}.`
  );
}

/** Reverts the newest entry that hasn't been reverted yet. */
export async function undoLatest(plugin: BasesToolboxPlugin): Promise<void> {
  const entry = [...plugin.history].reverse().find((e) => !e.revertedAt);
  if (!entry) {
    new Notice("Nothing to undo.");
    return;
  }
  reportNotice(entry, await revertEntry(plugin, entry));
}

export function describeEntry(entry: HistoryEntry): string {
  // Merge entries carry a ready-made human label in `property` and no find/replace.
  if (entry.fileSnapshots?.length) return entry.property;
  const from = entry.find === null ? "all values" : `“${entry.find}”`;
  const to = entry.replace.trim() === "" ? "(cleared)" : `“${entry.replace}”`;
  return `${entry.property}: ${from} → ${to}`;
}
