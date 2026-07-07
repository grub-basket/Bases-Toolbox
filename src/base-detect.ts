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
 * The base view the user is looking at, in priority order:
 *   1. the focused leaf, if it's a base (base tab has keyboard focus);
 *   2. the most-recent MAIN-area leaf, if it's a base — `getMostRecentLeaf()`
 *      keeps pointing at the last-focused center tab even when focus has moved to
 *      a sidebar, the command palette, or a cell editor that blurs the leaf. This
 *      is what lets "New note with properties" work from the palette/hotkey
 *      without first clicking into a cell, and it disambiguates when several
 *      bases are open (returns the one you were actually viewing). Crucially it
 *      does NOT reach back to a base in a background tab: if your most-recent
 *      center tab is a markdown note, it returns that (not a base), so detection
 *      correctly yields null;
 *   3. the DOM-active base leaf (`.mod-active`) — belt-and-suspenders for older
 *      builds; and
 *   4. the sole open base, but ONLY at cold start (no center tab focused yet).
 *      Once a non-base center tab has been focused, tier 2 already returned null
 *      and we do not fall back to a background base here.
 * When several bases are open and none of the above resolves, return null rather
 * than guess (callers show a notice).
 *
 * Runtime signals only (no `apiVersion` branching): `getMostRecentLeaf` exists on
 * both 1.12.x stable and 1.13 insider, and on 1.12.7 the `.mod-active` class is
 * NOT reliably present on a base leaf once a sidebar is focused — which is why
 * tier 2 (not the DOM check) is the one that fixes the blank-rows / cell-required
 * report on stable.
 */
export function activeBaseView(app: App): (BaseViewLike & { file: TFile }) | null {
  const w = app.workspace;
  const focused = w.activeLeaf?.view;
  if (isBaseView(focused)) return focused;

  // The last-focused CENTER tab. If it's a base, that's the one you're viewing.
  // If it's a NON-base (a markdown note, another view), you're looking at
  // something else — do NOT reach back into a background base (honours the
  // "don't grab a base from another tab" intent). `recentLeaf` is null only
  // before any center tab has ever been focused (cold start), which the sole-base
  // fallback below covers.
  const recentLeaf = w.getMostRecentLeaf?.();
  const recent = recentLeaf?.view;
  if (isBaseView(recent)) return recent;

  const views = w.getLeavesOfType("bases").map((l) => l.view);
  // Belt-and-suspenders for builds that mark the active base leaf in the DOM.
  const domActive = views.find(
    (v) => (v as BaseViewLike)?.containerEl?.closest?.(".workspace-leaf.mod-active")
  );
  if (isBaseView(domActive)) return domActive;

  // Cold start only: no center tab has been focused yet AND exactly one base is
  // open → it's unambiguously the one on screen. When `recentLeaf` exists but was
  // a non-base, we deliberately fall through to null instead of grabbing this
  // base from the background.
  if (!recentLeaf && views.length === 1 && isBaseView(views[0])) return views[0];
  return null;
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
