import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { changeInEffect, describeEntry, reportNotice, revertEntry } from "./history";
import { valueToDisplay } from "./scan";
import { HistoryEntry } from "./types";
import { installMainTabAction, installMetadataRefresh, installRefocusRefresh, installSidebarAction, openFileFromView } from "./view-refresh";

export const VIEW_TYPE_HISTORY = "bases-toolbox-history";

/**
 * Operation history as a main-area tab: every entry expands into per-file
 * rows (old → new, drift badge) with checkboxes, so a revert can target just
 * the files you pick — and optionally force-overwrite drifted ones.
 */
export class HistoryView extends ItemView {
  icon = "history";
  private plugin: BasesToolboxPlugin;
  private expanded = new Set<HistoryEntry>();
  private checked = new Map<HistoryEntry, Set<string>>();
  private force = false;

  constructor(leaf: WorkspaceLeaf, plugin: BasesToolboxPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_HISTORY;
  }

  getDisplayText(): string {
    return "Frontmatter (properties & values) History";
  }

  async onOpen(): Promise<void> {
    this.render();
    installMainTabAction(this);
    installSidebarAction(this);
    // Realtime refresh: a delete / find & replace / revert elsewhere writes
    // files → metadata "resolved" → the history list (and drift badges) update
    // without a close/reopen. Preserves expand/checkbox state (instance fields).
    installMetadataRefresh(this, () => this.render());
    installRefocusRefresh(this, () => this.render());
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("bases-toolbox-frv");

    if (!this.plugin.history.length) {
      root.createDiv({ cls: "bases-toolbox-fr-info", text: "No operations yet." });
      return;
    }

    const bar = root.createDiv({ cls: "bases-toolbox-frv-bar" });
    bar.createSpan({
      cls: "bases-toolbox-fr-info",
      text: `${this.plugin.history.length} operation${this.plugin.history.length === 1 ? "" : "s"} logged.`,
    });
    // Own line so it doesn't crowd the summary; propercased.
    const forceLabel = root.createEl("label", { cls: "bases-toolbox-fr-info bases-toolbox-frv-force" });
    const forceCb = forceLabel.createEl("input", { type: "checkbox" });
    forceCb.checked = this.force;
    forceCb.addEventListener("change", () => {
      this.force = forceCb.checked;
    });
    forceLabel.createSpan({ text: " Also revert notes I've edited since the change" });
    root.createDiv({
      cls: "bases-toolbox-fr-info bases-toolbox-frv-force-help",
      text: "By default, reverting skips any note you edited again after the change (marked “edited since”), so it never overwrites your newer work. Turn this on to revert those too. Note merges always revert as a whole and ignore this setting.",
    });

    for (const entry of [...this.plugin.history].reverse()) {
      this.renderEntry(root, entry);
    }
  }

  private renderEntry(root: HTMLElement, entry: HistoryEntry): void {
    const box = root.createDiv({ cls: "bases-toolbox-dup-group" });
    const header = box.createDiv({ cls: "bases-toolbox-index-prop-header" });
    header.createSpan({ cls: "bases-toolbox-index-prop-name", text: describeEntry(entry) });
    if (entry.source)
      header.createSpan({ cls: "bases-toolbox-index-prop-type", text: entry.source });
    const fileCount = entry.fileSnapshots?.length ?? entry.changes.length;
    header.createSpan({
      cls: "bases-toolbox-index-prop-count",
      text: `${new Date(entry.timestamp).toLocaleString()} · ${fileCount} file${fileCount === 1 ? "" : "s"}`,
    });
    if (entry.revertedAt)
      header.createSpan({ cls: "bases-toolbox-history-reverted", text: "reverted" });

    header.addEventListener("click", () => {
      if (this.expanded.has(entry)) this.expanded.delete(entry);
      else this.expanded.add(entry);
      this.render();
    });

    if (!this.expanded.has(entry)) return;

    // Merge entries restore whole-file snapshots — render those + an all-or-
    // nothing revert (a partial merge-revert would be incoherent).
    if (entry.fileSnapshots?.length) {
      this.renderMergeEntry(box, entry);
      return;
    }

    const checked = this.checked.get(entry) ?? new Set(entry.changes.map((c) => c.path));
    this.checked.set(entry, checked);

    const list = box.createDiv({ cls: "bases-toolbox-frv-list" });
    for (const change of entry.changes) {
      const row = list.createDiv({ cls: "bases-toolbox-frv-row" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = checked.has(change.path);
      cb.addEventListener("change", () => {
        if (cb.checked) checked.add(change.path);
        else checked.delete(change.path);
      });
      const file = this.app.vault.getAbstractFileByPath(change.path);
      const link = row.createSpan({ cls: "bases-toolbox-frv-path", text: change.path });
      link.addEventListener("click", () => {
        if (file instanceof TFile) void openFileFromView(this, file);
        else void this.app.workspace.openLinkText(change.path, "", true);
      });

      // drift badge: is the operation's change still in effect for this file?
      const fm = file
        ? ((this.app.metadataCache.getFileCache(file as never)?.frontmatter ?? {}) as Record<string, unknown>)
        : null;
      if (!fm) row.createSpan({ cls: "bases-toolbox-history-reverted", text: "file missing" });
      else if (!changeInEffect(fm, change))
        row.createSpan({ cls: "bases-toolbox-history-reverted", text: "edited since" });

      const before = change.deleted || !change.created ? valueToDisplay(change.oldValue) : "(new)";
      const after = change.deleted
        ? "(deleted)"
        : change.newValue === undefined
          ? "?"
          : valueToDisplay(change.newValue);
      row.createSpan({ cls: "bases-toolbox-frv-diff", text: `${before} → ${after}` });
    }

    if (!entry.revertedAt) {
      const btn = box.createEl("button", { text: "Revert selected" });
      btn.addEventListener("click", () => void (async () => {
        btn.disabled = true;
        const paths = this.checked.get(entry) ?? new Set<string>();
        const all = paths.size === entry.changes.length;
        reportNotice(
          entry,
          await revertEntry(this.plugin, entry, {
            paths: all ? undefined : paths,
            force: this.force,
          })
        );
        this.render();
      })());
    }
  }

  /** Snapshot-based merge entry: list the affected notes and a single armed
   * "Revert merge" button that restores everything to the pre-merge state. */
  private renderMergeEntry(box: HTMLElement, entry: HistoryEntry): void {
    const list = box.createDiv({ cls: "bases-toolbox-frv-list" });
    for (const snap of entry.fileSnapshots ?? []) {
      const row = list.createDiv({ cls: "bases-toolbox-frv-row" });
      const file = this.app.vault.getAbstractFileByPath(snap.path);
      const link = row.createSpan({ cls: "bases-toolbox-frv-path", text: snap.path });
      link.addEventListener("click", () => {
        if (file instanceof TFile) void openFileFromView(this, file);
        else void this.app.workspace.openLinkText(snap.path, "", true);
      });
      row.createSpan({
        cls: "bases-toolbox-frv-diff",
        text: snap.kind === "removed" ? "trashed → will be recreated" : "changed → will be restored",
      });
    }

    if (entry.revertedAt) return;
    box.createDiv({
      cls: "bases-toolbox-fr-info",
      text: "Reverting restores every note above to its pre-merge state and recreates the trashed sources. Any edits made since the merge are overwritten.",
    });
    const btn = box.createEl("button", { text: "Revert merge" });
    let armed = false;
    btn.addEventListener("click", () => void (async () => {
      if (!armed) {
        armed = true;
        btn.setText("Click again to confirm reverting this merge");
        btn.addClass("mod-warning");
        return;
      }
      btn.disabled = true;
      reportNotice(entry, await revertEntry(this.plugin, entry));
      this.render();
    })());
  }
}

export async function openHistoryView(plugin: BasesToolboxPlugin): Promise<void> {
  const { workspace } = plugin.app;
  let leaf = workspace.getLeavesOfType(VIEW_TYPE_HISTORY)[0];
  if (!leaf) {
    leaf = workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_HISTORY, active: true });
  }
  await workspace.revealLeaf(leaf);
  if (leaf.view instanceof HistoryView) leaf.view.render();
}
