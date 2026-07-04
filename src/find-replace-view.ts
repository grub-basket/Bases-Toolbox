import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { parseReplacement, replaceIn } from "./find-replace";
import { PropertyUsage, findKey, valueToDisplay } from "./scan";
import { ChangeRecord } from "./types";
import { installMainTabAction, installRefocusRefresh, installSidebarAction, openFileFromView } from "./view-refresh";
import { attachAllowedSuggest } from "./suggest";

export const VIEW_TYPE_FIND_REPLACE = "bases-toolbox-find-replace";

const ALL = "__bt_all_values__";

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
  private find: string = ALL;
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
    this.find = find ?? ALL;
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

    const bar = root.createDiv({ cls: "bases-toolbox-frv-bar" });

    bar.createSpan({ text: "Property" });
    this.propertySel = bar.createEl("select");
    const props = this.plugin.propertyCache.get();
    if (!props.length) {
      root.createDiv({ cls: "bases-toolbox-fr-info", text: "No properties in this vault yet." });
      return;
    }
    if (!this.property) this.property = props[0].name;
    for (const p of props) {
      this.propertySel.createEl("option", { value: p.name, text: `${p.name} (${p.count})` });
    }
    this.propertySel.value = this.property;
    this.propertySel.addEventListener("change", () => {
      this.property = this.propertySel?.value ?? "";
      this.find = ALL;
      this.renderControls();
    });

    bar.createSpan({ text: "Find" });
    this.findSel = bar.createEl("select");
    const usage = this.usage();
    this.findSel.createEl("option", { value: ALL, text: `All values (${usage?.count ?? 0} files)` });
    for (const [display, count] of [...(usage?.values.entries() ?? [])].sort((a, b) => b[1] - a[1])) {
      this.findSel.createEl("option", { value: display, text: `${display} (${count})` });
    }
    this.findSel.value = this.find;
    if (this.findSel.value !== this.find) {
      // preset value vanished from the vault — fall back to All
      this.find = ALL;
      this.findSel.value = ALL;
    }
    this.findSel.addEventListener("change", () => {
      this.find = this.findSel?.value ?? ALL;
      this.refreshResults();
    });

    bar.createSpan({ text: "Replace with" });
    this.replaceInput = bar.createEl("input", {
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

    // validation line (same semantics as the old modal)
    if (this.validateEl) {
      if (this.replace.trim() === "") this.validateEl.setText("Empty replacement clears the value.");
      else {
        const display = valueToDisplay(parseReplacement(this.replace, usage.type));
        const count = usage.values.get(display) ?? 0;
        this.validateEl.setText(
          count
            ? `“${display}” is an existing value of ${usage.name} (${count} file${count === 1 ? "" : "s"}) — matches will merge into it.`
            : `“${display}” is a new value for ${usage.name}.`
        );
      }
    }

    const find = this.find === ALL ? null : this.find;
    const replacement = parseReplacement(this.replace, usage.type);
    this.rows = [];
    for (const file of usage.files) {
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

    const header = results.createDiv({ cls: "bases-toolbox-frv-bar" });
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
      cls: "bases-toolbox-fr-info",
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

  private updateApply(): void {
    const n = this.rows.filter((r) => r.checked).length;
    if (this.applyBtn) {
      this.applyBtn.disabled = n === 0;
      this.applyBtn.setText(`Apply to ${n} file${n === 1 ? "" : "s"}`);
    }
  }

  private async apply(): Promise<void> {
    if (this.running) return;
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
      if (changes.length) {
        await this.plugin.addHistoryEntry({
          property: usage.name,
          find,
          replace: this.replace,
          timestamp: Date.now(),
          changes,
          source: "find & replace",
        });
      }
      new Notice(`${usage.name}: updated ${changes.length} file${changes.length === 1 ? "" : "s"}.`);
      this.replace = "";
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
