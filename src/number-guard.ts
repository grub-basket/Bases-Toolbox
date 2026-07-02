import type BasesToolboxPlugin from "./main";

/**
 * Matches number inputs inside the frontmatter property editor or any Bases
 * view. The "bases-" class check is intentionally loose because Bases DOM
 * class names are not part of the public API and shift between releases.
 */
function guardedNumberInput(target: EventTarget | null): HTMLInputElement | null {
  if (!(target instanceof HTMLInputElement)) return null;
  if (target.type !== "number") return null;
  const scope = target.closest('.metadata-property, [class^="bases-"], [class*=" bases-"]');
  return scope ? target : null;
}

export function installNumberGuard(plugin: BasesToolboxPlugin): void {
  plugin.registerDomEvent(
    document,
    "keydown",
    (e: KeyboardEvent) => {
      const s = plugin.settings;
      if (!s.blockArrowAndWheel && !s.digitsOnlyTyping) return;
      if (!guardedNumberInput(e.target)) return;
      // preventDefault (not stopPropagation) so the value doesn't spin but
      // Obsidian's own navigation handlers still see the key.
      if (s.blockArrowAndWheel && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        return;
      }
      if (
        s.digitsOnlyTyping &&
        e.key.length === 1 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !/[0-9.\-]/.test(e.key)
      ) {
        // Swallows "e", "+", letters — everything a number input would
        // otherwise accept beyond digits, "." and "-".
        e.preventDefault();
      }
    },
    { capture: true }
  );

  plugin.registerDomEvent(
    document,
    "wheel",
    (e: WheelEvent) => {
      if (!plugin.settings.blockArrowAndWheel) return;
      const input = guardedNumberInput(e.target);
      // Chromium only spins the value when the input is focused; scrolling
      // past an unfocused input is left alone so the page still scrolls.
      if (input && input === document.activeElement) e.preventDefault();
    },
    { capture: true, passive: false }
  );
}
