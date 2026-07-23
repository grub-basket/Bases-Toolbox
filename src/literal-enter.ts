import type BasesToolboxPlugin from "./main";

/**
 * Literal Enter: stop Obsidian's value-suggestion popup from stealing what you
 * typed. Natively, when the suggestion popup is open, Enter accepts the
 * HIGHLIGHTED suggestion — so typing a new, unique value that happens to prefix
 * an existing one ("Foo" while "Foobar" is suggested) silently commits
 * "Foobar".
 *
 * With this guard on, Enter commits exactly what you typed UNLESS you navigated
 * the list with the arrow keys first — explicitly picking a suggestion still
 * works, only the implicit first-item steal is blocked.
 *
 * How: a capture-phase keydown listener on the document runs before Obsidian's
 * own key handling (the number guard relies on the same ordering). When the
 * steal case is detected we swallow the Enter, dispatch a synthetic Escape so
 * the suggester closes itself properly (popping its key scope), then re-send a
 * synthetic Enter so the literal value commits. Synthetic events are tagged so
 * the guard ignores its own re-dispatches. If a particular surface ignores the
 * re-sent Enter, the worst case is pressing Enter once more — the typed value
 * is never replaced.
 *
 * Scoped to frontmatter property editors and Bases cells (same scoping as the
 * number guard) so the editor's [[link]] autocomplete, the command palette, and
 * this plugin's own suggesters are untouched.
 */

/** Tag carried by events this guard dispatches itself. */
const SYNTHETIC = "basesToolboxLiteralEnter";

type Tagged = KeyboardEvent & { [SYNTHETIC]?: boolean };

/** The editable the user is typing into, when it's a property/bases field. */
function guardedEditable(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const editable =
    target instanceof HTMLInputElement || target.isContentEditable ? target : null;
  if (!editable) return null;
  const scope = editable.closest('.metadata-property, [class^="bases-"], [class*=" bases-"]');
  return scope ? editable : null;
}

function typedText(el: HTMLElement): string {
  return (el instanceof HTMLInputElement ? el.value : el.textContent ?? "").trim();
}

function visibleSuggestionPopup(): HTMLElement | null {
  const pop = activeDocument.querySelector<HTMLElement>(".suggestion-container");
  return pop && pop.isShown() ? pop : null;
}

export function installLiteralEnter(plugin: BasesToolboxPlugin): void {
  // Arrow navigation since the current popup appeared → the user is choosing a
  // suggestion on purpose; Enter should accept it. Keyed to the popup element
  // so a fresh popup resets the flag.
  let navigatedPopup: HTMLElement | null = null;

  const dispatchKey = (el: HTMLElement, key: string, code: string, keyCode: number) => {
    const ev = new KeyboardEvent("keydown", {
      key,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
    }) as Tagged;
    ev[SYNTHETIC] = true;
    el.dispatchEvent(ev);
  };

  plugin.registerDomEvent(
    activeDocument,
    "keydown",
    (e: KeyboardEvent) => {
      if (!plugin.settings.literalEnter) return;
      if ((e as Tagged)[SYNTHETIC]) return; // our own re-dispatch
      const editable = guardedEditable(e.target);
      if (!editable) return;

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        navigatedPopup = visibleSuggestionPopup();
        return;
      }
      if (e.key !== "Enter") return;

      const pop = visibleSuggestionPopup();
      if (!pop) return;
      if (navigatedPopup === pop) return; // deliberate selection — let it through

      const selected = pop.querySelector<HTMLElement>(".suggestion-item.is-selected");
      const typed = typedText(editable);
      const suggestion = selected?.textContent?.trim() ?? "";
      // No steal happening (nothing highlighted, or it IS what was typed).
      if (!selected || suggestion === typed) return;

      // Block the suggestion-accept entirely…
      e.preventDefault();
      e.stopImmediatePropagation();
      // …close the popup on its own terms (pops the suggester's key scope)…
      dispatchKey(editable, "Escape", "Escape", 27);
      // …then commit the literal text with a fresh Enter once the popup is gone.
      window.setTimeout(() => {
        if (!visibleSuggestionPopup()) dispatchKey(editable, "Enter", "Enter", 13);
      }, 0);
    },
    { capture: true }
  );
}
