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
import { visibleColumnOrder } from "./conditional-format";
import { siftMatch } from "./sift";
import type { ViewOpUndo } from "./types";

/**
 * Manage a base view's COLUMNS from one list — hide, reveal, reorder, and jump
 * to one that's scrolled off-screen.
 *
 * Everything here rests on one fact: a view's visible columns ARE its `order:`
 * array in the `.base` YAML, rendered left-to-right in sequence. Hiding a column
 * is removing it from `order`; revealing one is putting it back. So (as with the
 * view manager and formula columns) we treat the file as the API.
 *
 * The three things that make this less trivial than it sounds:
 *
 *  - **Where the "available" columns come from.** Obsidian's own column menu
 *    only lists what the view already knows about. The interesting list is
 *    `view.controller.relevantProperties` — a Set scoped to THIS base, which
 *    includes properties present in the base's notes that aren't currently
 *    shown. That's the "toggle one on when I need it" list, and it's only
 *    readable while the base is actually open.
 *  - **Two naming forms for the same column.** That Set uses dashed file props
 *    (`file-name`, `file-ext`), while YAML `order` uses dotted (`file.name`),
 *    and the live controller order uses `note.` prefixes on note properties.
 *    Everything is normalised to one canonical id (`canonicalId`) before it is
 *    compared or written, or toggles silently no-op.
 *  - **Views with no explicit `order`.** Those show Bases' default columns, and
 *    there is nothing to remove an entry from. The first mutation therefore
 *    MATERIALISES the current effective column list into the file (read from the
 *    live view) and says so once — from then on the view is on an explicit list.
 *    That's a real behaviour change (newly added note properties stop appearing
 *    on their own), which this manager is the replacement for.
 *
 * Every mutation records a surgical `order` undo (see `ViewOpUndo`) so a revert
 * puts the previous column list back without touching anything else in the base
 * — including deleting the `order` key again if we were the ones who created it.
 */

type ViewNode = Record<string, unknown> & { name?: unknown; order?: unknown };

type ColumnKind = "file" | "formula" | "note";

interface ColumnInfo {
  /** Canonical, YAML-shaped id — `file.name`, `status`, `formula.total`. */
  id: string;
  kind: ColumnKind;
}

const KIND_LABEL: Record<ColumnKind, string> = {
  file: "file",
  formula: "formula",
  note: "property",
};

/**
 * One canonical spelling per column, so the live controller's ids, the Set's
 * ids and the YAML's ids all compare equal:
 *   `file-name` / `file.name`      → `file.name`
 *   `formula-total` / `formula.x`  → `formula.total`
 *   `note.status` / `status`       → `status`
 * Only the two known prefixes are dash-converted — a note property really
 * called `my-thing` must survive untouched.
 */
export function canonicalId(raw: string): string {
  const s = raw.trim();
  if (s.startsWith("file-")) return `file.${s.slice(5)}`;
  if (s.startsWith("formula-")) return `formula.${s.slice(8)}`;
  if (s.startsWith("note.")) return s.slice(5);
  if (s.startsWith("note-")) return s.slice(5);
  return s;
}

function kindOf(id: string): ColumnKind {
  if (id.startsWith("file.")) return "file";
  if (id.startsWith("formula.")) return "formula";
  return "note";
}

const infoFor = (id: string): ColumnInfo => ({ id, kind: kindOf(id) });

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

const nameOf = (v: ViewNode): string => (typeof v.name === "string" ? v.name : "");

/** The view's explicit column list, or null when it has none (Bases defaults). */
function explicitOrder(v: ViewNode | undefined): string[] | null {
  if (!v || !Array.isArray(v.order)) return null;
  return (v.order as unknown[]).filter((x) => typeof x === "string").map((x) => canonicalId(x as string));
}

/* ---------- the live base view (for available props + jump-to) ---------- */

/** One column of the live table view: its property id and its (possibly
 * detached) cell element, whose inline styles carry the column's x-offset. */
interface TableHeaderCell {
  prop?: unknown;
  el?: HTMLElement;
}

interface BasesLeafView {
  file?: TFile;
  containerEl?: HTMLElement;
  getState?: () => Record<string, unknown>;
  controller?: {
    relevantProperties?: unknown;
    /** The type-specific view (table/cards/…) — only the table has columns. */
    view?: {
      header?: { cells?: TableHeaderCell[] };
      scrollEl?: HTMLElement;
    };
  };
}

function baseLeaves(app: App, file: TFile) {
  return app.workspace
    .getLeavesOfType("bases")
    .filter((l) => (l.view as unknown as BasesLeafView)?.file?.path === file.path);
}

/** The open leaf showing this base on `viewName`, if there is one. */
function leafShowing(app: App, file: TFile, viewName: string) {
  const leaves = baseLeaves(app, file);
  return (
    leaves.find((l) => (l.view as unknown as BasesLeafView).getState?.().viewName === viewName) ??
    null
  );
}

/**
 * Properties this base's notes actually use, from the live controller. Scoped to
 * the base (not the vault), and includes ones that aren't currently columns —
 * which is the whole point. Null when the base isn't open, since there's no
 * controller to ask.
 */
function relevantProperties(app: App, file: TFile): string[] | null {
  for (const leaf of baseLeaves(app, file)) {
    const rel = (leaf.view as unknown as BasesLeafView).controller?.relevantProperties;
    if (rel instanceof Set) {
      return Array.from(rel).filter((x): x is string => typeof x === "string").map(canonicalId);
    }
    if (Array.isArray(rel)) {
      return rel.filter((x): x is string => typeof x === "string").map(canonicalId);
    }
  }
  return null;
}

/**
 * The columns the view renders right now, canonicalised. Null if not on screen.
 *
 * Two sources, in order: the view config's `order` (what the file says), then
 * the table's own header cells. The second one is what makes a view with NO
 * explicit order manageable — `viewConfig.order` is null for those, so the
 * config alone would report "no columns" for a table that's plainly showing
 * some, and materialising from that would wipe them.
 */
function liveOrder(app: App, file: TFile, viewName: string): string[] | null {
  const leaf = leafShowing(app, file, viewName);
  if (!leaf) return null;
  const order = visibleColumnOrder(leaf.view);
  if (order?.length) return order.map(canonicalId);
  const cells = (leaf.view as unknown as BasesLeafView).controller?.view?.header?.cells;
  if (Array.isArray(cells) && cells.length) {
    return cells.map((c) => canonicalId(String(c?.prop ?? ""))).filter((id) => id.length > 0);
  }
  return null;
}

/* ---------- writing ---------- */

/**
 * read → parse → replace ONE view's `order:` → write, recording a surgical undo.
 * `mutate` gets the effective order (materialised from the live view when the
 * file has none) and returns the new one, or null to abort without writing.
 */
async function rewriteOrder(
  plugin: BasesToolboxPlugin,
  file: TFile,
  viewName: string,
  label: string,
  effectiveFallback: string[],
  mutate: (order: string[]) => string[] | null
): Promise<{ ok: boolean; materialised: boolean }> {
  const before = await plugin.app.vault.read(file);
  const doc = parseDoc(before);
  if (!doc) {
    new Notice("Could not parse this .base file.");
    return { ok: false, materialised: false };
  }
  const views = viewsOf(doc);
  const idx = views.findIndex((v) => nameOf(v) === viewName);
  if (idx < 0) {
    new Notice(`The view “${viewName}” is no longer in this base.`);
    return { ok: false, materialised: false };
  }
  const previousOrder = explicitOrder(views[idx]);
  // Refuse to materialise from nothing. With no explicit `order` AND no live
  // view to read the rendered columns from, the effective list is empty — and
  // writing that out would replace the view's whole (default) column set with
  // just the one column being touched.
  if (previousOrder === null && effectiveFallback.length === 0) {
    new Notice(
      "This view has no explicit column list yet. Open the base on this view first so its current columns can be read."
    );
    return { ok: false, materialised: false };
  }
  const effective = previousOrder ?? effectiveFallback;
  const next = mutate([...effective]);
  if (!next) return { ok: false, materialised: false };

  views[idx].order = next;
  doc.views = views;
  await plugin.app.vault.modify(file, stringifyYaml(doc));
  await plugin.addHistoryEntry({
    property: label,
    find: null,
    replace: "",
    timestamp: Date.now(),
    changes: [],
    source: "column manager",
    // Surgical: puts THIS view's previous order back (and removes the `order`
    // key entirely when we were the ones who created it), leaving every other
    // later change to the base alone. The snapshot stays as a safety net.
    viewUndo: {
      path: file.path,
      op: "order",
      viewName,
      previousOrder,
      expectedOrder: next,
    } satisfies ViewOpUndo,
    fileSnapshots: [{ path: file.path, content: before, kind: "modified" }],
  });
  return { ok: true, materialised: previousOrder === null };
}

/* ---------- toolbar button ---------- */

const TOOLBAR_BTN_CLASS = "bases-toolbox-cm-toolbar-btn";
const VM_BTN_CLASS = "bases-toolbox-vm-toolbar-btn";

/**
 * Put a "Manage columns" button in every open base's toolbar, right after the
 * view manager's button (or the view switcher when that one isn't there yet).
 * Anchoring AFTER the view-manager button matters: the view manager re-creates
 * its own button whenever it isn't directly after the switcher, so inserting
 * ourselves between the two would make the pair fight on every layout event.
 *
 * Same two DOM traps as the view manager: the global `createDiv()` builds in the
 * main window's document (wrong in a popout) and `ownerDocument.createDiv()`
 * appends to the document root and throws — so build on the toolbar itself.
 */
export function applyColumnManagerButtons(plugin: BasesToolboxPlugin): boolean {
  let pending = false;
  for (const leaf of plugin.app.workspace.getLeavesOfType("bases")) {
    const view = leaf.view as unknown as BasesLeafView;
    const el = view.containerEl;
    const file = view.file;
    if (!el || !(file instanceof TFile)) continue;

    const viewsMenu = el.querySelector(".bases-toolbar-views-menu");
    // Bases builds its toolbar asynchronously — report so the caller retries.
    if (!viewsMenu) {
      pending = true;
      continue;
    }
    const anchor = el.querySelector(`.${VM_BTN_CLASS}`) ?? viewsMenu;

    const existing = el.querySelector(`.${TOOLBAR_BTN_CLASS}`);
    if (existing && existing.previousElementSibling === anchor) continue;
    existing?.remove();

    const bar = anchor.parentElement;
    if (!bar) continue;
    const btn = bar.createDiv({ cls: `bases-toolbar-item ${TOOLBAR_BTN_CLASS}` });
    btn.setAttribute("aria-label", "Manage columns");
    setIcon(btn, "columns-3");
    plugin.registerDomEvent(btn, "click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const viewName = (leaf.view as unknown as BasesLeafView).getState?.().viewName;
      new ColumnManagerModal(plugin, file, typeof viewName === "string" ? viewName : null).open();
    });
    anchor.insertAdjacentElement("afterend", btn);
  }
  return pending;
}

/** Registers the listeners that keep the toolbar button present as bases open. */
export function installColumnManagerButton(plugin: BasesToolboxPlugin): void {
  let timer: number | null = null;
  const clear = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  const attempt = (left: number) => {
    clear();
    if (applyColumnManagerButtons(plugin) && left > 0) {
      timer = window.setTimeout(() => attempt(left - 1), 150);
    }
  };
  const reapply = () => attempt(10); // ~1.5s of grace, then give up
  plugin.registerEvent(plugin.app.workspace.on("layout-change", reapply));
  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", reapply));
  // `file-open` is the one that fires when an EMPTY leaf becomes a base.
  plugin.registerEvent(plugin.app.workspace.on("file-open", reapply));
  plugin.app.workspace.onLayoutReady(reapply);
  plugin.register(clear);
  plugin.register(() => {
    for (const leaf of plugin.app.workspace.getLeavesOfType("bases")) {
      const el = (leaf.view as unknown as BasesLeafView).containerEl;
      el?.querySelectorAll(`.${TOOLBAR_BTN_CLASS}`).forEach((n) => n.remove());
    }
  });
}

export function openColumnManager(plugin: BasesToolboxPlugin): void {
  const active = activeBaseView(plugin.app);
  const file = active?.file ?? plugin.app.workspace.getActiveFile();
  if (file?.extension === "base") {
    const state = (active as unknown as BasesLeafView | null)?.getState?.();
    const viewName = typeof state?.viewName === "string" ? state.viewName : null;
    new ColumnManagerModal(plugin, file, viewName).open();
  } else new ColumnManagerBasePicker(plugin).open();
}

class ColumnManagerBasePicker extends FuzzySuggestModal<TFile> {
  constructor(private plugin: BasesToolboxPlugin) {
    super(plugin.app);
    this.setPlaceholder("Pick a base to manage columns for…");
  }
  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((f) => f.extension === "base");
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    new ColumnManagerModal(this.plugin, f, null).open();
  }
}

export class ColumnManagerModal extends Modal {
  /** Which view's columns we're editing. Null until the first render resolves it. */
  private viewName: string | null;
  /** Live filter over both lists. */
  private query = "";
  /** Warn about materialising an implicit order once per modal, not per click. */
  private materialisedNoticeShown = false;

  constructor(
    private plugin: BasesToolboxPlugin,
    private file: TFile,
    viewName: string | null
  ) {
    super(plugin.app);
    this.viewName = viewName;
  }

  onOpen(): void {
    this.titleEl.setText(`Columns: ${this.file.basename}`);
    this.modalEl.addClass("bases-toolbox-cm-modal");
    void this.render();
  }

  /* ---------- state resolution ---------- */

  /** The effective column list for the current view: explicit `order` if it has
   * one, otherwise what the live view is actually rendering. */
  private effectiveOrder(view: ViewNode | undefined): { order: string[]; explicit: boolean } {
    const explicit = explicitOrder(view);
    if (explicit) return { order: explicit, explicit: true };
    const live = this.viewName ? liveOrder(this.app, this.file, this.viewName) : null;
    return { order: live ?? [], explicit: false };
  }

  /**
   * Everything that could be a column of this view: what's shown, every property
   * the base's notes actually use, this base's formulas, and any column another
   * view of the same base uses (so a column you hid somewhere else is still
   * reachable here).
   */
  private allColumns(doc: Record<string, unknown>, shown: string[]): ColumnInfo[] {
    const ids = new Set<string>(shown);
    for (const p of relevantProperties(this.app, this.file) ?? []) ids.add(p);
    const formulas = doc.formulas;
    if (formulas && typeof formulas === "object") {
      for (const name of Object.keys(formulas as Record<string, unknown>)) {
        ids.add(`formula.${name}`);
      }
    }
    for (const v of viewsOf(doc)) for (const id of explicitOrder(v) ?? []) ids.add(id);
    return Array.from(ids).map(infoFor);
  }

  /* ---------- render ---------- */

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
    if (!views.length) {
      contentEl.createDiv({
        cls: "bases-toolbox-fr-info",
        text: "This base has no views yet — add one from the view manager first.",
      });
      return;
    }
    // Resolve which view we're on: the one passed in, else the one on screen,
    // else the base's default (first) view.
    if (!this.viewName || !views.some((v) => nameOf(v) === this.viewName)) {
      this.viewName = nameOf(views[0]);
    }
    const view = views.find((v) => nameOf(v) === this.viewName);
    const { order: shown, explicit } = this.effectiveOrder(view);
    const all = this.allColumns(doc, shown);
    const shownSet = new Set(shown);
    const hidden = all.filter((c) => !shownSet.has(c.id));

    contentEl.createDiv({
      cls: "bases-toolbox-fr-info",
      text:
        "The columns this view shows, left to right. Hide one, reveal one the notes already use, drag the order around, " +
        "or jump to a column that's scrolled off-screen. Every change is revertible from the bulk file change history.",
    });

    // ---- which view ----
    if (views.length > 1) {
      new Setting(contentEl)
        .setName("View")
        .setDesc("Columns are per-view — each view of a base has its own list.")
        .addDropdown((dd) => {
          for (const v of views) {
            const n = nameOf(v);
            if (n) dd.addOption(n, n);
          }
          dd.setValue(this.viewName ?? "");
          dd.onChange((v) => {
            this.viewName = v;
            void this.render();
          });
        });
    }

    if (!explicit) {
      contentEl.createDiv({
        cls: "bases-toolbox-fr-info bases-toolbox-cm-implicit",
        text: shown.length
          ? "This view has no explicit column list — it's showing Bases' defaults. The first change here writes the list below into the base, " +
            "after which newly added note properties stop appearing on their own (reveal them here instead)."
          : "This view has no explicit column list and isn't currently on screen, so there's nothing to read the current columns from. " +
            "Open the base on this view, then reopen this dialog.",
      });
    }
    if (!relevantProperties(this.app, this.file)) {
      contentEl.createDiv({
        cls: "bases-toolbox-fr-info",
        text: "The base isn't open, so the list below can only show columns already referenced in the file. Open the base to also see properties its notes use but don't show.",
      });
    }

    // ---- filter ----
    const search = contentEl.createEl("input", {
      type: "search",
      cls: "bases-toolbox-cm-search",
      attr: { placeholder: "Filter columns…", "aria-label": "Filter columns" },
    });
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      this.applyFilter();
    });

    // ---- shown ----
    new Setting(contentEl).setName(`Shown (${shown.length})`).setHeading();
    if (!shown.length) {
      contentEl.createDiv({ cls: "bases-toolbox-fr-info", text: "No columns to show yet." });
    }
    const shownList = contentEl.createDiv({ cls: "bases-toolbox-cm-list" });
    shown.forEach((id, i) => this.renderShownRow(shownList, shown, id, i));

    // ---- grouping ----
    if (shown.length > 1) {
      new Setting(contentEl)
        .setName("Group")
        .setDesc(
          "Obsidian always puts the file columns first. These re-sort the list while keeping each group's own order (and leave file.name leading, since that's the row's name)."
        )
        .addButton((b) =>
          b.setButtonText("Properties first").onClick(() => void this.group("note"))
        )
        .addButton((b) => b.setButtonText("File first").onClick(() => void this.group("file")));
    }

    // ---- hidden ----
    new Setting(contentEl).setName(`Hidden (${hidden.length})`).setHeading();
    if (!hidden.length) {
      contentEl.createDiv({
        cls: "bases-toolbox-fr-info",
        text: "Nothing hidden — every property this base knows about is a column.",
      });
    } else {
      contentEl.createDiv({
        cls: "bases-toolbox-fr-info",
        text: "Properties the base's notes use (plus its formulas) that this view doesn't show. Revealing one adds it as the last column.",
      });
    }
    const hiddenList = contentEl.createDiv({ cls: "bases-toolbox-cm-list" });
    // Group order in the hidden list: properties, then formulas, then file —
    // the reverse of Obsidian's own bias, since note properties are what you
    // come here looking for.
    const rank: Record<ColumnKind, number> = { note: 0, formula: 1, file: 2 };
    [...hidden]
      .sort((a, b) => rank[a.kind] - rank[b.kind] || a.id.localeCompare(b.id))
      .forEach((c) => this.renderHiddenRow(hiddenList, c));

    if (hidden.length > 1) {
      new Setting(contentEl).addButton((b) =>
        b.setButtonText("Reveal all").onClick(() => void this.revealAll(hidden.map((c) => c.id)))
      );
    }

    this.applyFilter();
  }

  private renderShownRow(parent: HTMLElement, shown: string[], id: string, index: number): void {
    const row = parent.createDiv({ cls: "bases-toolbox-cm-row" });
    row.dataset.search = id;
    row.createSpan({ cls: "bases-toolbox-cm-name", text: id });
    row.createSpan({ cls: "bases-toolbox-cm-badges", text: KIND_LABEL[kindOf(id)] });

    const actions = row.createDiv({ cls: "bases-toolbox-cm-actions" });

    new ExtraButtonComponent(actions)
      .setIcon("crosshair")
      .setTooltip("Scroll this column into view")
      .onClick(() => this.jumpTo(index, id));

    const up = new ExtraButtonComponent(actions)
      .setIcon("arrow-up")
      .setTooltip("Move left")
      .onClick(() => void this.move(index, -1, id));
    if (index === 0) up.setDisabled(true);

    const down = new ExtraButtonComponent(actions)
      .setIcon("arrow-down")
      .setTooltip("Move right")
      .onClick(() => void this.move(index, 1, id));
    if (index === shown.length - 1) down.setDisabled(true);

    if (index !== 0) {
      new ExtraButtonComponent(actions)
        .setIcon("chevrons-up")
        .setTooltip("Move to the front")
        .onClick(() => void this.move(index, -index, id));
    }

    new ExtraButtonComponent(actions)
      .setIcon("eye-off")
      .setTooltip("Hide this column")
      .onClick(() => void this.hide(index, id));
  }

  private renderHiddenRow(parent: HTMLElement, col: ColumnInfo): void {
    const row = parent.createDiv({ cls: "bases-toolbox-cm-row" });
    row.dataset.search = col.id;
    row.createSpan({ cls: "bases-toolbox-cm-name", text: col.id });
    row.createSpan({ cls: "bases-toolbox-cm-badges", text: KIND_LABEL[col.kind] });
    const actions = row.createDiv({ cls: "bases-toolbox-cm-actions" });
    new ExtraButtonComponent(actions)
      .setIcon("eye")
      .setTooltip("Show this column")
      .onClick(() => void this.reveal(col.id));
  }

  /** Hide rows that don't match the query; hide a list that empties out. */
  private applyFilter(): void {
    const q = this.query.trim();
    for (const list of Array.from(
      this.contentEl.querySelectorAll<HTMLElement>(".bases-toolbox-cm-list")
    )) {
      let any = false;
      for (const row of Array.from(list.children) as HTMLElement[]) {
        const hit = !q || siftMatch(q, row.dataset.search ?? "");
        row.toggle(hit);
        if (hit) any = true;
      }
      list.toggle(any || !q);
    }
  }

  /* ---------- mutations ---------- */

  /** The order to fall back on when the file has no explicit one. */
  private fallbackOrder(): string[] {
    return (this.viewName ? liveOrder(this.app, this.file, this.viewName) : null) ?? [];
  }

  private async apply(
    label: string,
    mutate: (order: string[]) => string[] | null
  ): Promise<boolean> {
    if (!this.viewName) return false;
    const fallback = this.fallbackOrder();
    const res = await rewriteOrder(
      this.plugin,
      this.file,
      this.viewName,
      label,
      fallback,
      mutate
    );
    if (res.ok && res.materialised && !this.materialisedNoticeShown) {
      this.materialisedNoticeShown = true;
      new Notice(
        "This view now has an explicit column list — new note properties won't appear on their own; reveal them here.",
        8000
      );
    }
    if (res.ok) void this.render();
    return res.ok;
  }

  private async hide(index: number, id: string): Promise<void> {
    await this.apply(`Hid column “${id}”`, (order) => {
      // Re-find by id: the file may have changed since the render.
      const at = order[index] === id ? index : order.indexOf(id);
      if (at < 0) return null;
      if (order.length <= 1) {
        new Notice("A view needs at least one column — reveal another before hiding this one.");
        return null;
      }
      order.splice(at, 1);
      return order;
    });
  }

  private async reveal(id: string): Promise<void> {
    await this.apply(`Showed column “${id}”`, (order) => {
      if (order.includes(id)) return null; // already shown (stale render)
      order.push(id);
      return order;
    });
  }

  private async revealAll(ids: string[]): Promise<void> {
    await this.apply("Showed all hidden columns", (order) => {
      const added = ids.filter((id) => !order.includes(id));
      if (!added.length) return null;
      return [...order, ...added];
    });
  }

  private async move(index: number, delta: number, id: string): Promise<void> {
    await this.apply(`Moved column “${id}”`, (order) => {
      const at = order[index] === id ? index : order.indexOf(id);
      if (at < 0) return null;
      const to = at + delta;
      if (to < 0 || to >= order.length) return null;
      const [moved] = order.splice(at, 1);
      order.splice(to, 0, moved);
      return order;
    });
  }

  /**
   * Re-sort so one group leads, each group keeping its existing relative order.
   * `file.name` stays first regardless — it's the row's name column, and pushing
   * it into the middle of the table reads as a bug, not a preference.
   */
  private async group(first: ColumnKind): Promise<void> {
    const label = first === "note" ? "Grouped columns: properties first" : "Grouped columns: file first";
    await this.apply(label, (order) => {
      const lead = order[0] === "file.name" ? ["file.name"] : [];
      const rest = order.slice(lead.length);
      const head = rest.filter((c) => kindOf(c) === first);
      const tail = rest.filter((c) => kindOf(c) !== first);
      const next = [...lead, ...head, ...tail];
      if (next.every((c, i) => c === order[i])) {
        // Say so rather than doing nothing visible — with file.name pinned in
        // front, "properties first" is often already true.
        new Notice("The columns are already grouped that way.");
        return null;
      }
      return next;
    });
  }

  /* ---------- jump to column ---------- */

  /**
   * Scroll a column into view in the live table.
   *
   * The naive approach — index the rendered `.bases-table-header` elements —
   * is WRONG, and quietly so: Bases virtualises columns horizontally, so the
   * rendered headers are a sliding window over the order that doesn't even
   * start at column 0 once the table is scrolled. Indexing it lands on the
   * wrong column exactly when the table is wide enough for this feature to
   * matter. (Header labels are no good either: they're humanised, and a column
   * can carry a display name.)
   *
   * The table view keeps a COMPLETE ordered list of its columns at
   * `controller.view.header.cells`, each carrying its property id and an
   * element whose `inset-inline-start` / `width` are kept up to date even while
   * the column is detached. That's an exact x-offset for any column, on- or
   * off-screen, so we scroll the container there directly. Builds that don't
   * expose it fall back to the rendered-header index, which is right whenever
   * nothing is virtualised away (i.e. no overflow — when jumping is a no-op
   * anyway).
   */
  private jumpTo(index: number, id: string): void {
    if (!this.viewName) return;
    const leaf = leafShowing(this.app, this.file, this.viewName);
    if (!leaf) {
      new Notice("Open this base on this view first — there's nothing on screen to scroll.");
      return;
    }
    void this.app.workspace.revealLeaf(leaf);

    const table = (leaf.view as unknown as BasesLeafView).controller?.view;
    const cells = Array.isArray(table?.header?.cells) ? table.header.cells : null;
    const scrollEl = table?.scrollEl;
    if (cells && scrollEl && typeof scrollEl.scrollTo === "function") {
      const cell = cells.find((c) => canonicalId(String(c?.prop ?? "")) === id);
      const el = cell?.el;
      if (el) {
        const start = Number.parseFloat(el.style.insetInlineStart) || 0;
        const width = Number.parseFloat(el.style.width) || 0;
        // Centre it when there's room, otherwise just bring its left edge in.
        // (Overshooting the end is fine — the browser clamps to max scroll,
        // which still leaves the last column on screen.)
        const left = Math.max(0, start - Math.max(0, (scrollEl.clientWidth - width) / 2));
        // Deliberately INSTANT, not smooth: as the scroll animates, Bases
        // virtualises columns in and out and re-renders, which cancels the
        // animation part-way — measured landing 156px short, and a second jump
        // not moving at all. A one-shot scroll can't be interrupted.
        scrollEl.scrollTo({ left, behavior: "auto" });
        this.flash(el);
        return;
      }
    }

    // Fallback: index against the rendered headers.
    const containerEl = (leaf.view as unknown as BasesLeafView).containerEl;
    const live = liveOrder(this.app, this.file, this.viewName);
    const at = live ? (live[index] === id ? index : live.indexOf(id)) : index;
    const headers = containerEl
      ? Array.from(containerEl.querySelectorAll<HTMLElement>(".bases-table-header"))
      : [];
    const header = at >= 0 ? headers[at] : undefined;
    if (!header) {
      new Notice(`Couldn't find the “${id}” column on screen.`);
      return;
    }
    header.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    this.flash(header);
  }

  /** Brief highlight so the eye lands on the column after the scroll. The class
   * sticks to the element even if it's currently detached, so a column that
   * only renders once the scroll arrives still flashes. */
  private flash(el: HTMLElement): void {
    el.addClass("bases-toolbox-cm-flash");
    const win = el.ownerDocument.defaultView ?? window;
    win.setTimeout(() => el.removeClass("bases-toolbox-cm-flash"), 1400);
  }
}
