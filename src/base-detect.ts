import { App, TFile } from "obsidian";

/**
 * Shared "which base is the user looking at" detection.
 *
 * `app.workspace.activeLeaf` / `getActiveFile()` are NOT reliable for this: they
 * can point at a non-base leaf even when a base is open and on screen (focus in
 * a cell editor, a sidebar, another plugin's view, or the command palette
 * leaving a different view focused). `getLeavesOfType("bases")` is the reliable
 * signal — the same one Bulk Edit and Conditional Formatting already use.
 */

export type BaseViewLike = {
  getViewType?: () => string;
  file?: TFile;
  containerEl?: HTMLElement;
  controller?: { results?: unknown };
};

export function isBaseView(v: unknown): v is BaseViewLike & { file: TFile } {
  return (
    !!v &&
    (v as BaseViewLike).getViewType?.() === "bases" &&
    (v as BaseViewLike).file instanceof TFile
  );
}

/**
 * The base view the user is looking at: prefer the focused leaf, then the
 * DOM-active base leaf, then the sole open base. When several bases are open and
 * none is DOM-active, return null rather than guess (callers show a notice).
 */
export function activeBaseView(app: App): (BaseViewLike & { file: TFile }) | null {
  const w = app.workspace;
  const focused = w.activeLeaf?.view;
  if (isBaseView(focused)) return focused;
  const views = w.getLeavesOfType("bases").map((l) => l.view);
  const domActive = views.find(
    (v) => (v as BaseViewLike)?.containerEl?.closest?.(".workspace-leaf.mod-active")
  );
  const chosen = domActive ?? (views.length === 1 ? views[0] : null);
  return isBaseView(chosen) ? chosen : null;
}

/**
 * The `.base` file backing the base view that contains a given cell/element —
 * derived from the owning leaf, not `getActiveFile()` (which can point
 * elsewhere when the base isn't the focused leaf). Returns null if no open base
 * leaf contains the element.
 */
export function baseFileForCell(app: App, el: HTMLElement): TFile | null {
  const owning = app.workspace
    .getLeavesOfType("bases")
    .find((l) => (l.view as BaseViewLike)?.containerEl?.contains(el))?.view as
    | BaseViewLike
    | undefined;
  return owning?.file instanceof TFile ? owning.file : null;
}
