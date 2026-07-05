# Base embeds — reference

Embed a base in any note with the standard embed syntax:

    ![[My Base.base]]

**Bases Toolbox** adds per-embed *display flags*, written in the embed's "alt
text" after a pipe `|`. Combine flags by separating them with spaces.

## Flags

| Flag | Effect |
| --- | --- |
| `bases-no-toolbar` | Hide the base's toolbar (view switcher + filters button). |
| `bases-no-header` | Hide the column header row. |
| `bt-height-<px>` | Fix the embed's height — e.g. `bt-height-200` is 200px; content scrolls inside. |

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

- These flags are provided by the Bases Toolbox plugin. `bases-no-toolbar` and
  `bases-no-header` are CSS; `bt-height-<px>` needs the plugin running.
- The flags live in the embed's alt text (after the `|`), not in the base file,
  so the same base can look different in different notes.

> This file is packaged in the plugin (src/embed-reference.ts). Settings →
> "Generate Base embeds reference note" writes it into your vault.
