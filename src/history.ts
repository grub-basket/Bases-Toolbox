import { Notice, TFile } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { pruneDeletionAudit } from "./property-delete";
import { findKey } from "./scan";
import { ChangeRecord, HistoryEntry } from "./types";

interface RevertReport {
  restored: number;
  /** Property gone from the file (deleted or renamed) — left alone. */
  propertyMissing: number;
  /** Value edited again since the operation — left alone. */
  valueChanged: number;
  /** File deleted or moved. */
  fileMissing: number;
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
export async function revertEntry(
  plugin: BasesToolboxPlugin,
  entry: HistoryEntry,
  opts: RevertOptions = {}
): Promise<RevertReport> {
  const report: RevertReport = { restored: 0, propertyMissing: 0, valueChanged: 0, fileMissing: 0 };
  // Paths whose deleted-property change we actually restored — used to prune the
  // deletion audit so a restored deletion doesn't linger in the JSONL.
  const restoredDeletions: string[] = [];
  for (const change of entry.changes) {
    if (opts.paths && !opts.paths.has(change.path)) continue;
    const file = plugin.app.vault.getAbstractFileByPath(change.path);
    if (!(file instanceof TFile)) {
      report.fileMissing++;
      continue;
    }
    await plugin.app.fileManager.processFrontMatter(file, (fm) => {
      const key = findKey(fm, change.property);
      if (!opts.force && !changeInEffect(fm, change)) {
        if (key === null && !change.deleted) report.propertyMissing++;
        else report.valueChanged++;
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
  await plugin.savePluginData();
  return report;
}

export function reportNotice(entry: HistoryEntry, r: RevertReport): void {
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
  const from = entry.find === null ? "all values" : `“${entry.find}”`;
  const to = entry.replace.trim() === "" ? "(cleared)" : `“${entry.replace}”`;
  return `${entry.property}: ${from} → ${to}`;
}
