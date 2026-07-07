export interface ChangeRecord {
  path: string;
  property: string;
  /** Value before the change (absent when the operation created the property). */
  oldValue: unknown;
  /**
   * Value the operation wrote. Undefined only in entries migrated from the
   * pre-history format; those revert unconditionally.
   */
  newValue?: unknown;
  /** True when the operation created the property; revert deletes it. */
  created?: boolean;
  /** True when the operation deleted the property; revert restores oldValue. */
  deleted?: boolean;
}

/**
 * A whole-file snapshot, for operations that change more than frontmatter
 * (note merges rewrite bodies, trash sources, and re-point backlinks). Revert
 * restores `content` verbatim — recreating the file when it was `removed`.
 */
export interface FileSnapshot {
  path: string;
  /** Full file content before the operation. */
  content: string;
  /** "removed" = the op trashed it (revert recreates); "modified" = overwrite. */
  kind: "modified" | "removed";
}

export interface HistoryEntry {
  property: string;
  /** Display string of the value that was matched, or null for "all values". */
  find: string | null;
  replace: string;
  timestamp: number;
  changes: ChangeRecord[];
  /** Set once the entry has been fully reverted. */
  revertedAt?: number;
  /** Which feature produced the entry (find & replace, bulk edit, rollup…). */
  source?: string;
  /**
   * Whole-file snapshots. Present for operations (note merges) that can't be
   * revved by the property-diff path; when set, revert restores these instead
   * of walking `changes` (which is empty for such entries).
   */
  fileSnapshots?: FileSnapshot[];
}

export interface BasesToolboxSettings {
  /** Swallow ArrowUp/ArrowDown and scroll-wheel spin on number property inputs. */
  blockArrowAndWheel: boolean;
  /** Swallow character keys other than digits, "." and "-" on number property inputs. */
  digitsOnlyTyping: boolean;
  /** Max history entries to keep; null = unlimited. Oldest are dropped first. */
  historyCap: number | null;
  /** Stack list-property pills vertically in Bases table cells. */
  multilineListCells: boolean;
  /** Whether the "raise the row height" tip was already shown once on enable. */
  multilineTipShown: boolean;
  /** Conditional row-coloring rules for Bases views. */
  formatRules: import("./conditional-format").FormatRule[];
  /** Master switch for conditional formatting — off suspends ALL rules without
   * deleting them (and clears any applied colors). */
  cfEnabled: boolean;
  /** Pinned allowed values per property (key: lowercase property name). */
  allowedValues: Record<string, string[]>;
  /** Live-synced property forks (source → target with a transform). */
  propertyForks: import("./property-fork").PropertyForkDef[];
  /** Forks deleted from settings, kept so they can be restored. */
  removedForks: import("./property-fork").PropertyForkDef[];
  /** Last-used companions destination ("" = adjacent to each file). */
  companionsFolder: string;
  /** Legacy include-filter (unused since 0.1.4 — see companionExcludeExts). */
  companionExts: string;
  /** Extensions to EXCLUDE from companioning (comma-separated, no dot). */
  companionExcludeExts: string;
  /** Companion the whole vault (off by default — scope to folders instead). */
  companionVaultWide: boolean;
  /** Folders to limit auto/retroactive companioning to (one path per line). */
  companionFolders: string;
  /** Automatically create companions for newly added non-md files. */
  companionAuto: boolean;
  /**
   * Format-doctor issues the user marked "ignore" (see issueKey() in
   * format-doctor.ts: path + property + JSON of the current value). An ignore
   * only holds while the value is unchanged — if the value changes ("breaks"),
   * the key no longer matches and the issue re-flags.
   */
  ignoredFormatIssues: string[];
  /**
   * Duplicate groups the user marked "ignore" in the duplicate finder. The key
   * is the group's sorted member paths joined with NUL (see groupKey() in
   * merge.ts). Like format-doctor ignores, it only holds while the group is
   * unchanged — add or remove a near-duplicate and the key no longer matches,
   * so the group re-flags for review.
   */
  ignoredDuplicateGroups: string[];
  /** Duplicate finder: folders to skip entirely when scanning (e.g. daily notes). */
  dupExcludeFolders: string[];
  /** Duplicate finder: don't name-group date-like / purely numeric basenames
   * (kills the "every daily note is a duplicate" false positives). */
  dupSkipDateLikeNames: boolean;
  /** One-time flag: the ".base" default exclusion has been merged into an
   * existing user's companionExcludeExts. Prevents re-adding it after they
   * deliberately remove it. */
  companionBaseExclusionApplied: boolean;
  /** Launcher features the user pinned, by id ("view:<type>" / "cmd:<command>"
   * / "settings"). Shown in a Favorites section at the top of the launcher. */
  favoriteFeatures: string[];
  /** How many blank property rows a plain "New note with properties" starts
   * with (base-driven creates use the base's columns instead). */
  newNoteMinRows: number;
}

export const DEFAULT_SETTINGS: BasesToolboxSettings = {
  blockArrowAndWheel: true,
  digitsOnlyTyping: true,
  historyCap: null,
  multilineListCells: false,
  multilineTipShown: false,
  formatRules: [],
  cfEnabled: true,
  allowedValues: {},
  propertyForks: [],
  removedForks: [],
  companionsFolder: "",
  companionExts: "",
  companionExcludeExts: "base",
  companionVaultWide: false,
  companionFolders: "",
  companionAuto: false,
  ignoredFormatIssues: [],
  ignoredDuplicateGroups: [],
  dupExcludeFolders: [],
  dupSkipDateLikeNames: true,
  // Default false so the one-time migration runs for existing users (whose
  // saved data lacks this flag → falls back to the default).
  companionBaseExclusionApplied: false,
  favoriteFeatures: ["cmd:new-note-with-properties"],
  newNoteMinRows: 5,
};

/** A filter condition removed from a .base file, kept so it can be re-enabled. */
export interface DisabledFilter {
  /** The raw condition string as it appeared in the .base YAML. */
  text: string;
  /** Which conjunction array it came from. */
  conj: "and" | "or";
  /** "" for base-level filters, otherwise the view name. */
  scope: string;
}

export interface PluginData {
  settings: BasesToolboxSettings;
  history: HistoryEntry[];
  /** Disabled filters keyed by .base file path. */
  disabledFilters: Record<string, DisabledFilter[]>;
}
