# Bases Toolbox

Bases Toolbox adds tools for the properties behind Obsidian Bases. You can
edit many notes at once, find and replace values across the vault, color
table rows by rules, import and export CSV files, and fix values that don't
match their type. Every change a tool makes to your notes is recorded in
History, where you can undo it.

## Getting started

Open any tool from the **launcher**, the wrench icon in the left ribbon. It
groups the tools by what they act on and tags each one with how far it
reaches. The tools that rewrite many notes at once are at the bottom, under
"Many notes at once". The default settings are safe to start with.

### Common tasks

The Scope column shows how far each tool reaches. An **Open base** tool
changes only the notes the base in your active tab shows, after its filters.
A **Whole vault** tool changes every note that has the property, whatever
base is open.

| I want to… | Tool | Scope |
|---|---|---|
| See every property, its values and which notes use them | Property index | Whole vault (look first, act per item) |
| Change a property on the notes a base is showing | Bulk edit base results | Open base |
| Fill in a property only where it's missing | Bulk edit base results → "Set only if missing" | Open base |
| Copy one property into another (e.g. `startTime` → `Time`) | Convert / fork a property → "Copy as-is" | Whole vault |
| Rename or merge one value everywhere (e.g. `todo` → `to-do`) | Find & replace | Whole vault |
| Fix values stored in the wrong format (dates, numbers…) | Format doctor | Whole vault |
| Keep a formula's result as a real property | Sync formula into property | Open base |
| Set the order properties appear in inside my notes | Reorder properties in notes | Open base view, whole base, or whole vault |
| Keep a copy of my tables outside Obsidian | Export to CSV, following "Before you lose access to Obsidian" | Open base, or a base or folder you pick |
| Undo something | The **Undo** button on the "updated N files" notice, or History | Whatever the change touched |

## Features

### Find & replace property values

Command: **Find and replace property values**. By default it works on **every
note in the vault** that has the property. With a base open, the **Notes**
picker can limit it to the rows one base tab shows (after its filters; the
same base open in two tabs is listed once per tab). If that tab is closed,
nothing applies until you pick an open base or switch back to Whole vault.
Pick a property, then either
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

### Literal Enter

Settings toggle: **Literal Enter**. While you type a property value, Enter
saves exactly what you typed instead of the highlighted suggestion. To pick a
suggestion, move to it with the arrow keys first.

### Bulk edit base results

Command: **Bulk edit base results**. With a base open, act on
every file the view currently shows — filters, search, everything applied.
Five modes: **set** (replace), **set only if missing** (backfill defaults
without clobbering), **append** / **remove** list items, and **delete the
property** entirely. All logged in history and revertible; reverting a
bulk-create deletes the property again, reverting a delete restores it.

The value can refer to **other properties of the same note**: `{{startTime}}`
copies each row's own `startTime` into the property you're setting, and
`{{startTime:HH:mm}}` reformats a date/time with a moment.js format. Mix them
with text (`at {{startTime:h:mm a}}`) or use one per line to append list
items. Notes where a referenced property is missing or empty are skipped and
counted, and the dialog previews what the first note will get.

### Rollups into real properties

Command: **Compute rollup into property**. For every result of the open base,
count/sum/average/min/max over the notes linking to it (or linked from it)
and write the result into a real frontmatter property that Bases can display
and sort natively. One-shot — re-run to refresh. Logged in history,
revertible.

### Sync formula into property

Command: **Sync formula into property**. For every note in the open base, it
works out one of the base's formulas and writes the result into a property
you name. A value that only existed as a live formula becomes a stored
property you can sort, filter or use elsewhere. Dates are written as dates,
and links stay links. One-shot, so re-run it to refresh. Logged in history,
revertible.

### Reorder properties in notes

Command: **Reorder properties in notes**, also in the launcher and as a
button in Manage columns. It sets the order properties appear in inside your
notes, which is the order Obsidian's Properties view shows, across many notes
at once. Only the order changes: values stay as they are, and nothing extra
is written into the notes.

- **Pick the notes:** the open base's current view (its filtered rows), the
  whole base (its own filters, ignoring the view's), or every note in the
  vault. With no base open, it runs on the vault.
- **Arrange the list:** it starts from the view's columns, then every other
  property by how often it's used, each with a note count. Drag the handle or
  use the arrow buttons, and remove a property to leave it where it is.
- **Properties not in the list** go after the listed ones, or stay where they
  are. This is a setting you can change each time.
- **Preview:** it shows how many notes will change. Notes already in order
  aren't touched, and above 200 notes it asks first.
- **Undo:** use the Undo button on the done notice, Undo last change, or
  History. A note you've edited since is skipped unless you force it.
- **Saved orders:** save, load, update and delete named orders. Settings →
  **Property orders** renames and deletes them, and exports or imports them
  as JSON. The format is shared with the GridSense plugin, so an order moves
  between the two.

Obsidian rewrites the frontmatter when it saves it, so YAML comments in
reordered notes are dropped.

### Conditional formatting

Color Bases rows, or single cells, by rules. Each rule has a property, an
operator, a value, a **scope** (the whole row, or just that property's cell)
and a color from the theme palette or a custom color, applied as a subtle
tint. The operators are equals, does not equal, contains, greater or less
than, is empty, is not empty, and is duplicated in this base. A rule can apply
to every base or only the bases you pick.

Rules apply top to bottom, and the first match wins for each row and each
cell. Edit them inline, drag to reorder, and check each one's swatch. Colors
update live as you edit notes and scroll, in base tabs, embedded bases, canvas
cards and hover popovers, whether or not the table shows a file column.

Manage the rules in the plugin settings or in a sidebar panel (command:
**Open conditional formatting panel**), which can pop out to its own tab.

### CSV import & export

Both **Import CSV as notes** and **Export to CSV** are their own panels — open
either from the launcher, and like every panel it can live in the sidebar, its
own tab, or a separate window. Each also has a dialog.

**Import CSV as notes**: paste or pick a CSV/TSV → per-column property name,
type (text/number/date/boolean/list/link), include toggle, filename column →
one note per row in a target folder, with an optional auto-created .base.
Dates are normalized (US, European, month names, Excel serials); quoted
fields may contain newlines.

**Export to CSV** — the panel / dialog has two tabs:

- **From a base**: pick any `.base` file (no need to open it) and **load** it —
  you see its base-level filters, choose **which view** to export (bases can have
  several, each with its own filters and columns), and see that view's filters
  and column order before exporting. It resolves the built-in `file.*` columns
  (name, path, folder, ext, size, ctime, mtime, tags) plus your frontmatter
  properties. This tab reads the `.base` file without running it, so formula
  columns and link lists come out blank, and a view with filters beyond folder
  scope is flagged as a best-effort superset. The **Export active base results
  as CSV** command fills those columns in. A **"Write readable summary (.md)"** button emits a
  plain-language note of the base's filters, formulas, sort, and grouping — the
  things a flat CSV can't hold — so you can rebuild them in your spreadsheet.
  The exporter lists these limitations inline.
- **From a folder**: pick any folder and **load** it — check off any subfolders
  to **ignore**, and see the **non-markdown files** a CSV export skips (images,
  PDFs…). One button **companions** them (creates queryable notes) regardless of
  your companion settings, so they're included on the next load. Then every
  note's frontmatter becomes a CSV row, with a column per key found.

Both preview first, with a **column checklist** (all on by default) so you pick
what to include, then "Copy for Excel" (TSV to clipboard) or write a `.csv`
(next to the base, or in the folder). Wikilinks are unwrapped and lists joined
with ";". Output is multiple files (CSV + optional summary), not a zip.

For the **exact rows a view is showing**, after all its filters, open the base
and run the **"Export active base results as CSV"** command. It uses the view's
column order and needs a base in the active tab. Every column comes out as the
table shows it, including formulas, backlinks and other computed columns. The
file is saved as `<base name> export.csv` next to the base, and
exporting that base again replaces it.

#### Before you lose access to Obsidian

Export while Obsidian still runs if you might lose it, for example on a work
computer or before moving to another app. Your notes stay readable without
Obsidian, because they're plain Markdown files, and `.base` files are plain
text. What you can't recreate without Obsidian is the table itself: which notes
each view shows, and what its formulas work out to.

For each base you want to keep:

1. **Export each view.** Open the base, switch to the view, and run **Export
   active base results as CSV**. This gives the exact rows and every column,
   formulas included.
2. **Rename each CSV before the next export.** Every view of a base saves to
   the same file name, so the next export replaces the last one.
3. **Save the filters, sorting and grouping.** In **Export to CSV**, open the
   **From a base** tab, load the base, choose **Export this view**, then
   **Write readable summary (.md)**. A CSV can't hold these, but the summary
   describes them in plain language.
4. **Optionally, keep formula results in the notes too.** **Sync formula into
   property** writes a formula's result into each note, so the value survives
   in the note itself. It changes your notes, and you can undo it from
   History.

Then, once for the vault:

1. **Catch notes no base shows.** In **Export to CSV**, open the **From a
   folder** tab and export each folder you care about. Every note's properties
   become a row.
2. **Copy everything out and check it.** Exports are saved inside your vault, so
   copy the vault folder somewhere you'll still be able to reach. Open a CSV
   there to confirm it looks right. Images and PDFs aren't in the CSV, but
   copying the vault folder keeps them.

In a CSV, links become plain text and lists are joined with a semicolon.

### Merge notes & duplicate finder

**Merge current note into another**: frontmatter-aware — properties missing
on the target are copied, list properties union, and scalar conflicts get a
per-property picker. The source's body is appended, links to the source are
re-pointed at the target (aliases preserved), and the source moves to the
vault trash (recoverable). The merge is recorded in History, so you can
revert all of it.

**Find duplicate notes**: group candidates by similar file names (case,
punctuation, and "copy"/number suffixes ignored), by equal values of a
property you choose, and/or by identical bodies. Limit the scan to folders or
exclude some. Each group shows every note's size, property count and dates,
and how its body differs from the note you keep. Untick a note to leave it out
of the merge.

A keep policy (oldest, newest or longest) can choose the note to keep, and
then **Merge all visible groups** clears a whole scan at once. When no copy
deserves to survive, **Merge all N into a new note** combines the ticked notes
into a new one. Every merge, including bulk ones, can be reverted from
History.

### Filter quick-toggle

Command: **Toggle base filters**. Disable individual filter conditions of a
.base without deleting them — disabled filters are remembered by the plugin
and can be re-enabled later. (Nested filter groups are listed but not yet
toggleable.)

### Manage a base's views and columns

These open from the launcher, and the first two also from buttons next to a
base's view switcher.

- **Manage views for this base**: one dialog for all of a base's views. Rename
  in place, duplicate a whole view (columns, sort and filters), reorder, set
  the default, show one, add and delete.
- **Manage columns for this base**: hide, reveal and reorder a view's columns,
  and jump to one that's scrolled off-screen. The reveal list comes from the
  properties the base's notes actually use, plus its formulas. **Group**
  re-sorts the columns so your own properties come before the file ones. A
  view with no column list gets one the first time you change something here,
  and after that new properties no longer appear on their own, so reveal them
  from this dialog.
- **Add or fix a base formula column**: adds a formula column by writing it
  into the `.base` file. It also repairs Obsidian's empty-formula glitch, a
  blank formula the Bases editor won't let you edit.
- **Toggle read-only for this base** and **Toggle read-only for all bases**:
  lock a base, or every base, so its cells
  can't be edited, which guards against accidental edits and deletes. Links
  and the date picker stay clickable. Manage the list in Settings → Read-only
  bases.
- **Exclude skipped file extensions from this base**: adds a filter so files
  with the extensions in your skip list (Settings → Always skip file
  extensions, `.edtz` by default) stop appearing in every view. Running it
  again doesn't add it twice. Revertible from History.

### Kanban views

- **Toggle hide empty columns (kanban)**: a toolbar button on kanban views,
  and a command, that hides the columns with no cards. It switches Bases' own
  "hide empty groups" option, and clicking again brings them back.
- **Manual card order for this base's kanban**: Bases orders kanban cards by the base's sort, so a
  card you drag snaps back after a reload. This gives the base a number
  property for the order, fills it in from a starting order you pick
  (creation date, modification date, name or the current order) and sorts the
  kanban by it. Values are spaced out so you can put a card between two
  others. Re-run it any time to start over. The values and the sort change are
  both revertible from History.

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

### Bases built-in properties (and Obsidian's forgetful picker)

Obsidian's Bases property menu sometimes drops the built-in `file.*`
attributes, so a column you want — created time, tags, folder — isn't offered.
They aren't formulas; you can re-add any of them by its identifier:

| Identifier | What it is |
| --- | --- |
| `file.name` | note name (no extension) |
| `file.ext` | file extension |
| `file.path` / `file.folder` | full path / containing folder |
| `file.size` | size in bytes |
| `file.ctime` / `file.mtime` | created / modified time |
| `file.tags` | every tag (frontmatter + body) |
| `file.links` / `file.backlinks` / `file.embeds` | outgoing links / backlinks / embeds |
| `file.properties` | all frontmatter properties on the file |

**To add one**: in a table view open a column's property menu and pick it under
**File** — or edit the `.base` file directly and add the identifier to a view's
`order:` list:

```yaml
views:
  - type: table
    order:
      - file.name
      - file.ctime      # re-added built-in
      - file.tags
```

**For a formatted or computed column** (a readable date, a derived value), use a
**formula** instead — add a `formulas:` block and reference it as
`formula.<name>`:

```yaml
formulas:
  created: file.ctime
views:
  - type: table
    order:
      - file.name
      - formula.created
```

…then rename that column's header in the view. Obsidian 1.9.5+ ships a built-in
formula editor (autocomplete + docs), and the community plugin
[Formula Forge](https://community.obsidian.md/plugins/formula-forge) adds global
formulas and renders them inline — reach for either if you're writing anything
beyond a bare `file.*` reference.

This "forgetting" is Obsidian's behavior, not something this plugin can patch —
but the property index above never forgets *your* properties.

#### Recipe: look up a value from a linked note (a Bases "XLOOKUP")

Bases has no built-in relational lookup, but if a property **links to another
note**, a formula can pull one of *that* note's properties in — the equivalent
of Excel's XLOOKUP. Say each Transaction links to an Account
(`account: [[Chase 1234]]`) and you want the Account's bank name as a column:

```yaml
formulas:
  bank: account.asFile().properties.bank
```

For property names with spaces or symbols, use bracket syntax on both sides:

```yaml
formulas:
  holder: note["Account"].asFile().properties["Account Holder Name"]
```

Then add `formula.bank` / `formula.holder` to the view's `order`. It's the
relational join Bases doesn't give you out of the box. (This is a plain Bases
formula recipe, not a plugin feature.)

### Property format doctor

Command: **Property format doctor**. Obsidian flags type-mismatched property
values but "corrects" them destructively — sometimes erasing the value
outright. The doctor opens a tab listing every value in the vault that
doesn't match its property's assigned type (number, checkbox, date,
datetime, text, list, tags, aliases), explains what each type expects with
an example, and pre-fills a suggested fix only when one is safe (dates get
normalized, `yes` becomes `true`, scalars become one-item lists, a date in a
datetime slot gains `T00:00`). Everything is editable before applying;
inputs that still don't match are marked red and the file is left untouched;
an empty input means "skip" — a value is never erased. Applied fixes are
logged to history and revertible.

### Convert or fork a property's format

Command: **Convert or fork a property's format**. For frontmatter that
predates Bases — dates like `3/4/2024` or `February 3 2025`, or values
wrapped in `[[wikilinks]]` where you want raw text (or vice versa). Pick a
property and a transform (normalize dates → YYYY-MM-DD, unwrap wikilinks,
wrap in wikilinks, plain copy), preview the effect, then either **convert in
place** or **fork into a second property** so you keep your original format
AND a Bases-friendly variant side by side. Forks can be kept in **live
sync** — edit the original and the fork recomputes automatically. Live syncs
are managed in the plugin settings: pause one without deleting it, delete it
(deleted syncs move to a restorable "recently removed" list), or open the
fork builder to add another. Every apply is
history-logged and revertible.

### Allowed values (pinned)

From the property index, pin the allowed values of any property (pin icon).
Editing a pinned property — in the frontmatter panel or a Bases cell — shows
a picker of the allowed values, and the **Audit allowed values** command
lists every value that falls outside a pinned list, with one-click jumps
into find & replace.

### Companion notes for non-Markdown files

Command: **Create companion notes for non-Markdown files**. Bases only reads
frontmatter from `.md` files — images, PDFs, audio, and other attachments
are invisible to it. This scans a folder (or the vault), optionally filtered
by extension, and creates one companion note per file (named
`<file>.<ext>.md`) whose frontmatter replicates the file's metadata —
`file-name`, `file-ext`, `file-size`, `file-created`, `file-modified`,
`file-path` — plus a `companion-of` link and an embed of the file in the
body. Companions live adjacent to their files by default, or collected into
a designated folder mirroring the source structure. Re-running refreshes the
`file-*` properties while preserving anything you added to a companion;
originals are never touched, and files derived from notes (like version
files other plugins create) are never companioned. Every non-Markdown file is eligible by default; settings let you **exclude
specific extensions** (managed as chips, with every file type found in your
vault listed so you can click to exclude it), set a default destination, and
turn on an opt-in **auto mode** that companions files as they're added —
enabling it also companions eligible files that already existed.

### Stamp file metadata into note properties

Command: **Stamp file metadata into note properties**. Filesystem
created/modified times get destroyed by syncs, copies, and migrations —
frontmatter travels with the note forever. This snapshots each Markdown
note's current times into properties of your choosing (default `created` /
`modified`), scoped to a folder or the vault. Set-if-missing by default, so
existing values are respected; overwrite is opt-in. Logged to history and
revertible.

### Inline-field migration

Command: **Migrate inline fields to properties**. Scans for Dataview-style
`Key:: value` lines (and optionally `[key:: value]` spans), previews what it
found, and writes them into frontmatter so Bases can query them. Optionally
cleans the migrated fields out of note bodies (off by default — that part
isn't revertible; the frontmatter side is, via history). Scope to a folder
or the whole vault; existing properties are skipped unless you opt into
overwriting.

### Property forms for one note

- **New note with properties**: creates a note from a roomy form for its
  properties.
- **Edit properties of the active note**: the same form for the active note, which can also
  rename it.

### Audit aliased links in properties

Command: **Audit aliased internal links in properties**. Finds property values
whose links use an alias (`[[Note|Alias]]`) and groups them by the note they
point to. It flags any note that's linked more than one way, such as with
different aliases, or with an alias in some values and none in others.
Read-only.

### Open a grid with GridSense

Command: **New grid (GridSense)**. Opens an editable, spreadsheet-style grid
over a folder's notes, using the separate GridSense plugin. If GridSense isn't
installed or is turned off, it says so. Nothing else in Bases Toolbox needs
GridSense.

### Open Stashpad notes in Stashpad

A setting, off by default. With it on, clicking a note in a base that lives in
a Stashpad folder opens it in the Stashpad view instead of the plain editor.
Cmd/Ctrl-click and middle-click do the same in a new tab. Only notes with a
Stashpad id are redirected.

## Tips & recipes

**Fork any note (duplicate + rename in one go)**: Obsidian's core **Templates**
plugin already covers new-note-from-template, so this plugin doesn't ship a
templates feature. To quickly clone an *existing* note and rename it, install
the community **[Commander](https://obsidian.md/plugins?id=cmdr)** plugin and
bind a macro that runs *Create new note* and then *Rename file* back to back —
one click forks the note you're on.

**Writing formulas**: for anything past a bare `file.*` reference (see
[Bases built-in properties](#bases-built-in-properties-and-obsidians-forgetful-picker)
above), use Obsidian 1.9.5+'s built-in formula editor, or
[Formula Forge](https://community.obsidian.md/plugins/formula-forge) for global
formulas and inline rendering. A full formula *builder* is out of scope here —
those tools do it well.

## Credits & related plugins

Parts of this plugin overlap with — and were inspired by — existing
community work. Credit where due, and if one of these fits your workflow
better, use it. What each is capable of:

- **[Mass Editor](https://github.com/ondreu/mass-editor)** (MIT) — shipped
  while this plugin's find & replace was already in development (built
  independently). Reviewing its code later inspired several history
  refinements here — selective per-file revert, the force-revert option, and
  set-if-missing/delete bulk modes — as concepts; no code was copied, our
  implementations are our own. Capabilities:
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
  the companion browser tool our CSV import's converter core is ported from
  (same author as this plugin):
  - paste/drop CSV or TSV, map columns to typed properties, live preview
  - downloads a ZIP of ready-to-drop .md files — no install, works offline

## Permissions & data

Bases Toolbox runs entirely on your machine. It has **no network access** — it
never sends anything anywhere, and there is no telemetry or analytics.

- **Reading the list of files in your vault** — the property index, vault-wide
  find & replace, companion-notes scan, base discovery, and merge all need to
  enumerate file paths (`vault.getFiles` / `getMarkdownFiles`). This stays
  local; it's what lets the plugin offer "a searchable index of every property"
  and replace a value everywhere it appears.
- **Clipboard** — used **write-only**. When you click a Copy button (copy
  property name, copy value, copy file path, or copy a CSV export) the plugin
  writes to the clipboard. It **never reads** the clipboard, so nothing you've
  copied from elsewhere is ever accessed.
- **Reading and writing note files** — property edits, find & replace, and the
  format doctor modify frontmatter through the standard Obsidian file API, only
  when you ask them to.

## Development

```
pnpm install
pnpm run dev        # watch build
pnpm run build      # production build
pnpm run deploy     # build + copy artifacts to the vault(s) in .deploy-target
```

`.deploy-target` (gitignored) holds one `<vault>/.obsidian/plugins/bases-toolbox`
path per line.
