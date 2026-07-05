import { Notice, TFile } from "obsidian";
import type BasesToolboxPlugin from "./main";

/**
 * The Base-embeds reference note, packaged as a string so generating it needs
 * no network. Kept in sync with docs/base-embeds-reference.md in the repo.
 */
export const EMBED_REFERENCE = `# Base embeds — reference

Embed a base in any note with the standard embed syntax:

    ![[My Base.base]]

**Bases Toolbox** adds per-embed *display flags*, written in the embed's "alt
text" after a pipe \`|\`. Combine flags by separating them with spaces.

## Flags

| Flag | Effect |
| --- | --- |
| \`bases-no-toolbar\` | Hide the base's toolbar (view switcher + filters button). |
| \`bases-no-header\` | Hide the column header row. |
| \`bt-height-<px>\` | Fix the embed's height — e.g. \`bt-height-200\` is 200px; content scrolls inside. |

## Examples

Plain embed (default view, full chrome):

    ![[My Base.base]]

Hide the toolbar:

    ![[My Base.base|bases-no-toolbar]]

Hide the toolbar *and* the header:

    ![[My Base.base|bases-no-toolbar bases-no-header]]

A compact, fixed 300px-tall embed with no toolbar:

    ![[My Base.base|bases-no-toolbar bt-height-300]]

---

Notes:

- These flags are provided by the Bases Toolbox plugin. \`bases-no-toolbar\` and
  \`bases-no-header\` are CSS; \`bt-height-<px>\` needs the plugin running.
- The flags live in the embed's alt text (after the \`|\`), not in the base file,
  so the same base can look different in different notes.
`;

const REFERENCE_PATH = "Bases Toolbox — Base embeds.md";

/** Writes the reference note into the vault (or reveals it) and opens it. */
export async function generateEmbedReference(plugin: BasesToolboxPlugin): Promise<void> {
  const { vault, workspace } = plugin.app;
  const existing = vault.getAbstractFileByPath(REFERENCE_PATH);
  let file: TFile;
  if (existing instanceof TFile) {
    await vault.modify(existing, EMBED_REFERENCE);
    file = existing;
    new Notice("Refreshed the Base embeds reference note.");
  } else {
    file = await vault.create(REFERENCE_PATH, EMBED_REFERENCE);
    new Notice(`Created "${REFERENCE_PATH}".`);
  }
  await workspace.getLeaf(true).openFile(file);
}
