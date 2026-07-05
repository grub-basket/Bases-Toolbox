import { ItemView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { changeInEffect, describeEntry, reportNotice, revertEntry } from "./history";
import type { RevertReport, SkipReason } from "./history";
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
  /** Result of the last revert, per entry — so skipped files stay on screen. */
  private lastReport = new Map<HistoryEntry, RevertReport>();

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
      this.render(); // re-render so the per-entry risk warnings appear/disappear
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

  /** A data-loss warning to show in the header, or null when reverting is safe.
   * Merges always overwrite post-merge edits; other operations only do so when
   * "force" is on (otherwise drifted notes are skipped, not clobbered). */
  private riskWarning(entry: HistoryEntry): string | null {
    if (entry.revertedAt) return null; // nothing left to revert
    if (entry.fileSnapshots?.length) return "reverting overwrites edits made after the merge";
    if (this.force) return "force is on — reverting overwrites notes you edited since";
    return null;
  }

  private renderEntry(root: HTMLElement, entry: HistoryEntry): void {
    const box = root.createDiv({ cls: "bases-toolbox-dup-group" });
    const header = box.createDiv({ cls: "bases-toolbox-index-prop-header" });
    header.createSpan({ cls: "bases-toolbox-index-prop-name", text: describeEntry(entry) });
    // Red risk flag right after the name: reverting THIS entry could lose data.
    // Merges always can (whole-note restore); other ops only when force is on
    // (otherwise notes you've edited since are safely skipped).
    const risk = this.riskWarning(entry);
    if (risk) {
      const w = header.createSpan({ cls: "bases-toolbox-history-risk" });
      setIcon(w.createSpan({ cls: "bases-toolbox-history-risk-icon" }), "alert-triangle");
      w.createSpan({ text: risk });
    }
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
        const report = await revertEntry(this.plugin, entry, {
          paths: all ? undefined : paths,
          force: this.force,
        });
        this.lastReport.set(entry, report);
        reportNotice(entry, report);
        this.render();
      })());
    }

    this.renderSkipped(box, entry);
  }

  /** After a revert, list the files that were NOT reverted (and why) so the
   * user can open them and decide what to do — no hunting through a toast. */
  private renderSkipped(box: HTMLElement, entry: HistoryEntry): void {
    const report = this.lastReport.get(entry);
    if (!report?.skipped.length) return;

    const reasonText: Record<SkipReason, string> = {
      "edited since": "edited since — left untouched",
      "property missing": "property renamed or removed — left untouched",
      "file missing": "file moved or deleted — nothing to revert",
      "path reused": "a note now occupies this path — not recreated",
    };

    const panel = box.createDiv({ cls: "bases-toolbox-history-skipped" });
    panel.createDiv({
      cls: "bases-toolbox-fr-info",
      text: `${report.skipped.length} file${report.skipped.length === 1 ? "" : "s"} not reverted:`,
    });
    for (const s of report.skipped) {
      const row = panel.createDiv({ cls: "bases-toolbox-frv-row" });
      const link = row.createSpan({ cls: "bases-toolbox-frv-path", text: s.path });
      link.addEventListener("click", () => {
        const f = this.app.vault.getAbstractFileByPath(s.path);
        if (f instanceof TFile) void openFileFromView(this, f);
        else void this.app.workspace.openLinkText(s.path, "", true);
      });
      row.createSpan({ cls: "bases-toolbox-frv-diff", text: reasonText[s.reason] });
    }
    if (report.skipped.some((s) => s.reason === "edited since")) {
      panel.createDiv({
        cls: "bases-toolbox-fr-info bases-toolbox-frv-force-help",
        text: "“Edited since” means the property was changed again after this operation, so it was left alone to protect that newer edit. Open a file to review it — or tick “Also revert notes I've edited since the change” above and revert again to overwrite them.",
      });
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

    if (entry.revertedAt) {
      this.renderSkipped(box, entry);
      return;
    }
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
      const report = await revertEntry(this.plugin, entry);
      this.lastReport.set(entry, report);
      reportNotice(entry, report);
      this.render();
    })());
    this.renderSkipped(box, entry);
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
