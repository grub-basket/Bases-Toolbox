import { Notice, TFile, parseYaml, setIcon, stringifyYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { activeBaseView } from "./base-detect";

/**
 * A one-click "hide empty columns" toggle in a kanban base's toolbar.
 *
 * Bases already has a `hideEmptyGroups` option for kanban views, but it's
 * buried in the view-options menu (the ⋯ → Edit view flow). This surfaces it as
 * a toolbar button that only appears while a kanban view is on screen, so
 * emptying the board of its dead columns is one click. The button reflects the
 * current state (pressed = columns are hidden). It's a plain view-config
 * toggle — clicking again brings the empty columns back — so it isn't recorded
 * in history (nothing to revert that a second click doesn't).
 */

const BTN_CLASS = "bases-toolbox-kanban-empty-btn";
const CM_BTN_CLASS = "bases-toolbox-cm-toolbar-btn";
const VM_BTN_CLASS = "bases-toolbox-vm-toolbar-btn";

interface BasesLeafView {
  file?: TFile;
  containerEl?: HTMLElement;
  getState?: () => Record<string, unknown>;
  controller?: { view?: { type?: unknown } };
}

type ViewNode = Record<string, unknown> & { type?: unknown; name?: unknown; hideEmptyGroups?: unknown };

function viewsOf(doc: Record<string, unknown>): ViewNode[] {
  return Array.isArray(doc.views) ? (doc.views as ViewNode[]) : [];
}

/** The active view is a kanban? Read the live controller (authoritative for
 * "what's on screen right now", and it updates on a view-type switch). */
function activeViewIsKanban(view: BasesLeafView): boolean {
  return view.controller?.view?.type === "kanban";
}

/** Read the `hideEmptyGroups` of a named view from the .base (default false). */
async function readHideEmpty(
  plugin: BasesToolboxPlugin,
  file: TFile,
  viewName: string
): Promise<boolean> {
  try {
    const doc = (parseYaml(await plugin.app.vault.read(file)) ?? {}) as Record<string, unknown>;
    const v = viewsOf(doc).find((x) => x.name === viewName && x.type === "kanban");
    return v?.hideEmptyGroups === true;
  } catch {
    return false;
  }
}

/** Flip `hideEmptyGroups` on a named kanban view; returns the new value, or
 * null if the view couldn't be found / the file couldn't be parsed. */
async function toggleHideEmpty(
  plugin: BasesToolboxPlugin,
  file: TFile,
  viewName: string
): Promise<boolean | null> {
  const raw = await plugin.app.vault.read(file);
  let doc: Record<string, unknown>;
  try {
    doc = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  } catch {
    new Notice("Could not parse this .base file.");
    return null;
  }
  const v = viewsOf(doc).find((x) => x.name === viewName && x.type === "kanban");
  if (!v) {
    new Notice("This view isn't a kanban, or it's no longer in the base.");
    return null;
  }
  const next = !(v.hideEmptyGroups === true);
  if (next) v.hideEmptyGroups = true;
  else delete v.hideEmptyGroups; // keep the file clean when back to the default
  await plugin.app.vault.modify(file, stringifyYaml(doc));
  return next;
}

/**
 * Containers we've already wired a MutationObserver onto — switching a base's
 * view TYPE (kanban ↔ table) in place fires none of the workspace events
 * (layout/leaf/file), so without this the button would linger on a table view.
 * The observer re-runs the apply pass when Bases swaps the view content.
 */
const observed = new WeakSet<HTMLElement>();

/**
 * Ensure the toggle button is present on every open kanban base (and absent
 * from non-kanban views). Idempotent — safe to call on every layout event.
 * Returns true when a base's toolbar wasn't ready yet (caller retries).
 */
export function applyKanbanButtons(plugin: BasesToolboxPlugin): boolean {
  let pending = false;
  for (const leaf of plugin.app.workspace.getLeavesOfType("bases")) {
    const view = leaf.view as unknown as BasesLeafView;
    const el = view.containerEl;
    const file = view.file;
    if (!el || !(file instanceof TFile)) continue;

    // Wire the view-switch observer once per container. Debounced re-apply.
    if (!observed.has(el)) {
      observed.add(el);
      let deb: number | null = null;
      const isContainerSwap = (nodes: NodeList): boolean => {
        for (const n of Array.from(nodes)) {
          if (
            n instanceof HTMLElement &&
            (n.matches?.("[class*=bases-kanban-container], [class*=bases-table-container], [class*=bases-cards], [class*=bases-list]") ||
              n.querySelector?.("[class*=bases-kanban-container], [class*=bases-table-container]"))
          ) {
            return true;
          }
        }
        return false;
      };
      const obs = new MutationObserver((muts) => {
        // React only to the view CONTAINER being swapped (a view-type switch),
        // not to card churn from virtualization/scroll.
        if (!muts.some((m) => isContainerSwap(m.addedNodes) || isContainerSwap(m.removedNodes))) return;
        if (deb !== null) window.clearTimeout(deb);
        deb = window.setTimeout(() => applyKanbanButtons(plugin), 120);
      });
      obs.observe(el, { childList: true, subtree: true });
      plugin.register(() => obs.disconnect());
    }

    const existing = el.querySelector<HTMLElement>(`.${BTN_CLASS}`);

    // Only on kanban views — remove the button anywhere else.
    if (!activeViewIsKanban(view)) {
      existing?.remove();
      continue;
    }

    const viewsMenu = el.querySelector(".bases-toolbar-views-menu");
    if (!viewsMenu) {
      // Toolbar still rendering — but if the view is kanban and there's no
      // toolbar yet, ask the caller to retry.
      pending = true;
      continue;
    }
    // Sit after the column-manager button (which sits after the view-manager
    // button, after the switcher) so the toolbox buttons form a stable cluster
    // and don't fight each other's re-positioning.
    const anchor =
      el.querySelector(`.${CM_BTN_CLASS}`) ?? el.querySelector(`.${VM_BTN_CLASS}`) ?? viewsMenu;

    const viewName = typeof view.getState?.().viewName === "string" ? (view.getState!().viewName as string) : "";

    // Already in place — just refresh its pressed state.
    if (existing && existing.previousElementSibling === anchor) {
      void refreshState(plugin, file, viewName, existing);
      continue;
    }
    existing?.remove();

    const bar = anchor.parentElement;
    if (!bar) continue;
    const btn = bar.createDiv({ cls: `bases-toolbar-item ${BTN_CLASS}` });
    setIcon(btn, "gallery-vertical-end");
    btn.setAttribute("aria-label", "Hide empty columns");
    plugin.registerDomEvent(btn, "click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const vn = typeof view.getState?.().viewName === "string" ? (view.getState!().viewName as string) : "";
      void toggleHideEmpty(plugin, file, vn).then((next) => {
        if (next === null) return;
        btn.toggleClass("is-active", next);
        btn.setAttribute("aria-label", next ? "Show empty columns" : "Hide empty columns");
      });
    });
    anchor.insertAdjacentElement("afterend", btn);
    void refreshState(plugin, file, viewName, btn);
  }
  return pending;
}

/** Sync a button's pressed state to the .base's current value. */
async function refreshState(
  plugin: BasesToolboxPlugin,
  file: TFile,
  viewName: string,
  btn: HTMLElement
): Promise<void> {
  if (!viewName) return;
  const hidden = await readHideEmpty(plugin, file, viewName);
  btn.toggleClass("is-active", hidden);
  btn.setAttribute("aria-label", hidden ? "Show empty columns" : "Hide empty columns");
}

/** Registers the listeners that keep the button present as kanban bases open
 * and as the user switches view types. */
export function installKanbanButtons(plugin: BasesToolboxPlugin): void {
  let timer: number | null = null;
  const clear = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  const attempt = (left: number) => {
    clear();
    if (applyKanbanButtons(plugin) && left > 0) {
      timer = window.setTimeout(() => attempt(left - 1), 150);
    }
  };
  const reapply = () => attempt(10);
  plugin.registerEvent(plugin.app.workspace.on("layout-change", reapply));
  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", reapply));
  plugin.registerEvent(plugin.app.workspace.on("file-open", reapply));
  plugin.app.workspace.onLayoutReady(reapply);
  plugin.register(clear);
  plugin.register(() => {
    for (const leaf of plugin.app.workspace.getLeavesOfType("bases")) {
      const el = (leaf.view as unknown as BasesLeafView).containerEl;
      el?.querySelectorAll(`.${BTN_CLASS}`).forEach((n) => n.remove());
    }
  });
}

/** Command form (for a hotkey): toggle hide-empty on the active kanban base. */
export function toggleHideEmptyColumns(plugin: BasesToolboxPlugin): void {
  const view = activeBaseView(plugin.app) as unknown as BasesLeafView | null;
  const file = (view as { file?: TFile } | null)?.file;
  if (!view || !(file instanceof TFile) || !activeViewIsKanban(view)) {
    new Notice("Open a base on a kanban view first.");
    return;
  }
  const viewName = typeof view.getState?.().viewName === "string" ? (view.getState!().viewName as string) : "";
  void toggleHideEmpty(plugin, file, viewName).then((next) => {
    if (next !== null) new Notice(next ? "Hiding empty columns." : "Showing empty columns.");
  });
}
