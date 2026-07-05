import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { VIEW_TYPE_PROPERTY_INDEX } from "./property-index";
import { VIEW_TYPE_FIND_REPLACE } from "./find-replace-view";
import { VIEW_TYPE_HISTORY } from "./history-view";
import { VIEW_TYPE_FORMAT_DOCTOR } from "./format-doctor";
import { VIEW_TYPE_CONDITIONAL_FORMAT } from "./conditional-format-view";
import { VIEW_TYPE_DUPLICATE_FINDER } from "./merge";
import { VIEW_TYPE_CSV_IMPORT } from "./csv-import-view";
import { VIEW_TYPE_CSV_EXPORT } from "./csv-export-view";

export const VIEW_TYPE_LAUNCHER = "bases-toolbox-launcher";

/**
 * A friendly left-sidebar "launch anything" panel: every Bases Toolbox feature
 * with a button to open it, grouped by how it opens (a sidebar panel, a tab, or
 * a dialog). Built for coworkers who don't want to hunt the command palette.
 */

interface ViewFeature {
  name: string;
  desc: string;
  icon: string;
  type: string;
}

interface ToolFeature {
  name: string;
  desc: string;
  icon: string;
  /** Command id WITHOUT the `bases-toolbox:` prefix. */
  command: string;
}

const VIEWS: ViewFeature[] = [
  { name: "Property index", desc: "Every property, its values & files", icon: "table-properties", type: VIEW_TYPE_PROPERTY_INDEX },
  { name: "Find & replace", desc: "Bulk-edit a property's values", icon: "replace", type: VIEW_TYPE_FIND_REPLACE },
  { name: "History", desc: "Review & revert past changes", icon: "history", type: VIEW_TYPE_HISTORY },
  { name: "Format doctor", desc: "Fix values that don't match their type", icon: "stethoscope", type: VIEW_TYPE_FORMAT_DOCTOR },
  { name: "Conditional formatting", desc: "Color Bases rows/cells by value", icon: "paintbrush", type: VIEW_TYPE_CONDITIONAL_FORMAT },
  { name: "Find duplicate notes", desc: "Detect near-duplicate notes", icon: "copy", type: VIEW_TYPE_DUPLICATE_FINDER },
  { name: "Import CSV as notes", desc: "Turn a CSV/TSV into notes", icon: "file-down", type: VIEW_TYPE_CSV_IMPORT },
  { name: "Export to CSV", desc: "Scan a folder's notes into a CSV", icon: "file-up", type: VIEW_TYPE_CSV_EXPORT },
];

const TOOLS: ToolFeature[] = [
  { name: "Convert / fork a property", desc: "Normalize dates, (un)wrap wikilinks", icon: "git-fork", command: "fork-property" },
  { name: "Audit pinned allowed values", desc: "Find values outside an allowed list", icon: "pin", command: "audit-allowed-values" },
  { name: "Compute rollup", desc: "Aggregate linked notes into a property", icon: "sigma", command: "compute-rollup" },
  { name: "Migrate inline fields", desc: "Convert “key:: value” to frontmatter", icon: "list-plus", command: "migrate-inline-fields" },
  { name: "Merge note into another", desc: "Combine two notes + their properties", icon: "merge", command: "merge-note" },
  { name: "Create companion notes", desc: "Make non-Markdown files queryable", icon: "file-plus-2", command: "companion-notes" },
  { name: "Stamp file metadata", desc: "Write created/modified into frontmatter", icon: "stamp", command: "metadata-stamp" },
  { name: "Bulk edit base results", desc: "Edit properties across a base's rows", icon: "square-pen", command: "bulk-edit-base-results" },
  { name: "Zoom into cell", desc: "Big editor for the focused Bases cell", icon: "maximize-2", command: "zoom-into-cell" },
  { name: "Toggle base filters", desc: "Quickly enable/disable a base's filters", icon: "filter", command: "toggle-base-filters" },
];

export class LauncherView extends ItemView {
  icon = "wrench";
  private plugin: BasesToolboxPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: BasesToolboxPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_LAUNCHER;
  }

  getDisplayText(): string {
    return "Bases Toolbox";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("bases-toolbox-launcher");
    root.createDiv({ cls: "bases-toolbox-launcher-intro", text: "Open any Bases Toolbox feature." });

    // Panels & windows — the views open either in a sidebar or a main tab.
    root.createDiv({ cls: "bases-toolbox-launcher-section", text: "Panels & windows" });
    for (const f of VIEWS) {
      const card = this.card(root, f.name, f.desc, f.icon);
      this.launchBtn(card, "panel-right", "Sidebar", `Open ${f.name} in the sidebar`, () =>
        void this.openView(f.type, "sidebar")
      );
      this.launchBtn(card, "picture-in-picture-2", "Tab", `Open ${f.name} in a tab`, () =>
        void this.openView(f.type, "tab")
      );
      this.launchBtn(card, "app-window", "Window", `Open ${f.name} in a new window`, () =>
        void this.openView(f.type, "window")
      );
    }

    // Dialogs & actions — each opens its own modal / runs its action.
    root.createDiv({ cls: "bases-toolbox-launcher-section", text: "Dialogs & actions" });
    for (const f of TOOLS) {
      const card = this.card(root, f.name, f.desc, f.icon);
      this.launchBtn(card, "play", "Open", `Open ${f.name}`, () => this.runCommand(f.command));
    }

    // Settings shortcut at the bottom.
    root.createDiv({ cls: "bases-toolbox-launcher-section", text: "Settings" });
    const s = this.card(root, "Bases Toolbox settings", "Toggles, forks, formatting rules, reference", "settings");
    this.launchBtn(s, "settings", "Open", "Open Bases Toolbox settings", () => this.runCommand("open-settings"));
  }

  /** Run one of the plugin's commands by its (un-prefixed) id. `commands` is
   * undocumented on App, so it's accessed through a narrow cast. */
  private runCommand(command: string): void {
    (
      this.plugin.app as unknown as { commands: { executeCommandById: (id: string) => void } }
    ).commands.executeCommandById(`${this.plugin.manifest.id}:${command}`);
  }

  private card(parent: HTMLElement, name: string, desc: string, icon: string): HTMLElement {
    const card = parent.createDiv({ cls: "bases-toolbox-launcher-card" });
    setIcon(card.createSpan({ cls: "bases-toolbox-launcher-icon" }), icon);
    const text = card.createDiv({ cls: "bases-toolbox-launcher-text" });
    text.createDiv({ cls: "bases-toolbox-launcher-name", text: name });
    text.createDiv({ cls: "bases-toolbox-launcher-desc", text: desc });
    card.createDiv({ cls: "bases-toolbox-launcher-actions" });
    return card;
  }

  private launchBtn(card: HTMLElement, icon: string, label: string, aria: string, fn: () => void): void {
    const actions = card.querySelector<HTMLElement>(".bases-toolbox-launcher-actions") ?? card;
    const b = actions.createEl("button", { cls: "bases-toolbox-launcher-btn", text: label });
    setIcon(b.createSpan({ cls: "bases-toolbox-launcher-btn-icon" }), icon);
    b.setAttribute("aria-label", aria);
    b.addEventListener("click", fn);
  }

  /** Reuse an existing leaf of this type in the target area, else create one. */
  private async openView(type: string, where: "sidebar" | "tab" | "window"): Promise<void> {
    const ws = this.app.workspace;
    const isMain = (l: WorkspaceLeaf) => l.getRoot() === ws.rootSplit;
    const isSidebar = (l: WorkspaceLeaf) =>
      l.getRoot() === ws.leftSplit || l.getRoot() === ws.rightSplit;
    // A popout window is neither the main split nor a sidebar.
    const inArea = (l: WorkspaceLeaf) =>
      where === "sidebar" ? isSidebar(l) : where === "tab" ? isMain(l) : !isMain(l) && !isSidebar(l);
    const existing = ws.getLeavesOfType(type).find(inArea);
    if (existing) {
      await ws.revealLeaf(existing);
      return;
    }
    const leaf =
      where === "sidebar" ? ws.getRightLeaf(false) : ws.getLeaf(where === "window" ? "window" : "tab");
    if (!leaf) return;
    await leaf.setViewState({ type, active: true });
    await ws.revealLeaf(leaf);
  }
}

/** Opens the launcher in the LEFT sidebar (or reveals it if already open). */
export async function openLauncher(plugin: BasesToolboxPlugin): Promise<void> {
  const { workspace } = plugin.app;
  const existing = workspace.getLeavesOfType(VIEW_TYPE_LAUNCHER)[0];
  if (existing) {
    await workspace.revealLeaf(existing);
    return;
  }
  const leaf = workspace.getLeftLeaf(false);
  if (!leaf) return;
  await leaf.setViewState({ type: VIEW_TYPE_LAUNCHER, active: true });
  await workspace.revealLeaf(leaf);
}
