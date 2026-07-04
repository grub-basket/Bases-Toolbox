import { ItemView, TFile, debounce } from "obsidian";

/**
 * Shared refresh/focus helpers for the plugin's main-area + sidebar views.
 * (Extended in later commits with refocus-refresh and open-from-view helpers.)
 */

/**
 * Re-render a view when the metadata cache settles, so data edits made elsewhere
 * (deletes, find & replace, forks, reverts) show live without reopening the tab.
 * Debounced (leading+trailing) to coalesce a burst of file writes.
 */
export function installMetadataRefresh(view: ItemView, render: () => void, debounceMs = 600): void {
  const deb = debounce(render, debounceMs, true);
  view.registerEvent(view.app.metadataCache.on("resolved", () => deb()));
}

/**
 * Anchors subsequent `getLeaf()` calls to the window the view lives in. A view
 * popped out into its own window otherwise dumps new tabs back in the MAIN
 * window, because getLeaf() resolves relative to the workspace's active leaf.
 * Call this immediately before opening tabs from a view.
 */
export function anchorViewWindow(view: ItemView): void {
  view.app.workspace.setActiveLeaf(view.leaf, { focus: false });
}

/**
 * Opens a file from a plugin view in the SAME window as the view (popout-safe).
 * Alt/Option-click reuses the current tab instead of opening a new one.
 */
export async function openFileFromView(view: ItemView, file: TFile, e?: MouseEvent): Promise<void> {
  const ws = view.app.workspace;
  anchorViewWindow(view);
  const sameTab = !!e && e.altKey;
  await ws.getLeaf(sameTab ? false : "tab").openFile(file);
}
