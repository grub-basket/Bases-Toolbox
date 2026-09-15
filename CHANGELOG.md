# Changelog

All notable user-facing changes to Bases Toolbox, newest first.

## 0.1.65
- **Filter the history by source.** The bulk file change history gets a source dropdown, so you can narrow the log to just one kind of operation — e.g. **Kanban order** (which groups the card-ordering and its sort change into one option) for a kanban-scoped view of what changed and one-click reverts, or find & replace, merges, imports, and so on. Shows “N of M operations (filtered)”; “All sources” restores the full list.

## 0.1.64
- **Kanban: one-click “hide empty columns.”** A toolbar button on kanban bases (and a command) that toggles Bases' hideEmptyGroups without digging into the view-options menu. It only appears while a kanban view is on screen and shows the current state; click again to bring empty columns back.
- **Hide view types from the picker.** A new opt-in setting hides chosen Bases view types (Table / Cards / List / Kanban) from the view-type picker — the native “Add view” / change-type menu and Bases Toolbox's own add-view dropdown — for when a community plugin shares a native type's name and the duplicate is confusing. The type keeps working on existing views; it's only removed from the picker, and the native-menu filter is conservative enough to never remove a real view from the switcher. Nothing hidden by default.

## 0.1.63
- **Manual card order for kanban.** Obsidian's Bases kanban orders cards inside each column by the base's sort, so a dragged card has no persistent position — reload and it snaps back (there's nowhere for the kanban to store a manual order). This command gives the base a numeric order property, seeds it **spaced** (10, 20, 30… so you can slot a card between two others without renumbering) from a basis you pick — creation date, modification date, name, or the current order — and points the kanban's sort at it. Now each column has a real, editable, **persistent** order: change a card's order value and it moves. Re-run any time to reseed. Command, launcher entry, and in-app reference; both the values and the sort change are revertible from the bulk file change history.

## 0.1.62
- **Sync formula into property.** A new command (and launcher entry) that writes a base's *computed* formula column into a real frontmatter property on every note in the view — so a value that only existed as a live formula becomes a stored property you can sort, filter, group, or reuse anywhere. Pick the formula, name the property; it evaluates via Bases' own engine, skips reserved names, and is one-shot and fully revertible from history (re-run to refresh). The sibling of **Compute rollup into property**, for computed columns instead of linked notes. (Closes the request for syncing formula results into properties.)

## 0.1.61
- **Duplicate finder — merge into a NEW note.** When none of the duplicates deserves to be "the one", a second button per group merges every ticked note into a brand-new note instead: it lands in the oldest note's folder as "<name> (merged)", inherits the oldest `created` and a fresh `modified`, takes the oldest note's value when properties conflict, concatenates the bodies oldest-first, re-points backlinks, and trashes the sources. Unticked notes are left alone. Revertible from history (the sources come back; the new note is emptied rather than deleted). The new note opens when it's done.

## 0.1.60
- **Duplicate finder feedback round.** Merged notes now inherit the **oldest** member's `created` and a fresh `modified` (when the notes carry date frontmatter) — and the preview says so. Keep/tick selections **survive switching between the To review / Ignored tabs**. Unique-ID filenames (letters + a long number) no longer collapse into one bogus group — only short trailing numbers ("Meeting notes 2") still fold. Trashed notes list one full path per line. Preview details read one per line, without repeating near-identical filenames in 2-note groups. Diffs are labelled **pairwise** with a note that merging appends bodies whole. The whole view is wider (720 → 1200px).
- **Importer:** optional **"Add a created property"** toggle (off) stamps `created: <import time>` on newly created notes (a sheet's own created column wins; update mode untouched). The **body template** now documents itself — a collapsible rules-and-example block under the setting.

## 0.1.59
- **Much faster load on slow / network drives.** Starting the plugin used to make ~45 filesystem round-trips (history files + settings buckets) one after another, *before* telling Obsidian it had loaded — invisible on an SSD, but seconds on a network drive, which is what earned the "plugin took a long time to load" flag. The plugin now registers everything instantly and loads its data just after, in parallel batches instead of serially. Nothing else changes: saves wait for the data to arrive first (so an early save can never overwrite your real settings), and undo/history wait for the load before acting.

## 0.1.58
- **Importer — pick exactly which rows import.** A collapsible, searchable **row picker** lists every parsed row with a chip saying what the import will do to it against the target folder (**new** / **exists → update** / overwrite / skip / "-2" copy). All / None / Invert act on the *filtered* rows, so "filter to one provider → None → clear filter" slicing works. Deselected rows are reported in the summary, and the selection is part of the crash-recovery draft.
- **Importer — presets for recurring imports.** Save the whole setup — target folder, column mapping (names, types, included columns, filename column), collision policy, conflict policy, template, base options — under a name (say, one per provider roster). Next month: pick the preset, paste the new sheet, import. Column settings match **by header**, so a re-exported sheet lines up even if its column order changed, and you're told when the sheet and the preset have drifted (columns missing / new).
- **Importer — choose which side wins in update mode.** A new conflict policy for re-imports onto existing notes: **imported wins** (the old behavior) or **keep existing — only fill empty**, so hand-corrected fields survive the next roster import. Overridable **per column** (e.g. keep your corrected phone numbers but always take the sheet's status). Blank cells still never clear anything, bodies are never touched, and the whole update stays revertible from history.
- **Duplicate finder — body diffs.** Once a note is picked to keep, each differing note gets a collapsible **line diff** against it (changes highlighted, long unchanged runs folded away) — so "which of these actually differs, and how" no longer means opening them side by side.
- **Duplicate finder — leave part of a group out.** Every note in a group now has a tick; untick one and it's simply left alone while the rest merge. The merge button and preview follow the selection.
- **Duplicate finder — merge all visible groups.** With a keep-policy set (oldest / newest / longest), one button merges every group on screen, with progress, then rescans. Each group is written as its own history entry, so any single one can still be reverted. Notes that appear in two groups are handled safely (a note already merged away is skipped, not re-merged).
- **Duplicate finder — easier to take in.** Scan options now live in one collapsible block that folds away after a scan, so results get the page. Each note row shows its size, property count, and created/edited dates, so choosing the keeper doesn't require opening anything.
- Folder include/exclude scoping in the duplicate finder was re-verified end to end (a scan honours both, exclude wins).

## 0.1.57
- **New — Always-skip file extensions.** A skip list (Settings → Bases Toolbox → **Always skip file extensions**, seeded with `edtz`) plus a command, **"Exclude skipped file extensions from this base"**, that appends a filter so files with those extensions — Stashpad's encrypted `.edtz` notes, images, PDFs, whatever you list — stop showing up as rows. The rule goes on the base's top-level filter, so it covers **every view** at once. Running it again won't duplicate the rule, and if the base already uses an "or" filter it's wrapped in an "and" so the exclusion still holds (otherwise the exclusion would quietly let those files back in). Revertible from the bulk file change history. Also on the launcher.

## 0.1.56
- **New — Open Stashpad notes in Stashpad (setting, off by default).** With it on, clicking a note in a base that lives in a Stashpad folder opens it in the **Stashpad view** — keeping its place in the parent/children tree — instead of the plain markdown editor. Cmd/Ctrl-click and middle-click do the same in a new tab. Only real Stashpad notes are redirected: a file needs a Stashpad `id`, so author files, attachments, encrypted `.edtz` files, and anything outside a Stashpad folder open exactly as before. Needs the Stashpad plugin; does nothing (and says so once) without it. Bases Toolbox doesn't otherwise depend on Stashpad.

## 0.1.55
- **New — "New grid" in the toolbox panel.** Opens an editable, Excel-style grid over a folder's notes, using the separate **GridSense** plugin: pick the folder and it opens. Also available as the command "New grid (GridSense)", so you can give it a hotkey. If GridSense isn't installed — or is installed but switched off — you're told exactly that, and what to do about it, instead of the button doing nothing. Bases Toolbox doesn't otherwise depend on GridSense; everything else works with it absent.

## 0.1.54
- **New — Columns manager.** One list for a base view's columns: **hide** any of them, **reveal** ones you're not showing, **reorder** with move-left / move-right / move-to-front, and **jump to a column** that's scrolled off-screen. Open it from the new **button next to the base's view switcher** (beside the view manager's), the command **"Manage columns for this base"**, or the launcher.
  - The reveal list is built from the properties this base's notes **actually use** — including ones that have never been a column — plus the base's formulas and anything another view of the same base shows. So switching on a property you forgot about is one click, instead of hunting through Obsidian's property menu.
  - **Group** re-sorts the columns so your own properties lead instead of Obsidian's file attributes (`file.name` stays in front — it's the row's name). Each group keeps its existing internal order.
  - **Jump to column** scrolls the table straight to a column, even one that's far off to the right. Worth knowing: Bases renders only the columns near the viewport, so this works off the view's real column list rather than what happens to be on screen — and it scrolls in one step, because an animated scroll gets cut short as Bases re-renders mid-flight.
  - Columns are **per view** — pick which view you're editing from the dropdown when a base has more than one.
  - Every change is revertible from the bulk file change history, and reverts are surgical: undoing one column change leaves later ones alone.
  - One caveat, stated up front: a view with **no explicit column list** is showing Bases' defaults, and there's nothing to add to or remove from. The first change you make writes the current columns into the base — after which newly added note properties no longer appear on their own, and you reveal them from this dialog instead. You're told once when it happens, and undoing that first change removes the list again.
- **Reverting a base view or column change** now reports what it actually reverted ("Reverted: Hid column “price”") instead of describing it as a note merge.

## 0.1.53
- **View changes now undo surgically.** Previously, undoing a view change restored the whole `.base` file to how it was at that moment — so undoing an *older* change also wiped any newer ones. Each view operation now stores its own inverse (a rename undoes to a rename, a duplicate to a removal, a delete puts the exact view back with all its settings, a reorder moves it back) and applies it to the base as it is *now*, leaving later changes untouched. If the view has been renamed or removed since, the undo is skipped and reported rather than guessed at — and the entry stays available to retry. Existing history entries from 0.1.52 keep working via the old whole-file restore.

## 0.1.52
- **New — View manager.** One dialog for all of a base's views, replacing Obsidian's four-levels-deep flow (view menu → edit arrow → three-dot menu → Duplicate → name it). Every view is listed in switcher order: **rename in place**, **duplicate** (copies the whole view — columns, sort, filters, card size and all), **reorder** with up/down, **make default** (the view a base opens on), **show** a view in the open tab, **add** a new one, and **delete** with a confirmation. Open it from the new **button next to the base's view switcher**, the command **"Manage views for this base"**, or the launcher. Every change is revertible from the bulk file change history. Duplicate names are auto-suffixed (Bases identifies views by name), and renaming or deleting the view you're currently looking at re-points the open tab so it never lands on a view that no longer exists.
- **Bulk file change history** now describes whole-file changes generically instead of assuming every one is a note merge ("Revert this change" rather than "Revert merge" for base edits).

## 0.1.51
- **Store-guideline cleanup.** Removed two informational `console.log` migration messages, switched cross-window-unsafe `instanceof HTMLInputElement` checks to Obsidian's `.instanceOf()`, and used `createDiv()` in place of `createEl("div")` — all to satisfy the community-plugin review guidelines. The **Open settings** and **Open launcher** commands no longer repeat "Bases Toolbox" in their names (Obsidian already shows the plugin name next to each command).

## 0.1.50
- **Duplicate finder — scope the scan by folder.** Replaced the single exclude-folders box with two progressively-growing lists: **Only these folders** (lock the scan to specific folders — leave empty for the whole vault) and **Exclude folders** (skip specific folders; exclude wins over include). Both work at once, and each folder row has a **subfolders** toggle so it can reach into subfolders or stay to that folder's top level only. Your old exclude-folder list is carried over automatically (each kept as "with subfolders").
- **Duplicate finder — filter the results by folder.** After a scan, a row of folder chips shows every folder the duplicates were found in (with a count); click one to temporarily hide its groups so you can focus your merges on the folders you care about. A group stays visible as long as one of its notes is in a folder that isn't hidden. The filter resets on each new scan.
- **Importer — big imports now show up reliably.** After the fast burst-write, the importer now forces Obsidian to register the new notes immediately instead of waiting on the OS file-watcher, which could lag and leave a big import showing only *some* of its rows in the base until you nudged the folder. All rows now appear as soon as the import finishes (their cell values fill in a moment later as metadata parses).

## 0.1.49
- **New — Audit aliased internal links.** A command/tool ("Audit aliased internal links in properties") that scans every note's frontmatter for internal links written with an alias (`[[Note|Shown As]]`), grouped by the note they point to. It flags any target shown more than one way — different aliases, or aliased in some values and plain in others — since those read as different values in Bases and are the ones worth standardizing. Read-only: it surfaces them (with links to each occurrence); it doesn't change anything.

## 0.1.48
- **Importer — never lose an in-progress import.** As you paste and set up an import, the pasted data and the whole mapping (folder, types, renamed columns, options) are saved to a draft automatically. If Obsidian closes or crashes, a notice on next launch flags the recoverable import, and reopening the importer shows a **Restore** bar to bring it all back (with a confirm if you've already started a new import, so nothing is clobbered). The draft survives a full restart and clears itself once an import succeeds.

## 0.1.47
- **Importer — much faster for big imports.** New notes are now written to disk in one fast burst (a bounded worker pool, on desktop) instead of one-at-a-time through Obsidian's slower indexed-create path, after resolving all filenames up front so suffixing stays correct. Obsidian then indexes the notes in the background, so a large base fills in over a few moments rather than blocking the whole time. The import auto-opens the base it creates, and big imports keep a persistent notice up (with the action button restyled onto its own line) explaining the base is still filling in. On mobile it falls back to the standard create path.
- **Importer — better type detection + type icons.** Pasted cells are cleaned of invisible characters (zero-width spaces, non-breaking spaces, BOM) that spreadsheets carry, so a column of dates from Excel is actually recognized as dates and normalized. Dates are now detected by their values, not just the column name. Columns of IDs/codes with letters, or with leading zeros (like `007`), stay text instead of being turned into numbers. The type dropdown for each column now shows an icon per type.

## 0.1.46
- **Importer — update existing notes.** A new collision policy, **"Update the note — merge properties, keep the body,"** maps the imported columns onto existing notes instead of creating -2 duplicates or overwriting: re-import a sheet with new columns (same folder + base) and the new properties are merged into each matching note. Blank cells never clear an existing value, note bodies are untouched, the reused base gains the new columns automatically, and the whole run is undoable from the bulk file change history.
- **Literal Enter (opt-in).** Stops the value-suggestion popup from replacing what you typed: with the popup open, Enter commits your exact text instead of the highlighted suggestion — unless you arrow-navigated to a suggestion first, which still accepts it. Applies to property fields and Bases cells. Enable under Settings → "Literal Enter".
- **Plugin data is no longer one big file.** Settings, conditional-formatting rules, allowed values, forks, ignore lists and the undo history now live in separate files under the plugin folder, so `data.json` stays small and changing a setting no longer rewrites your entire undo history. Your existing data is migrated automatically on first load, after a backup of the original `data.json` is written alongside it.
- **Undo history is stored in chunks** (250 entries per file, per area — find & replace, merge, property index, and so on). History stays uncapped: nothing is ever discarded, but adding an entry only rewrites the newest chunk instead of the whole log. A file that can't be read is set aside rather than overwritten.

## 0.1.45
- **Importer — paste a list, not just a table.** Records separated by blank lines are detected as a list, with each record's lines becoming columns you name in the mapping table (e.g. title/URL pairs copied from a browser tab-export extension become a 2-column import). A new **Input format** dropdown lets you force Auto / Table / List.
- **Importer — URLs are no longer typed as links.** Obsidian's link property type only resolves internal `[[wikilinks]]`, so URL columns were producing broken links. URL columns now import as text; the link type is still auto-assigned to genuine internal-link columns.
- **Importer — set every column's type at once.** A "Set all columns to `<type>`" control, plus "Re-detect types" to restore the automatic detection (which also undoes a bulk change).
- **Importer — progress and a way in.** Long imports now show a progress bar and a live "Importing X/N…" notice, the Import button is disabled while a run is in flight, and the completion notice has an **Open base** button.

## 0.1.44
- **New — Read-only bases.** Lock a base so its cells can't be edited (and rows can't be accidentally deleted), with links and the date-picker still clickable. A global "make all bases read-only" toggle, or a per-base list — both under **Settings → Read-only bases**, plus commands "Toggle read-only for this base" and "Toggle read-only for all bases" and a launcher tool. A separate opt-in, **"Also prevent adding rows,"** additionally hides the toolbar "New" button on read-only bases (some teams want append-only, others a hard lock). Built on the community read-only CSS approach, scoped per base and kept in sync as bases open.

## 0.1.43
- **Add formula column now embeds Obsidian's own formula editor.** While the base is open, the expression fields (both editing an existing formula and adding a new one) become Obsidian's native Bases formula editor — real autocomplete for functions and property/column names, plus inline syntax validation as you type. Falls back to a plain input if the base isn't open.

## 0.1.42
- **New — Add formula column:** add a computed (formula) column to a base without hand-editing YAML — a command + launcher tool that writes the `formulas:` entry into the `.base` file and adds the column to your chosen view(s). It also **repairs Obsidian's empty-formula glitch**: a formula created with a blank expression that the Bases UI locks you out of editing (and that survives reopening/restart) — you can now type an expression straight in and fix it, or remove it. It never writes an empty formula, so it can't create the glitch in the first place.

## 0.1.41
- **Conditional formatting:** tidier rule-row layout — the up/down arrows are now stacked together on the left of each row, and the delete button sits at the far right.

## 0.1.40
- **Conditional formatting:** rule rows now have a drag handle (⋮⋮) — grab it to reorder rules by dragging, in both the settings tab and the sidebar panel. The up/down arrows still work too.

## 0.1.39
- **Duplicate finder:** the "Exclude folders" and "Same value of property" boxes now have autocomplete — folder paths (comma-separated, completes the segment you're typing) and vault property names.
- **Launcher:** the tool search box is now fuzzy — token-based matching that treats `-`, `_`, and spaces as equivalent, so "csv imp" or "find-replace" both match.

## 0.1.38
- **Bases filter popover:** capped its width to the viewport so a long filter value (or a zoomed-in window) no longer pushes it off the right edge.

## 0.1.36
- **Property index — change type:** a "Change type…" action on each property matches Obsidian's native property-type switch (Text, List, Number, Checkbox, Date, Date & time), with an optional one-shot conversion of existing values (numbers parsed, checkboxes from yes/no, dates normalized, lists wrapped/joined). Values that can't convert cleanly are left as-is. Fully undoable.

## 0.1.35
- **Property index — delete:** deleting a whole property now also clears it from Obsidian's property list (including any type you'd set for it), so it disappears entirely instead of lingering. Value/file-scoped deletes still leave the property in place.

## 0.1.34
- **Duplicate finder:** a "Default note to keep" option (oldest / newest / longest) pre-selects which note survives each merge, applied across every group. You can still change the pick per group.

## 0.1.33
- **CSV importer:** shows up front whether it will create a new base or reuse an existing one.

## 0.1.32
- **CSV importer:** documents the note-body template variables and which column becomes the note title.

## 0.1.31
- **Conditional formatting:** live two-way sync between the settings tab and the sidebar panel — edit a rule in one and the other updates instantly.

## 0.1.30
- **Conditional formatting:** the base-scope picker gained search and folder grouping so you can target bases quickly.

## 0.1.29
- **Conditional formatting:** rules can have optional names.

## 0.1.28
- **History:** renamed to "Bulk file change history" for discoverability.

## 0.1.27
- **Duplicate finder:** skips date-like and purely numeric names (no more "every daily note is a duplicate"), plus an exclude-folders option.

## 0.1.26
- **Launcher:** added a search/filter box.

## 0.1.25
- **Conditional formatting:** a global master enable/disable toggle and command.

## 0.1.24
- **Conditional formatting:** duplicate a rule from the settings tab or the panel.

## 0.1.23
- **Conditional formatting:** the custom color picker appears immediately when you choose "Custom".

## 0.1.22
- **CSV importer:** name the base file (blank = folder name), a subfolder hint, and collision-safe reuse (never overwrites).

## 0.1.21
- **CSV importer:** "Omit empty values" now defaults off.

## 0.1.19–0.1.20
- **Base detection:** features now find the base from the focused or most-recent tab — no cell click needed, and no more blank rows when several bases are open.
- **Conditional formatting:** cell-scope colors now follow renamed/reordered columns correctly.

## 0.1.16–0.1.18
- **Base detection hardening:** every base feature reliably detects an open base even when it isn't the focused pane.

## 0.1.15
- **Reliability:** reserved-key guards, `not(inFolder)` export scope, and a more resilient merge-revert.

## 0.1.14
- **Properties:** edit/create-properties modal.
- **Launcher:** favorites.
- **Conditional formatting:** live duplicate-rule detection.
- **CSV:** `.base` companion default and wider column pickers.

## 0.1.13
- **CSV export:** export a base's current view, with folder-ignore, companion handling, and column selection; drag-and-drop import; a built-ins reference panel and a readable base summary.

## 0.1.12
- **CSV:** separate import and export panels, base + folder export, a built-in-properties reference, and safer reverts.

## 0.1.11
- **History:** per-entry revert risk warnings and a post-revert skipped-files panel.

## 0.1.9–0.1.10
- **Duplicate finder:** full workflow — clickable note links, run as a tab or window, a merge preview with chronological body ordering, ignore tabs, and fully revertible merges.
- **Launcher:** opens in its own window.

## 0.1.8
- **Launcher** added.
- **Conditional formatting:** "is duplicated" operator.
- **Find & replace:** cleaner one-control-per-row UI.
- **Format doctor:** type icons in group headings.
- Richer in-app help/reference.

## 0.1.7
- Move-any-view-to-sidebar actions; format doctor gained a persistent "Ignore" with To-fix / Ignored tabs.

## 0.1.4–0.1.6
- **Property index:** delete / rename / audit / search, type icons, and a per-file menu shortcut.
- **Conditional formatting:** autocomplete, de-dupe, and the sidebar panel.
- **Forks:** fork management, adoption of existing forks, and smart auto-names.
- **Pinned allowed values:** violation audit with a persistent notice and reliable pin indicators.
- **Companion notes**, a live format-doctor preview, and an in-app reference.

## 0.1.2–0.1.3
- **Companion notes**, metadata stamp, a **conditional-formatting** overhaul with per-base scoping, **fork management**, and property-index file access.

## 0.1.1
- Store-review fixes: `setCssStyles`, popout/`activeDocument` compatibility, `trashFile`, and deprecation cleanups.

## 0.1.0
- Initial release: number-input guard (no arrow/scroll changes on number cells), find & replace property values with history + revert, and the property index sidebar.
