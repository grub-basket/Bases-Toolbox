export interface ChangeRecord {
  path: string;
  property: string;
  /** Value before the change (the property always existed when recorded). */
  oldValue: unknown;
  /**
   * Value the operation wrote. Undefined only in entries migrated from the
   * pre-history format; those revert unconditionally.
   */
  newValue?: unknown;
}

export interface HistoryEntry {
  property: string;
  /** Display string of the value that was matched, or null for "all values". */
  find: string | null;
  replace: string;
  timestamp: number;
  changes: ChangeRecord[];
  /** Set once the entry has been reverted (even partially). */
  revertedAt?: number;
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
}

export const DEFAULT_SETTINGS: BasesToolboxSettings = {
  blockArrowAndWheel: true,
  digitsOnlyTyping: true,
  historyCap: null,
  multilineListCells: false,
};

export interface PluginData {
  settings: BasesToolboxSettings;
  history: HistoryEntry[];
}
