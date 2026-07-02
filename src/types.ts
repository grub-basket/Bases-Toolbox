export interface ChangeRecord {
  path: string;
  property: string;
  /** Value before the change (the property always existed when recorded). */
  oldValue: unknown;
}

export interface LastOperation {
  property: string;
  /** Display string of the value that was matched, or null for "all values". */
  find: string | null;
  replace: string;
  timestamp: number;
  changes: ChangeRecord[];
}

export interface BasesToolboxSettings {
  /** Swallow ArrowUp/ArrowDown and scroll-wheel spin on number property inputs. */
  blockArrowAndWheel: boolean;
  /** Swallow character keys other than digits, "." and "-" on number property inputs. */
  digitsOnlyTyping: boolean;
}

export const DEFAULT_SETTINGS: BasesToolboxSettings = {
  blockArrowAndWheel: true,
  digitsOnlyTyping: true,
};

export interface PluginData {
  settings: BasesToolboxSettings;
  lastOperation: LastOperation | null;
}
