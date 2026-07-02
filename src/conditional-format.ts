import { TFile, debounce } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { findKey } from "./scan";

export interface FormatRule {
  id: string;
  property: string;
  op: FormatOp;
  value: string;
  color: string; // key of RULE_COLORS
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

function decorateRow(plugin: BasesToolboxPlugin, row: HTMLElement): void {
  const href = row.querySelector("[data-href]")?.getAttribute("data-href");
  const file = href ? plugin.app.vault.getAbstractFileByPath(href) : null;
  if (!(file instanceof TFile)) return;
  const fm = (plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<
    string,
    unknown
  >;

  let color: string | null = null;
  for (const rule of plugin.settings.formatRules) {
    if (!rule.enabled || !rule.property) continue;
    const key = findKey(fm, rule.property);
    const value = key === null ? undefined : fm[key];
    if (matches(rule, value)) {
      color = RULE_COLORS[rule.color] ?? null;
      break; // first matching rule wins
    }
  }

  if (color) {
    row.style.backgroundColor = color;
    row.dataset.btFormatted = "1";
  } else if (row.dataset.btFormatted) {
    row.style.removeProperty("background-color");
    delete row.dataset.btFormatted;
  }
}

export function redecorateAll(plugin: BasesToolboxPlugin): void {
  document.querySelectorAll<HTMLElement>(".bases-tr").forEach((r) => decorateRow(plugin, r));
}

export function installConditionalFormatting(plugin: BasesToolboxPlugin): void {
  const refresh = debounce(() => redecorateAll(plugin), 250, true);

  const observer = new MutationObserver((mutations) => {
    if (!plugin.settings.formatRules.length) return;
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(".bases-tr")) decorateRow(plugin, node);
        else if (node.querySelector?.(".bases-tr")) refresh();
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  plugin.register(() => observer.disconnect());

  // Frontmatter edits re-evaluate rules for visible rows.
  plugin.registerEvent(plugin.app.metadataCache.on("changed", () => refresh()));
  refresh();
}
