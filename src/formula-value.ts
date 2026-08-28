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
  // Bases Value wrappers carry the raw datum under one of these.
  for (const k of ["data", "value", "time"]) {
    const inner = o[k];
    const it = typeof inner;
    if (it === "number" || it === "boolean") return inner;
    if (it === "string") return (inner as string) === "" ? null : inner;
  }
  // Last resort: the display string (dates, links, and computed text render here).
  try {
    const fn = (o as { toString?: () => string }).toString;
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
  const getValue = (entry as { getValue?: (key: string) => unknown })?.getValue;
  if (typeof getValue !== "function") return undefined;
  try {
    return toPrimitive(getValue.call(entry, `formula.${name}`));
  } catch {
    return null;
  }
}

/** Whether a results entry exposes the live formula-evaluation API at all. */
export function entrySupportsFormulas(entry: unknown): boolean {
  return typeof (entry as { getValue?: unknown })?.getValue === "function";
}
