import { AbstractInputSuggest, App, TFile, getAllTags } from "obsidian";
import type BasesToolboxPlugin from "./main";

/*
 * Shared autocomplete for every text box that names something in the vault —
 * folders, notes, .base files, tags, property keys and values, file extensions,
 * template variables. ONE generic suggester (VaultInputSuggest) plus small
 * source functions; each field just picks a source and (for list fields) the
 * separator characters.
 *
 * House rules baked in here so every call site gets them for free:
 *  - Matching is multi-token, order-independent and case-insensitive; exact and
 *    prefix matches rank first (see rankMatches).
 *  - Sources are LAZY: nothing is scanned until the popup is about to show, and
 *    the scan is cached until the popup closes (so typing doesn't rescan the
 *    vault on every keystroke, and a reopen sees fresh data). Property keys/
 *    values come from the plugin's shared PropertyCache, which is itself
 *    invalidated on metadata changes.
 *  - Free text always stays allowed — a suggestion is an offer, never a gate.
 *  - Picking a suggestion commits exactly like typing: the value is written,
 *    then bubbling `input` + `change` events fire, so Setting.onChange handlers,
 *    container-level autosave and blur/change commit logic all persist it.
 *  - List fields ("a, b, c", one path per line) complete only the token at the
 *    caret and replace just that token; items already in the list are hidden.
 */

/** One suggestion: the text to insert, plus an optional faint second line. */
export interface SuggestItem {
  value: string;
  /** Secondary line (a usage count, or what picking it means). */
  note?: string;
}

type Source = () => (string | SuggestItem)[];

export interface SuggestOptions {
  /** Max rows rendered. 0 = never truncate (the CF property/value decision). Default 100. */
  limit?: number;
  /**
   * Treat the field as a list separated by any of these characters (e.g. ","
   * or "\n,;"). Only the token under the caret is completed and replaced.
   */
  list?: string;
  /**
   * What the source depends on (e.g. the property a value box is for). When
   * it changes the cached list is rebuilt even if the popup never closed.
   */
  key?: () => string;
}

/** A text field AbstractInputSuggest can drive. Textareas work (the popup reads
 * `.value` for anything that isn't a contenteditable div) and are used for the
 * one-item-per-line list fields. */
export type TextField = HTMLInputElement | HTMLTextAreaElement;

const DEFAULT_LIMIT = 100;

/**
 * Filters + ranks `items` against `query`. Every whitespace-separated query
 * token must appear somewhere (any order, case-insensitive). Ranking: exact →
 * whole-string prefix → a path segment / word starts with the query → any
 * other match; ties keep the caller's order (callers pre-sort by frequency or
 * alphabetically). Empty query → everything, in the caller's order.
 */
export function rankMatches<T>(items: T[], query: string, text: (t: T) => string, limit = 0): T[] {
  const q = query.trim().toLowerCase();
  let out: T[];
  if (!q) {
    out = items;
  } else {
    const tokens = q.split(/\s+/).filter(Boolean);
    const wordStart = new RegExp(`(^|[/\\s._#-])${escapeRegExp(tokens[0])}`);
    const scored: { item: T; score: number; i: number }[] = [];
    items.forEach((item, i) => {
      const hay = text(item).toLowerCase();
      if (!tokens.every((t) => hay.includes(t))) return;
      let score = 3;
      if (hay === q) score = 0;
      else if (hay.startsWith(q)) score = 1;
      else if (wordStart.test(hay)) score = 2;
      scored.push({ item, score, i });
    });
    scored.sort((a, b) => a.score - b.score || a.i - b.i);
    out = scored.map((s) => s.item);
  }
  return limit > 0 ? out.slice(0, limit) : out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The list token under the caret: [start, end) plus its text. */
export interface ListToken {
  start: number;
  end: number;
  text: string;
}

/** Finds the token containing `caret` in a list separated by any char in `seps`. */
export function tokenAt(value: string, caret: number, seps: string): ListToken {
  let start = caret;
  while (start > 0 && !seps.includes(value[start - 1])) start--;
  let end = caret;
  while (end < value.length && !seps.includes(value[end])) end++;
  return { start, end, text: value.slice(start, end) };
}

/** After a comma/semicolon keep one space before the inserted item; after a
 * newline, a space separator or at the start, none (no doubled spaces). */
function leadFor(before: string): string {
  return before && !/\s$/.test(before) ? " " : "";
}

/** Every other (trimmed, lowercased) item in the list — to hide already-used values. */
function otherTokens(value: string, tok: ListToken, seps: string): Set<string> {
  const rest = value.slice(0, tok.start) + value.slice(tok.end);
  const out = new Set<string>();
  let cur = "";
  for (const ch of rest + seps[0]) {
    if (seps.includes(ch)) {
      const t = cur.trim().toLowerCase();
      if (t) out.add(t);
      cur = "";
    } else cur += ch;
  }
  return out;
}

/**
 * Writes `value` into the field (caret at `caret`, default end) and fires the
 * same events typing would — bubbling `input` then `change` — so every kind of
 * persistence listener (Setting.onChange, container autosave, change/blur
 * commits) sees the pick.
 */
export function commitFieldValue(el: TextField, value: string, caret = value.length): void {
  el.value = value;
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    // some input types (number/date) don't support selection — harmless
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * The one generic suggester. `source` is called lazily (first suggestion
 * request after the popup opens) and cached until it closes.
 */
export class VaultInputSuggest extends AbstractInputSuggest<SuggestItem> {
  private cache: SuggestItem[] | null = null;
  private cacheKey = "";
  private readonly list: string | null;
  private readonly key: (() => string) | null;

  constructor(
    app: App,
    protected readonly el: TextField,
    private readonly source: Source,
    opts: SuggestOptions = {}
  ) {
    // AbstractInputSuggest reads `.value` from anything that isn't a
    // contenteditable div, so a textarea behaves like an input here.
    super(app, el as HTMLInputElement);
    this.limit = opts.limit ?? DEFAULT_LIMIT;
    this.list = opts.list ?? null;
    this.key = opts.key ?? null;
  }

  private items(): SuggestItem[] {
    const key = this.key ? this.key() : "";
    if (this.cache && key !== this.cacheKey) this.cache = null;
    if (!this.cache) {
      this.cacheKey = key;
      const seen = new Set<string>();
      const out: SuggestItem[] = [];
      for (const raw of this.source()) {
        const item = typeof raw === "string" ? { value: raw } : raw;
        if (!item.value) continue;
        const k = item.value.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(item);
      }
      this.cache = out;
    }
    return this.cache;
  }

  /** The text being completed: the caret's list token, or the whole field. */
  protected currentQuery(): { query: string; tok: ListToken | null } {
    if (!this.list) return { query: this.el.value, tok: null };
    const tok = tokenAt(this.el.value, this.el.selectionStart ?? this.el.value.length, this.list);
    return { query: tok.text, tok };
  }

  protected getSuggestions(): SuggestItem[] {
    const { query, tok } = this.currentQuery();
    let items = this.items();
    if (tok && this.list) {
      const used = otherTokens(this.el.value, tok, this.list);
      if (used.size) items = items.filter((i) => !used.has(i.value.toLowerCase()));
    }
    // Rank on the value only — notes are counts/labels, not searchable text.
    return rankMatches(items, query, (i) => i.value);
  }

  renderSuggestion(item: SuggestItem, el: HTMLElement): void {
    if (!item.note) {
      el.setText(item.value);
      return;
    }
    el.addClass("mod-complex");
    const content = el.createDiv({ cls: "suggestion-content" });
    content.createDiv({ cls: "suggestion-title", text: item.value });
    content.createDiv({ cls: "suggestion-note bases-toolbox-suggest-path", text: item.note });
  }

  selectSuggestion(item: SuggestItem): void {
    const { tok } = this.currentQuery();
    if (!tok) {
      commitFieldValue(this.el, item.value);
    } else {
      const v = this.el.value;
      const before = v.slice(0, tok.start);
      const inserted = leadFor(before) + item.value;
      commitFieldValue(this.el, before + inserted + v.slice(tok.end), before.length + inserted.length);
    }
    this.close();
  }

  close(): void {
    this.cache = null; // next open rescans, so it never shows stale vault data
    super.close();
  }
}

/* ------------------------------------------------------------------ sources */

/** Every real vault folder path (A→Z). `root` adds "/" first. Uses the public
 * folder list — not markdown parents — so an empty folder is still offered. */
export function folderSource(app: App, root = false): string[] {
  const paths = app.vault
    .getAllFolders(false)
    .map((f) => f.path)
    .filter((p) => p && p !== "/")
    .sort((a, b) => a.localeCompare(b));
  return root ? ["/", ...paths] : paths;
}

/** Every tag in the vault (frontmatter + inline), most-used first, without "#". */
export function tagSource(app: App): SuggestItem[] {
  const counts = new Map<string, { name: string; n: number }>();
  for (const f of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(f);
    if (!cache) continue;
    for (const raw of new Set(getAllTags(cache) ?? [])) {
      const name = raw.replace(/^#/, "");
      const key = name.toLowerCase();
      const c = counts.get(key);
      if (c) c.n++;
      else counts.set(key, { name, n: 1 });
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .map((c) => ({ value: c.name, note: `${c.n} note${c.n === 1 ? "" : "s"}` }));
}

/** Every file extension in the vault except Markdown, most-common first. */
export function extensionSource(app: App): SuggestItem[] {
  const counts = new Map<string, number>();
  for (const f of app.vault.getFiles()) {
    const e = f.extension.toLowerCase();
    if (!e || e === "md") continue;
    counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([e, n]) => ({ value: e, note: `${n} file${n === 1 ? "" : "s"}` }));
}

/** Every frontmatter property name (the full vault index, never capped). */
export function propertySource(plugin: BasesToolboxPlugin): SuggestItem[] {
  return plugin.propertyCache.get().map((u) => ({ value: u.name }));
}

/**
 * Distinct values of `property`, most-used first. Tag properties also offer
 * every inline #tag in the vault (without the "#", as frontmatter stores them).
 */
export function valueSource(plugin: BasesToolboxPlugin, property: string): string[] {
  const usage = plugin.propertyCache.usage(property);
  const values = usage ? [...usage.values.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v) : [];
  const isTags = property.trim().toLowerCase() === "tags" || usage?.type === "tags";
  if (isTags) for (const t of tagSource(plugin.app)) values.push(t.value);
  return values;
}

/* ------------------------------------------------------------ attach helpers */

/**
 * A plain text-input autocomplete backed by a live list of strings. Kept for
 * the existing call sites; defaults to `limit = 0` (never truncate) because
 * that is the deliberate conditional-formatting behavior (2026-07-03).
 */
export class ListInputSuggest extends VaultInputSuggest {
  constructor(plugin: BasesToolboxPlugin, inputEl: TextField, options: () => string[], opts: SuggestOptions = {}) {
    super(plugin.app, inputEl, options, { limit: 0, ...opts });
  }
}

/** Folder-path autocomplete (optionally a list of folders). */
export function attachFolderSuggest(
  plugin: BasesToolboxPlugin,
  el: TextField,
  opts: SuggestOptions & { root?: boolean } = {}
): VaultInputSuggest {
  return new VaultInputSuggest(plugin.app, el, () => folderSource(plugin.app, opts.root), opts);
}

/** File-extension autocomplete — usually a comma/space list. */
export function attachExtensionSuggest(
  plugin: BasesToolboxPlugin,
  el: TextField,
  opts: SuggestOptions = {}
): VaultInputSuggest {
  return new VaultInputSuggest(plugin.app, el, () => extensionSource(plugin.app), opts);
}

/** Attaches property-name autocomplete (all vault properties, never truncated). */
export function attachPropertySuggest(plugin: BasesToolboxPlugin, inputEl: TextField): ListInputSuggest {
  return new ListInputSuggest(plugin, inputEl, () => propertySource(plugin).map((i) => i.value));
}

/**
 * Attaches value autocomplete to an input. Values track whatever property name
 * `getProperty()` currently returns, so the suggestions match the chosen field.
 * Pass `list` for a multi-value box (e.g. one item per line).
 */
export function attachValueSuggest(
  plugin: BasesToolboxPlugin,
  inputEl: TextField,
  getProperty: () => string,
  opts: SuggestOptions = {}
): ListInputSuggest {
  return new ListInputSuggest(plugin, inputEl, () => valueSource(plugin, getProperty()), { key: getProperty, ...opts });
}

/**
 * Attaches "allowed value" autocomplete for a find & replace target: if the
 * property tracked by `getProperty()` has PINNED allowed values, suggest those
 * (the canonical set to replace a wrong value with); otherwise fall back to the
 * property's existing distinct values so the box is still useful. Reads
 * settings.allowedValues directly to avoid an import cycle with allowed-values.
 */
export function attachAllowedSuggest(
  plugin: BasesToolboxPlugin,
  inputEl: HTMLInputElement,
  getProperty: () => string
): ListInputSuggest {
  return new ListInputSuggest(plugin, inputEl, () => {
    const property = getProperty();
    const pinned = plugin.settings.allowedValues[property.toLowerCase()];
    if (pinned && pinned.length) return pinned;
    return valueSource(plugin, property);
  }, { key: getProperty });
}

/**
 * Autocomplete for `{{variable}}` placeholders (CSV import patterns). Only
 * active while the caret sits inside an open "{{" — the rest of the field is
 * free text. Picking inserts `{{name}}` (reusing a "}}" already typed).
 */
export class TemplateVarSuggest extends AbstractInputSuggest<SuggestItem> {
  constructor(
    app: App,
    private readonly el: HTMLInputElement,
    private readonly source: () => SuggestItem[]
  ) {
    super(app, el);
    this.limit = DEFAULT_LIMIT;
  }

  private openVar(): { start: number; caret: number; query: string } | null {
    const caret = this.el.selectionStart ?? this.el.value.length;
    const m = this.el.value.slice(0, caret).match(/\{\{([^{}]*)$/);
    return m ? { start: caret - m[1].length - 2, caret, query: m[1] } : null;
  }

  protected getSuggestions(): SuggestItem[] {
    const o = this.openVar();
    if (!o) return [];
    return rankMatches(this.source(), o.query, (i) => i.value);
  }

  renderSuggestion(item: SuggestItem, el: HTMLElement): void {
    el.addClass("mod-complex");
    const content = el.createDiv({ cls: "suggestion-content" });
    content.createDiv({ cls: "suggestion-title", text: `{{${item.value}}}` });
    if (item.note) content.createDiv({ cls: "suggestion-note bases-toolbox-suggest-path", text: item.note });
  }

  selectSuggestion(item: SuggestItem): void {
    const o = this.openVar();
    if (!o) return this.close();
    const v = this.el.value;
    let rest = v.slice(o.caret);
    if (rest.startsWith("}}")) rest = rest.slice(2);
    const inserted = `{{${item.value}}}`;
    const before = v.slice(0, o.start);
    commitFieldValue(this.el, before + inserted + rest, before.length + inserted.length);
    this.close();
  }
}

/**
 * The value suggester for the properties modal. Two modes in one input:
 *  - When the caret sits inside an open "[[" token, it suggests vault notes and
 *    inserts a [[wikilink]] at that spot — so you can add MANY links in one
 *    field (each new "[[" re-triggers, unlike a one-shot picker).
 *  - Otherwise it suggests the property's pinned/existing values. In a list
 *    textarea (one per line or ";"-separated) only the item under the caret is
 *    completed and replaced; in a single-line input the whole value is.
 */
export class PropertyValueSuggest extends AbstractInputSuggest<TFile | string> {
  constructor(
    private plugin: BasesToolboxPlugin,
    private el: TextField,
    private getProperty: () => string,
    /** When false, "[[" never triggers note suggestions (e.g. tags/aliases). */
    private allowLinks = true
  ) {
    super(plugin.app, el as HTMLInputElement);
    this.limit = 30;
  }

  /** List separators — only textareas hold lists here. */
  private get seps(): string | null {
    return this.el instanceof HTMLTextAreaElement ? "\n;" : null;
  }

  /** The open "[[…" token at the caret, or null. `start` is just after "[[". */
  private openLink(): { start: number; query: string } | null {
    if (!this.allowLinks) return null;
    const pos = this.el.selectionStart ?? this.el.value.length;
    const m = this.el.value.slice(0, pos).match(/\[\[([^[\]]*)$/);
    return m ? { start: pos - m[1].length, query: m[1] } : null;
  }

  getSuggestions(query: string): (TFile | string)[] {
    const link = this.openLink();
    if (link) {
      return rankMatches(this.plugin.app.vault.getMarkdownFiles(), link.query, (f) => f.path, 30);
    }
    const property = this.getProperty();
    const pinned = this.plugin.settings.allowedValues[property.toLowerCase()];
    let values = pinned && pinned.length ? pinned.slice() : valueSource(this.plugin, property);
    let q = query;
    const seps = this.seps;
    if (seps) {
      const tok = tokenAt(this.el.value, this.el.selectionStart ?? this.el.value.length, seps);
      q = tok.text;
      const used = otherTokens(this.el.value, tok, seps);
      values = values.filter((v) => !used.has(v.toLowerCase()));
    }
    return rankMatches([...new Set(values)], q, (v) => v);
  }

  renderSuggestion(item: TFile | string, el: HTMLElement): void {
    if (typeof item === "string") {
      el.setText(item);
      return;
    }
    el.createSpan({ text: item.basename });
    el.createSpan({ cls: "bases-toolbox-suggest-path", text: `  ${item.path}` });
  }

  selectSuggestion(item: TFile | string): void {
    if (typeof item === "string") {
      const seps = this.seps;
      if (!seps) {
        commitFieldValue(this.el, item);
      } else {
        const v = this.el.value;
        const tok = tokenAt(v, this.el.selectionStart ?? v.length, seps);
        const before = v.slice(0, tok.start);
        const inserted = leadFor(before) + item;
        commitFieldValue(this.el, before + inserted + v.slice(tok.end), before.length + inserted.length);
      }
      this.close();
      return;
    }
    const link = this.openLink();
    const linktext = this.plugin.app.metadataCache.fileToLinktext(item, "", true);
    const pos = this.el.selectionStart ?? this.el.value.length;
    const insStart = link ? link.start - 2 : pos; // include the "[["
    const before = this.el.value.slice(0, insStart);
    const after = this.el.value.slice(pos);
    const inserted = `[[${linktext}]]`;
    commitFieldValue(this.el, `${before}${inserted}${after}`, before.length + inserted.length);
    this.close();
  }
}
