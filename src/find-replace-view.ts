import { App, ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { isBaseView } from "./base-detect";
import type BasesToolboxPlugin from "./main";
import { parseReplacement, replaceIn } from "./find-replace";
import { PropertyUsage, findKey, valueToDisplay } from "./scan";
import { ChangeRecord, HistoryEntry } from "./types";
import { noticeWithUndo } from "./history";
import { ConfirmModal } from "./property-delete";
import { installMainTabAction, installRefocusRefresh, installSidebarAction, openFileFromView } from "./view-refresh";
import { attachAllowedSuggest } from "./suggest";

export const VIEW_TYPE_FIND_REPLACE = "bases-toolbox-find-replace";

const ALL = "__bt_all_values__";
/**
 * The Find dropdown's starting state: nothing chosen yet, so nothing previews
 * and Apply stays off. (It used to start on "All values" with an empty
 * replacement — one click cleared the property in every note in the vault.)
 */
const CHOOSE = "__bt_choose_value__";

/**
 * Open base tabs and the notes each one shows right now (after its filters and
 * search), keyed by TAB (leaf id), not by `.base` file: the same base open in
 * two tabs can show different views with different filters, and the run must
 * use exactly the rows of the tab the user picked. Reads the view's controller
 * results, the same undocumented internals bulk edit uses; a tab that isn't
 * loaded yet simply isn't listed.
 */
function openBaseRows(app: App): Map<string, { name: string; paths: Set<string> }> {
  const found: { id: string; base: string; paths: Set<string> }[] = [];
  for (const leaf of app.workspace.getLeavesOfType("bases")) {
    const v = leaf.view;
    const id = (leaf as unknown as { id?: string }).id;
    if (!isBaseView(v) || !id) continue;
    const results = v.controller?.results;
    if (!(results instanceof Map)) continue;
    const paths = new Set<string>();
    // Notes only: a folder filter also matches the .base files themselves.
    for (const f of results.keys()) if (f instanceof TFile && f.extension === "md") paths.add(f.path);
    found.push({ id, base: v.file.basename, paths });
  }
  // Same base in several tabs → label them "Tasks · tab 1", "Tasks · tab 2".
  const out = new Map<string, { name: string; paths: Set<string> }>();
  for (const f of found) {
    const same = found.filter((g) => g.base === f.base);
    const name = same.length > 1 ? `${f.base} · tab ${same.indexOf(f) + 1}` : f.base;
    out.set(f.id, { name, paths: f.paths });
  }
  return out;
}

interface PreviewRow {
  path: string;
  before: string;
  after: string;
  checked: boolean;
}

/**
 * Find & replace as a full main-area tab: pick property and value, then
 * review every matched file (current value → new value) as a checklist and
 * apply to only the checked ones. Replaces the old modal flow.
 */
export class FindReplaceView extends ItemView {
  icon = "replace";
  private plugin: BasesToolboxPlugin;
  private property = "";
  private find: string = CHOOSE;
  /** Id of the base TAB whose shown rows limit the run; "" = whole vault. */
  private scopeBase = "";
  /** That tab's label when picked, kept for messages after it closes. */
  private scopeName = "";
  private replace = "";
  private rows: PreviewRow[] = [];
  private running = false;

  private propertySel: HTMLSelectElement | null = null;
  private findSel: HTMLSelectElement | null = null;
  private replaceInput: HTMLInputElement | null = null;
  private validateEl: HTMLElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private applyBtn: HTMLButtonElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: BasesToolboxPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_FIND_REPLACE;
  }

  getDisplayText(): string {
    return "Find & replace properties";
  }

  /** Called by the property index / audit to open pre-filled. */
  setPreset(property: string, find?: string): void {
    this.property = property;
    this.find = find ?? CHOOSE;
    this.renderControls();
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("bases-toolbox-frv");
    this.renderControls();
    installMainTabAction(this);
    installSidebarAction(this);
    // Re-render when the tab regains focus (fixes stale/blank deferred leaves).
    // this.replace and the current property/find selections are instance fields,
    // so an in-progress replacement value survives the re-render.
    installRefocusRefresh(this, () => this.renderControls());
  }

  private usage(): PropertyUsage | undefined {
    return this.plugin.propertyCache.usage(this.property);
  }

  private renderControls(): void {
    const root = this.contentEl;
    root.empty();

    const props = this.plugin.propertyCache.get();
    if (!props.length) {
      root.createDiv({ cls: "bases-toolbox-fr-info", text: "No properties in this vault yet." });
      return;
    }

    // Say the reach up front: people expect bulk tools to act on the open
    // base's filtered rows, and by default this one doesn't.
    const bases = openBaseRows(this.app);
    const picked = this.scopeBase ? bases.get(this.scopeBase) : undefined;
    const scope = root.createDiv({ cls: "bases-toolbox-fr-scope" });
    scope.toggleClass("is-base", !!this.scopeBase);
    setIcon(scope.createSpan({ cls: "bases-toolbox-fr-scope-icon" }), this.scopeBase ? "table" : "globe");
    scope.createSpan({
      text: !this.scopeBase
        ? "Whole vault: changes every note that has the property, not just a base's rows. To change only the rows a base shows, pick it under Notes."
        : picked
          ? `Only the notes base “${picked.name}” shows right now (${picked.paths.size}, after its filters).`
          : "The base tab you picked was closed, so nothing will change. Pick an open base under Notes, or switch to Whole vault.",
    });

    // Each part on its own row: [Notes ▾], [Property ▾], [Find ▾], "Replace with", [textbox].
    const ctl = root.createDiv({ cls: "bases-toolbox-fr-controls" });

    // Notes: whole vault, or only the rows an open base shows. Offered when a
    // base is open (or one was picked and has since closed — kept, not
    // silently widened to the whole vault).
    if (bases.size || this.scopeBase) {
      const notesRow = ctl.createDiv({ cls: "bases-toolbox-fr-ctl-row" });
      notesRow.createSpan({ cls: "bases-toolbox-fr-ctl-label", text: "Notes" });
      const notesSel = notesRow.createEl("select", { cls: "dropdown" });
      notesSel.createEl("option", { value: "", text: "Whole vault" });
      for (const [path, b] of bases) {
        notesSel.createEl("option", { value: path, text: `Only rows of “${b.name}” (${b.paths.size} notes)` });
      }
      if (this.scopeBase && !picked) {
        notesSel.createEl("option", { value: this.scopeBase, text: `Only rows of “${this.scopeName}” (not open)` });
      }
      notesSel.value = this.scopeBase;
      notesSel.addEventListener("change", () => {
        this.scopeBase = notesSel.value;
        this.scopeName = bases.get(notesSel.value)?.name ?? "";
        this.renderControls();
      });
    }

    const propRow = ctl.createDiv({ cls: "bases-toolbox-fr-ctl-row" });
    propRow.createSpan({ cls: "bases-toolbox-fr-ctl-label", text: "Property" });
    this.propertySel = propRow.createEl("select", { cls: "dropdown" });
    if (!this.property) this.property = props[0].name;
    for (const p of props) {
      this.propertySel.createEl("option", { value: p.name, text: `${p.name} (${p.count})` });
    }
    this.propertySel.value = this.property;
    this.propertySel.addEventListener("change", () => {
      this.property = this.propertySel?.value ?? "";
      this.find = CHOOSE;
      this.renderControls();
    });

    const findRow = ctl.createDiv({ cls: "bases-toolbox-fr-ctl-row" });
    findRow.createSpan({ cls: "bases-toolbox-fr-ctl-label", text: "Find" });
    this.findSel = findRow.createEl("select", { cls: "dropdown" });
    const usage = this.usage();
    this.findSel.createEl("option", { value: CHOOSE, text: "Choose a value…" });
    this.findSel.createEl("option", {
      value: ALL,
      // The per-value counts are vault-wide, so a scoped run doesn't show one here.
      text: this.scopeBase
        ? "All values — every note with this property in that base"
        : `All values — every note with this property (${usage?.count ?? 0} files)`,
    });
    for (const [display, count] of [...(usage?.values.entries() ?? [])].sort((a, b) => b[1] - a[1])) {
      this.findSel.createEl("option", { value: display, text: `${display} (${count})` });
    }
    this.findSel.value = this.find;
    if (this.findSel.value !== this.find) {
      // preset value vanished from the vault — make the user choose again
      this.find = CHOOSE;
      this.findSel.value = CHOOSE;
    }
    this.findSel.addEventListener("change", () => {
      this.find = this.findSel?.value ?? CHOOSE;
      this.refreshResults();
    });

    ctl.createDiv({ cls: "bases-toolbox-fr-ctl-label bases-toolbox-fr-ctl-labelrow", text: "Replace with" });
    const replRow = ctl.createDiv({ cls: "bases-toolbox-fr-ctl-row" });
    this.replaceInput = replRow.createEl("input", {
      type: "text",
      attr: { placeholder: "New value (empty clears)" },
    });
    this.replaceInput.value = this.replace;
    // Suggest the target property's pinned allowed values (or its existing
    // values) so you can pick the correct replacement from the list.
    attachAllowedSuggest(this.plugin, this.replaceInput, () => this.property);
    this.replaceInput.addEventListener("input", () => {
      this.replace = this.replaceInput?.value ?? "";
      this.refreshResults();
    });

    this.validateEl = root.createDiv({ cls: "bases-toolbox-fr-info" });
    this.resultsEl = root.createDiv();

    const footer = root.createDiv({ cls: "bases-toolbox-frv-bar" });
    this.applyBtn = footer.createEl("button", { text: "Apply", cls: "mod-cta" });
    this.applyBtn.addEventListener("click", () => void this.apply());

    this.refreshResults();
  }

  private refreshResults(): void {
    const usage = this.usage();
    const results = this.resultsEl;
    if (!usage || !results) return;
    results.empty();

    if (this.find === CHOOSE) {
      this.rows = [];
      if (this.validateEl) {
        this.validateEl.empty();
        this.validateEl.removeClass("bases-toolbox-fr-clearwarn");
        this.validateEl.createSpan({
          text: `Pick the value to find — or “All values” to change every note that has ${usage.name}.`,
        });
      }
      this.updateApply();
      return;
    }

    // Validation line. Empty replacement is destructive (clears the value), so
    // it reads as a red warning with an icon; a filled-in value tempers it back
    // to a plain informational note.
    if (this.validateEl) {
      this.validateEl.empty();
      const empty = this.replace.trim() === "";
      this.validateEl.toggleClass("bases-toolbox-fr-clearwarn", empty);
      if (empty) {
        setIcon(this.validateEl.createSpan({ cls: "bases-toolbox-fr-warn-icon" }), "alert-triangle");
        this.validateEl.createSpan({ text: "Empty replacement clears the value." });
      } else {
        const display = valueToDisplay(parseReplacement(this.replace, usage.type));
        const count = usage.values.get(display) ?? 0;
        this.validateEl.createSpan({
          text: count
            ? `“${display}” is an existing value of ${usage.name} (${count} file${count === 1 ? "" : "s"}) — matches will merge into it.`
            : `“${display}” is a new value for ${usage.name}.`,
        });
      }
    }

    const find = this.find === ALL ? null : this.find;
    const replacement = parseReplacement(this.replace, usage.type);
    const scope = this.scopePaths();
    this.rows = [];
    for (const file of usage.files) {
      if (scope && !scope.has(file.path)) continue;
      const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
      const key = findKey(fm, usage.name);
      if (key === null) continue;
      const cur = fm[key];
      const next = replaceIn(cur, find, replacement);
      if (!next.changed) continue;
      this.rows.push({
        path: file.path,
        before: valueToDisplay(cur),
        after: valueToDisplay(next.value),
        checked: true,
      });
    }

    const header = results.createDiv({ cls: "bases-toolbox-frv-bar bases-toolbox-fr-summary-bar" });
    const selectAll = header.createEl("input", { type: "checkbox" });
    selectAll.checked = true;
    selectAll.addEventListener("change", () => {
      this.rows.forEach((r) => (r.checked = selectAll.checked));
      results
        .querySelectorAll<HTMLInputElement>(".bases-toolbox-frv-row input")
        .forEach((cb) => (cb.checked = selectAll.checked));
      this.updateApply();
    });
    header.createSpan({
      cls: "bases-toolbox-fr-summary",
      text: `${this.rows.length} file${this.rows.length === 1 ? "" : "s"} will change`,
    });

    const list = results.createDiv({ cls: "bases-toolbox-frv-list" });
    for (const row of this.rows) {
      const rowEl = list.createDiv({ cls: "bases-toolbox-frv-row" });
      const cb = rowEl.createEl("input", { type: "checkbox" });
      cb.checked = row.checked;
      cb.addEventListener("change", () => {
        row.checked = cb.checked;
        this.updateApply();
      });
      const link = rowEl.createSpan({ cls: "bases-toolbox-frv-path", text: row.path });
      link.addEventListener("click", () => {
        const f = this.app.vault.getAbstractFileByPath(row.path);
        if (f instanceof TFile) void openFileFromView(this, f);
        else void this.app.workspace.openLinkText(row.path, "", true);
      });
      rowEl.createSpan({ cls: "bases-toolbox-frv-diff", text: `${row.before} → ${row.after}` });
    }
    this.updateApply();
  }

  /** null = whole vault; otherwise the paths the picked base shows right now
   * (empty if that base has been closed, so nothing previews or applies). */
  private scopePaths(): Set<string> | null {
    if (!this.scopeBase) return null;
    return openBaseRows(this.app).get(this.scopeBase)?.paths ?? new Set();
  }

  private updateApply(): void {
    const n = this.rows.filter((r) => r.checked).length;
    if (this.applyBtn) {
      this.applyBtn.disabled = n === 0;
      this.applyBtn.setText(`Apply to ${n} file${n === 1 ? "" : "s"}`);
    }
  }

  /**
   * "All values" rewrites (or, with an empty replacement, clears) the property
   * in every checked note across the vault, so it asks first. A specific value
   * is a targeted change and applies straight away, as before.
   */
  private apply(): void {
    if (this.running || this.find === CHOOSE) return;
    const usage = this.usage();
    if (!usage) return;
    if (this.scopeGone()) return;
    if (this.find !== ALL) {
      void this.doApply();
      return;
    }
    const n = this.rows.filter((r) => r.checked).length;
    const notes = `${n} note${n === 1 ? "" : "s"}`;
    const clearing = this.replace.trim() === "";
    const display = valueToDisplay(parseReplacement(this.replace, usage.type));
    const where = this.scopeBase
      ? `shown by base “${this.scopeName}”`
      : "across the whole vault — not just a base's rows";
    new ConfirmModal(this.plugin, {
      title: clearing ? `Clear “${usage.name}” in ${notes}?` : `Replace every “${usage.name}” value in ${notes}?`,
      body:
        (clearing
          ? `This empties ${usage.name} in ${notes} ${where}.`
          : `Every value of ${usage.name} in ${notes} ${where} becomes “${display}” (lists collapse to that one value).`) +
        " It's logged, so you can undo it from History.",
      confirmText: clearing ? "Clear values" : "Replace all",
      danger: true,
      onConfirm: () => void this.doApply(),
    }).open();
  }

  /**
   * A scoped run whose base tab closed after the preview was built (the view
   * didn't re-render) must not go ahead on stale rows — stop, say why, and
   * re-render, which shows the "(not open)" state with nothing to apply.
   */
  private scopeGone(): boolean {
    if (!this.scopeBase || openBaseRows(this.app).has(this.scopeBase)) return false;
    new Notice(`Base “${this.scopeName}” isn't open any more — nothing was changed.`);
    this.renderControls();
    return true;
  }

  private async doApply(): Promise<void> {
    // Re-checked here too: the base can close while the confirm dialog is up.
    if (this.running || this.scopeGone()) return;
    const usage = this.usage();
    if (!usage) return;
    this.running = true;
    try {
      const find = this.find === ALL ? null : this.find;
      const replacement = parseReplacement(this.replace, usage.type);
      const wanted = new Set(this.rows.filter((r) => r.checked).map((r) => r.path));
      const changes: ChangeRecord[] = [];
      for (const file of usage.files) {
        if (!wanted.has(file.path)) continue;
        let oldValue: unknown;
        let newValue: unknown;
        let changed = false;
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          const key = findKey(fm, usage.name);
          if (key === null) return;
          const cur = fm[key];
          const next = replaceIn(cur, find, replacement);
          if (!next.changed) return;
          oldValue = Array.isArray(cur) ? cur.slice() : cur;
          newValue = Array.isArray(next.value) ? next.value.slice() : next.value;
          fm[key] = next.value;
          changed = true;
        });
        if (changed) changes.push({ path: file.path, property: usage.name, oldValue, newValue });
      }
      const message = `${usage.name}: updated ${changes.length} file${changes.length === 1 ? "" : "s"}.`;
      if (changes.length) {
        const entry: HistoryEntry = {
          property: usage.name,
          find,
          replace: this.replace,
          timestamp: Date.now(),
          changes,
          source: "find & replace",
        };
        await this.plugin.addHistoryEntry(entry);
        noticeWithUndo(this.plugin, message, entry);
      } else {
        new Notice(message);
      }
      this.replace = "";
      // After an all-values run, don't leave the view primed to run it again.
      if (this.find === ALL) this.find = CHOOSE;
      this.renderControls();
    } finally {
      this.running = false;
    }
  }
}

/** Opens (or reveals) the find & replace tab, optionally pre-filled. */
export async function openFindReplaceView(
  plugin: BasesToolboxPlugin,
  property?: string,
  find?: string
): Promise<void> {
  const { workspace } = plugin.app;
  let leaf = workspace.getLeavesOfType(VIEW_TYPE_FIND_REPLACE)[0];
  if (!leaf) {
    leaf = workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_FIND_REPLACE, active: true });
  }
  await workspace.revealLeaf(leaf);
  const view = leaf.view;
  if (view instanceof FindReplaceView && property) view.setPreset(property, find);
}
