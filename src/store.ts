import type BasesToolboxPlugin from "./main";
import type { HistoryEntry } from "./types";

/**
 * Split persistence: instead of one ever-growing data.json, each domain owns its
 * own JSON file under the plugin folder. Two problems this fixes:
 *
 *  1. Ballooning — history is unbounded by default, so data.json grew forever.
 *  2. Write amplification — `saveData()` rewrites the WHOLE blob, so toggling a
 *     checkbox rewrote every history entry too.
 *
 * Drift-proofing rules, deliberately conservative because this data is a user's
 * only undo record:
 *  - Every file is an envelope `{version, data}` so the shape can migrate later.
 *  - Files load INDEPENDENTLY: a missing file yields the default, and one bad
 *    file can never take down the others (or the plugin).
 *  - An unreadable/corrupt file is QUARANTINED (renamed to `.corrupt-<ts>`)
 *    rather than silently overwritten — nothing is ever destroyed.
 *  - Saves are per-file, so one domain can't clobber another's write.
 */

export const STORE_VERSION = 1;

interface Envelope<T> {
  version: number;
  data: T;
}

export class JsonStore<T> {
  constructor(
    private plugin: BasesToolboxPlugin,
    /** Path relative to the plugin folder, e.g. "history/merge.json". */
    private rel: string,
    private fallback: () => T
  ) {}

  private get adapter() {
    return this.plugin.app.vault.adapter;
  }

  /** Absolute-in-vault path of this store's file. */
  get path(): string {
    return `${this.plugin.manifest.dir}/${this.rel}`;
  }

  async exists(): Promise<boolean> {
    try {
      return await this.adapter.exists(this.path);
    } catch {
      return false;
    }
  }

  /** Never throws — a missing or broken file degrades to the default. */
  async load(): Promise<T> {
    try {
      if (!(await this.adapter.exists(this.path))) return this.fallback();
      const raw = await this.adapter.read(this.path);
      const env = JSON.parse(raw) as Envelope<T> | null;
      if (!env || typeof env !== "object" || !("data" in env)) throw new Error("bad envelope");
      return (env.data ?? this.fallback()) as T;
    } catch (e) {
      console.error(`[Bases Toolbox] Could not read ${this.rel}; quarantining it.`, e);
      await this.quarantine();
      return this.fallback();
    }
  }

  async save(value: T): Promise<void> {
    await this.ensureParent();
    const env: Envelope<T> = { version: STORE_VERSION, data: value };
    await this.adapter.write(this.path, JSON.stringify(env, null, 2));
  }

  /**
   * Renames an unreadable file aside instead of deleting/overwriting it, so a
   * corrupt history can still be recovered by hand.
   */
  private async quarantine(): Promise<void> {
    try {
      if (!(await this.adapter.exists(this.path))) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await this.adapter.rename(this.path, `${this.path}.corrupt-${stamp}`);
    } catch (e) {
      console.error(`[Bases Toolbox] Could not quarantine ${this.rel}.`, e);
    }
  }

  private async ensureParent(): Promise<void> {
    const parent = this.path.slice(0, this.path.lastIndexOf("/"));
    try {
      if (parent && !(await this.adapter.exists(parent))) await this.adapter.mkdir(parent);
    } catch {
      /* mkdir races are fine — the write below will surface a real failure */
    }
  }
}

/* ---------- chunked history ---------- */

/** Entries per history chunk file. Bounds the cost of a single append. */
export const HISTORY_CHUNK_SIZE = 250;

/**
 * A domain's undo history, stored as NUMBERED CHUNKS instead of one growing
 * array: `history/<domain>/0001.json`, `0002.json`, …
 *
 * Why chunks rather than a cap: capping means silently destroying a user's undo
 * record. Chunking keeps everything but bounds the write — appending only
 * rewrites the newest chunk, and editing an old entry (a revert sets
 * `revertedAt`) only rewrites the chunk holding it. This is the usual shape for
 * append-heavy logs. Append-only JSONL would give cheaper appends still, but
 * history entries are MUTATED on revert, which that format handles badly
 * without tombstones + compaction.
 *
 * Chunk membership is positional and therefore deterministic — entry N lives in
 * chunk floor(N / SIZE) — so nothing extra has to be tracked, and a per-chunk
 * dirty check means untouched chunks are never rewritten.
 */
export class HistoryChunkStore {
  /** Last-written JSON per chunk filename, so unchanged chunks are skipped. */
  private clean = new Map<string, string>();

  constructor(
    private plugin: BasesToolboxPlugin,
    private domain: string
  ) {}

  private get adapter() {
    return this.plugin.app.vault.adapter;
  }
  private get dir(): string {
    return `${this.plugin.manifest.dir}/history/${this.domain}`;
  }
  /** The pre-chunking single file (store split phase 1). */
  private get legacyPath(): string {
    return `${this.plugin.manifest.dir}/history/${this.domain}.json`;
  }

  private chunkName(i: number): string {
    return `${String(i + 1).padStart(4, "0")}.json`;
  }

  /** Reads every chunk (plus any legacy single file) in order. Never throws. */
  async load(): Promise<HistoryEntry[]> {
    const out: HistoryEntry[] = [];

    // Read the phase-1 single file, if present. It is NOT retired here — the
    // chunks must be written first (below), or a crash between the two would
    // leave the entries in neither place.
    let legacy: HistoryEntry[] | null = null;
    try {
      if (await this.adapter.exists(this.legacyPath)) {
        const env = JSON.parse(await this.adapter.read(this.legacyPath)) as { data?: HistoryEntry[] };
        legacy = env?.data ?? [];
        out.push(...legacy);
      }
    } catch (e) {
      console.error(`[Bases Toolbox] Could not read legacy history for ${this.domain}.`, e);
    }

    try {
      // NB: no early return when the folder is absent — the legacy
      // materialisation below still has to run on a first migration.
      if (await this.adapter.exists(this.dir)) {
        const listing = await this.adapter.list(this.dir);
        const chunks = listing.files.filter((f) => /\d+\.json$/.test(f)).sort();
        for (const path of chunks) {
          try {
            const env = JSON.parse(await this.adapter.read(path)) as { data?: HistoryEntry[] };
            if (Array.isArray(env?.data)) out.push(...env.data);
          } catch (e) {
            // One bad chunk must not lose the others — quarantine just that file.
            console.error(`[Bases Toolbox] Corrupt history chunk ${path}; quarantining.`, e);
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            await this.adapter.rename(path, `${path}.corrupt-${stamp}`).catch(() => undefined);
          }
        }
      }
    } catch (e) {
      console.error(`[Bases Toolbox] Could not read history chunks for ${this.domain}.`, e);
    }

    // Materialise the chunks BEFORE retiring the legacy file, so the entries are
    // never in-flight between the two representations.
    if (legacy) {
      try {
        await this.save(out);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await this.adapter.rename(this.legacyPath, `${this.legacyPath}.pre-chunk-${stamp}`);
      } catch (e) {
        console.error(`[Bases Toolbox] Could not chunk legacy history for ${this.domain}.`, e);
      }
    }
    return out;
  }

  /** Writes only the chunks whose contents actually changed. */
  async save(entries: HistoryEntry[]): Promise<void> {
    try {
      if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
    } catch {
      /* mkdir race — the writes below surface any real failure */
    }
    const chunks: HistoryEntry[][] = [];
    for (let i = 0; i < entries.length; i += HISTORY_CHUNK_SIZE) {
      chunks.push(entries.slice(i, i + HISTORY_CHUNK_SIZE));
    }
    if (!chunks.length) chunks.push([]); // keep one chunk so a clear persists

    for (let i = 0; i < chunks.length; i++) {
      const name = this.chunkName(i);
      const json = JSON.stringify({ version: STORE_VERSION, data: chunks[i] }, null, 2);
      if (this.clean.get(name) === json) continue;
      await this.adapter.write(`${this.dir}/${name}`, json);
      this.clean.set(name, json);
    }
    // If the history shrank (a clear), blank any now-surplus chunks rather than
    // deleting files — same effect on load, nothing removed from disk.
    let i = chunks.length;
    for (;;) {
      const name = this.chunkName(i);
      const path = `${this.dir}/${name}`;
      if (!(await this.adapter.exists(path))) break;
      const json = JSON.stringify({ version: STORE_VERSION, data: [] }, null, 2);
      if (this.clean.get(name) !== json) {
        await this.adapter.write(path, json);
        this.clean.set(name, json);
      }
      i++;
    }
  }
}

/* ---------- settings buckets ---------- */

/**
 * Settings fields that get their own file instead of living in data.json.
 *
 * The split happens at the PERSISTENCE layer only: `plugin.settings` keeps its
 * exact in-memory shape, so every existing reader/writer (`settings.formatRules`
 * and friends — ~67 call sites) is untouched. `savePluginData()` decomposes the
 * object on the way out and dirty-checks each bucket, so a settings toggle
 * rewrites data.json plus only the bucket that actually changed.
 *
 * Growth-prone or independently-edited data goes here; small scalars/flags stay
 * in data.json.
 */
export interface SettingsBucket {
  key: string;
  rel: string;
  /** Settings keys stored in this file. */
  fields: string[];
}

export const SETTINGS_BUCKETS: SettingsBucket[] = [
  // Conditional formatting gets its own folder — it's the most-edited feature
  // and the likeliest to grow more files later (per-base rule sets, palettes).
  { key: "cf", rel: "conditional-format/rules.json", fields: ["formatRules"] },
  { key: "allowed-values", rel: "allowed-values.json", fields: ["allowedValues"] },
  { key: "forks", rel: "forks.json", fields: ["propertyForks", "removedForks"] },
  // Ignore lists grow one entry per "ignore this" click.
  { key: "ignored", rel: "ignored.json", fields: ["ignoredFormatIssues", "ignoredDuplicateGroups"] },
  { key: "read-only", rel: "read-only.json", fields: ["readOnlyBases"] },
];

/* ---------- history domains ---------- */

/** The per-domain history files. One undo history per domain. */
export const HISTORY_DOMAINS = [
  "find-replace",
  "property-index",
  "bulk-edit",
  "merge",
  "fork",
  "format-doctor",
  "rollup",
  "inline-fields",
  "metadata-stamp",
  "other",
] as const;

export type HistoryDomain = (typeof HISTORY_DOMAINS)[number];

/**
 * Maps a history entry's free-text `source` to the file that owns it. Matching
 * is substring-based so existing sources ("property index delete", "property
 * index rename value", "fork of X", "convert in place") land in one domain
 * without needing every caller rewritten.
 */
export function historyDomain(source?: string | null): HistoryDomain {
  const s = (source ?? "").toLowerCase();
  if (s.includes("property index")) return "property-index";
  if (s.includes("bulk edit")) return "bulk-edit";
  if (s.includes("replace") || s.includes("find")) return "find-replace";
  if (s.includes("merge")) return "merge";
  if (s.includes("fork") || s.includes("convert in place")) return "fork";
  if (s.includes("doctor")) return "format-doctor";
  if (s.includes("rollup")) return "rollup";
  if (s.includes("inline")) return "inline-fields";
  if (s.includes("metadata") || s.includes("stamp")) return "metadata-stamp";
  return "other";
}
