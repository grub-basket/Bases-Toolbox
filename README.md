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

### Property index

Command: **Open property index** (also a ribbon icon). A sidebar view listing
every frontmatter property in the vault with its type, file count, and — when
expanded — every distinct value with usage counts. Built straight from the
metadata cache, so it never forgets a property the way the Bases filter menu
can. Each property and value has a shortcut into find & replace.

## Development

```
pnpm install
pnpm run dev        # watch build
pnpm run build      # production build
pnpm run deploy     # build + copy artifacts to the vault(s) in .deploy-target
```

`.deploy-target` (gitignored) holds one `<vault>/.obsidian/plugins/bases-toolbox`
path per line.
