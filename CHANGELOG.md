# Changelog

All notable user-facing changes to Bases Toolbox, newest first.

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
