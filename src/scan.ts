import { App, TFile } from "obsidian";

export interface PropertyUsage {
  /** Display name (first-seen casing). */
  name: string;
  /** Assigned widget type from the property type manager, if known. */
  type: string | null;
  /** Number of files that have this property. */
  count: number;
  /** Display string of each distinct value -> number of files using it. */
  values: Map<string, number>;
  files: TFile[];
}

export const EMPTY_DISPLAY = "(empty)";

export function valueToDisplay(v: unknown): string {
  if (v === null || v === undefined || v === "") return EMPTY_DISPLAY;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** The property type manager is not in the public API; probe it defensively. */
export function getPropertyType(app: App, name: string): string | null {
  const mtm = (app as unknown as { metadataTypeManager?: any }).metadataTypeManager;
  if (!mtm) return null;
  const key = name.toLowerCase();
  try {
    return mtm.getPropertyInfo?.(key)?.widget ?? mtm.getAssignedType?.(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * Builds a full index of every frontmatter property in the vault from the
 * metadata cache. Independent of the Bases filter UI, so it never "forgets"
 * a property while any file still carries it.
 */
export function scanProperties(app: App): PropertyUsage[] {
  const byLower = new Map<string, PropertyUsage>();
  for (const file of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;
    for (const key of Object.keys(fm)) {
      if (key === "position") continue; // legacy cache bookkeeping, not a property
      const lower = key.toLowerCase();
      let usage = byLower.get(lower);
      if (!usage) {
        usage = {
          name: key,
          type: getPropertyType(app, lower),
          count: 0,
          values: new Map(),
          files: [],
        };
        byLower.set(lower, usage);
      }
      usage.count++;
      usage.files.push(file);
      const v = fm[key];
      const items = Array.isArray(v) ? (v.length ? v : [null]) : [v];
      const seen = new Set<string>();
      for (const item of items) {
        const d = valueToDisplay(item);
        if (seen.has(d)) continue; // count each value once per file
        seen.add(d);
        usage.values.set(d, (usage.values.get(d) ?? 0) + 1);
      }
    }
  }
  return [...byLower.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Finds the actual frontmatter key matching a property name, case-insensitively. */
export function findKey(fm: Record<string, unknown>, name: string): string | null {
  if (name in fm) return name;
  const lower = name.toLowerCase();
  for (const k of Object.keys(fm)) if (k.toLowerCase() === lower) return k;
  return null;
}
