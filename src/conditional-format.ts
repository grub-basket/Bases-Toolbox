import { Modal, Notice, Setting, TFile, debounce } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { findKey, valueToDisplay } from "./scan";

export type FormatScope = "row" | "cell";

export interface FormatRule {
  id: string;
  /** Optional human label for the rule (shown instead of the raw condition). */
  name?: string;
  property: string;
  op: FormatOp;
  value: string;
  color: string; // key of RULE_COLORS, or "custom"
  /** Hex color (e.g. #ff9800) used when color === "custom". */
  customColor?: string;
  /** Color the whole row (default) or only this property's cell. */
  scope?: FormatScope;
  /** Base file paths this rule applies to; empty/undefined = all bases. */
  bases?: string[];
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
  | "not-empty"
  | "duplicated";

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
  duplicated: "is duplicated (in this base)",
};

/** Ops that take no value (the value input is hidden for these). */
export const VALUELESS_OPS = new Set<FormatOp>(["empty", "not-empty", "duplicated"]);

export const CUSTOM_COLOR = "custom";
export const DEFAULT_CUSTOM_HEX = "#ff9800";

/**
 * Identity of a rule's *condition* — property, operator, value, scope, and the
 * set of bases it targets. Two rules with the same key fire on the same cells,
 * so the second is redundant (color aside). Used to warn on duplicates.
 */
export function ruleMatchKey(r: FormatRule): string {
  const needsValue = !VALUELESS_OPS.has(r.op);
  const bases = r.bases?.length ? [...r.bases].sort().join("|") : "*";
  return [
    r.property.trim().toLowerCase(),
    r.op,
    needsValue ? r.value.trim().toLowerCase() : "",
    r.scope ?? "row",
    bases,
  ].join("§");
}

/**
 * Index of the first rule matching `candidate`'s condition, or -1. Pass
 * `excludeIndex` to skip the candidate's own slot when checking an existing row.
 */
export function findDuplicateRule(
  rules: FormatRule[],
  candidate: FormatRule,
  excludeIndex = -1
): number {
  const key = ruleMatchKey(candidate);
  return rules.findIndex((r, i) => i !== excludeIndex && ruleMatchKey(r) === key);
}

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

/** Normalise a property id for comparison: lowercase, drop the `note.` prefix
 * (`file.` is kept so file.name never collides with a note property called
 * "name"). */
const normProp = (s: string): string => s.toLowerCase().replace(/^note\./, "");

/**
 * The live, ordered list of visible column ids for a base view
 * (`["file.name", "note.category", …]`), read from the view controller's
 * property menu. This is the SAME order the table renders its columns and its
 * `.bases-td` cells in, and it respects the active view, runtime column
 * reordering, display names, and formula columns. Returns null on builds that
 * don't expose it (callers fall back to header-text matching).
 */
export function visibleColumnOrder(view: unknown): string[] | null {
  const order = (
    view as { controller?: { propertyMenu?: { viewConfig?: { order?: unknown } } } }
  )?.controller?.propertyMenu?.viewConfig?.order;
  return Array.isArray(order) && order.every((k) => typeof k === "string")
    ? (order as string[])
    : null;
}

/**
 * Maps a property name to its column index in the table containing `row`.
 * Prefers the view's live column `order` (robust — survives display names,
 * formula columns, and reordering); falls back to matching the header's DISPLAY
 * text, which silently misses a column whose header was renamed (the cause of
 * "conditional formatting colours rows but not cells" when a column has a
 * display name).
 */
function columnIndexFor(row: HTMLElement, property: string, order?: string[] | null): number {
  if (order && order.length) {
    const target = normProp(property);
    const idx = order.findIndex((k) => normProp(k) === target);
    if (idx >= 0) return idx;
  }
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

/** The .base path whose view contains this row (embed src or owning leaf). */
function basePathForRow(plugin: BasesToolboxPlugin, row: HTMLElement): string | undefined {
  const embed = row.closest<HTMLElement>(".bases-embed");
  if (embed) {
    const src = (embed.getAttribute("src") ?? "").split("#")[0];
    const active = plugin.app.workspace.getActiveFile()?.path ?? "";
    return plugin.app.metadataCache.getFirstLinkpathDest(src, active)?.path;
  }
  for (const leaf of plugin.app.workspace.getLeavesOfType("bases")) {
    const view = leaf.view as unknown as { containerEl?: HTMLElement; file?: TFile };
    if (view.containerEl?.contains(row)) return view.file?.path;
  }
  return undefined;
}

/** Reads a base row's file frontmatter (via its data-href link), or null. */
function fmForRow(plugin: BasesToolboxPlugin, row: HTMLElement): Record<string, unknown> | null {
  const href = row.querySelector("[data-href]")?.getAttribute("data-href");
  const file = href ? plugin.app.vault.getAbstractFileByPath(href) : null;
  if (!(file instanceof TFile)) return null;
  return (plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
}

/** Per property (lowercased) → value display → count, scoped to one base. */
type DupCounts = Map<string, Map<string, number>>;

const isEmptyValue = (v: unknown): boolean =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

function decorateRow(
  plugin: BasesToolboxPlugin,
  row: HTMLElement,
  basePath?: string,
  dupCounts?: DupCounts,
  order?: string[] | null
): void {
  clearRow(row); // always start clean so removed/changed rules don't linger
  if (!plugin.settings.cfEnabled) return; // master switch off → leave rows bare
  const fm = fmForRow(plugin, row);
  if (fm === null) return;

  // Resolve which base this row belongs to only if some rule is base-scoped.
  const anyScoped = plugin.settings.formatRules.some((r) => r.bases?.length);
  const bp = !anyScoped ? undefined : basePath !== undefined ? basePath : basePathForRow(plugin, row);

  let rowColor: string | null = null;
  const cellColors = new Map<number, string>(); // column index → color

  for (const rule of plugin.settings.formatRules) {
    if (!rule.enabled || !rule.property) continue;
    if (rule.bases?.length && !(bp && rule.bases.includes(bp))) continue;
    const key = findKey(fm, rule.property);
    const value = key === null ? undefined : fm[key];
    let hit: boolean;
    if (rule.op === "duplicated") {
      // Highlight values that appear more than once among THIS base's rows.
      const disp = isEmptyValue(value) ? null : valueToDisplay(value);
      const m = dupCounts?.get(rule.property.toLowerCase());
      hit = disp !== null && !!m && (m.get(disp) ?? 0) > 1;
    } else {
      hit = matches(rule, value);
    }
    if (!hit) continue;
    const color = ruleColor(rule);
    if (!color) continue;
    if (rule.scope === "cell") {
      const idx = columnIndexFor(row, rule.property, order);
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

/** Every document that could hold a base view — main window plus popouts. */
function allBaseDocuments(plugin: BasesToolboxPlugin): Set<Document> {
  const docs = new Set<Document>();
  docs.add(activeDocument);
  docs.add(document);
  plugin.app.workspace.iterateAllLeaves((leaf) => {
    const doc = leaf.view?.containerEl?.ownerDocument;
    if (doc) docs.add(doc);
  });
  return docs;
}

/**
 * Decorate a set of rows that belong to ONE base together — precomputing, for
 * any "duplicated" rule, how many of THESE rows share each value (so duplicate
 * highlighting is scoped to the base's currently-shown rows).
 */
function decorateRowGroup(
  plugin: BasesToolboxPlugin,
  rows: HTMLElement[],
  basePath?: string,
  order?: string[] | null
): void {
  const dupProps = new Set(
    plugin.settings.formatRules
      .filter((r) => r.enabled && r.op === "duplicated" && r.property)
      .map((r) => r.property.toLowerCase())
  );
  let counts: DupCounts | undefined;
  if (dupProps.size) {
    counts = new Map();
    for (const p of dupProps) counts.set(p, new Map());
    for (const row of rows) {
      const fm = fmForRow(plugin, row);
      if (!fm) continue;
      for (const p of dupProps) {
        const key = findKey(fm, p);
        const v = key === null ? undefined : fm[key];
        if (isEmptyValue(v)) continue;
        const m = counts.get(p);
        if (!m) continue;
        const disp = valueToDisplay(v);
        m.set(disp, (m.get(disp) ?? 0) + 1);
      }
    }
  }
  for (const row of rows) decorateRow(plugin, row, basePath, counts, order);
}

export function redecorateAll(plugin: BasesToolboxPlugin): void {
  // Master switch off → strip any colors we applied and stop. Rules are kept in
  // settings, just suspended.
  if (!plugin.settings.cfEnabled) {
    for (const doc of allBaseDocuments(plugin)) {
      doc.querySelectorAll<HTMLElement>(".bases-tr").forEach((r) => clearRow(r));
    }
    return;
  }
  const done = new WeakSet<HTMLElement>();
  // Base tabs (and popouts): all rows in a leaf's view are one base.
  for (const leaf of plugin.app.workspace.getLeavesOfType("bases")) {
    const view = leaf.view as unknown as { containerEl?: HTMLElement; file?: TFile };
    const rows = view.containerEl
      ? Array.from(view.containerEl.querySelectorAll<HTMLElement>(".bases-tr"))
      : [];
    decorateRowGroup(plugin, rows, view.file?.path, visibleColumnOrder(leaf.view));
    rows.forEach((r) => done.add(r));
  }
  // Embedded bases: group per .bases-embed so duplicates are scoped to it.
  for (const doc of allBaseDocuments(plugin)) {
    doc.querySelectorAll<HTMLElement>(".bases-embed").forEach((embed) => {
      const rows = Array.from(embed.querySelectorAll<HTMLElement>(".bases-tr")).filter(
        (r) => !done.has(r)
      );
      if (rows.length) {
        decorateRowGroup(plugin, rows);
        rows.forEach((r) => done.add(r));
      }
    });
    // Anything left over — decorate individually (no duplicate context).
    doc.querySelectorAll<HTMLElement>(".bases-tr").forEach((r) => {
      if (!done.has(r)) {
        decorateRow(plugin, r);
        done.add(r);
      }
    });
  }
}

/**
 * Re-decorate now AND on the next frame AND after a short delay. Bases may
 * re-render its table shortly after a settings change or a modal close
 * (which fires no workspace event), so a single pass can be wiped — the
 * later passes catch the re-render. This is what makes a new rule show up
 * without an app reload.
 */
export function scheduleRedecorate(plugin: BasesToolboxPlugin): void {
  redecorateAll(plugin);
  window.requestAnimationFrame(() => redecorateAll(plugin));
  window.setTimeout(() => redecorateAll(plugin), 250);
}

export function installConditionalFormatting(plugin: BasesToolboxPlugin): void {
  const refresh = debounce(() => redecorateAll(plugin), 150, true);
  plugin.refreshConditionalFormatting = () => scheduleRedecorate(plugin);

  // "is duplicated" needs the WHOLE base's rows (counts), so single-row
  // re-decoration can't evaluate it — route those to a group refresh instead.
  const hasDupRule = () =>
    plugin.settings.formatRules.some((r) => r.enabled && r.op === "duplicated" && r.property);

  const observe = (doc: Document) => {
    const observer = new MutationObserver((mutations) => {
      if (!plugin.settings.formatRules.length) return;
      for (const mutation of mutations) {
        // Row recycled to a different file (virtualization) → re-evaluate it.
        if (mutation.type === "attributes") {
          const t = mutation.target;
          if (t.instanceOf(HTMLElement)) {
            const row = (t as HTMLElement).closest<HTMLElement>(".bases-tr");
            if (row) hasDupRule() ? refresh() : decorateRow(plugin, row);
          }
          continue;
        }
        for (const node of Array.from(mutation.addedNodes)) {
          if (!node.instanceOf(HTMLElement)) continue;
          const el = node as HTMLElement;
          if (el.matches(".bases-tr")) hasDupRule() ? refresh() : decorateRow(plugin, el);
          else if (el.querySelector(".bases-tr")) refresh();
        }
      }
    });
    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-href"], // Bases recycles rows by swapping this
    });
    plugin.register(() => observer.disconnect());
  };
  observe(document);
  // A popout window opened later gets its own observer.
  plugin.registerEvent(
    plugin.app.workspace.on("window-open", (win) => observe(win.doc))
  );

  // Re-apply on every signal that a base view may have (re)rendered.
  plugin.registerEvent(plugin.app.metadataCache.on("changed", () => refresh()));
  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", () => refresh()));
  plugin.registerEvent(plugin.app.workspace.on("layout-change", () => scheduleRedecorate(plugin)));
  plugin.registerEvent(plugin.app.workspace.on("resize", () => refresh()));
  scheduleRedecorate(plugin);
}


/**
 * Picks which bases (sheets) a formatting rule applies to. Empty selection =
 * all bases. Lists every .base file in the vault as a checklist.
 */
export class BaseScopeModal extends Modal {
  private plugin: BasesToolboxPlugin;
  private selected: Set<string>;
  private onSave: (paths: string[]) => void;

  constructor(plugin: BasesToolboxPlugin, current: string[], onSave: (paths: string[]) => void) {
    super(plugin.app);
    this.plugin = plugin;
    this.selected = new Set(current);
    this.onSave = onSave;
  }

  onOpen(): void {
    this.titleEl.setText("Apply rule to which sheets?");
    const { contentEl } = this;
    contentEl.createDiv({
      cls: "bases-toolbox-fr-info",
      text: "Select the bases this rule colors. Select none to apply it to every base.",
    });

    const bases = this.app.vault
      .getFiles()
      .filter((f) => f.extension === "base")
      .sort((a, b) => a.path.localeCompare(b.path));
    if (!bases.length) {
      contentEl.createDiv({ cls: "bases-toolbox-fr-info", text: "No .base files in this vault yet." });
    }

    // Search — filters the checklist live by path/name.
    const search = contentEl.createEl("input", {
      type: "search",
      cls: "bases-toolbox-cf-scope-search",
      attr: { placeholder: "Filter bases…", "aria-label": "Filter bases" },
    });
    const list = contentEl.createDiv({ cls: "bases-toolbox-pin-list" });

    // Grouped by parent folder so long vaults stay navigable.
    const renderList = (query: string): void => {
      list.empty();
      const q = query.trim().toLowerCase();
      const groups = new Map<string, TFile[]>();
      for (const base of bases) {
        if (q && !base.path.toLowerCase().includes(q)) continue;
        const folder = base.parent?.path && base.parent.path !== "/" ? base.parent.path : "(vault root)";
        (groups.get(folder) ?? groups.set(folder, []).get(folder)!).push(base);
      }
      if (!groups.size) {
        list.createDiv({ cls: "bases-toolbox-fr-info", text: "No bases match." });
        return;
      }
      for (const folder of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
        list.createDiv({ cls: "bases-toolbox-cf-scope-folder", text: folder });
        for (const base of groups.get(folder)!) {
          const rowEl = list.createDiv({ cls: "bases-toolbox-dup-row" });
          const cb = rowEl.createEl("input", { type: "checkbox" });
          cb.checked = this.selected.has(base.path);
          cb.addEventListener("change", () => {
            if (cb.checked) this.selected.add(base.path);
            else this.selected.delete(base.path);
          });
          rowEl.createSpan({ text: ` ${base.basename}` });
        }
      }
    };
    renderList("");
    search.addEventListener("input", () => renderList(search.value));

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Apply to all")
          .onClick(() => {
            this.selected.clear();
            this.onSave([]);
            new Notice("Rule now applies to all sheets.");
            this.close();
          })
      )
      .addButton((b) =>
        b
          .setButtonText("Save")
          .setCta()
          .onClick(() => {
            this.onSave([...this.selected]);
            this.close();
          })
      );
  }
}
