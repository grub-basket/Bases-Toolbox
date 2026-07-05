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
  /** Display string of each distinct value -> the files that use it. */
  valueFiles: Map<string, TFile[]>;
  files: TFile[];
}

export const EMPTY_DISPLAY = "(empty)";

/** Lucide icon per Obsidian property widget type (shared by the index + doctor). */
export const TYPE_ICONS: Record<string, string> = {
  text: "type",
  multitext: "list",
  number: "hash",
  checkbox: "square-check",
  date: "calendar",
  datetime: "calendar-clock",
  tags: "tags",
  aliases: "arrow-right-left",
  file: "file",
  folder: "folder",
  property: "link",
};
export const UNTYPED_ICON = "circle-dashed";

/** The Lucide icon name for a property's widget type (fallback for untyped). */
export function typeIconName(type: string | null | undefined): string {
  return type ? TYPE_ICONS[type] ?? UNTYPED_ICON : UNTYPED_ICON;
}

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
          valueFiles: new Map(),
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
        const vf = usage.valueFiles.get(d);
        if (vf) vf.push(file);
        else usage.valueFiles.set(d, [file]);
      }
    }
  }
  return [...byLower.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const LIST_TYPES = new Set(["multitext", "tags", "aliases"]);

/**
 * Converts raw text from a textarea/input into a frontmatter value for the
 * given property: list types split one-item-per-line, numbers/checkboxes
 * coerce, empty clears (null), anything else stays a string.
 */
export function parseValueForProperty(app: App, key: string, raw: string): unknown {
  const type = getPropertyType(app, key);
  if (LIST_TYPES.has(type ?? "")) {
    const items = raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return items.length ? items : null;
  }
  if (type === "number") {
    const n = Number(raw.trim());
    return raw.trim() !== "" && !Number.isNaN(n) ? n : raw.trim() || null;
  }
  if (type === "checkbox") return raw.trim() === "true";
  if (raw === "") return null;
  if (type && type !== "unknown") return raw;
  // No assigned type: light heuristic.
  const t = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true") return true;
  if (t === "false") return false;
  return raw;
}

/**
 * Memoized property index. Obsidian's metadataCache is already the "database"
 * (an incrementally-updated in-memory index of all frontmatter), so no
 * separate store is needed — this just avoids re-deriving the per-property
 * aggregation on every modal open. Any metadata change marks it dirty; the
 * next read rebuilds (O(files) map lookups, no disk I/O).
 */
export class PropertyCache {
  private cached: PropertyUsage[] | null = null;

  constructor(private app: App) {}

  markDirty(): void {
    this.cached = null;
  }

  get(): PropertyUsage[] {
    if (!this.cached) this.cached = scanProperties(this.app);
    return this.cached;
  }

  /** O(1)-ish lookup of one property's usage (case-insensitive). */
  usage(name: string): PropertyUsage | undefined {
    const lower = name.toLowerCase();
    return this.get().find((u) => u.name.toLowerCase() === lower);
  }
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Keys that would touch object internals rather than data — never edit these. */
export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}

/** Finds the actual frontmatter key matching a property name, case-insensitively. */
export function findKey(fm: Record<string, unknown>, name: string): string | null {
  if (isUnsafeKey(name)) return null;
  if (Object.prototype.hasOwnProperty.call(fm, name)) return name;
  const lower = name.toLowerCase();
  for (const k of Object.keys(fm)) if (k.toLowerCase() === lower) return k;
  return null;
}
