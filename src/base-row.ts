import { App, TFile } from "obsidian";

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
}

interface RowModel {
  el?: unknown;
  entry?: { file?: unknown };
}

/** Depth-first search of a Component tree for the table row whose element is `row`. */
function fileFromRowModel(node: ComponentNode, row: Element): TFile | null {
  if (Array.isArray(node.rows)) {
    const match = (node.rows as RowModel[]).find((r) => r?.el === row);
    if (match) return match.entry?.file instanceof TFile ? match.entry.file : null;
  }
  if (!Array.isArray(node._children)) return null;
  for (const child of node._children as ComponentNode[]) {
    const file = child ? fileFromRowModel(child, row) : null;
    if (file) return file;
  }
  return null;
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

  // No file column in this view, so nothing in the DOM names the note. Ask the
  // table view that rendered the row (undocumented internals, hence the guards).
  let file: TFile | null = null;
  app.workspace.iterateAllLeaves((leaf) => {
    if (!file && leaf.view?.containerEl?.contains(row)) {
      file = fileFromRowModel(leaf.view as unknown as ComponentNode, row);
    }
  });
  return file;
}
