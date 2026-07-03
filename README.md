# Bases Toolbox

Quality-of-life tools for Bases and properties in Obsidian.

## Features

### Find & replace property values

Command: **Find & replace property values**. Pick a property, then either
replace one specific value everywhere it appears or override every value at
once. Works on list properties too (the matched item is replaced in place;
a global override collapses the list to the new value). Leaving the
replacement empty clears the value.

Every run is logged. **Find & replace history** opens as a main-area tab
listing all past operations (newest first, uncapped by default — an optional
cap and a clear-history action live in the settings). Each entry expands into
per-file rows showing old → new with an "edited since" badge on drifted
files; revert all of an operation or just the files you check.
**Undo last find & replace** reverts the newest active entry. Reverts are
best-effort: files whose value was edited again are skipped and reported —
unless you enable the force toggle, which overwrites them. An entry only
counts as reverted once nothing from it remains in effect, so you can always
retry. The log survives app restarts.

### Number input guard

Number properties — in the frontmatter editor and inside Bases views — no
longer change value when you press ArrowUp/ArrowDown or scroll the mouse
wheel over a focused input. Optionally, only digits, `.` and `-` are accepted
as typed characters (so no stray `e` exponents). Both behaviors are toggles
in the plugin settings and are on by default.

### Bulk edit base results

Command: **Bulk edit properties of base results**. With a base open, act on
every file the view currently shows — filters, search, everything applied.
Five modes: **set** (replace), **set only if missing** (backfill defaults
without clobbering), **append** / **remove** list items, and **delete the
property** entirely. All logged in history and revertible; reverting a
bulk-create deletes the property again, reverting a delete restores it.

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
community work. Credit where due, and if one of these fits your workflow
better, use it. What each is capable of:

- **[Mass Editor](https://github.com/ondreu/mass-editor)** — shipped while
  this plugin's find & replace was already in development (built
  independently). Capabilities:
  - query builder over tags, frontmatter, and body text
  - bulk frontmatter set / add / delete / append on the matched notes
  - automatic per-run backups with a history panel
  - selective undo with drift detection and git-style diffs
- **[Better Properties](https://github.com/unxok/obsidian-better-properties)** —
  the full-featured take on property editing (BRAT install):
  - select-style fields with predefined value lists per property
  - extra property input types beyond core's set
  - rename or delete a property across the whole vault from the property menu
- **[Metadata Menu](https://github.com/mdelobelle/metadatamenu)** — the
  heavyweight metadata suite (requires Dataview):
  - fileClass schemas: define which fields a kind of note has
  - select / multi-select fields with predefined and dynamic values
  - lookup fields that aggregate over Dataview queries and persist results
    into frontmatter (count / sum / average / custom JS)
  - edit any field from context menus, links, or buttons anywhere in the app
- **[Multi Properties](https://github.com/fez-github/obsidian-multi-properties)** —
  bulk property editing:
  - add or overwrite properties on many notes at once
  - works on folders, multi-selected files, and search results
    (this plugin covers the missing scope: the live results of a Bases view)
- **[Dataview to Properties](https://github.com/tsunemaru/dataview-to-properties)** —
  converts Dataview inline `key:: value` fields into frontmatter properties
  (our migrator adds folder scoping, a dry-run preview, and revertible writes)
- **[Bases Lock](https://github.com/tcyeee/obsidian-bases-lock)** — per-embed
  control of embedded bases:
  - hide the toolbar / lock header interaction with `|x` / `|o` embed flags
    (reading view; our flags add a fixed-height option)
- **[Colored Bases Properties](https://github.com/rafjaf/obsidian-colored-bases-properties)** —
  automatic, hash-based colors for property value pills in Bases views
  (our conditional formatting instead colors whole rows by explicit rules)
- **[Dualyze Notes](https://github.com/dualyze-ai/dualyze-notes)** — finds
  similar notes by weighted title / heading / tag / link / body similarity
  and builds side-by-side merge drafts for their bodies
- **[Merge Notes](https://github.com/martinschenk/obsidian-merge-notes)** —
  straightforward concatenation of two notes into one
  (our merge adds frontmatter awareness: list union + per-conflict picker)
- **[CSV-to-Obsidian-Properties-for-Bases](https://github.com/grub-basket/CSV-to-Obsidian-Properties-for-Bases)** —
  the companion browser tool our CSV import is ported from:
  - paste/drop CSV or TSV, map columns to typed properties, live preview
  - downloads a ZIP of ready-to-drop .md files — no install, works offline

## Development

```
pnpm install
pnpm run dev        # watch build
pnpm run build      # production build
pnpm run deploy     # build + copy artifacts to the vault(s) in .deploy-target
```

`.deploy-target` (gitignored) holds one `<vault>/.obsidian/plugins/bases-toolbox`
path per line.
