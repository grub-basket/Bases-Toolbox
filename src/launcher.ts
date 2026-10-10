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
import { siftMatch } from "./sift";

export const VIEW_TYPE_LAUNCHER = "bases-toolbox-launcher";

/**
 * A friendly left-sidebar "launch anything" panel: every Bases Toolbox feature
 * with a button to open it, grouped by WHAT IT ACTS ON (the open base, one
 * note, the whole vault…) with the tools that rewrite many notes at once kept
 * at the bottom, out of harm's way. Each card also wears a scope tag, so the
 * reach of a tool is visible in Favorites and search results too. Built for
 * coworkers who don't want to hunt the command palette.
 */

/**
 * What a tool can change — shown as a tag on its card. "display" tools only
 * read notes or change how Bases looks, never note contents.
 */
type Scope = "vault" | "folder" | "base" | "note" | "display";

const SCOPE_LABEL: Record<Scope, string> = {
  vault: "Whole vault",
  folder: "Folder or vault",
  base: "Open base",
  note: "One note",
  display: "Changes no notes",
};

const SCOPE_TIP: Record<Scope, string> = {
  vault: "Can change notes anywhere in the vault",
  folder: "Changes notes in a folder you pick — or the whole vault if you leave it empty",
  base: "Works on the base in your active tab (its filtered rows)",
  note: "Works on a single note",
  display: "Only reads notes or changes how Bases looks — note contents are left alone",
};

interface FeatureBase {
  name: string;
  desc: string;
  icon: string;
  scope?: Scope;
  /** Overrides the scope tag's text (e.g. "Two notes" for merge). */
  scopeLabel?: string;
}

interface ViewFeature extends FeatureBase {
  kind: "view";
  type: string;
}

interface ToolFeature extends FeatureBase {
  kind: "tool";
  /** Command id WITHOUT the `bases-toolbox:` prefix. */
  command: string;
}

type Feature = ViewFeature | ToolFeature;

interface Section {
  title: string;
  hint?: string;
  items: Feature[];
}

const view = (f: Omit<ViewFeature, "kind">): ViewFeature => ({ kind: "view", ...f });
const tool = (f: Omit<ToolFeature, "kind">): ToolFeature => ({ kind: "tool", ...f });

const SECTIONS: Section[] = [
  {
    title: "This base",
    hint: "Work on the base in your active tab.",
    items: [
      tool({ name: "Bulk edit base results", desc: "Edit the notes the open base shows (only its filtered rows)", icon: "square-pen", command: "bulk-edit-base-results", scope: "base" }),
      tool({ name: "Toggle base filters", desc: "Quickly enable/disable a base's filters", icon: "filter", command: "toggle-base-filters", scope: "base" }),
      tool({ name: "Manage base columns", desc: "Hide, reveal, reorder & jump to a view's columns", icon: "columns-3", command: "manage-base-columns", scope: "base" }),
      tool({ name: "Manage base views", desc: "Rename, duplicate, reorder & delete a base's views", icon: "settings-2", command: "manage-base-views", scope: "base" }),
      tool({ name: "Add formula column", desc: "Add or fix a base's formula (computed) column", icon: "function-square", command: "add-formula-column", scope: "base" }),
      tool({ name: "Sync formula", desc: "Write a base's formula results into a property", icon: "function-square", command: "sync-formula", scope: "base" }),
      tool({ name: "Compute rollup", desc: "Aggregate linked notes into a property", icon: "sigma", command: "compute-rollup", scope: "base" }),
      tool({ name: "Zoom into cell", desc: "Big editor for the focused Bases cell", icon: "maximize-2", command: "zoom-into-cell", scope: "note" }),
      tool({ name: "Toggle base read-only", desc: "Lock this base so its cells can't be edited", icon: "lock", command: "toggle-base-readonly", scope: "base" }),
      tool({ name: "Kanban card order", desc: "Give a base's kanban a persistent, manual card order", icon: "kanban-square", command: "kanban-manual-order", scope: "base" }),
      tool({ name: "Hide empty kanban columns", desc: "Toggle hiding columns with no cards on a kanban base", icon: "gallery-vertical-end", command: "kanban-toggle-hide-empty", scope: "base" }),
      tool({ name: "Exclude skipped extensions", desc: "Filter files like .edtz out of a base (uses your skip list)", icon: "file-x", command: "exclude-skipped-extensions", scope: "base" }),
      view({ name: "Conditional formatting", desc: "Color Bases rows/cells by value", icon: "paintbrush", type: VIEW_TYPE_CONDITIONAL_FORMAT, scope: "display" }),
    ],
  },
  {
    title: "One note",
    hint: "Work on the note you have open.",
    items: [
      tool({ name: "New note with properties", desc: "Create a note via a roomy property form", icon: "file-plus", command: "new-note-with-properties", scope: "note" }),
      tool({ name: "Edit note properties", desc: "Roomy form for the active note (with rename)", icon: "table-properties", command: "edit-note-properties", scope: "note" }),
      tool({ name: "Merge note into another", desc: "Combine two notes + their properties", icon: "merge", command: "merge-note", scope: "note", scopeLabel: "Two notes" }),
    ],
  },
  {
    title: "Explore & review",
    hint: "Look across the vault. Nothing changes until you act on an item.",
    items: [
      view({ name: "Property index", desc: "Every property, its values & files", icon: "table-properties", type: VIEW_TYPE_PROPERTY_INDEX, scope: "vault" }),
      view({ name: "History", desc: "Review & revert past changes", icon: "history", type: VIEW_TYPE_HISTORY }),
      view({ name: "Format doctor", desc: "Fix values that don't match their type", icon: "stethoscope", type: VIEW_TYPE_FORMAT_DOCTOR, scope: "vault" }),
      view({ name: "Find duplicate notes", desc: "Detect near-duplicate notes", icon: "copy", type: VIEW_TYPE_DUPLICATE_FINDER, scope: "vault" }),
      tool({ name: "Audit pinned allowed values", desc: "Find values outside an allowed list", icon: "pin", command: "audit-allowed-values", scope: "vault" }),
      tool({ name: "Audit aliased links", desc: "Find property links with aliases to standardize", icon: "link", command: "audit-aliased-links", scope: "display" }),
    ],
  },
  {
    title: "Import & export",
    items: [
      view({ name: "Import CSV as notes", desc: "Turn a CSV/TSV into notes", icon: "file-down", type: VIEW_TYPE_CSV_IMPORT, scope: "folder", scopeLabel: "Creates notes" }),
      view({ name: "Export to CSV", desc: "Scan a folder's notes into a CSV", icon: "file-up", type: VIEW_TYPE_CSV_EXPORT, scope: "display" }),
      tool({ name: "New grid", desc: "Open an editable grid over a folder (needs GridSense)", icon: "grid-3x3", command: "new-grid", scope: "folder" }),
    ],
  },
  {
    title: "Many notes at once",
    hint: "Change notes across the whole vault (or a folder you pick) in one go. Every change is logged, so you can undo it from History.",
    items: [
      view({ name: "Find & replace", desc: "Change one property's values in every note in the vault", icon: "replace", type: VIEW_TYPE_FIND_REPLACE, scope: "vault" }),
      tool({ name: "Convert / fork a property", desc: "Normalize dates, (un)wrap wikilinks, or copy into another property", icon: "git-fork", command: "fork-property", scope: "vault" }),
      tool({ name: "Migrate inline fields", desc: "Convert “key:: value” to frontmatter", icon: "list-plus", command: "migrate-inline-fields", scope: "folder" }),
      tool({ name: "Stamp file metadata", desc: "Write created/modified into frontmatter", icon: "stamp", command: "metadata-stamp", scope: "folder" }),
      tool({ name: "Create companion notes", desc: "Make non-Markdown files queryable", icon: "file-plus-2", command: "companion-notes", scope: "folder" }),
    ],
  },
];

const ALL_FEATURES: Feature[] = SECTIONS.flatMap((s) => s.items);

/** The favorite id a feature is stored under (stable across regroupings). */
const featureId = (f: Feature): string => (f.kind === "view" ? `view:${f.type}` : `cmd:${f.command}`);

export class LauncherView extends ItemView {
  icon = "wrench";
  private plugin: BasesToolboxPlugin;
  /** Live search query; survives re-renders (favoriting rebuilds the list). */
  private filterQuery = "";

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
    root.createDiv({
      cls: "bases-toolbox-launcher-intro",
      text: "Open any Bases Toolbox feature. The tag on each card says what it can change. Tap the ☆ to pin one to Favorites.",
    });

    // Search/filter — narrows the visible cards by name or description.
    const search = root.createEl("input", {
      type: "search",
      cls: "bases-toolbox-launcher-search",
      attr: { placeholder: "Search tools…", "aria-label": "Search tools" },
    });
    search.value = this.filterQuery;
    search.addEventListener("input", () => {
      this.filterQuery = search.value;
      this.applyFilter();
    });

    // Favorites — pinned features, in pin order. Drag to re-arrange.
    const favs = this.plugin.settings.favoriteFeatures;
    if (favs.length) {
      root.createDiv({ cls: "bases-toolbox-launcher-section", text: "★ Favorites" });
      root.createDiv({ cls: "bases-toolbox-launcher-hint", text: "Drag to re-arrange." });
      favs.forEach((id, i) => {
        const card = this.renderById(root, id);
        if (card) this.makeFavDraggable(card, i);
      });
    }

    // Grouped by what the tools act on; the many-notes-at-once tools come last.
    // How each one opens is still visible from its buttons (Sidebar/Tab/Window
    // for panels, Open for dialogs).
    for (const section of SECTIONS) {
      root.createDiv({ cls: "bases-toolbox-launcher-section", text: section.title });
      if (section.hint) root.createDiv({ cls: "bases-toolbox-launcher-hint", text: section.hint });
      for (const f of section.items) this.renderFeature(root, f);
    }

    // Settings shortcut at the bottom.
    root.createDiv({ cls: "bases-toolbox-launcher-section", text: "Settings" });
    this.renderSettings(root);

    // Re-apply any active query after a rebuild (e.g. after favoriting).
    this.applyFilter();
  }

  /**
   * Hide cards whose name/description don't match the query, and hide any section
   * header (and its hint) that ends up with no visible cards under it. Empty
   * query shows everything.
   */
  private applyFilter(): void {
    const q = this.filterQuery.trim();
    const root = this.contentEl;
    const nodes = Array.from(root.children) as HTMLElement[];
    let sectionHeader: HTMLElement | null = null;
    let sectionHint: HTMLElement | null = null;
    let sectionHasVisible = false;
    const closeSection = () => {
      if (sectionHeader) sectionHeader.toggle(sectionHasVisible);
      if (sectionHint) sectionHint.toggle(sectionHasVisible);
    };
    for (const node of nodes) {
      if (node.hasClass("bases-toolbox-launcher-section")) {
        closeSection();
        sectionHeader = node;
        sectionHint = null;
        sectionHasVisible = false;
      } else if (node.hasClass("bases-toolbox-launcher-hint")) {
        sectionHint = node;
      } else if (node.hasClass("bases-toolbox-launcher-card")) {
        // Fuzzy match: siftMatch is whitespace-tokenized (every token must hit)
        // and treats -/_/space as equivalent, so "csv imp" or "find-replace"
        // both land — more forgiving than the old plain substring test.
        const hit = !q || siftMatch(q, node.dataset.search ?? "");
        node.toggle(hit);
        if (hit) sectionHasVisible = true;
      }
    }
    closeSection();
  }

  /** Render a feature by its favorite id, wherever it lives. Returns the card. */
  private renderById(parent: HTMLElement, id: string): HTMLElement | null {
    if (id === "settings") return this.renderSettings(parent);
    const f = ALL_FEATURES.find((x) => featureId(x) === id);
    return f ? this.renderFeature(parent, f) : null;
  }

  private renderFeature(parent: HTMLElement, f: Feature): HTMLElement {
    return f.kind === "view" ? this.renderView(parent, f) : this.renderTool(parent, f);
  }

  private renderView(parent: HTMLElement, f: ViewFeature): HTMLElement {
    const card = this.card(parent, f, featureId(f));
    this.launchBtn(card, "panel-right", "Sidebar", `Open ${f.name} in the sidebar`, () =>
      void this.openView(f.type, "sidebar")
    );
    this.launchBtn(card, "picture-in-picture-2", "Tab", `Open ${f.name} in a tab`, () =>
      void this.openView(f.type, "tab")
    );
    this.launchBtn(card, "app-window", "Window", `Open ${f.name} in a new window`, () =>
      void this.openView(f.type, "window")
    );
    return card;
  }

  private renderTool(parent: HTMLElement, f: ToolFeature): HTMLElement {
    const card = this.card(parent, f, featureId(f));
    this.launchBtn(card, "play", "Open", `Open ${f.name}`, () => this.runCommand(f.command));
    return card;
  }

  private renderSettings(parent: HTMLElement): HTMLElement {
    const s = this.card(
      parent,
      { name: "Bases Toolbox settings", desc: "Toggles, forks, formatting rules, reference", icon: "settings" },
      "settings"
    );
    this.launchBtn(s, "settings", "Open", "Open Bases Toolbox settings", () => this.runCommand("open-settings"));
    return s;
  }

  private async toggleFavorite(id: string): Promise<void> {
    const favs = this.plugin.settings.favoriteFeatures;
    const i = favs.indexOf(id);
    if (i >= 0) favs.splice(i, 1);
    else favs.push(id);
    await this.plugin.savePluginData();
    this.render();
  }

  private dragFrom: number | null = null;

  /** Make a favorites card draggable to re-order settings.favoriteFeatures. */
  private makeFavDraggable(card: HTMLElement, index: number): void {
    card.addClass("bases-toolbox-fav-card");
    card.setAttribute("draggable", "true");
    card.addEventListener("dragstart", (e) => {
      this.dragFrom = index;
      card.addClass("is-dragging");
      e.dataTransfer?.setData("text/plain", String(index));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      this.dragFrom = null;
      this.contentEl.findAll(".bases-toolbox-launcher-card").forEach((c) => {
        c.removeClass("is-dragging");
        c.removeClass("is-drop-target");
      });
    });
    card.addEventListener("dragover", (e) => {
      if (this.dragFrom === null || this.dragFrom === index) return;
      e.preventDefault();
      card.addClass("is-drop-target");
    });
    card.addEventListener("dragleave", () => card.removeClass("is-drop-target"));
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.removeClass("is-drop-target");
      const from = this.dragFrom;
      if (from === null || from === index) return;
      void this.moveFavorite(from, index);
    });
  }

  private async moveFavorite(from: number, to: number): Promise<void> {
    const favs = this.plugin.settings.favoriteFeatures;
    if (from < 0 || from >= favs.length) return;
    const [id] = favs.splice(from, 1);
    favs.splice(to, 0, id);
    await this.plugin.savePluginData();
    this.render();
  }

  /** Run one of the plugin's commands by its (un-prefixed) id. `commands` is
   * undocumented on App, so it's accessed through a narrow cast. */
  private runCommand(command: string): void {
    (
      this.plugin.app as unknown as { commands: { executeCommandById: (id: string) => void } }
    ).commands.executeCommandById(`${this.plugin.manifest.id}:${command}`);
  }

  private card(parent: HTMLElement, f: FeatureBase, id: string): HTMLElement {
    const { name, desc, icon, scope } = f;
    const scopeText = scope ? (f.scopeLabel ?? SCOPE_LABEL[scope]) : "";
    const card = parent.createDiv({ cls: "bases-toolbox-launcher-card" });
    // The scope tag is searchable too, so "vault" lists every vault-wide tool.
    card.dataset.search = `${name} ${desc} ${scopeText}`.toLowerCase();
    setIcon(card.createSpan({ cls: "bases-toolbox-launcher-icon" }), icon);
    const text = card.createDiv({ cls: "bases-toolbox-launcher-text" });
    const nameEl = text.createDiv({ cls: "bases-toolbox-launcher-name", text: name });
    if (scope) {
      nameEl.createSpan({
        cls: `bases-toolbox-launcher-scope is-${scope}`,
        text: scopeText,
        attr: { "aria-label": SCOPE_TIP[scope] },
      });
    }
    text.createDiv({ cls: "bases-toolbox-launcher-desc", text: desc });

    const fav = this.plugin.settings.favoriteFeatures.includes(id);
    const star = card.createSpan({
      cls: `bases-toolbox-launcher-star${fav ? " is-fav" : ""}`,
      attr: { "aria-label": fav ? "Unpin from Favorites" : "Pin to Favorites" },
    });
    setIcon(star, "star");
    star.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.toggleFavorite(id);
    });

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
