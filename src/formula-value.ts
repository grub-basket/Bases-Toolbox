/**
 * Pure helpers for "Sync formula into property" — no Obsidian imports, so the
 * conversion/guard logic is unit-testable in isolation. `sync-formula.ts` wires
 * these to the live base view.
 */

export type FormulaDef = { name: string; expr: string };

/** The formulas a parsed `.base` document defines (top-level `formulas:` map). */
export function formulasFromDoc(doc: unknown): FormulaDef[] {
  if (!doc || typeof doc !== "object") return [];
  const f = (doc as Record<string, unknown>).formulas;
  if (!f || typeof f !== "object" || Array.isArray(f)) return [];
  return Object.entries(f as Record<string, unknown>).map(([name, expr]) => ({
    name,
    expr: String(expr),
  }));
}

/**
 * Converts a Bases formula result — a wrapped `Value` from the live query engine
 * (or already a plain JS value) — into something safe to write into frontmatter.
 * Probed defensively across the shapes the engine uses, falling back to the
 * displayed string so a date/number/text formula lands as what the user sees.
 */
export function toPrimitive(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "number" || t === "boolean") return v;
  if (t === "string") return (v as string) === "" ? null : v;
  if (Array.isArray(v)) {
    const arr = v.map(toPrimitive).filter((x) => x !== null && x !== undefined);
    return arr.length ? arr : null;
  }
  const o = v as Record<string, unknown>;
  // A date value is { date, time }, where `time` is a flag saying whether it
  // has a time part. Its display string is the stored date format.
  if (Object.prototype.toString.call(o.date) === "[object Date]") return displayString(v);
  // A link prints as [[target]], so it stays a link when written into a note.
  if (typeof o.resolve === "function") return displayString(v);
  // A file value (file(), this.file, file.file) holds the file itself.
  const file = o.file as { path?: unknown } | null | undefined;
  if (file && typeof file.path === "string") return `[[${file.path}]]`;
  // A formula that failed for this row carries only its error message.
  if (typeof o.message === "string" && !("data" in o) && !("value" in o)) return null;
  // A list value holds its items, each a value of its own.
  if (Array.isArray(o.data)) return toPrimitive(o.data);
  // Other Bases Value wrappers carry the raw datum under one of these.
  for (const k of ["data", "value"]) {
    const inner = o[k];
    const it = typeof inner;
    if (it === "number" || it === "boolean") return inner;
    if (it === "string") return (inner as string) === "" ? null : inner;
  }
  if (typeof o.time === "number") return o.time;
  const s = displayString(v);
  // The empty value has no datum and prints "null".
  if (s === "null" && !("data" in o) && !("value" in o)) return null;
  // Last resort: the display string (computed text renders here).
  return s;
}

/** A value's display string, or null when it has none worth keeping. */
function displayString(v: unknown): string | null {
  try {
    const fn = (v as { toString?: () => string }).toString;
    if (typeof fn === "function") {
      const s = fn.call(v);
      return s && s !== "[object Object]" ? s : null;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Reads one formula's value for a single results entry, defensively.
 * Returns `undefined` when the entry doesn't expose the engine API (signals
 * "Obsidian internals changed" to the caller); `null` when the engine threw for
 * that row (an error formula) or produced nothing.
 */
export function readFormulaValue(entry: unknown, name: string): unknown {
  return readEntryValue(entry, `formula.${name}`);
}

/**
 * Reads any column (`formula.x`, `file.backlinks`, `note.status`…) for one
 * results entry, with the same return contract as `readFormulaValue`.
 */
export function readEntryValue(entry: unknown, key: string): unknown {
  const getValue = (entry as { getValue?: (key: string) => unknown })?.getValue;
  if (typeof getValue !== "function") return undefined;
  try {
    return toPrimitive(getValue.call(entry, key));
  } catch {
    return null;
  }
}

/** Whether a results entry exposes the live formula-evaluation API at all. */
export function entrySupportsFormulas(entry: unknown): boolean {
  return typeof (entry as { getValue?: unknown })?.getValue === "function";
}
