import { App, Events, Plugin, TFile } from "obsidian";

/**
 * Which note does a Bases table row belong to?
 *
 * "The first `[data-href]` in the row" is NOT an answer: any property cell
 * holding an internal link renders its own `data-href`, and that link can sit
 * to the left of the file column. Its value is the link's text, so it either
 * resolves to nothing or (for a link written as a full path) to the LINKED
 * note. Everything that reads or writes "this row's note" must come through
 * here instead.
 */

/** The cell Bases renders as a link to the row's own note (file.name / file). */
const OWN_FILE_LINK =
  '.bases-td[data-property="file.name"] [data-href], .bases-td[data-property="file.file"] [data-href]';

interface ComponentNode {
  _children?: unknown;
  rows?: unknown;
  file?: unknown;
  /** Popover opened from this component. It lives outside the view's DOM. */
  hoverPopover?: unknown;
  previewMode?: unknown;
  editMode?: unknown;
  /** A canvas card's content. */
  child?: unknown;
  canvas?: { nodes?: unknown };
}

interface RowModel {
  el?: unknown;
  entry?: { file?: unknown };
}

/** The components reachable from `node`, including the ones `_children` omits. */
function linkedComponents(node: ComponentNode): unknown[] {
  return [
    ...(Array.isArray(node._children) ? (node._children as unknown[]) : []),
    node.hoverPopover,
    node.previewMode,
    node.editMode,
    node.child,
  ];
}

interface RowMatch {
  /** The note the row shows. */
  file: TFile | null;
  /** The .base file whose table drew the row, when a component names it. */
  base: TFile | null;
}

/** Depth-first search of a Component tree for the table row whose element is `row`. */
function searchComponents(
  node: ComponentNode,
  row: Element,
  base: TFile | null,
  seen: Set<ComponentNode>
): RowMatch | null {
  seen.add(node);
  const ownBase = node.file instanceof TFile && node.file.extension === "base" ? node.file : base;
  if (Array.isArray(node.rows)) {
    const match = (node.rows as RowModel[]).find((r) => r?.el === row);
    if (match) {
      return { file: match.entry?.file instanceof TFile ? match.entry.file : null, base: ownBase };
    }
  }
  for (const linked of linkedComponents(node)) {
    if (!linked || typeof linked !== "object" || seen.has(linked)) continue;
    const found = searchComponents(linked, row, ownBase, seen);
    if (found) return found;
  }
  // Canvas cards are independent tables: one card's base says nothing about another's.
  const cards = node.canvas?.nodes;
  if (cards instanceof Map) {
    for (const card of cards.values() as Iterable<ComponentNode>) {
      if (seen.has(card)) continue;
      const found = searchComponents(card, row, null, seen);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Whatever recently opened a hover popover. Search results, backlinks, tab
 * headers and links inside Bases cells hold their popover on an object no
 * workspace leaf leads to, so remember the ones seen. A few is enough: only a
 * popover still on screen can contain a row.
 */
let recentHoverParents: ComponentNode[] = [];
const MAX_HOVER_PARENTS = 5;

export function trackHoverParents(plugin: Plugin): void {
  // "hover-link" is the event every link hover goes through; it isn't in the typings.
  const onHover = (data: unknown) => {
    const parent = (data as { hoverParent?: unknown } | null)?.hoverParent;
    if (!parent || typeof parent !== "object") return;
    recentHoverParents = [
      parent,
      ...recentHoverParents.filter((p) => p !== parent),
    ].slice(0, MAX_HOVER_PARENTS);
  };
  plugin.registerEvent((plugin.app.workspace as Events).on("hover-link", onHover));
  plugin.register(() => {
    recentHoverParents = [];
  });
}

/**
 * Asks the table view that rendered the row (undocumented internals, hence the
 * guards). A hover popover sits outside every view's DOM, so any view may have
 * opened it.
 */
function findRowInViews(app: App, row: Element): RowMatch | null {
  const inPopover = row.closest(".hover-popover") !== null;
  let found: RowMatch | null = null;
  if (inPopover) {
    for (const parent of recentHoverParents) {
      found = searchComponents(parent, row, null, new Set());
      if (found) return found;
    }
  }
  app.workspace.iterateAllLeaves((leaf) => {
    if (!found && (inPopover || leaf.view?.containerEl?.contains(row))) {
      found = searchComponents(leaf.view as unknown as ComponentNode, row, null, new Set());
    }
  });
  return found;
}

/**
 * The note a Bases table row shows, or null for a row that has none (a header)
 * or that can't be identified. Null means "leave this row alone": callers must
 * never fall back to some other link in the row.
 */
export function fileForBaseRow(app: App, row: Element): TFile | null {
  const href = row.querySelector(OWN_FILE_LINK)?.getAttribute("data-href");
  const linked = href ? app.vault.getAbstractFileByPath(href) : null;
  if (linked instanceof TFile) return linked;

  // No file column in this view, so nothing in the DOM names the note.
  return findRowInViews(app, row)?.file ?? null;
}

/** The .base file a row belongs to, for surfaces whose DOM doesn't name it. */
export function baseFileForRow(app: App, row: Element): TFile | null {
  return findRowInViews(app, row)?.base ?? null;
}
