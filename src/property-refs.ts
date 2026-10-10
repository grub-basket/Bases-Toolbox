import { moment } from "obsidian";
import { findKey } from "./scan";

/**
 * `{{property}}` references in a bulk-edit value: each note fills them in from
 * its OWN frontmatter, so "Set Time to {{startTime}}" copies every row's
 * startTime into its Time. `{{name:moment-format}}` reformats a date/time
 * value (e.g. `{{startTime:HH:mm}}`), the same convention as the CSV
 * importer's `{{date:FORMAT}}` variables.
 */

const REF = /\{\{([^{}]+)\}\}/g;
const WHOLE = /^\s*\{\{([^{}]+)\}\}\s*$/;

export function hasPropertyRefs(text: string): boolean {
  return /\{\{[^{}]+\}\}/.test(text);
}

export type RefResult =
  | { ok: true; value: unknown; whole: boolean }
  | { ok: false; missing: string };

type Lookup = { ok: true; value: unknown } | { ok: false; missing: string };

// Obsidian re-exports moment as a namespace type; it's callable at runtime.
const mo = moment as unknown as (
  input: unknown,
  format?: unknown,
  strict?: boolean
) => { isValid(): boolean; format(f: string): string };
const ISO_8601 = (moment as unknown as { ISO_8601: unknown }).ISO_8601;

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

/** An exact property name wins (even one containing a colon); otherwise
 * `name:format` splits at the first colon. Empty values count as missing so a
 * reference never silently clears the target. */
function lookup(fm: Record<string, unknown>, token: string): Lookup {
  const t = token.trim();
  let key = findKey(fm, t);
  let fmt = "";
  let name = t;
  if (key === null) {
    const ci = t.indexOf(":");
    if (ci > 0) {
      name = t.slice(0, ci).trim();
      fmt = t.slice(ci + 1).trim();
      key = findKey(fm, name);
    }
  }
  if (key === null || isEmpty(fm[key])) return { ok: false, missing: name };
  const v = fm[key];
  if (!fmt) return { ok: true, value: Array.isArray(v) ? v.slice() : v };
  // Strict: loose parsing reads "Project 12" as 2012 or a bare 3 as year 0003
  // and writes a made-up date; those notes must skip instead. Time-only values
  // ("09:30") are accepted so {{startTime:HH:mm}} works on them too.
  const m =
    v instanceof Date
      ? mo(v)
      : mo(String(v), [ISO_8601, "YYYY-MM-DD HH:mm", "YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD", "HH:mm", "HH:mm:ss", "h:mm A", "h:mm a"], true);
  if (!m.isValid()) return { ok: false, missing: `${key} as a date` };
  return { ok: true, value: m.format(fmt) };
}

function asText(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * Fill in every reference in `text` from one note's frontmatter. A value that
 * is exactly one reference keeps the source's own value (a list stays a list,
 * a number stays a number); anything mixed with other text becomes a string.
 * If any referenced property is missing or empty on this note, the result is
 * `ok: false` and the caller skips the note.
 */
export function resolvePropertyRefs(text: string, fm: Record<string, unknown>): RefResult {
  const whole = WHOLE.exec(text);
  if (whole) {
    const r = lookup(fm, whole[1]);
    return r.ok ? { ok: true, value: r.value, whole: true } : r;
  }
  // A holder object, because TS doesn't track assignments made in the callback.
  const miss: { name?: string } = {};
  const out = text.replace(REF, (_, token: string) => {
    const r = lookup(fm, token);
    if (!r.ok) {
      miss.name ??= r.missing;
      return "";
    }
    return asText(r.value);
  });
  return miss.name === undefined ? { ok: true, value: out, whole: false } : { ok: false, missing: miss.name };
}
