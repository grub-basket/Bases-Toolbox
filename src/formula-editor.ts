import { App, TFile } from "obsidian";
import { EditorView, placeholder as cmPlaceholder } from "@codemirror/view";
import { EditorState, Extension } from "@codemirror/state";

/**
 * A single-line formula input that, when possible, IS Obsidian's own Bases
 * formula editor — same autocomplete (functions + column/property names) and
 * inline syntax validation. Obsidian exposes the CodeMirror language bundle on
 * an open base's controller via `getEditorLanguageSupport()`; we mount a small
 * CodeMirror view with that extension. When it's unavailable (base not open, or
 * the undocumented API changed) we fall back to a plain <input> so nothing
 * breaks — everything here is feature-detected and try/caught.
 */

type BaseControllerLike = {
  getEditorLanguageSupport?: () => { extension?: unknown } | null;
};

/**
 * The CodeMirror extension backing the formula editor for `file`, or null.
 * Requires the base to be OPEN (the language support is bound to a live
 * controller's context, which is what makes its autocomplete base-specific).
 */
export function formulaLanguageExtension(app: App, file: TFile): Extension | null {
  try {
    const leaf = app.workspace
      .getLeavesOfType("bases")
      .find((l) => (l.view as { file?: TFile })?.file?.path === file.path);
    const ctrl = (leaf?.view as { controller?: BaseControllerLike })?.controller;
    const ext = ctrl?.getEditorLanguageSupport?.()?.extension;
    return (ext as Extension) ?? null;
  } catch {
    return null;
  }
}

export interface FormulaField {
  getValue(): string;
  destroy(): void;
  native: boolean;
}

/**
 * Mounts a formula input into `parent`. Uses the native CodeMirror editor when
 * `extension` is provided, else a plain input. Newlines are stripped on read so
 * the value is always a single-line expression.
 */
export function mountFormulaField(
  parent: HTMLElement,
  initial: string,
  extension: Extension | null,
  opts: { placeholder?: string; onChange?: () => void } = {}
): FormulaField {
  if (extension) {
    try {
      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc: initial,
          extensions: [
            extension,
            EditorView.lineWrapping,
            cmPlaceholder(opts.placeholder ?? ""),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) opts.onChange?.();
            }),
          ],
        }),
      });
      view.dom.addClass("bases-toolbox-formula-cm");
      return {
        native: true,
        getValue: () => view.state.doc.toString().replace(/\n/g, " ").trim(),
        destroy: () => view.destroy(),
      };
    } catch {
      // fall through to the plain input on any CM failure
    }
  }
  const input = parent.createEl("input", { type: "text", cls: "bases-toolbox-formula-expr" });
  input.value = initial;
  if (opts.placeholder) input.placeholder = opts.placeholder;
  input.addEventListener("input", () => opts.onChange?.());
  return {
    native: false,
    getValue: () => input.value.trim(),
    destroy: () => input.remove(),
  };
}
