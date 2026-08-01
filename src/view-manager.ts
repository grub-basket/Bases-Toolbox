import {
  App,
  ExtraButtonComponent,
  FuzzySuggestModal,
  Modal,
  Notice,
  Setting,
  TFile,
  parseYaml,
  setIcon,
  stringifyYaml,
} from "obsidian";
import type BasesToolboxPlugin from "./main";
import { activeBaseView } from "./base-detect";
import { ConfirmModal } from "./property-delete";

/**
 * Manage a base's VIEWS from one modal — rename, duplicate, reorder, set the
 * default, delete, add, and switch to one.
 *
 * Obsidian's own flow buries this: open the view menu → the tiny edit arrow →
 * a three-dot menu → "Duplicate view" → name it. Every one of those operations
 * is really just an edit to the `views:` array in the `.base` file, so (as with
 * the filter toggle and formula columns) we treat the file as the API and do
 * the whole thing in one list.
 *
 * Three things this has to get right, none of them obvious:
 *  - **Duplicate deep-clones the whole node.** A view carries view-type-specific
 *    keys (card size, image property, per-column widths…) that we don't know
 *    about; rebuilding one from a known-keys whitelist would silently drop them.
 *  - **Names are identity.** Bases addresses a view by `name` (that's what the
 *    leaf's state stores), so two views sharing a name break switching — every
 *    rename/duplicate/add goes through `uniqueName()`.
 *  - **Open tabs have to be re-pointed.** A leaf showing "Alpha" keeps that name
 *    in its state; renaming or deleting "Alpha" underneath it leaves the tab
 *    pointing at a view that no longer exists, so we update the live state after
 *    the write.
 *
 * Every mutation snapshots the `.base` file into the bulk file change history,
 * so any of it can be reverted like any other Bases Toolbox operation.
 */

type ViewNode = Record<string, unknown> & { name?: unknown; type?: unknown };

/** Fallback when the Bases plugin doesn't expose its registrations. */
const DEFAULT_VIEW_TYPES = ["table", "cards", "list"];

interface BasesInternalPlugin {
  registrations?: Record<string, unknown>;
}

/** View types Bases has registered, read at runtime so new ones (or ones added
 * by other plugins) show up without a Bases Toolbox update. */
function viewTypes(app: App): string[] {
  const internal = (
    app as unknown as {
      internalPlugins?: { getEnabledPluginById?: (id: string) => unknown };
    }
  ).internalPlugins;
  const bases = internal?.getEnabledPluginById?.("bases") as BasesInternalPlugin | null | undefined;
  const reg = bases?.registrations;
  const keys = reg && typeof reg === "object" ? Object.keys(reg) : [];
  return keys.length ? keys : [...DEFAULT_VIEW_TYPES];
}

/** Deep copy of a view node — preserves keys we don't know about. Prefers
 * `structuredClone` so a YAML date stays a Date; the JSON round-trip fallback
 * would flatten it to a string and quietly change how it re-serializes. */
function cloneView(v: ViewNode): ViewNode {
  const win = activeWindow as (Window & { structuredClone?: <T>(x: T) => T }) | undefined;
  if (win && typeof win.structuredClone === "function") return win.structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as ViewNode;
}

/** `base`, or the first free "base copy" / "base copy 2" / … */
function uniqueName(base: string, taken: Set<string>): string {
  const stem = base.trim() || "View";
  if (!taken.has(stem)) return stem;
  let candidate = `${stem} copy`;
  let n = 2;
  while (taken.has(candidate)) candidate = `${stem} copy ${n++}`;
  return candidate;
}

function parseDoc(raw: string): Record<string, unknown> | null {
  try {
    return (parseYaml(raw) ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function viewsOf(doc: Record<string, unknown>): ViewNode[] {
  return Array.isArray(doc.views) ? (doc.views as ViewNode[]) : [];
}

function nameOf(v: ViewNode): string {
  return typeof v.name === "string" ? v.name : "";
}

interface BasesLeafView {
  file?: TFile;
  getState?: () => Record<string, unknown>;
  setState?: (state: Record<string, unknown>, opts: { history: boolean }) => unknown;
}

/** Open base leaves showing this exact file. */
function baseLeaves(app: App, file: TFile): BasesLeafView[] {
  return app.workspace
    .getLeavesOfType("bases")
    .map((l) => l.view as unknown as BasesLeafView)
    .filter((v) => v?.file?.path === file.path);
}

/** The view currently on screen for this base, if it's open at all. */
function onScreenView(app: App, file: TFile): string | null {
  for (const view of baseLeaves(app, file)) {
    const n = view.getState?.().viewName;
    if (typeof n === "string" && n) return n;
  }
  return null;
}

/** Re-point every open leaf that was showing `from` onto `to`. */
async function retargetLeaves(app: App, file: TFile, from: string, to: string): Promise<void> {
  for (const view of baseLeaves(app, file)) {
    const state = view.getState?.();
    if (state && state.viewName === from) {
      await view.setState?.({ ...state, viewName: to }, { history: false });
    }
  }
}

/**
 * read → parse → mutate the `views:` array → write, snapshotting the original
 * into history first. `mutate` returns false to abort without writing.
 */
async function rewriteViews(
  plugin: BasesToolboxPlugin,
  file: TFile,
  label: string,
  mutate: (views: ViewNode[], doc: Record<string, unknown>) => boolean
): Promise<boolean> {
  const before = await plugin.app.vault.read(file);
  const doc = parseDoc(before);
  if (!doc) {
    new Notice("Could not parse this .base file.");
    return false;
  }
  const views = viewsOf(doc);
  if (!mutate(views, doc)) return false;
  doc.views = views;
  await plugin.app.vault.modify(file, stringifyYaml(doc));
  await plugin.addHistoryEntry({
    property: label,
    find: null,
    replace: "",
    timestamp: Date.now(),
    changes: [],
    source: "view manager",
    fileSnapshots: [{ path: file.path, content: before, kind: "modified" }],
  });
  return true;
}

/* ---------- toolbar button (sits right after the view switcher) ---------- */

const TOOLBAR_BTN_CLASS = "bases-toolbox-vm-toolbar-btn";

/**
 * Put a "Manage views" button into every open base's toolbar, immediately after
 * Obsidian's view switcher. Idempotent — re-running repositions or recreates the
 * button only when it's missing or has drifted, so it can safely be called on
 * every layout change. (Verified: Bases keeps the same toolbar element across
 * view switches AND across rewrites of the `.base` file, so this doesn't need a
 * MutationObserver; the layout/leaf events are enough.)
 */
export function applyViewManagerButtons(plugin: BasesToolboxPlugin): boolean {
  let pending = false;
  for (const leaf of plugin.app.workspace.getLeavesOfType("bases")) {
    const view = leaf.view as unknown as BasesLeafView & { containerEl?: HTMLElement };
    const el = view.containerEl;
    const file = view.file;
    if (!el || !(file instanceof TFile)) continue;

    const viewsMenu = el.querySelector(".bases-toolbar-views-menu");
    // Bases builds its toolbar asynchronously, so on a freshly-opened base the
    // switcher often isn't in the DOM yet when the layout event fires. Report
    // it so the caller retries instead of leaving the button permanently absent.
    if (!viewsMenu) {
      pending = true;
      continue;
    }

    const existing = el.querySelector(`.${TOOLBAR_BTN_CLASS}`);
    // Already sitting directly after the switcher — nothing to do.
    if (existing && existing.previousElementSibling === viewsMenu) continue;
    existing?.remove();

    // Create it ON THE TOOLBAR, then slide it into place. Two traps avoided:
    // the global `createDiv()` builds in the main window's document (wrong when
    // the base is in a popout), and `ownerDocument.createDiv()` *appends to the
    // document root* — which throws HierarchyRequestError and would abort this
    // whole pass. Building on the real parent sidesteps both.
    const bar = viewsMenu.parentElement;
    if (!bar) continue;
    const btn = bar.createDiv({ cls: `bases-toolbar-item ${TOOLBAR_BTN_CLASS}` });
    btn.setAttribute("aria-label", "Manage views");
    setIcon(btn, "settings-2");
    plugin.registerDomEvent(btn, "click", (e) => {
      e.preventDefault();
      e.stopPropagation(); // don't let the click fall through to the switcher
      new ViewManagerModal(plugin, file).open();
    });
    viewsMenu.insertAdjacentElement("afterend", btn);
  }
  return pending;
}

/** Registers the listeners that keep the toolbar button present as bases open. */
export function installViewManagerButton(plugin: BasesToolboxPlugin): void {
  let timer: number | null = null;
  const clear = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  // Poll briefly (not forever) while a base's toolbar is still rendering.
  const attempt = (left: number) => {
    clear();
    if (applyViewManagerButtons(plugin) && left > 0) {
      timer = window.setTimeout(() => attempt(left - 1), 150);
    }
  };
  const reapply = () => attempt(10); // ~1.5s of grace, then give up
  plugin.registerEvent(plugin.app.workspace.on("layout-change", reapply));
  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", reapply));
  // `file-open` is the one that fires when an EMPTY leaf becomes a base: at
  // layout/leaf-change time there's no base leaf yet, so those passes see
  // nothing to do and schedule no retry.
  plugin.registerEvent(plugin.app.workspace.on("file-open", reapply));
  plugin.app.workspace.onLayoutReady(reapply);
  plugin.register(clear);
  // Leave no trace when the plugin is disabled.
  plugin.register(() => {
    for (const leaf of plugin.app.workspace.getLeavesOfType("bases")) {
      const el = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl;
      el?.querySelectorAll(`.${TOOLBAR_BTN_CLASS}`).forEach((n) => n.remove());
    }
  });
}

export function openViewManager(plugin: BasesToolboxPlugin): void {
  const active = activeBaseView(plugin.app)?.file ?? plugin.app.workspace.getActiveFile();
  if (active?.extension === "base") new ViewManagerModal(plugin, active).open();
  else new ViewManagerBasePicker(plugin).open();
}

class ViewManagerBasePicker extends FuzzySuggestModal<TFile> {
  constructor(private plugin: BasesToolboxPlugin) {
    super(plugin.app);
    this.setPlaceholder("Pick a base to manage views for…");
  }
  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((f) => f.extension === "base");
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    new ViewManagerModal(this.plugin, f).open();
  }
}

export class ViewManagerModal extends Modal {
  /** Guards against a rename committing while a re-render is tearing the row
   * down (removing a focused input can fire `blur`). */
  private busy = false;
  private newName = "";
  private newType = "table";
  /** Views as of the last render — used only for labels/tooltips. */
  private lastViews: ViewNode[] = [];

  constructor(
    private plugin: BasesToolboxPlugin,
    private file: TFile
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText(`Views: ${this.file.basename}`);
    this.modalEl.addClass("bases-toolbox-vm-modal");
    void this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    const doc = parseDoc(await this.app.vault.read(this.file));
    if (!doc) {
      contentEl.createDiv({
        cls: "bases-toolbox-fr-warning",
        text: "Could not parse this .base file.",
      });
      return;
    }
    const views = viewsOf(doc);
    this.lastViews = views;
    const openName = onScreenView(this.app, this.file);

    contentEl.createDiv({
      cls: "bases-toolbox-fr-info",
      text:
        "Every view of this base, in the order they appear in its switcher. The first one is what the base opens on. " +
        "Rename in place; duplicating copies the whole view (columns, sort, filters and all). Changes are revertible from the bulk file change history.",
    });

    if (!views.length) {
      contentEl.createDiv({
        cls: "bases-toolbox-fr-info",
        text: "This base has no views yet — add one below.",
      });
    }

    const listEl = contentEl.createDiv({ cls: "bases-toolbox-vm-list" });
    views.forEach((v, i) => this.renderRow(listEl, views, v, i, openName));

    // ---- Add a view ----
    new Setting(contentEl).setName("Add a view").setHeading();
    const types = viewTypes(this.app);
    if (!types.includes(this.newType)) this.newType = types[0] ?? "table";

    new Setting(contentEl)
      .setName("Name")
      .setDesc("Shown in the base's view switcher. A duplicate name gets a suffix.")
      .addText((t) =>
        t
          .setPlaceholder("e.g. By status")
          .setValue(this.newName)
          .onChange((v) => (this.newName = v))
      );

    new Setting(contentEl)
      .setName("Type")
      .addDropdown((dd) => {
        for (const t of types) dd.addOption(t, t);
        dd.setValue(this.newType);
        dd.onChange((v) => (this.newType = v));
      });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Add view")
        .setCta()
        .onClick(() => void this.addView())
    );
  }

  private renderRow(
    parent: HTMLElement,
    views: ViewNode[],
    view: ViewNode,
    index: number,
    openName: string | null
  ): void {
    const name = nameOf(view);
    const row = parent.createDiv({ cls: "bases-toolbox-vm-row" });

    const nameInput = row.createEl("input", {
      cls: "bases-toolbox-vm-name",
      type: "text",
      value: name,
    });
    nameInput.setAttribute("aria-label", "View name");

    let committed = false;
    const commit = () => {
      if (committed || this.busy) return;
      const next = nameInput.value.trim();
      if (!next || next === name) {
        nameInput.value = name; // blank or unchanged → snap back
        return;
      }
      committed = true;
      void this.rename(index, name, next);
    };
    nameInput.addEventListener("blur", commit);
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        nameInput.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        nameInput.value = name;
        nameInput.blur();
      }
    });

    const badges: string[] = [];
    if (typeof view.type === "string" && view.type) badges.push(view.type);
    if (index === 0) badges.push("default");
    if (name && name === openName) badges.push("on screen");
    row.createSpan({ cls: "bases-toolbox-vm-badges", text: badges.join(" · ") });

    const actions = row.createDiv({ cls: "bases-toolbox-vm-actions" });

    new ExtraButtonComponent(actions)
      .setIcon("eye")
      .setTooltip("Show this view")
      .onClick(() => void this.showView(name));

    new ExtraButtonComponent(actions)
      .setIcon("copy")
      .setTooltip("Duplicate this view")
      .onClick(() => void this.duplicate(index));

    const up = new ExtraButtonComponent(actions)
      .setIcon("arrow-up")
      .setTooltip(index === 1 ? "Move up (makes it the default)" : "Move up")
      .onClick(() => void this.move(index, -1));
    if (index === 0) up.setDisabled(true);

    const down = new ExtraButtonComponent(actions)
      .setIcon("arrow-down")
      .setTooltip("Move down")
      .onClick(() => void this.move(index, 1));
    if (index === views.length - 1) down.setDisabled(true);

    if (index !== 0) {
      new ExtraButtonComponent(actions)
        .setIcon("chevrons-up")
        .setTooltip("Make this the default view (move to top)")
        .onClick(() => void this.move(index, -index));
    }

    new ExtraButtonComponent(actions)
      .setIcon("trash-2")
      .setTooltip("Delete this view")
      .onClick(() => this.confirmDelete(index, name, views.length));
  }

  /** The view node at `index` as of the last render (labels only — every
   * mutation re-reads the file, so this is never the source of truth). */
  private viewAt(index: number): ViewNode {
    return this.lastViews[index] ?? {};
  }

  /** Switch the open base tab to `name`, opening the base if it isn't open. */
  private async showView(name: string): Promise<void> {
    if (!name) return;
    const leaves = baseLeaves(this.app, this.file);
    if (leaves.length) {
      for (const view of leaves) {
        const state = view.getState?.() ?? {};
        await view.setState?.(
          { ...state, file: this.file.path, viewName: name },
          { history: false }
        );
      }
    } else {
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.openFile(this.file);
      const view = leaf.view as unknown as BasesLeafView;
      const state = view.getState?.() ?? {};
      await view.setState?.({ ...state, file: this.file.path, viewName: name }, { history: false });
    }
    void this.render();
  }

  private async rename(index: number, from: string, to: string): Promise<void> {
    this.busy = true;
    let final = to;
    const ok = await rewriteViews(this.plugin, this.file, `Renamed view “${from}”`, (views) => {
      const target = views[index];
      // Position AND name must still match — the file may have changed under us.
      if (!target || nameOf(target) !== from) return false;
      const taken = new Set(views.filter((_, i) => i !== index).map(nameOf));
      final = uniqueName(to, taken);
      target.name = final;
      return true;
    });
    this.busy = false;
    if (!ok) {
      void this.render();
      return;
    }
    await retargetLeaves(this.app, this.file, from, final);
    if (final !== to) new Notice(`A view named “${to}” already exists — used “${final}”.`);
    void this.render();
  }

  private async duplicate(index: number): Promise<void> {
    let created = "";
    const label = nameOf(this.viewAt(index)) || "view";
    const ok = await rewriteViews(this.plugin, this.file, `Duplicated view “${label}”`, (views) => {
      const src = views[index];
      if (!src) return false;
      const copy = cloneView(src);
      created = uniqueName(nameOf(src) || "View", new Set(views.map(nameOf)));
      copy.name = created;
      views.splice(index + 1, 0, copy); // sits right after the one it came from
      return true;
    });
    if (ok) new Notice(`Created “${created}”.`);
    void this.render();
  }

  private async move(index: number, delta: number): Promise<void> {
    const to = index + delta;
    await rewriteViews(this.plugin, this.file, "Reordered views", (views) => {
      if (index < 0 || index >= views.length || to < 0 || to >= views.length) return false;
      const [moved] = views.splice(index, 1);
      views.splice(to, 0, moved);
      return true;
    });
    void this.render();
  }

  private confirmDelete(index: number, name: string, total: number): void {
    const label = name || "this unnamed view";
    const last = total <= 1;
    new ConfirmModal(this.plugin, {
      title: `Delete ${name ? `view “${name}”` : "this unnamed view"}?`,
      body: last
        ? `This is the base's only view. Deleting it leaves the base with no views — you'd need to add one before it shows anything. Revertible from the bulk file change history.`
        : `Its columns, sort, filters and layout go with it. Revertible from the bulk file change history.`,
      confirmText: "Delete view",
      danger: true,
      onConfirm: () => void this.remove(index, label),
    }).open();
  }

  private async remove(index: number, label: string): Promise<void> {
    let removedName = "";
    let fallback: string | null = null;
    const ok = await rewriteViews(this.plugin, this.file, `Deleted view “${label}”`, (views) => {
      if (index < 0 || index >= views.length) return false;
      removedName = nameOf(views[index]);
      views.splice(index, 1);
      fallback = views.length ? nameOf(views[Math.min(index, views.length - 1)]) : null;
      return true;
    });
    if (ok) {
      // A tab still showing the deleted view has to go somewhere.
      if (removedName && fallback) {
        await retargetLeaves(this.app, this.file, removedName, fallback);
      }
      new Notice(`Deleted “${label}”.${fallback ? "" : " This base now has no views."}`);
    }
    void this.render();
  }

  private async addView(): Promise<void> {
    let created = "";
    const type = this.newType;
    const ok = await rewriteViews(this.plugin, this.file, "Added a view", (views, doc) => {
      created = uniqueName(this.newName.trim() || "New view", new Set(views.map(nameOf)));
      // Only `type` + `name` — deliberately no `order`, so Bases picks the
      // default columns instead of us fabricating a list that hides the rest.
      views.push({ type, name: created });
      if (!Array.isArray(doc.views)) doc.views = views;
      return true;
    });
    if (ok) {
      this.newName = "";
      new Notice(`Added “${created}”.`);
    }
    void this.render();
  }
}
