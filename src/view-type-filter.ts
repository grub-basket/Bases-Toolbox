import { App } from "obsidian";
import type BasesToolboxPlugin from "./main";

/**
 * Hide chosen Bases view types from the view-type picker.
 *
 * Why: some users run a community plugin that predates the native Bases view of
 * the same name (the classic case is the old "Kanban" plugin vs Bases' own
 * Kanban), and want the native type out of the way to avoid confusion. Bases
 * doesn't let you unregister a built-in view type (that would break existing
 * views of that type), so this hides the OPTION from the picker instead — the
 * type still works, it's just not offered when adding / changing a view.
 *
 * Two application points:
 *  - Bases Toolbox's own view manager filters its "Add a view" Type dropdown
 *    (see view-manager.ts — it reads `hiddenViewTypes`). Fully controlled.
 *  - Bases' NATIVE type-picker menu (the "Add view" / change-type submenu) is
 *    filtered by a MutationObserver here. It fires only when a type is actually
 *    hidden (default: none), and it's deliberately conservative: it only trims a
 *    menu that is itself a type picker — every one of its action items maps to a
 *    registered view type — so it can never strip a real view out of the view
 *    switcher (whose items are the user's view names, not types).
 */

interface BasesInternalPlugin {
  registrations?: Record<string, { name?: unknown; icon?: unknown }>;
}

export interface RegisteredType {
  id: string;
  name: string;
  /** The lucide icon class Bases registers for the type, e.g. `lucide-kanban-square`. */
  icon: string;
}

/** The Bases view types registered right now (table/cards/list/kanban + any a
 * plugin added), with their display name + icon. */
export function registeredViewTypes(app: App): RegisteredType[] {
  const internal = (
    app as unknown as { internalPlugins?: { getEnabledPluginById?: (id: string) => unknown } }
  ).internalPlugins;
  const bases = internal?.getEnabledPluginById?.("bases") as BasesInternalPlugin | null | undefined;
  const reg = bases?.registrations;
  if (!reg || typeof reg !== "object") return [];
  return Object.keys(reg).map((id) => ({
    id,
    name: typeof reg[id]?.name === "string" ? (reg[id].name as string) : id,
    icon: typeof reg[id]?.icon === "string" ? (reg[id].icon as string) : "",
  }));
}

/** Whether a menu item corresponds to this registered type (title + icon). */
function itemMatchesType(item: HTMLElement, t: RegisteredType): boolean {
  const title = item.querySelector(".menu-item-title")?.textContent?.trim();
  if (title !== t.name) return false;
  if (!t.icon) return true;
  const svg = item.querySelector<HTMLElement>(".menu-item-icon svg");
  return !!svg && svg.classList.contains(t.icon);
}

/**
 * Install the native-menu filter. Cheap when nothing is hidden — the observer
 * stays, but every callback bails on the first check.
 */
export function installViewTypeFilter(plugin: BasesToolboxPlugin): void {
  const filterMenu = (menu: HTMLElement): void => {
    const hidden = plugin.settings.hiddenViewTypes;
    if (!hidden.length) return;
    const types = registeredViewTypes(plugin.app);
    if (!types.length) return;
    const items = Array.from(menu.querySelectorAll<HTMLElement>(".menu-item"));
    if (items.length < 2) return;

    // Which items map to a registered type? Only proceed if this menu is a
    // TYPE PICKER — i.e. every actionable item is a registered-type entry —
    // so we never trim a real view out of the view switcher.
    const typeOf = new Map<HTMLElement, RegisteredType>();
    for (const item of items) {
      if (item.hasClass("menu-item-section") || !item.querySelector(".menu-item-title")) continue;
      const match = types.find((t) => itemMatchesType(item, t));
      if (match) typeOf.set(item, match);
    }
    const actionItems = items.filter(
      (i) => !i.hasClass("menu-item-section") && i.querySelector(".menu-item-title")
    );
    if (!actionItems.length || actionItems.some((i) => !typeOf.has(i))) return; // not a pure type picker

    for (const [item, t] of typeOf) {
      if (hidden.includes(t.id)) item.remove();
    }
  };

  const obs = new MutationObserver((muts) => {
    if (!plugin.settings.hiddenViewTypes.length) return;
    for (const m of muts) {
      for (const node of Array.from(m.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.hasClass("menu")) filterMenu(node);
        else node.querySelectorAll?.(".menu").forEach((el) => filterMenu(el as HTMLElement));
      }
    }
  });
  // Obsidian mounts menus as direct children of <body>, so childList (no
  // subtree) catches them without firing on every app-wide DOM mutation.
  obs.observe(document.body, { childList: true });
  plugin.register(() => obs.disconnect());
  // Popout windows get their own body — filter menus there too.
  plugin.registerEvent(
    plugin.app.workspace.on("window-open", (win) => {
      const wobs = new MutationObserver((muts) => {
        if (!plugin.settings.hiddenViewTypes.length) return;
        for (const m of muts)
          for (const node of Array.from(m.addedNodes))
            if (node instanceof HTMLElement && node.hasClass("menu")) filterMenu(node);
      });
      wobs.observe(win.doc.body, { childList: true });
      plugin.register(() => wobs.disconnect());
    })
  );
}
