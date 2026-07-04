import { ItemView, TFile, WorkspaceLeaf, debounce } from "obsidian";

/**
 * Shared refresh/focus helpers for the plugin's main-area + sidebar views.
 * (Extended in later commits with refocus-refresh and open-from-view helpers.)
 */

/**
 * Re-render a view when the metadata cache settles, so data edits made elsewhere
 * (deletes, find & replace, forks, reverts) show live without reopening the tab.
 * Debounced (leading+trailing) to coalesce a burst of file writes.
 */
/**
 * Adds a "Move to sidebar" tab-header action — the inverse of "Open in a main
 * tab". Moves the view's leaf into the right sidebar (carrying its state), or
 * just reveals it if it's already docked in the left/right sidebar.
 */
export function installSidebarAction(view: ItemView): void {
  view.addAction("sidebar-right", "Move to sidebar", () => void moveViewToSidebar(view));
}

async function moveViewToSidebar(view: ItemView): Promise<void> {
  const ws = view.app.workspace;
  const root = view.leaf.getRoot();
  if (root === ws.leftSplit || root === ws.rightSplit) {
    await ws.revealLeaf(view.leaf); // already in a sidebar
    return;
  }
  const right = ws.getRightLeaf(false);
  if (!right) return;
  const state = view.leaf.getViewState();
  await right.setViewState({ type: view.getViewType(), active: true, state: state.state });
  await ws.revealLeaf(right);
  view.leaf.detach();
}

/**
 * Adds an "Open in a main tab" tab-header action for views that don't already
 * have one, so a view moved into the sidebar can be brought back to a main tab.
 */
export function installMainTabAction(view: ItemView): void {
  view.addAction("picture-in-picture-2", "Open in a main tab", () => void moveViewToMainTab(view));
}

async function moveViewToMainTab(view: ItemView): Promise<void> {
  const ws = view.app.workspace;
  if (view.leaf.getRoot() === ws.rootSplit) {
    await ws.revealLeaf(view.leaf); // already a main tab
    return;
  }
  const leaf = ws.getLeaf("tab");
  const state = view.leaf.getViewState();
  await leaf.setViewState({ type: view.getViewType(), active: true, state: state.state });
  await ws.revealLeaf(leaf);
  view.leaf.detach();
}

export function installMetadataRefresh(view: ItemView, render: () => void, debounceMs = 600): void {
  const deb = debounce(render, debounceMs, true);
  view.registerEvent(view.app.metadataCache.on("resolved", () => deb()));
}

/**
 * Re-render when this view's leaf regains active focus. Fixes stale/blank
 * content on a deferred leaf that Obsidian parked while it was backgrounded.
 */
export function installRefocusRefresh(view: ItemView, render: () => void): void {
  view.registerEvent(
    view.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf === view.leaf) render();
    })
  );
}

/**
 * Anchors subsequent `getLeaf()` calls to the window the view lives in. A view
 * popped out into its own window otherwise dumps new tabs back in the MAIN
 * window, because getLeaf() resolves relative to the workspace's active leaf.
 * Call this immediately before opening tabs from a view.
 */
export function anchorViewWindow(view: ItemView): void {
  // Only re-anchor for POPOUT windows. In the main window, getLeaf("tab")
  // already opens in the main editor area — even when the view is docked in a
  // sidebar — whereas setActiveLeaf on a sidebar leaf would make getLeaf open
  // the note INSIDE the sidebar. A popout view has its own document.
  if (view.containerEl.ownerDocument === document) return;
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
  const target = ws.getLeaf(sameTab ? false : "tab");
  await target.openFile(file);
  // Auto-return-focus: when the user closes the note we just opened in a new
  // tab, bring the view back to the front. (Reusing the current tab has no
  // separate leaf to watch, so only arm for new tabs.)
  if (!sameTab) armReturnFocus(view, target);
}

/**
 * Re-reveals `view` once `openedLeaf` is gone from the workspace (the user closed
 * the note the view opened). One-shot: unregisters itself on fire. Does nothing
 * if the view itself was closed in the meantime.
 */
function armReturnFocus(view: ItemView, openedLeaf: WorkspaceLeaf): void {
  const ws = view.app.workspace;
  const ref = ws.on("layout-change", () => {
    let noteOpen = false;
    let viewOpen = false;
    ws.iterateAllLeaves((l) => {
      if (l === openedLeaf) noteOpen = true;
      if (l === view.leaf) viewOpen = true;
    });
    if (noteOpen) return; // note still open — keep waiting
    ws.offref(ref);
    if (viewOpen) void ws.revealLeaf(view.leaf);
  });
  view.registerEvent(ref);
}
