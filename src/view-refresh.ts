import { ItemView, debounce } from "obsidian";

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
