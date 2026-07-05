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
  /** Conditional row-coloring rules for Bases views. */
  formatRules: import("./conditional-format").FormatRule[];
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
}

export const DEFAULT_SETTINGS: BasesToolboxSettings = {
  blockArrowAndWheel: true,
  digitsOnlyTyping: true,
  historyCap: null,
  multilineListCells: false,
  formatRules: [],
  allowedValues: {},
  propertyForks: [],
  removedForks: [],
  companionsFolder: "",
  companionExts: "",
  companionExcludeExts: "",
  companionVaultWide: false,
  companionFolders: "",
  companionAuto: false,
  ignoredFormatIssues: [],
  ignoredDuplicateGroups: [],
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
