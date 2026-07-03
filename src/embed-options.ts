import type BasesToolboxPlugin from "./main";

/**
 * Per-embed display flags for bases embedded in notes, written as embed alt
 * text: `![[My Base.base|bases-no-toolbar bt-height-200]]`.
 *
 * - `bases-no-toolbar` / `bases-no-header` are handled in styles.css via
 *   [alt~=] selectors (the alt text stays an attribute on .bases-embed —
 *   unlike image embeds it never becomes a class).
 * - `bt-height-<px>` needs JS (CSS can't read numbers out of attributes):
 *   a MutationObserver applies the height to embeds as they render.
 */
const HEIGHT_FLAG = /\bbt-height-(\d{2,4})\b/;

function applyHeight(el: HTMLElement): void {
  const m = (el.getAttribute("alt") ?? "").match(HEIGHT_FLAG);
  if (!m) return;
  const px = `${m[1]}px`;
  // Equality guard: Obsidian writes its own inline height on base embeds
  // after render, so we re-assert on style mutations — without this check
  // our own write would re-trigger the observer forever.
  if (el.style.height === px && el.style.maxHeight === px) return;
  el.setCssStyles({ height: px, maxHeight: px });
}

export function installEmbedOptions(plugin: BasesToolboxPlugin): void {
  const scan = (root: ParentNode) =>
    root.querySelectorAll<HTMLElement>(".bases-embed[alt]").forEach(applyHeight);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        const t = mutation.target;
        if (t.instanceOf(HTMLElement) && (t as HTMLElement).matches(".bases-embed"))
          applyHeight(t as HTMLElement);
        continue;
      }
      for (const node of Array.from(mutation.addedNodes)) {
        if (!node.instanceOf(HTMLElement)) continue;
        const el = node as HTMLElement;
        if (el.matches(".bases-embed")) applyHeight(el);
        else scan(el);
      }
    }
  });
  observer.observe(activeDocument.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "alt"],
  });
  plugin.register(() => observer.disconnect());
  scan(activeDocument.body);
}
