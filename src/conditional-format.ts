import { TFile, debounce } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { findKey } from "./scan";

export type FormatScope = "row" | "cell";

export interface FormatRule {
  id: string;
  property: string;
  op: FormatOp;
  value: string;
  color: string; // key of RULE_COLORS, or "custom"
  /** Hex color (e.g. #ff9800) used when color === "custom". */
  customColor?: string;
  /** Color the whole row (default) or only this property's cell. */
  scope?: FormatScope;
  enabled: boolean;
}

export type FormatOp =
  | "equals"
  | "not-equals"
  | "contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "empty"
  | "not-empty";

export const OP_LABELS: Record<FormatOp, string> = {
  equals: "equals",
  "not-equals": "does not equal",
  contains: "contains",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  empty: "is empty",
  "not-empty": "is not empty",
};

export const CUSTOM_COLOR = "custom";
export const DEFAULT_CUSTOM_HEX = "#ff9800";

/** Display label for a color key ("red" → "Red", "custom" → "Custom…"). */
export function colorLabel(key: string): string {
  if (key === CUSTOM_COLOR) return "Custom…";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Resolves a rule to its CSS background tint (palette var or custom hex). */
export function ruleColor(rule: FormatRule): string | null {
  if (rule.color === CUSTOM_COLOR) {
    const m = (rule.customColor ?? DEFAULT_CUSTOM_HEX).match(/^#?([0-9a-fA-F]{6})$/);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    // same 0.18 alpha as the palette tints, so custom rows blend in
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.18)`;
  }
  return RULE_COLORS[rule.color] ?? null;
}

/** A solid swatch color of the rule's choice, for the settings preview. */
export function ruleSwatchColor(rule: FormatRule): string {
  if (rule.color === CUSTOM_COLOR) return rule.customColor ?? DEFAULT_CUSTOM_HEX;
  return SWATCH_COLORS[rule.color] ?? "transparent";
}

/** Theme-aware tints via Obsidian's extended color palette variables. */
export const RULE_COLORS: Record<string, string> = {
  red: "rgba(var(--color-red-rgb), 0.18)",
  orange: "rgba(var(--color-orange-rgb), 0.18)",
  yellow: "rgba(var(--color-yellow-rgb), 0.18)",
  green: "rgba(var(--color-green-rgb), 0.18)",
  cyan: "rgba(var(--color-cyan-rgb), 0.18)",
  blue: "rgba(var(--color-blue-rgb), 0.18)",
  purple: "rgba(var(--color-purple-rgb), 0.18)",
  pink: "rgba(var(--color-pink-rgb), 0.18)",
};

/** Fully-opaque versions for the settings preview swatch. */
const SWATCH_COLORS: Record<string, string> = {
  red: "var(--color-red)",
  orange: "var(--color-orange)",
  yellow: "var(--color-yellow)",
  green: "var(--color-green)",
  cyan: "var(--color-cyan)",
  blue: "var(--color-blue)",
  purple: "var(--color-purple)",
  pink: "var(--color-pink)",
};

function matches(rule: FormatRule, fmValue: unknown): boolean {
  const isEmpty =
    fmValue === undefined ||
    fmValue === null ||
    fmValue === "" ||
    (Array.isArray(fmValue) && fmValue.length === 0);
  switch (rule.op) {
    case "empty":
      return isEmpty;
    case "not-empty":
      return !isEmpty;
  }
  if (isEmpty) return false;
  const values = Array.isArray(fmValue) ? fmValue : [fmValue];
  const want = rule.value.trim();
  // not-equals must hold for EVERY item — some() would match any 2-item list
  if (rule.op === "not-equals") return values.every((v) => String(v) !== want);
  return values.some((v) => {
    const s = String(v);
    switch (rule.op) {
      case "equals":
        return s === want;
      case "not-equals":
        return s !== want;
      case "contains":
        return s.toLowerCase().includes(want.toLowerCase());
      default: {
        const a = Number(v);
        const b = Number(want);
        if (Number.isNaN(a) || Number.isNaN(b)) return false;
        if (rule.op === "gt") return a > b;
        if (rule.op === "gte") return a >= b;
        if (rule.op === "lt") return a < b;
        return a <= b;
      }
    }
  });
}

/** Maps a property name to its column index in the table containing `row`. */
function columnIndexFor(row: HTMLElement, property: string): number {
  // Headers live in a separate thead OUTSIDE .bases-table — scope to the
  // whole view so both the header row and the body rows are in reach.
  const view = row.closest<HTMLElement>(".bases-view") ?? row.closest<HTMLElement>(".view-content");
  if (!view) return -1;
  const headers = Array.from(view.querySelectorAll<HTMLElement>(".bases-table-header-name"));
  const lower = property.toLowerCase();
  return headers.findIndex((h) => (h.textContent ?? "").trim().toLowerCase() === lower);
}

function clearRow(row: HTMLElement): void {
  if (row.dataset.btFormatted) {
    row.setCssStyles({ backgroundColor: "" });
    delete row.dataset.btFormatted;
  }
  row.querySelectorAll<HTMLElement>("[data-bt-cell-formatted]").forEach((c) => {
    c.setCssStyles({ backgroundColor: "" });
    delete c.dataset.btCellFormatted;
  });
}

function decorateRow(plugin: BasesToolboxPlugin, row: HTMLElement): void {
  clearRow(row); // always start clean so removed/changed rules don't linger
  const href = row.querySelector("[data-href]")?.getAttribute("data-href");
  const file = href ? plugin.app.vault.getAbstractFileByPath(href) : null;
  if (!(file instanceof TFile)) return;
  const fm = (plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<
    string,
    unknown
  >;

  let rowColor: string | null = null;
  const cellColors = new Map<number, string>(); // column index → color

  for (const rule of plugin.settings.formatRules) {
    if (!rule.enabled || !rule.property) continue;
    const key = findKey(fm, rule.property);
    const value = key === null ? undefined : fm[key];
    if (!matches(rule, value)) continue;
    const color = ruleColor(rule);
    if (!color) continue;
    if (rule.scope === "cell") {
      const idx = columnIndexFor(row, rule.property);
      if (idx >= 0 && !cellColors.has(idx)) cellColors.set(idx, color); // first per cell wins
    } else if (rowColor === null) {
      rowColor = color; // first matching row rule wins
    }
  }

  if (rowColor) {
    row.setCssStyles({ backgroundColor: rowColor });
    row.dataset.btFormatted = "1";
  }
  if (cellColors.size) {
    const cells = Array.from(row.querySelectorAll<HTMLElement>(".bases-td"));
    for (const [idx, color] of cellColors) {
      const cell = cells[idx];
      if (cell) {
        cell.setCssStyles({ backgroundColor: color });
        cell.dataset.btCellFormatted = "1";
      }
    }
  }
}

export function redecorateAll(plugin: BasesToolboxPlugin): void {
  activeDocument.querySelectorAll<HTMLElement>(".bases-tr").forEach((r) => decorateRow(plugin, r));
}

export function installConditionalFormatting(plugin: BasesToolboxPlugin): void {
  const refresh = debounce(() => redecorateAll(plugin), 200, true);
  plugin.refreshConditionalFormatting = refresh;

  const observer = new MutationObserver((mutations) => {
    if (!plugin.settings.formatRules.length) return;
    for (const mutation of mutations) {
      // Row recycled to a different file (virtualization) → re-evaluate it.
      if (mutation.type === "attributes") {
        const t = mutation.target;
        if (t.instanceOf(HTMLElement)) {
          const row = (t as HTMLElement).closest<HTMLElement>(".bases-tr");
          if (row) decorateRow(plugin, row);
        }
        continue;
      }
      for (const node of Array.from(mutation.addedNodes)) {
        if (!node.instanceOf(HTMLElement)) continue;
        const el = node as HTMLElement;
        if (el.matches(".bases-tr")) decorateRow(plugin, el);
        else if (el.querySelector(".bases-tr")) refresh();
      }
    }
  });
  observer.observe(activeDocument.body, {
    childList: true,
    subtree: true,
    attributes: true,
    // data-href changes when Bases recycles a row for a different file
    attributeFilter: ["data-href"],
  });
  plugin.register(() => observer.disconnect());

  // Re-apply whenever the view context changes — this is what makes rule
  // edits show up the moment you return to the base from settings.
  plugin.registerEvent(plugin.app.metadataCache.on("changed", () => refresh()));
  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", () => refresh()));
  plugin.registerEvent(plugin.app.workspace.on("layout-change", () => refresh()));
  refresh();
}
