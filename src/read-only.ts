import { FuzzySuggestModal, Notice, TFile } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { BaseViewLike, activeBaseView, isBaseView } from "./base-detect";

/**
 * Read-only bases. A base is read-only when the global "all bases" setting is on
 * OR its `.base` path is in the per-base list. We mark the base view's container
 * with `bases-toolbox-readonly`; styles.css then disables pointer events on the
 * row body (`.bases-tbody`) so cells can't be edited, while keeping links and
 * the date-picker clickable. This is the community CSS-snippet approach, scoped
 * per base instead of applied globally, and re-applied as bases open/close.
 *
 * CSS scoping (not JS) does the enforcement, so it survives Bases re-rendering
 * its table — we only need to keep the container class in sync.
 */

const READONLY_CLASS = "bases-toolbox-readonly";
/** Extra modifier: also hide the toolbar "New" button (append-blocked). */
const READONLY_NONEW_CLASS = "bases-toolbox-readonly-nonew";

/** Whether the base at `path` should be read-only under the current settings. */
export function isBaseReadOnly(plugin: BasesToolboxPlugin, path: string): boolean {
  if (plugin.settings.readOnlyAllBases) return true;
  return plugin.settings.readOnlyBases.includes(path);
}

/** Syncs the read-only class on every open base view to match settings. */
export function applyReadOnly(plugin: BasesToolboxPlugin): void {
  for (const leaf of plugin.app.workspace.getLeavesOfType("bases")) {
    const view = leaf.view as BaseViewLike & { file?: TFile };
    const el = view.containerEl;
    if (!el) continue;
    const ro = view.file instanceof TFile && isBaseReadOnly(plugin, view.file.path);
    el.toggleClass(READONLY_CLASS, ro);
    el.toggleClass(READONLY_NONEW_CLASS, ro && plugin.settings.readOnlyBlockNewRow);
  }
}

/** Registers the listeners that keep read-only state applied as bases open. */
export function installReadOnly(plugin: BasesToolboxPlugin): void {
  const reapply = () => applyReadOnly(plugin);
  plugin.registerEvent(plugin.app.workspace.on("layout-change", reapply));
  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", reapply));
  // Initial pass once layout is ready.
  plugin.app.workspace.onLayoutReady(reapply);
}

/** Toggles read-only for a specific base file and re-applies. */
export async function toggleBaseReadOnly(plugin: BasesToolboxPlugin, file: TFile): Promise<boolean> {
  const list = plugin.settings.readOnlyBases;
  const i = list.indexOf(file.path);
  const nowReadOnly = i < 0;
  if (nowReadOnly) list.push(file.path);
  else list.splice(i, 1);
  await plugin.savePluginData();
  applyReadOnly(plugin);
  return nowReadOnly;
}

/** Command: toggle read-only for the base the user is looking at. */
export function toggleActiveBaseReadOnly(plugin: BasesToolboxPlugin): void {
  const view = activeBaseView(plugin.app);
  if (!isBaseView(view)) {
    new Notice("Open a base first, then toggle read-only.");
    return;
  }
  if (plugin.settings.readOnlyAllBases) {
    new Notice("All bases are read-only (global setting). Turn that off to control bases individually.");
    return;
  }
  void toggleBaseReadOnly(plugin, view.file).then((ro) =>
    new Notice(`“${view.file.basename}” is now ${ro ? "read-only" : "editable"}.`)
  );
}

/** Picks a base to add to the read-only list (only bases not already in it). */
export class ReadOnlyBasePicker extends FuzzySuggestModal<TFile> {
  constructor(
    private plugin: BasesToolboxPlugin,
    private onAdded: () => void
  ) {
    super(plugin.app);
    this.setPlaceholder("Pick a base to make read-only…");
  }
  getItems(): TFile[] {
    const set = new Set(this.plugin.settings.readOnlyBases);
    return this.app.vault.getFiles().filter((f) => f.extension === "base" && !set.has(f.path));
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    void toggleBaseReadOnly(this.plugin, f).then(this.onAdded);
  }
}

/** Command: flip the global "all bases read-only" setting. */
export async function toggleAllBasesReadOnly(plugin: BasesToolboxPlugin): Promise<void> {
  plugin.settings.readOnlyAllBases = !plugin.settings.readOnlyAllBases;
  await plugin.savePluginData();
  applyReadOnly(plugin);
  new Notice(`All bases are now ${plugin.settings.readOnlyAllBases ? "read-only" : "editable"}.`);
}
