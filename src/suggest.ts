import { AbstractInputSuggest } from "obsidian";
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
