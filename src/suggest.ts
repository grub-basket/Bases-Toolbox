import { AbstractInputSuggest, TFile } from "obsidian";
import type BasesToolboxPlugin from "./main";

/**
 * A plain text-input autocomplete backed by a live list of strings. Used to
 * suggest property names and values so you never have to remember them.
 *
 * Unlike Obsidian's own property suggester (which only remembers a capped set
 * of recently-seen properties), this pulls from the full vault-wide property
 * index and sets `limit = 0` so nothing is truncated — every match shows.
 */
export class ListInputSuggest extends AbstractInputSuggest<string> {
  private readonly el: HTMLInputElement;

  constructor(
    plugin: BasesToolboxPlugin,
    inputEl: HTMLInputElement,
    private options: () => string[]
  ) {
    super(plugin.app, inputEl);
    this.el = inputEl;
    this.limit = 0; // never truncate the list
  }

  protected getSuggestions(query: string): string[] {
    const q = query.trim().toLowerCase();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of this.options()) {
      if (!raw) continue;
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (!q || key.includes(q)) out.push(raw);
    }
    return out;
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }

  selectSuggestion(value: string): void {
    this.setValue(value);
    this.el.value = value;
    // Fire input so the row's change listener persists the choice.
    this.el.dispatchEvent(new Event("input"));
    this.close();
  }
}

/** Attaches property-name autocomplete (all vault properties) to an input. */
export function attachPropertySuggest(
  plugin: BasesToolboxPlugin,
  inputEl: HTMLInputElement
): ListInputSuggest {
  return new ListInputSuggest(plugin, inputEl, () =>
    plugin.propertyCache.get().map((u) => u.name)
  );
}

/**
 * Attaches value autocomplete to an input. Values track whatever property name
 * `getProperty()` currently returns, so the suggestions match the chosen field.
 */
export function attachValueSuggest(
  plugin: BasesToolboxPlugin,
  inputEl: HTMLInputElement,
  getProperty: () => string
): ListInputSuggest {
  return new ListInputSuggest(plugin, inputEl, () => {
    const usage = plugin.propertyCache.usage(getProperty());
    return usage ? [...usage.values.keys()] : [];
  });
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
    const usage = plugin.propertyCache.usage(property);
    return usage ? [...usage.values.keys()] : [];
  });
}

/**
 * The value suggester for the properties modal. Two modes in one input:
 *  - When the caret sits inside an open "[[" token, it suggests vault notes and
 *    inserts a [[wikilink]] at that spot — so you can add MANY links in one
 *    field (each new "[[" re-triggers, unlike a one-shot picker).
 *  - Otherwise it suggests the property's pinned/existing values (replace-all).
 * Works on <input> and <textarea> (lists).
 */
export class PropertyValueSuggest extends AbstractInputSuggest<TFile | string> {
  constructor(
    private plugin: BasesToolboxPlugin,
    private el: HTMLInputElement | HTMLTextAreaElement,
    private getProperty: () => string
  ) {
    super(plugin.app, el as unknown as HTMLInputElement);
    this.limit = 30;
  }

  /** The open "[[…" token at the caret, or null. `start` is just after "[[". */
  private openLink(): { start: number; query: string } | null {
    const pos = this.el.selectionStart ?? this.el.value.length;
    const m = this.el.value.slice(0, pos).match(/\[\[([^[\]]*)$/);
    return m ? { start: pos - m[1].length, query: m[1] } : null;
  }

  getSuggestions(): (TFile | string)[] {
    const link = this.openLink();
    if (link) {
      const q = link.query.toLowerCase();
      return this.plugin.app.vault
        .getMarkdownFiles()
        .filter((f) => !q || f.path.toLowerCase().includes(q))
        .slice(0, 30);
    }
    const property = this.getProperty();
    const pinned = this.plugin.settings.allowedValues[property.toLowerCase()];
    if (pinned && pinned.length) return pinned;
    const usage = this.plugin.propertyCache.usage(property);
    return usage ? [...usage.values.keys()] : [];
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
      this.el.value = item;
      this.el.dispatchEvent(new Event("input"));
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
    this.el.value = `${before}${inserted}${after}`;
    const caret = before.length + inserted.length;
    this.el.setSelectionRange(caret, caret);
    this.el.dispatchEvent(new Event("input"));
    this.close();
  }
}
