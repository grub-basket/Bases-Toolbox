# Bases Toolbox

Quality-of-life tools for Bases and properties in Obsidian.

## Features

### Find & replace property values

Command: **Find & replace property values**. Pick a property, then either
replace one specific value everywhere it appears or override every value at
once. Works on list properties too (the matched item is replaced in place;
a global override collapses the list to the new value). Leaving the
replacement empty clears the value.

Every run is logged. **Find & replace history** lists all past operations
(newest first, uncapped by default — an optional cap and a clear-history
action live in the settings) and each one can be reverted;
**Undo last find & replace** reverts the newest entry. The log survives app
restarts. Reverts are best-effort: a file is only restored if the property
still exists in it and still holds the value the operation wrote — renamed
properties, values edited since, and deleted files are skipped and reported.

### Number input guard

Number properties — in the frontmatter editor and inside Bases views — no
longer change value when you press ArrowUp/ArrowDown or scroll the mouse
wheel over a focused input. Optionally, only digits, `.` and `-` are accepted
as typed characters (so no stray `e` exponents). Both behaviors are toggles
in the plugin settings and are on by default.

### Bulk edit base results

Command: **Bulk edit properties of base results**. With a base open, set (or
create) a property on every file the view currently shows — filters, search,
everything applied. Logged in history, revertible; reverting a bulk-create
deletes the property again.

### Rollups into real properties

Command: **Compute rollup into property**. For every result of the open base,
count/sum/average/min/max over the notes linking to it (or linked from it)
and write the result into a real frontmatter property that Bases can display
and sort natively. One-shot — re-run to refresh. Logged in history,
revertible.

### Conditional formatting

Color Bases rows by rules (first match wins): property, operator
(equals/contains/compare/empty), value, and a theme-tinted color. Managed in
the plugin settings.

### CSV import & export

**Import CSV as notes**: paste or pick a CSV/TSV → per-column property name,
type (text/number/date/boolean/list/link), include toggle, filename column →
one note per row in a target folder, with an optional auto-created .base.
Dates are normalized (US, European, month names, Excel serials); quoted
fields may contain newlines.

**Export base results as CSV**: the open base's current results → clean CSV
(wikilinks unwrapped, lists joined with ";"), copied to the clipboard and
written next to the .base file.

### Merge notes & duplicate finder

**Merge current note into another**: frontmatter-aware — properties missing
on the target are copied, list properties union, and scalar conflicts get a
per-property picker. The source's body is appended, links to the source are
re-pointed at the target (aliases preserved), and the source moves to the
vault trash (recoverable). No automated undo — check the plan in the modal
before confirming.

**Find duplicate notes**: group candidates by similar file names (case,
punctuation, and "copy"/number suffixes ignored), by equal values of a
property you choose, and/or by identical bodies. Pick the note to keep per
group and merge the rest into it.

### Filter quick-toggle

Command: **Toggle base filters**. Disable individual filter conditions of a
.base without deleting them — disabled filters are remembered by the plugin
and can be re-enabled later. (Nested filter groups are listed but not yet
toggleable.)

### Cell zoom editor

Command: **Zoom into focused cell**. Click into a Bases cell or a property
value in the frontmatter panel, run the command (bind a hotkey), and edit the
value in a proper multi-line editor. List properties edit one-item-per-line.
Saved through Obsidian's frontmatter API.

### Embedded-base display options

Control how an embedded base renders via flags in the embed's alt text:

```
![[My Base.base|bases-no-toolbar]]        hide the toolbar row
![[My Base.base|bases-no-header]]         hide the whole header
![[My Base.base|bt-height-300]]           fix the embed height (px)
![[My Base.base|bases-no-header bt-height-150]]   combine them
```

No CSS snippets needed; flags apply per embed.

### Multiline list cells

Settings toggle: list-property values in Bases table cells stack one per
line instead of a single row of pills. Rows in Bases are fixed-height
(virtualized), so long lists scroll inside the cell — pair with the Bases
row-height option for taller rows.

### Property index

Command: **Open property index** (also a ribbon icon). A sidebar view listing
every frontmatter property in the vault with its type, file count, and — when
expanded — every distinct value with usage counts. Built straight from the
metadata cache, so it never forgets a property the way the Bases filter menu
can. Each property and value has a shortcut into find & replace.

### Allowed values (pinned)

From the property index, pin the allowed values of any property (pin icon).
Editing a pinned property — in the frontmatter panel or a Bases cell — shows
a picker of the allowed values, and the **Audit allowed values** command
lists every value that falls outside a pinned list, with one-click jumps
into find & replace.

### Inline-field migration

Command: **Migrate inline fields to properties**. Scans for Dataview-style
`Key:: value` lines (and optionally `[key:: value]` spans), previews what it
found, and writes them into frontmatter so Bases can query them. Optionally
cleans the migrated fields out of note bodies (off by default — that part
isn't revertible; the frontmatter side is, via history). Scope to a folder
or the whole vault; existing properties are skipped unless you opt into
overwriting.

## Credits & related plugins

Parts of this plugin overlap with — and were inspired by — existing
community work. Credit where due:

- **[Mass Editor](https://github.com/ondreu/mass-editor)** — shipped a
  query-based frontmatter editor with backups and selective undo while this
  plugin was already in development; our find & replace + history was built
  independently, but if you want query-builder-style mass edits, check it out.
- **[Better Properties](https://github.com/unxok/obsidian-better-properties)**
  and **[Metadata Menu](https://github.com/mdelobelle/metadatamenu)** — the
  full-featured takes on select-style property fields with predefined values.
  Our pinned allowed values are the lightweight, Bases-focused slice of that
  idea.
- **[Dataview to Properties](https://github.com/tsunemaru/dataview-to-properties)**
  — covers the basic inline-field conversion; ours adds scoping, dry-run
  preview, and revertible frontmatter writes.
- **[Multi Properties](https://github.com/fez-github/obsidian-multi-properties)**
  — bulk property editing over folders and search results (ours scopes to
  Bases view results instead).
- **[Bases Lock](https://github.com/tcyeee/obsidian-bases-lock)** — per-embed
  toolbar hiding via embed flags; our embed options add the fixed-height flag.
- **[Colored Bases Properties](https://github.com/rafjaf/obsidian-colored-bases-properties)**
  — colors property value pills in Bases; our conditional formatting colors
  whole rows by rules.
- **[Dualyze Notes](https://github.com/dualyze-ai/dualyze-notes)** and
  **[Merge Notes](https://github.com/martinschenk/obsidian-merge-notes)** —
  note merging by body; ours adds frontmatter-aware merging with conflict
  resolution.
- **[CSV-to-Obsidian-Properties-for-Bases](https://github.com/grub-basket/CSV-to-Obsidian-Properties-for-Bases)**
  — the companion web tool our CSV import is ported from.

## Development

```
pnpm install
pnpm run dev        # watch build
pnpm run build      # production build
pnpm run deploy     # build + copy artifacts to the vault(s) in .deploy-target
```

`.deploy-target` (gitignored) holds one `<vault>/.obsidian/plugins/bases-toolbox`
path per line.
