import { App, Notice, TFile } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { baseFileForCell } from "./base-detect";

/**
 * Open Stashpad notes in Stashpad, from a base.
 *
 * A note that lives in a Stashpad folder is a node in Stashpad's tree, not
 * really a markdown document — but clicking its name in a base gets you the
 * plain editor, losing the parent/children context that's the whole point of
 * it. With this on, such a click routes to the Stashpad view instead.
 *
 * How the pieces fit:
 *  - **Bases links are interceptable.** They're not `<a>` elements — a cell
 *    renders `<span class="internal-link" data-href="…">` inside a
 *    `.bases-td`. One capture-phase listener on the document sees the click
 *    before it can reach Obsidian's own delegated handler, so cancelling it
 *    there is enough (no per-view installation, nothing to re-attach when
 *    bases open and close).
 *  - **Stashpad is asked, not reimplemented.** It already has a deep-link
 *    entry point (`obsidian://stashpad?folder=…&note=…&run=open`). We call the
 *    plugin's `handleDeepLink` in-process when it's there, and fall back to
 *    the registered protocol URL — which is the actually-supported surface —
 *    when it isn't.
 *
 * Identifying a Stashpad note is the part where the obvious answers are wrong:
 *  - **Folder membership alone is not enough.** `<folder>/_authors/*.md` sit
 *    inside a Stashpad folder but aren't notes in its tree (they carry
 *    `authorId`, not `id`), and deep-linking to one would fail.
 *  - **The `.stashpad-order.json` sidecar can't be used as the marker.**
 *    Obsidian's vault index hides dotfiles, so it never appears in
 *    `getFiles()`; testing for it would mean an adapter hit per folder, per
 *    click.
 *
 * So the test is the one the deep link needs anyway: the file is under a known
 * Stashpad folder AND its frontmatter carries a Stashpad `id`. A note without
 * one has nothing to link to, so it falls through to the normal editor.
 */

const STASHPAD_ID = "stashpad";

/** Stashpad's own internals — resolved at runtime, never imported, so Bases
 * Toolbox neither depends on Stashpad nor breaks when it's absent. */
interface StashpadPlugin {
  settings?: {
    /** The primary Stashpad folder. */
    folder?: unknown;
    /** Most-recently-used Stashpad folders. */
    recentFolders?: unknown;
    lastUsedFolder?: unknown;
  };
  handleDeepLink?: (
    params: { folder?: string; note?: string; run?: string },
    opts?: { forceNewTab?: boolean; silent?: boolean }
  ) => Promise<boolean> | boolean;
}

interface AppInternals {
  plugins?: { plugins?: Record<string, unknown> };
}

function stashpad(app: App): StashpadPlugin | null {
  const p = (app as unknown as AppInternals).plugins?.plugins?.[STASHPAD_ID];
  return p ? (p as StashpadPlugin) : null;
}

/** Every folder Stashpad considers one of its own, longest first so that a
 * nested folder wins over its parent. */
function stashpadFolders(sp: StashpadPlugin): string[] {
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === "string" && v.trim()) out.add(v.trim().replace(/\/+$/, ""));
  };
  add(sp.settings?.folder);
  add(sp.settings?.lastUsedFolder);
  const recent = sp.settings?.recentFolders;
  if (Array.isArray(recent)) for (const r of recent) add(r);
  return [...out].sort((a, b) => b.length - a.length);
}

export interface StashpadTarget {
  folder: string;
  /** The note's 6-char frontmatter id — what the deep link addresses. */
  note: string;
}

/**
 * The Stashpad coordinates for a file, or null when it isn't a Stashpad note
 * (wrong folder, no id, or Stashpad isn't running).
 */
export function stashpadTargetFor(app: App, file: TFile): StashpadTarget | null {
  const sp = stashpad(app);
  if (!sp) return null;
  const folder = stashpadFolders(sp).find((f) => file.path.startsWith(`${f}/`));
  if (!folder) return null;
  const raw = app.metadataCache.getFileCache(file)?.frontmatter?.id;
  // Numbers are accepted because YAML happily turns an all-digit id into one
  // (Stashpad's own readId() has the same guard).
  const note = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  return note ? { folder, note } : null;
}

/** Hand off to Stashpad. Returns false when it couldn't be reached at all. */
function openInStashpad(app: App, target: StashpadTarget, newTab: boolean): boolean {
  const sp = stashpad(app);
  if (!sp) return false;
  if (typeof sp.handleDeepLink === "function") {
    // "reveal", NOT "open". Stashpad's deep link reveals the note in its view as
    // step 3, and the `open` macro then ALSO runs leaf.openFile() — i.e. opens
    // the markdown editor, the exact thing this feature exists to avoid. Tested:
    // run:"open" returns true and lands you in the editor.
    void sp.handleDeepLink({ folder: target.folder, note: target.note, run: "reveal" }, {
      forceNewTab: newTab,
    });
    return true;
  }
  // Fallback: the registered obsidian:// handler. Slower (round-trips through
  // the OS) but it's Stashpad's supported, documented surface, so it survives
  // an internal rename that would break the call above.
  const url =
    `obsidian://${STASHPAD_ID}?folder=${encodeURIComponent(target.folder)}` +
    `&note=${encodeURIComponent(target.note)}&run=reveal`;
  window.open(url);
  return true;
}

/**
 * Registers the click interception. Cheap when the setting is off or Stashpad
 * isn't installed — the listener stays, but bails on the first check, so
 * toggling the setting takes effect immediately with no re-install.
 */
export function installStashpadLinks(plugin: BasesToolboxPlugin): void {
  const handle = (evt: MouseEvent): void => {
    if (!plugin.settings.stashpadLinks) return;
    // Middle-click arrives as `auxclick`; ignore right-click entirely so the
    // context menu still works.
    if (evt.type === "auxclick" && evt.button !== 1) return;

    const el = evt.target instanceof HTMLElement ? evt.target : null;
    const link = el?.closest<HTMLElement>(".internal-link[data-href]");
    // Scoped to base cells on purpose: this is a Bases Toolbox feature, and
    // hijacking internal links everywhere in the vault is a different (much
    // more invasive) product.
    if (!link || !link.closest(".bases-td")) return;

    const href = link.getAttribute("data-href");
    if (!href) return;
    // `data-href` can be a full path or a bare link text, so resolve it the
    // way Obsidian would — relative to the .base file the cell belongs to,
    // which is what a relative link in that cell is relative to.
    const source = baseFileForCell(plugin.app, link)?.path ?? "";
    const file = plugin.app.metadataCache.getFirstLinkpathDest(href, source);
    if (!(file instanceof TFile)) return;

    const target = stashpadTargetFor(plugin.app, file);
    if (!target) return; // not a Stashpad note — leave the normal open alone

    // A modifier still means "new tab" — it just lands in Stashpad now.
    const newTab = evt.metaKey || evt.ctrlKey || evt.type === "auxclick";
    if (!openInStashpad(plugin.app, target, newTab)) return;

    // Only now cancel: if anything above bailed, Obsidian's own handling runs
    // untouched. stopPropagation at document-capture keeps the event from ever
    // descending to the workspace's delegated link handler.
    evt.preventDefault();
    evt.stopPropagation();
  };

  plugin.registerDomEvent(document, "click", handle, { capture: true });
  plugin.registerDomEvent(document, "auxclick", handle, { capture: true });
}

/** One-off explanation for the settings toggle when Stashpad isn't around. */
export function stashpadLinksUnavailable(app: App): string | null {
  return stashpad(app) ? null : "Stashpad isn't installed or is turned off — this does nothing until it is.";
}

export function warnIfStashpadMissing(app: App): void {
  const msg = stashpadLinksUnavailable(app);
  if (msg) new Notice(`Open in Stashpad: ${msg}`, 8000);
}
