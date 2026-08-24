import { FuzzySuggestModal, Notice, TFile, parseYaml, stringifyYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { activeBaseView } from "./base-detect";

/**
 * "Always skip these file extensions" — a settings list plus a command that
 * appends an exclusion to a base so files like `.edtz` (Stashpad's encrypted
 * notes) or images stop showing up as rows.
 *
 * The rule goes on the base's TOP-LEVEL `filters:`, which Bases applies to
 * every view, so one append covers them all. The only real subtlety is the
 * conjunction: an exclusion has to be AND-ed with whatever's already there. If
 * the base filter is an `or` (e.g. "folder A OR folder B"), appending
 * `file.ext != "edtz"` INTO that or-list would instead *include* every edtz
 * that fails the other clauses — the opposite of the intent. So when the
 * existing filter is (or contains) an `or`, we wrap it: `{ and: [ <existing>,
 * <exclusions> ] }`. A pure `and` is appended to in place; a bare string is
 * promoted to an `and`; nothing becomes a fresh `and`.
 *
 * Idempotent: a clause already present is skipped, so running it twice — or
 * after adding one more extension to the list — doesn't duplicate anything.
 *
 * Undoable: each run snapshots the whole `.base` into the bulk file change
 * history, so it reverts like any other operation.
 */

/** Normalise a user-entered extension: drop a leading dot, lowercase, trim. */
export function cleanExt(raw: string): string {
  return raw.trim().replace(/^\.+/, "").toLowerCase();
}

/** Parse the comma/newline/space-separated settings string into clean exts. */
export function parseExtList(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,]+/)) {
    const e = cleanExt(part);
    if (e) seen.add(e);
  }
  return [...seen];
}

/** The Bases filter clause that excludes one extension. */
const clauseFor = (ext: string): string => `file.ext != "${ext}"`;

type FiltersNode = { and?: unknown[]; or?: unknown[] } | string | undefined;

/** Every string clause reachable at the top level (bare, and[], or[]) — used to
 * skip exclusions that are already there. Nested groups are ignored (we don't
 * dig into them; a duplicate deeper down is harmless and rare). */
function existingClauses(filters: FiltersNode): Set<string> {
  const out = new Set<string>();
  if (typeof filters === "string") out.add(filters);
  else if (filters && typeof filters === "object") {
    for (const conj of ["and", "or"] as const) {
      const arr = filters[conj];
      if (Array.isArray(arr)) for (const x of arr) if (typeof x === "string") out.add(x);
    }
  }
  return out;
}

export interface SkipResult {
  /** Extensions whose clause was newly added. */
  added: string[];
  /** Extensions already excluded (clause present) — left alone. */
  already: string[];
  /** True when the existing `or` filter had to be wrapped in an `and`. */
  wrapped: boolean;
}

/**
 * Mutate `doc` to exclude `exts` at the base level. Returns what happened, or
 * null when there was nothing to do (every extension already excluded), so the
 * caller can skip the write.
 */
export function applySkipExtensions(
  doc: Record<string, unknown>,
  exts: string[]
): SkipResult | null {
  const filters = doc.filters as FiltersNode;
  const present = existingClauses(filters);
  const added: string[] = [];
  const already: string[] = [];
  for (const ext of exts) {
    if (present.has(clauseFor(ext))) already.push(ext);
    else added.push(ext);
  }
  if (!added.length) return null;
  const newClauses = added.map(clauseFor);

  let wrapped = false;
  const hasOr =
    !!filters && typeof filters === "object" && Array.isArray((filters as { or?: unknown[] }).or) &&
    (filters as { or: unknown[] }).or.length > 0;

  if (filters === undefined || filters === null) {
    doc.filters = { and: [...newClauses] };
  } else if (typeof filters === "string") {
    doc.filters = { and: [filters, ...newClauses] };
  } else if (hasOr) {
    // Wrap the whole existing filter so the exclusion AND-s with it.
    doc.filters = { and: [filters, ...newClauses] };
    wrapped = true;
  } else {
    // Pure `and` (or an empty/other object) — append in place, flattening.
    const obj = filters as { and?: unknown[] };
    const arr = Array.isArray(obj.and) ? obj.and : (obj.and = []);
    arr.push(...newClauses);
  }
  return { added, already, wrapped };
}

/* ---------- command ---------- */

async function runOnBase(plugin: BasesToolboxPlugin, file: TFile): Promise<void> {
  const exts = parseExtList(plugin.settings.skipExtensions);
  if (!exts.length) {
    new Notice(
      "No extensions in the skip list yet — add some under Settings → Bases Toolbox → Always skip file extensions.",
      8000
    );
    return;
  }

  const before = await plugin.app.vault.read(file);
  let doc: Record<string, unknown>;
  try {
    doc = (parseYaml(before) ?? {}) as Record<string, unknown>;
  } catch {
    new Notice("Could not parse this .base file.");
    return;
  }

  const result = applySkipExtensions(doc, exts);
  if (!result) {
    new Notice(`“${file.basename}” already excludes ${exts.map((e) => `.${e}`).join(", ")}.`);
    return;
  }

  await plugin.app.vault.modify(file, stringifyYaml(doc));
  await plugin.addHistoryEntry({
    property: `Excluded ${result.added.map((e) => `.${e}`).join(", ")} from “${file.basename}”`,
    find: null,
    replace: "",
    timestamp: Date.now(),
    changes: [],
    source: "skip extensions",
    fileSnapshots: [{ path: file.path, content: before, kind: "modified" }],
  });

  const added = result.added.map((e) => `.${e}`).join(", ");
  const skipped = result.already.length
    ? ` (${result.already.map((e) => `.${e}`).join(", ")} already excluded)`
    : "";
  const wrapped = result.wrapped
    ? " Its “or” filter was wrapped in an “and” so the exclusion holds."
    : "";
  new Notice(`Excluded ${added} from all views of “${file.basename}”.${skipped}${wrapped}`, 8000);
}

class SkipExtBasePicker extends FuzzySuggestModal<TFile> {
  constructor(private plugin: BasesToolboxPlugin) {
    super(plugin.app);
    this.setPlaceholder("Pick a base to exclude the skipped extensions from…");
  }
  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((f) => f.extension === "base");
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    void runOnBase(this.plugin, f);
  }
}

/** Command entry point: run on the active base, or pick one. */
export function excludeSkippedExtensions(plugin: BasesToolboxPlugin): void {
  const active = activeBaseView(plugin.app)?.file ?? plugin.app.workspace.getActiveFile();
  if (active?.extension === "base") void runOnBase(plugin, active);
  else new SkipExtBasePicker(plugin).open();
}
