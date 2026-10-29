import { App, Notice, TFile } from "obsidian";
import type BasesToolboxPlugin from "./main";
import type { BaseViewLike } from "./base-detect";
import { canonicalId } from "./column-manager";
import { visibleColumnOrder } from "./conditional-format";
import type { HistoryEntry, KeyOrderChange } from "./types";
import type { RevertOptions, RevertReport } from "./history";

/**
 * "Reorder properties in notes" — the engine (no UI; see property-order-modal.ts
 * and property-order-settings.ts).
 *
 * Rewrites the ORDER of frontmatter keys in many notes at once, so Obsidian's
 * Properties view lists them in a chosen order. Values never change, and
 * nothing extra (no order property) is written into the notes.
 *
 * Built to the spec shared with GridSense, so a saved order exported from one
 * plugin imports into the other — keep `PropertyOrdersExport` byte-compatible.
 *
 * Two things that are easy to get wrong:
 *
 *  - **JavaScript can't order integer-like keys.** A key such as `2024` or `10`
 *    is an "array index" to the engine and always enumerates FIRST, in numeric
 *    order, whatever order it was inserted in. So the order we can actually
 *    produce is the requested one with those keys hoisted (`achievableOrder`),
 *    and a note is only "changed" when that differs from what it has now —
 *    otherwise such a note would be rewritten on every run, forever.
 *  - **Obsidian rewrites the YAML.** `processFrontMatter` re-serializes the
 *    block, so comments are dropped and quoting/formatting may be normalized.
 *    The modal says so up front.
 */

export type UnlistedMode = "after" | "in-place";

/** A saved, named order. The exact shape travels in the export file. */
export interface PropertyOrderPreset {
  name: string;
  keys: string[];
  unlisted: UnlistedMode;
}

/** The shared on-disk / clipboard format (identical in GridSense). */
export interface PropertyOrdersExport {
  format: "property-orders";
  version: 1;
  orders: PropertyOrderPreset[];
}

export const EXPORT_FORMAT = "property-orders";
export const EXPORT_VERSION = 1;

export type OrderScope = "view" | "base" | "vault";

export const SCOPE_LABEL: Record<OrderScope, string> = {
  view: "Current view (its filtered rows)",
  base: "Whole base (the base's own filters, ignoring the view's)",
  vault: "Entire vault (every note)",
};

/** Source label in the bulk file change history. */
export const HISTORY_SOURCE = "property order";

/* ------------------------------------------------------------------ ordering */

const lower = (s: string): string => s.toLowerCase();

/** True for keys the JS engine enumerates before all others (array indices). */
export function isIndexKey(k: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(k)) return false;
  return Number(k) < 4294967295; // 2^32 - 1: the array-index ceiling
}

/**
 * The order an object will REALLY have after inserting keys in `order`:
 * array-index keys first (ascending), then the rest as given.
 */
export function achievableOrder(order: string[]): string[] {
  const idx = order.filter(isIndexKey).sort((a, b) => Number(a) - Number(b));
  return [...idx, ...order.filter((k) => !isIndexKey(k))];
}

/**
 * The new key order for one note.
 *
 * `list` is the managed order; matching is case-insensitive (Obsidian treats
 * `Status` and `status` as one property). Keys not in the list are "unlisted":
 *  - "after": listed keys first in list order, then unlisted keys in their
 *    existing relative order;
 *  - "in-place": unlisted keys keep their slots; the listed keys are dealt back
 *    into the slots listed keys occupied, in list order.
 * A note missing a listed key simply skips it.
 */
export function reorderKeys(keys: string[], list: string[], mode: UnlistedMode): string[] {
  const rank = new Map<string, number>();
  list.forEach((k, i) => {
    const l = lower(k);
    if (!rank.has(l)) rank.set(l, i);
  });
  const isListed = (k: string) => rank.has(lower(k));
  // Stable sort by rank (two keys differing only in case share a rank and keep
  // their existing relative order).
  const listed = keys
    .map((k, i) => ({ k, i }))
    .filter((x) => isListed(x.k))
    .sort((a, b) => (rank.get(lower(a.k)) ?? 0) - (rank.get(lower(b.k)) ?? 0) || a.i - b.i)
    .map((x) => x.k);
  if (mode === "after") return [...listed, ...keys.filter((k) => !isListed(k))];
  const out = keys.slice();
  let n = 0;
  for (let i = 0; i < out.length; i++) if (isListed(out[i])) out[i] = listed[n++];
  return out;
}

const sameOrder = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i]);

/** The order a note would end up in, or null when it's already there. */
export function plannedOrder(keys: string[], list: string[], mode: UnlistedMode): string[] | null {
  const next = achievableOrder(reorderKeys(keys, list, mode));
  return sameOrder(next, keys) ? null : next;
}

/** Rebuild `fm` in place so its keys enumerate in `order` (values untouched).
 * Keys missing from `order` (added behind our back) are kept, at the end. */
function rebuildInOrder(fm: Record<string, unknown>, order: string[]): void {
  const kept: [string, unknown][] = [];
  const seen = new Set<string>();
  for (const k of order) {
    if (Object.prototype.hasOwnProperty.call(fm, k) && !seen.has(k)) {
      kept.push([k, fm[k]]);
      seen.add(k);
    }
  }
  for (const k of Object.keys(fm)) if (!seen.has(k)) kept.push([k, fm[k]]);
  for (const k of Object.keys(fm)) delete fm[k];
  for (const [k, v] of kept) fm[k] = v;
}

/** A note's frontmatter keys, from the metadata cache (cheap; no file read). */
export function cachedKeys(app: App, file: TFile): string[] {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  return fm ? Object.keys(fm) : [];
}

/* ------------------------------------------------------------------- scopes */

interface BasesInternals {
  results?: unknown;
  viewName?: unknown;
  ctx?: { _local?: unknown };
  query?: {
    filters?: { test?: (ctx: unknown) => boolean } | null;
    getViewConfig?: (name: unknown) => { order?: unknown } | null | undefined;
  };
  view?: { header?: { cells?: { prop?: unknown }[] } };
}

const controllerOf = (view: BaseViewLike | null): BasesInternals | null =>
  ((view?.controller as BasesInternals | undefined) ?? null);

/** The markdown files the view currently shows (its filters + search applied). */
export function viewFiles(view: BaseViewLike | null): TFile[] | null {
  const results = controllerOf(view)?.results;
  if (!(results instanceof Map)) return null;
  return [...results.keys()].filter((f): f is TFile => f instanceof TFile && f.extension === "md");
}

/**
 * Every markdown file the BASE's own (top-level) filters match, ignoring the
 * view's filters. Bases has no public API for this, so it re-runs the base's
 * compiled filter the same way Bases' own query loop does: one evaluation
 * context per file (built with the class of a context Bases already made),
 * `query.filters.test(ctx)`. Returns null when those internals aren't there —
 * the modal then hides the option instead of guessing.
 */
export function wholeBaseFiles(app: App, view: BaseViewLike | null): TFile[] | null {
  const c = controllerOf(view);
  if (!c || !c.ctx || !c.query) return null;
  let sample: unknown = null;
  if (c.results instanceof Map) sample = c.results.values().next().value ?? null;
  if (!sample) sample = c.ctx._local ?? null;
  const Ctor = (sample as { constructor?: unknown } | null)?.constructor;
  if (typeof Ctor !== "function" || Ctor === Object) return null;
  const filter = c.query.filters;
  if (filter && typeof filter.test !== "function") return null;
  const ignored = (path: string): boolean => {
    const mc = app.metadataCache as unknown as { isUserIgnored?: (p: string) => boolean };
    return typeof mc.isUserIgnored === "function" ? mc.isUserIgnored(path) : false;
  };
  const out: TFile[] = [];
  let errors = 0;
  for (const f of app.vault.getMarkdownFiles()) {
    if (ignored(f.path)) continue;
    if (!filter) {
      out.push(f);
      continue;
    }
    try {
      const ctx = new (Ctor as new (a: unknown, b: TFile) => unknown)(c.ctx, f);
      if (filter.test?.(ctx)) out.push(f);
    } catch {
      errors++;
    }
  }
  // Every file failing means the internals changed shape — don't offer a
  // silently-empty scope.
  if (errors && !out.length) return null;
  return out;
}

/**
 * The view's column order as NOTE property names (no `file.*`, no formulas),
 * read from the live controller. Empty when nothing can be read.
 */
export function viewPropertyColumns(view: BaseViewLike | null): string[] {
  const c = controllerOf(view);
  let order: unknown = null;
  try {
    order = c?.query?.getViewConfig?.(c.viewName)?.order ?? null;
  } catch {
    order = null;
  }
  if (!Array.isArray(order) || !order.length) order = visibleColumnOrder(view);
  if (!Array.isArray(order) || !order.length) {
    const cells = c?.view?.header?.cells;
    order = Array.isArray(cells) ? cells.map((x) => String(x?.prop ?? "")) : [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of order as unknown[]) {
    if (typeof raw !== "string") continue;
    const id = canonicalId(raw);
    if (!id || id.startsWith("file.") || id.startsWith("formula.") || id.startsWith("this.")) continue;
    if (seen.has(lower(id))) continue;
    seen.add(lower(id));
    out.push(id);
  }
  return out;
}

/**
 * Frontmatter keys across `files`: count of notes per key (case-insensitive),
 * keyed by lowercase, with the most common spelling as the display name.
 */
export function keyCounts(app: App, files: TFile[]): Map<string, { name: string; count: number }> {
  const spell = new Map<string, Map<string, number>>();
  const counts = new Map<string, number>();
  for (const f of files) {
    const seen = new Set<string>();
    for (const k of cachedKeys(app, f)) {
      const l = lower(k);
      const s = spell.get(l) ?? new Map<string, number>();
      s.set(k, (s.get(k) ?? 0) + 1);
      spell.set(l, s);
      if (seen.has(l)) continue;
      seen.add(l);
      counts.set(l, (counts.get(l) ?? 0) + 1);
    }
  }
  const out = new Map<string, { name: string; count: number }>();
  for (const [l, n] of counts) {
    const best = [...(spell.get(l) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1])[0];
    out.set(l, { name: best ? best[0] : l, count: n });
  }
  return out;
}

/** Seed list: the view's property columns, then every other key in scope by
 * how often it appears (ties A→Z). */
export function seedList(viewCols: string[], counts: Map<string, { name: string; count: number }>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of viewCols) {
    if (seen.has(lower(k))) continue;
    seen.add(lower(k));
    out.push(counts.get(lower(k))?.name ?? k);
  }
  const rest = [...counts.entries()]
    .filter(([l]) => !seen.has(l))
    .sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name));
  for (const [, v] of rest) out.push(v.name);
  return out;
}

/* ---------------------------------------------------------------------- apply */

export interface PlannedChange {
  file: TFile;
  before: string[];
}

/** The notes that would change, judged from the metadata cache. */
export function planChanges(app: App, files: TFile[], list: string[], mode: UnlistedMode): PlannedChange[] {
  const out: PlannedChange[] = [];
  for (const file of files) {
    const keys = cachedKeys(app, file);
    if (keys.length < 2) continue;
    if (plannedOrder(keys, list, mode)) out.push({ file, before: keys });
  }
  return out;
}

const BATCH = 40;

const yieldToUi = (): Promise<void> => new Promise((r) => window.setTimeout(r, 0));

/**
 * Rewrites the key order of every planned note, in batches with a progress
 * notice, and records ONE history entry (so the whole run is undoable, or any
 * subset of its notes from the history view). The order is recomputed inside
 * `processFrontMatter` from the file as it is at write time, so a key added
 * since the preview is kept (and placed by the same rules) rather than lost.
 */
export async function applyOrder(
  plugin: BasesToolboxPlugin,
  planned: PlannedChange[],
  list: string[],
  mode: UnlistedMode,
  label: string
): Promise<{ entry: HistoryEntry | null; changed: number; failed: number }> {
  const changes: KeyOrderChange[] = [];
  let failed = 0;
  const total = planned.length;
  const progress = total > BATCH ? new Notice(`Reordering properties… 0 of ${total}`, 0) : null;
  try {
    for (let i = 0; i < planned.length; i++) {
      const { file } = planned[i];
      try {
        // Recorded only once the write has succeeded — a throw from the write
        // after the callback ran must not leave a "reordered" history row.
        const done: { rec: KeyOrderChange | null } = { rec: null };
        await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          const before = Object.keys(fm);
          const next = plannedOrder(before, list, mode);
          if (!next) return; // already in order now (cache was stale) — nothing to record
          rebuildInOrder(fm, next);
          done.rec = { path: file.path, before, after: Object.keys(fm) };
        });
        if (done.rec) changes.push(done.rec);
      } catch (e) {
        failed++;
        console.error(`[Bases Toolbox] Reorder properties failed for ${file.path}`, e);
      }
      if ((i + 1) % BATCH === 0) {
        progress?.setMessage(`Reordering properties… ${i + 1} of ${total}`);
        await yieldToUi();
      }
    }
  } finally {
    progress?.hide();
  }
  if (!changes.length) return { entry: null, changed: 0, failed };
  const entry: HistoryEntry = {
    property: label,
    find: null,
    replace: "",
    timestamp: Date.now(),
    changes: [],
    source: HISTORY_SOURCE,
    keyOrder: changes,
  };
  await plugin.addHistoryEntry(entry);
  return { entry, changed: changes.length, failed };
}

/** Where one note stands relative to a recorded reorder (cache-based):
 * still as the run left it, back in its old order, changed since, or gone. */
export function keyOrderState(app: App, change: KeyOrderChange): "in-effect" | "reverted" | "edited" | "missing" {
  const f = app.vault.getAbstractFileByPath(change.path);
  if (!(f instanceof TFile)) return "missing";
  const now = cachedKeys(app, f);
  if (sameOrder(now, change.after)) return "in-effect";
  if (sameOrder(now, achievableOrder(change.before))) return "reverted";
  return "edited";
}

/**
 * Undo a reorder: put each note's keys back in `before` order. A note is only
 * touched while it still has exactly the order the operation left (unless
 * `force`), so a note whose properties were added/removed/reordered since is
 * skipped as "edited since" rather than reshuffled. Forced, keys the note has
 * gained since are kept, after the restored ones.
 */
export async function revertKeyOrder(
  plugin: BasesToolboxPlugin,
  entry: HistoryEntry,
  opts: RevertOptions
): Promise<RevertReport> {
  const report: RevertReport = { restored: 0, propertyMissing: 0, valueChanged: 0, fileMissing: 0, skipped: [] };
  let failed = 0;
  for (const change of entry.keyOrder ?? []) {
    if (opts.paths && !opts.paths.has(change.path)) continue;
    const file = plugin.app.vault.getAbstractFileByPath(change.path);
    if (!(file instanceof TFile)) {
      report.fileMissing++;
      report.skipped.push({ path: change.path, property: "(property order)", reason: "file missing" });
      continue;
    }
    // Decide from the metadata cache FIRST. `processFrontMatter` re-serializes
    // the YAML even when the callback changes nothing, so calling it on a note
    // we're going to leave alone would still strip its comments / requote it.
    const cached = cachedKeys(plugin.app, file);
    if (sameOrder(cached, achievableOrder(change.before))) {
      report.restored++; // already back in the old order (e.g. a second pass)
      continue;
    }
    if (!opts.force && !sameOrder(cached, change.after)) {
      report.valueChanged++;
      report.skipped.push({ path: change.path, property: "(property order)", reason: "edited since" });
      continue;
    }
    const outcome = { edited: false };
    try {
      await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        const now = Object.keys(fm);
        // Re-check against the file itself in case the cache was stale.
        if (!opts.force && !sameOrder(now, change.after) && !sameOrder(now, achievableOrder(change.before))) {
          outcome.edited = true;
          return;
        }
        const target = achievableOrder(reorderKeys(now, change.before, "after"));
        if (!sameOrder(target, now)) rebuildInOrder(fm, target);
      });
    } catch (e) {
      // A failed write (locked by sync, unparseable YAML…) is retryable, so it
      // must NOT let the entry be marked reverted.
      failed++;
      report.skipped.push({ path: change.path, property: "(property order)", reason: "write failed" });
      console.error(`[Bases Toolbox] Reverting property order failed for ${change.path}`, e);
      continue;
    }
    if (outcome.edited) {
      report.valueChanged++;
      report.skipped.push({ path: change.path, property: "(property order)", reason: "edited since" });
    } else report.restored++;
  }
  if (!opts.paths && report.valueChanged === 0 && failed === 0) entry.revertedAt = Date.now();
  await plugin.saveHistory();
  return report;
}

/* -------------------------------------------------------------------- presets */

const isMode = (v: unknown): v is UnlistedMode => v === "after" || v === "in-place";

/** One preset from untrusted input, or null when it isn't one. */
function cleanPreset(raw: unknown): PropertyOrderPreset | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name || !Array.isArray(r.keys)) return null;
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const k of r.keys) {
    if (typeof k !== "string") continue;
    const t = k.trim();
    if (!t || seen.has(lower(t))) continue;
    seen.add(lower(t));
    keys.push(t);
  }
  return { name, keys, unlisted: isMode(r.unlisted) ? r.unlisted : "after" };
}

/** Settings-load sanitizer: drop anything malformed, de-duplicate names. */
export function sanitizePresets(raw: unknown): PropertyOrderPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: PropertyOrderPreset[] = [];
  const names = new Set<string>();
  for (const r of raw) {
    const p = cleanPreset(r);
    if (!p || names.has(p.name)) continue;
    names.add(p.name);
    out.push(p);
  }
  return out;
}

export function exportJson(presets: PropertyOrderPreset[]): string {
  const doc: PropertyOrdersExport = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    orders: presets.map((p) => ({ name: p.name, keys: [...p.keys], unlisted: p.unlisted })),
  };
  return JSON.stringify(doc, null, 2);
}

/** Parse an export; a string error message when it isn't one we accept. */
export function parseExport(text: string): { orders: PropertyOrderPreset[]; dropped: number } | string {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return "That isn't valid JSON.";
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "That JSON isn't a property-orders export.";
  const d = doc as Record<string, unknown>;
  if (d.format !== EXPORT_FORMAT) {
    return `Not a property-orders export (format is ${JSON.stringify(d.format ?? null)}, expected "${EXPORT_FORMAT}").`;
  }
  if (d.version !== EXPORT_VERSION) {
    return `Unsupported property-orders version ${JSON.stringify(d.version ?? null)} — this plugin reads version ${EXPORT_VERSION}.`;
  }
  if (!Array.isArray(d.orders)) return "The export has no \"orders\" list.";
  const orders: PropertyOrderPreset[] = [];
  let dropped = 0;
  const names = new Set<string>();
  for (const r of d.orders) {
    const p = cleanPreset(r);
    if (!p || names.has(p.name)) {
      dropped++;
      continue;
    }
    names.add(p.name);
    orders.push(p);
  }
  return { orders, dropped };
}
