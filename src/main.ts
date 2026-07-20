import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import { AllowedValuesAuditModal, anyPinViolations, installAllowedValuePicker } from "./allowed-values";
import { openBulkEdit } from "./bulk-edit";
import {
  CompanionNotesModal,
  MetadataStampModal,
  companionExistingFiles,
  installCompanionAuto,
  parseExts,
  vaultExtensions,
} from "./companion-notes";
import { installCellZoomTracking, openCellZoom } from "./cell-zoom";
import {
  CUSTOM_COLOR,
  DEFAULT_CUSTOM_HEX,
  FormatOp,
  FormatRule,
  FormatScope,
  OP_LABELS,
  RULE_COLORS,
  colorLabel,
  findDuplicateRule,
  installCfRowDrag,
  installConditionalFormatting,
  reorderRules,
  ruleSwatchColor,
  scheduleRedecorate,
  BaseScopeModal,
  VALUELESS_OPS,
} from "./conditional-format";
import { attachPropertySuggest, attachValueSuggest } from "./suggest";
import { exportBaseCsv } from "./csv-export";
import { CsvImportModal } from "./csv-import";
import { CsvImportView, VIEW_TYPE_CSV_IMPORT, openCsvImportView } from "./csv-import-view";
import { PropertiesModal, createNoteWithProperties, editActiveNoteProperties } from "./properties-modal";
import { CsvExportModal, CsvExportView, VIEW_TYPE_CSV_EXPORT, openCsvExportView } from "./csv-export-view";
import { installEmbedOptions } from "./embed-options";
import { generateEmbedReference } from "./embed-reference";
import { openFilterToggle } from "./filter-toggle";
import { openFormulaColumn } from "./formula-column";
import {
  ReadOnlyBasePicker,
  applyReadOnly,
  installReadOnly,
  toggleActiveBaseReadOnly,
  toggleAllBasesReadOnly,
} from "./read-only";
import { ConditionalFormatView, VIEW_TYPE_CONDITIONAL_FORMAT, openConditionalFormatView } from "./conditional-format-view";
import { LauncherView, VIEW_TYPE_LAUNCHER, openLauncher } from "./launcher";
import { FormatDoctorView, VIEW_TYPE_FORMAT_DOCTOR, openFormatDoctor } from "./format-doctor";
import { PropertySuggestModal } from "./find-replace";
import { FindReplaceView, VIEW_TYPE_FIND_REPLACE } from "./find-replace-view";
import { undoLatest } from "./history";
import {
  HISTORY_DOMAINS,
  HistoryChunkStore,
  HistoryDomain,
  JsonStore,
  SETTINGS_BUCKETS,
  SettingsBucket,
  historyDomain,
} from "./store";

/** disabledFilters lives in its own file too (it is not a settings field). */
const FILTERS_REL = "filters.json";
import { HistoryView, VIEW_TYPE_HISTORY, openHistoryView } from "./history-view";
import { InlineFieldMigratorModal } from "./inline-fields";
import { DuplicateFinderModal, DuplicateFinderView, VIEW_TYPE_DUPLICATE_FINDER, openDuplicateFinderView, startMerge } from "./merge";
import { installNumberGuard } from "./number-guard";
import { PropertyIndexView, VIEW_TYPE_PROPERTY_INDEX } from "./property-index";
import {
  ForkPropertyPicker,
  ForkRenameModal,
  TRANSFORM_LABELS,
  detectUnmanagedForks,
  installForkSync,
} from "./property-fork";
import { openRollup } from "./rollup";
import { PropertyCache } from "./scan";
import { BasesToolboxSettings, DEFAULT_SETTINGS, DisabledFilter, HistoryEntry, PluginData } from "./types";

export default class BasesToolboxPlugin extends Plugin {
  settings: BasesToolboxSettings = { ...DEFAULT_SETTINGS };
  history: HistoryEntry[] = [];
  disabledFilters: Record<string, DisabledFilter[]> = {};
  propertyCache: PropertyCache = new PropertyCache(this.app);
  /** Debounced re-decorate, set by installConditionalFormatting. */
  refreshConditionalFormatting?: () => void;
  /** The settings tab, so modals can refresh it live. Set when it mounts. */
  settingTab?: BasesToolboxSettingTab;
  /** The live "pinned values violated" toast, and whether it's currently up. */
  private pinNotice: Notice | null = null;
  /** True while the allowed-values audit modal is open — suppresses the toast
   * (the user is actively resolving violations; a toast reappearing behind the
   * modal reads as "stuck"). Reconciled once on close. */
  auditOpen = false;

  async onload(): Promise<void> {
    await this.loadPluginData();

    installNumberGuard(this);
    installEmbedOptions(this);
    installCellZoomTracking(this);
    installConditionalFormatting(this);
    installAllowedValuePicker(this);
    installForkSync(this);
    installCompanionAuto(this);
    installReadOnly(this);

    const dirty = () => this.propertyCache.markDirty();
    this.registerEvent(this.app.metadataCache.on("changed", dirty));
    this.registerEvent(this.app.metadataCache.on("deleted", dirty));
    this.registerEvent(this.app.vault.on("rename", dirty));

    // Warn (once, persistently) when a pinned property has out-of-list values,
    // with a one-click path to the audit. Re-checked as the vault changes.
    const checkPins = debounce(() => this.refreshPinViolationNotice(), 1500, false);
    this.app.workspace.onLayoutReady(() => this.refreshPinViolationNotice());
    this.registerEvent(this.app.metadataCache.on("resolved", () => checkPins()));

    // Right-click a note → edit its properties in the roomy form.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && file.extension === "md") {
          menu.addItem((item) =>
            item
              .setTitle("Edit properties (Bases Toolbox)")
              .setIcon("table-properties")
              .onClick(() => new PropertiesModal(this, { kind: "edit", file }).open())
          );
        }
      })
    );

    this.registerView(VIEW_TYPE_PROPERTY_INDEX, (leaf) => new PropertyIndexView(leaf, this));
    this.registerView(VIEW_TYPE_FIND_REPLACE, (leaf) => new FindReplaceView(leaf, this));
    this.registerView(VIEW_TYPE_HISTORY, (leaf) => new HistoryView(leaf, this));
    this.registerView(VIEW_TYPE_FORMAT_DOCTOR, (leaf) => new FormatDoctorView(leaf, this));
    this.registerView(VIEW_TYPE_CONDITIONAL_FORMAT, (leaf) => new ConditionalFormatView(leaf, this));
    this.registerView(VIEW_TYPE_LAUNCHER, (leaf) => new LauncherView(leaf, this));
    this.registerView(VIEW_TYPE_DUPLICATE_FINDER, (leaf) => new DuplicateFinderView(leaf, this));
    this.registerView(VIEW_TYPE_CSV_IMPORT, (leaf) => new CsvImportView(leaf, this));
    this.registerView(VIEW_TYPE_CSV_EXPORT, (leaf) => new CsvExportView(leaf, this));

    this.addCommand({
      id: "find-replace-property-values",
      name: "Find and replace property values",
      callback: () => new PropertySuggestModal(this).open(),
    });

    this.addCommand({
      id: "undo-last-find-replace",
      name: "Undo last change (find & replace, merge, etc.)",
      callback: () => void undoLatest(this),
    });

    this.addCommand({
      id: "find-replace-history",
      name: "Bulk file change history",
      callback: () => void openHistoryView(this),
    });

    this.addCommand({
      id: "fork-property",
      name: "Convert or fork a property's format",
      callback: () => new ForkPropertyPicker(this).open(),
    });

    this.addCommand({
      id: "format-doctor",
      name: "Property format doctor",
      callback: () => void openFormatDoctor(this),
    });

    this.addCommand({
      id: "audit-allowed-values",
      name: "Audit pinned allowed values",
      callback: () => new AllowedValuesAuditModal(this).open(),
    });

    this.addCommand({
      id: "compute-rollup",
      name: "Compute rollup into property",
      callback: () => openRollup(this),
    });

    this.addCommand({
      id: "migrate-inline-fields",
      name: "Migrate inline fields to properties",
      callback: () => new InlineFieldMigratorModal(this).open(),
    });

    this.addCommand({
      id: "merge-note",
      name: "Merge current note into another",
      callback: () => startMerge(this),
    });

    this.addCommand({
      id: "find-duplicates",
      name: "Find duplicate notes",
      callback: () => new DuplicateFinderModal(this).open(),
    });

    this.addCommand({
      id: "find-duplicates-tab",
      name: "Find duplicate notes (in a tab)",
      callback: () => void openDuplicateFinderView(this),
    });

    this.addCommand({
      id: "companion-notes",
      name: "Create companion notes for non-Markdown files",
      callback: () => new CompanionNotesModal(this).open(),
    });

    this.addCommand({
      id: "metadata-stamp",
      name: "Stamp file metadata into note properties",
      callback: () => new MetadataStampModal(this).open(),
    });

    this.addCommand({
      id: "import-csv",
      name: "Import CSV as notes (dialog)",
      callback: () => new CsvImportModal(this).open(),
    });

    this.addCommand({
      id: "open-csv-import",
      name: "Import CSV as notes (tab)",
      callback: () => void openCsvImportView(this),
    });

    this.addCommand({
      id: "edit-note-properties",
      name: "Edit properties of the active note",
      callback: () => editActiveNoteProperties(this),
    });

    this.addCommand({
      id: "new-note-with-properties",
      name: "New note with properties",
      callback: () => void createNoteWithProperties(this),
    });

    this.addCommand({
      id: "export-base-csv",
      name: "Export active base results as CSV",
      callback: () => void exportBaseCsv(this),
    });

    this.addCommand({
      id: "export-folder-csv",
      name: "Export a folder to CSV (dialog)",
      callback: () => new CsvExportModal(this).open(),
    });

    this.addCommand({
      id: "open-csv-export",
      name: "Export a folder to CSV (tab)",
      callback: () => void openCsvExportView(this),
    });

    this.addCommand({
      id: "bulk-edit-base-results",
      name: "Bulk edit properties of base results",
      callback: () => openBulkEdit(this),
    });

    this.addCommand({
      id: "zoom-into-cell",
      name: "Zoom into focused cell",
      callback: () => openCellZoom(this),
    });

    this.addCommand({
      id: "toggle-base-filters",
      name: "Toggle base filters",
      callback: () => openFilterToggle(this),
    });

    this.addCommand({
      id: "add-formula-column",
      name: "Add or fix a base formula column",
      callback: () => openFormulaColumn(this),
    });

    this.addCommand({
      id: "toggle-base-readonly",
      name: "Toggle read-only for this base",
      callback: () => toggleActiveBaseReadOnly(this),
    });

    this.addCommand({
      id: "toggle-all-bases-readonly",
      name: "Toggle read-only for all bases",
      callback: () => void toggleAllBasesReadOnly(this),
    });

    this.addCommand({
      id: "open-property-index",
      name: "Open property index",
      callback: () => void this.activatePropertyIndex(),
    });

    this.addCommand({
      id: "toggle-number-guard",
      name: "Toggle number guard (arrow keys & scroll wheel)",
      callback: () => void this.toggleSetting("blockArrowAndWheel", "Number guard"),
    });

    this.addCommand({
      id: "toggle-digits-only",
      name: "Toggle digits-only typing on number properties",
      callback: () => void this.toggleSetting("digitsOnlyTyping", "Digits-only typing"),
    });

    this.addCommand({
      id: "toggle-multiline-list-cells",
      name: "Toggle multiline list cells",
      callback: () =>
        void this.toggleSetting("multilineListCells", "Multiline list cells", () =>
          this.applyMultilineListCells()
        ),
    });

    this.addCommand({
      id: "open-settings",
      name: "Open Bases Toolbox settings",
      callback: () => this.openSettingsSection(),
    });

    this.addCommand({
      id: "open-conditional-formatting",
      name: "Open conditional formatting rules (settings)",
      callback: () => this.openSettingsSection("formatting"),
    });

    this.addCommand({
      id: "open-conditional-formatting-panel",
      name: "Open conditional formatting panel",
      callback: () => void openConditionalFormatView(this),
    });

    this.addCommand({
      id: "toggle-conditional-formatting",
      name: "Toggle conditional formatting (all rules)",
      callback: () => {
        this.settings.cfEnabled = !this.settings.cfEnabled;
        void this.savePluginData();
        scheduleRedecorate(this);
        new Notice(`Conditional formatting ${this.settings.cfEnabled ? "enabled" : "disabled"}.`);
      },
    });

    this.addCommand({
      id: "open-launcher",
      name: "Open Bases Toolbox launcher",
      callback: () => void openLauncher(this),
    });

    this.addRibbonIcon("wrench", "Bases Toolbox — launch a feature", () =>
      void openLauncher(this)
    );

    this.addRibbonIcon("table-properties", "Open property index", () =>
      void this.activatePropertyIndex()
    );

    this.addSettingTab(new BasesToolboxSettingTab(this.app, this));

    this.applyMultilineListCells();
  }

  onunload(): void {
    activeDocument.body.removeClass("bases-toolbox-multiline-lists");
    this.pinNotice?.hide();
    this.pinNotice = null;
  }

  /**
   * Keeps a single persistent toast in sync with pinned-value violations: shows
   * it (with an "Open audit" button) when any pinned property holds a value
   * outside its allowed list, and hides it once everything is back within the
   * lists. Only one toast at a time, so it never nags. Public so pin edits
   * (audit "Add to allowed", pin save/clear) can re-check immediately — those
   * change settings, not metadata, so the event-driven re-check wouldn't fire.
   */
  refreshPinViolationNotice(): void {
    // While the audit modal is open, never show the toast — the user is already
    // resolving violations there, and a toast popping up behind it looks stuck.
    if (this.auditOpen) {
      if (this.pinNotice) {
        this.pinNotice.hide();
        this.pinNotice = null;
      }
      return;
    }
    const violated = anyPinViolations(this);
    if (violated && !this.pinNotice) {
      const frag = createFragment((f) => {
        const wrap = f.createDiv({ cls: "bases-toolbox-pin-notice" });
        wrap.createDiv({
          text: "Bases Toolbox: some pinned properties have values outside their allowed list.",
        });
        const b = wrap.createEl("button", { text: "Open audit", cls: "mod-cta" });
        b.addEventListener("click", () => {
          new AllowedValuesAuditModal(this).open();
          this.pinNotice?.hide();
          this.pinNotice = null;
        });
      });
      this.pinNotice = new Notice(frag, 0);
    } else if (!violated && this.pinNotice) {
      this.pinNotice.hide();
      this.pinNotice = null;
    }
  }

  /**
   * Call after a settings-only pin change (audit "Add to allowed", pin
   * save/clear). Re-checks the violation toast AND re-renders any open property
   * index so its red pin icon updates — neither is driven by a metadata event.
   */
  refreshAfterPinChange(): void {
    this.refreshPinViolationNotice();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PROPERTY_INDEX)) {
      if (leaf.view instanceof PropertyIndexView) leaf.view.refreshNow();
    }
  }

  applyMultilineListCells(): void {
    activeDocument.body.toggleClass("bases-toolbox-multiline-lists", this.settings.multilineListCells);
  }

  /** Flips a boolean setting from a command, persists, and notifies. */
  async toggleSetting(
    key: "blockArrowAndWheel" | "digitsOnlyTyping" | "multilineListCells",
    label: string,
    after?: () => void
  ): Promise<void> {
    this.settings[key] = !this.settings[key];
    after?.();
    await this.savePluginData();
    new Notice(`${label}: ${this.settings[key] ? "on" : "off"}.`);
  }

  /**
   * Opens the plugin's settings tab, optionally scrolling a section into view
   * and flashing it. `app.setting` is undocumented but stable — probe defensively.
   */
  openSettingsSection(section?: string): void {
    const setting = (this.app as unknown as {
      setting?: { open: () => void; openTabById: (id: string) => void };
    }).setting;
    if (!setting) {
      new Notice("Couldn't open settings — open them manually and find Bases Toolbox.");
      return;
    }
    setting.open();
    setting.openTabById(this.manifest.id);
    if (!section) return;
    window.setTimeout(() => {
      const el = activeDocument.querySelector<HTMLElement>(`[data-bt-section="${section}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.addClass("bases-toolbox-flash");
      window.setTimeout(() => el.removeClass("bases-toolbox-flash"), 1600);
    }, 120);
  }

  async activatePropertyIndex(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROPERTY_INDEX)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf: WorkspaceLeaf | null = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_PROPERTY_INDEX, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /** Lazily-created per-domain history files (see src/store.ts). */
  private historyStores = new Map<HistoryDomain, HistoryChunkStore>();

  private historyStore(domain: HistoryDomain): HistoryChunkStore {
    let s = this.historyStores.get(domain);
    if (!s) {
      s = new HistoryChunkStore(this, domain);
      this.historyStores.set(domain, s);
    }
    return s;
  }

  /** Reads every domain file and merges them into one chronological list. */
  private async loadHistory(): Promise<HistoryEntry[]> {
    const all: HistoryEntry[] = [];
    for (const d of HISTORY_DOMAINS) all.push(...(await this.historyStore(d).load()));
    all.sort((a, b) => a.timestamp - b.timestamp);
    return all;
  }

  /** Rewrites the given domains from the in-memory list (others untouched). */
  private async saveHistoryDomains(domains: Iterable<HistoryDomain>): Promise<void> {
    const buckets = new Map<HistoryDomain, HistoryEntry[]>();
    for (const d of domains) buckets.set(d, []);
    for (const e of this.history) {
      const d = historyDomain(e.source);
      buckets.get(d)?.push(e);
    }
    for (const [d, entries] of buckets) await this.historyStore(d).save(entries);
  }

  /** Persists every history domain. Used for reverts/clears that can span files. */
  async saveHistory(): Promise<void> {
    await this.saveHistoryDomains(HISTORY_DOMAINS);
  }

  async addHistoryEntry(entry: HistoryEntry): Promise<void> {
    const before = this.history.length;
    this.history.push(entry);
    this.trimHistory();
    // A trim can drop entries from OTHER domains, so only the fast path (nothing
    // dropped) may write a single file.
    const trimmed = this.history.length !== before + 1;
    if (trimmed) await this.saveHistory();
    else await this.saveHistoryDomains([historyDomain(entry.source)]);
  }

  /** Drops the oldest entries when a cap is set. */
  trimHistory(): void {
    const cap = this.settings.historyCap;
    if (cap !== null && cap > 0 && this.history.length > cap)
      this.history = this.history.slice(-cap);
  }

  async clearHistory(): Promise<void> {
    this.history = [];
    await this.saveHistory();
  }

  private async loadPluginData(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData> & {
      lastOperation?: HistoryEntry | null;
    };
    this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    this.disabledFilters = data.disabledFilters ?? {};

    // History lives in per-domain files now. Load those first, then fold in any
    // legacy in-data.json history (and the even older single-undo slot) and
    // migrate it out — after backing data.json up, since this is the user's only
    // undo record.
    this.history = await this.loadHistory();
    const legacy = [...(data.history ?? []), ...(data.lastOperation ? [data.lastOperation] : [])];
    if (legacy.length) {
      await this.backupLegacyData();
      this.history = [...this.history, ...legacy].sort((a, b) => a.timestamp - b.timestamp);
      await this.saveHistory(); // write the split files BEFORE dropping the old copy
      await this.savePluginData(); // rewrites data.json without `history`
      console.log(`[Bases Toolbox] Migrated ${legacy.length} history entries out of data.json.`);
    }
    // Settings buckets (CF rules, allowed values, forks, ignore lists, read-only)
    // and disabled filters live in their own files. A bucket file WINS over the
    // legacy copy in data.json; when it's absent but data.json still carries the
    // fields, that's a pre-split install to migrate.
    let migrateBuckets = false;
    const legacySettings = (data.settings ?? {}) as Record<string, unknown>;
    for (const b of SETTINGS_BUCKETS) {
      const store = this.bucketStore(b.rel);
      if (await store.exists()) {
        const saved = await store.load();
        for (const f of b.fields) {
          if (f in saved && saved[f] !== undefined) {
            (this.settings as unknown as Record<string, unknown>)[f] = saved[f];
          }
        }
      } else if (b.fields.some((f) => legacySettings[f] !== undefined)) {
        migrateBuckets = true;
      }
      this.bucketClean.set(b.key, JSON.stringify(this.bucketPayload(b)));
    }
    const filtersStore = this.bucketStore(FILTERS_REL);
    if (await filtersStore.exists()) {
      this.disabledFilters = (await filtersStore.load()) as unknown as Record<string, DisabledFilter[]>;
    } else if (Object.keys(this.disabledFilters).length) {
      migrateBuckets = true;
    }
    this.bucketClean.set(FILTERS_REL, JSON.stringify(this.disabledFilters));
    if (migrateBuckets) {
      await this.backupLegacyData();
      // Force every bucket to write, then rewrite data.json without those fields.
      this.bucketClean.clear();
      await this.savePluginData();
      console.log("[Bases Toolbox] Migrated settings buckets out of data.json.");
    }

    // One-time: seed ".base" into the companion exclude list for existing users
    // (new installs already default to it). They can remove it afterwards — the
    // flag stops it coming back.
    if (!this.settings.companionBaseExclusionApplied) {
      const exts = parseExts(this.settings.companionExcludeExts);
      if (!exts.has("base")) {
        this.settings.companionExcludeExts =
          this.settings.companionExcludeExts.trim() === ""
            ? "base"
            : `${this.settings.companionExcludeExts.trim()}, base`;
      }
      this.settings.companionBaseExclusionApplied = true;
      await this.savePluginData();
    }
  }

  /** Lazily-created bucket files (CF rules, allowed values, forks, …). */
  private bucketStores = new Map<string, JsonStore<Record<string, unknown>>>();
  /** Last-written JSON per bucket, so unchanged buckets are skipped on save. */
  private bucketClean = new Map<string, string>();

  private bucketStore(rel: string): JsonStore<Record<string, unknown>> {
    let s = this.bucketStores.get(rel);
    if (!s) {
      s = new JsonStore<Record<string, unknown>>(this, rel, () => ({}));
      this.bucketStores.set(rel, s);
    }
    return s;
  }

  /** The slice of settings that a bucket owns. */
  private bucketPayload(b: SettingsBucket): Record<string, unknown> {
    const src = this.settings as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const f of b.fields) out[f] = src[f];
    return out;
  }

  /**
   * Writes data.json — core scalar settings ONLY. History lives in per-domain
   * files, and the growth-prone settings (CF rules, allowed values, forks,
   * ignore lists, read-only bases) plus disabled filters live in their own
   * bucket files, each written only when its contents actually changed. So the
   * ~50 callers of this (every settings toggle) stay valid but no longer rewrite
   * the undo record or unrelated data.
   */
  async savePluginData(): Promise<void> {
    const bucketFields = new Set(SETTINGS_BUCKETS.flatMap((b) => b.fields));
    const core: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.settings as unknown as Record<string, unknown>)) {
      if (!bucketFields.has(k)) core[k] = v;
    }
    await this.saveData({ settings: core } as unknown as PluginData);

    for (const b of SETTINGS_BUCKETS) {
      const payload = this.bucketPayload(b);
      const json = JSON.stringify(payload);
      if (this.bucketClean.get(b.key) === json) continue;
      await this.bucketStore(b.rel).save(payload);
      this.bucketClean.set(b.key, json);
    }
    const filtersJson = JSON.stringify(this.disabledFilters);
    if (this.bucketClean.get(FILTERS_REL) !== filtersJson) {
      await this.bucketStore(FILTERS_REL).save(
        this.disabledFilters as unknown as Record<string, unknown>
      );
      this.bucketClean.set(FILTERS_REL, filtersJson);
    }
  }

  /** One-time copy of the pre-split data.json, kept next to it (never deleted). */
  private async backupLegacyData(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      const src = `${this.manifest.dir}/data.json`;
      if (!(await adapter.exists(src))) return;
      const stamp = new Date().toISOString().slice(0, 10);
      const dest = `${this.manifest.dir}/data.backup-pre-split-${stamp}.json`;
      if (await adapter.exists(dest)) return; // already backed up today
      await adapter.write(dest, await adapter.read(src));
    } catch (e) {
      console.error("[Bases Toolbox] Could not back up data.json before the history split.", e);
    }
  }

  /**
   * Keep the two conditional-formatting editors in sync: a change made in one
   * (the settings tab or an open sidebar/tab panel) re-renders the OTHER so both
   * always show the same rules. `origin` is the surface that made the change; we
   * never re-render it (it either updated itself or the user is typing in it, so
   * re-rendering would steal focus). Debounced so per-keystroke edits don't thrash
   * the heavier settings re-render.
   */
  refreshCfUi = debounce((origin: "settings" | "panel"): void => {
    if (origin !== "settings") this.settingTab?.refreshIfOpen();
    if (origin !== "panel") {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CONDITIONAL_FORMAT)) {
        (leaf.view as ConditionalFormatView).render();
      }
    }
  }, 150);
}

class BasesToolboxSettingTab extends PluginSettingTab {
  private plugin: BasesToolboxPlugin;
  /** True while the tab is on screen — gates live re-renders from modals. */
  private mounted = false;

  constructor(app: App, plugin: BasesToolboxPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    plugin.settingTab = this;
  }

  hide(): void {
    this.mounted = false;
    super.hide();
  }

  /** Re-render only if the tab is currently open (e.g. after a fork is added). */
  refreshIfOpen(): void {
    if (this.mounted) this.display();
  }

  display(): void {
    const { containerEl } = this;
    this.mounted = true;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Block arrow-key and scroll-wheel changes")
      .setDesc(
        "Number properties (in frontmatter and Bases) no longer change value on ArrowUp/ArrowDown or the mouse wheel."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.blockArrowAndWheel).onChange(async (v) => {
          this.plugin.settings.blockArrowAndWheel = v;
          await this.plugin.savePluginData();
        })
      );

    new Setting(containerEl)
      .setName("Digits-only typing")
      .setDesc(
        'Number properties only accept digits, ".", "," and "-" — other character keys (like "e") are swallowed. Editing and shortcut keys still work.'
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.digitsOnlyTyping).onChange(async (v) => {
          this.plugin.settings.digitsOnlyTyping = v;
          await this.plugin.savePluginData();
        })
      );

    new Setting(containerEl)
      .setName("Multiline list cells")
      .setDesc(
        "In Bases table views, show list-property values stacked one per line instead of a single row of pills. Long lists scroll inside the cell — pair with the Bases row height option for taller rows."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.multilineListCells).onChange(async (v) => {
          this.plugin.settings.multilineListCells = v;
          this.plugin.applyMultilineListCells();
          // One-time nudge: stacking doesn't grow the (virtualized) row height,
          // so the list scrolls inside a short cell until the user raises Bases'
          // own row-height option. Point them there once, the first time they enable.
          if (v && !this.plugin.settings.multilineTipShown) {
            this.plugin.settings.multilineTipShown = true;
            new Notice(
              "Tip: raise the base's row height (Bases view options → row height) to see more of each stacked list.",
              8000
            );
          }
          await this.plugin.savePluginData();
        })
      );

    new Setting(containerEl)
      .setName("New-note blank properties")
      .setDesc(
        'How many empty property rows "New note with properties" starts with (when not launched from a base). 0–20.'
      )
      .addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.min = "0";
        t.inputEl.max = "20";
        t.setValue(String(this.plugin.settings.newNoteMinRows)).onChange(async (v) => {
          const n = Math.max(0, Math.min(20, Math.round(Number(v) || 0)));
          this.plugin.settings.newNoteMinRows = n;
          await this.plugin.savePluginData();
        });
      });

    new Setting(containerEl)
      .setName("Base embeds reference")
      .setDesc(
        "Generate a note in your vault documenting the base-embed display flags (bases-no-toolbar, bases-no-header, bt-height-<px>) with copy-paste examples. Packaged with the plugin — no internet needed."
      )
      .addButton((b) =>
        b.setButtonText("Generate reference note").onClick(() => void generateEmbedReference(this.plugin))
      );

    this.renderFormatRules(containerEl);

    // ---- Property forks (own section; heading always shows so the builder
    // has a clear home even before any fork exists) ----
    new Setting(containerEl)
      .setName("Property forks")
      .setDesc("Keep a second copy of a property in a different format (dates, wikilinks), recomputed live when the source changes.")
      .setHeading();

    new Setting(containerEl)
      .setName("Add a fork")
      .setDesc("Open the builder to convert or fork a property's format. Enable live sync there to manage it below.")
      .addButton((b) =>
        b.setButtonText("Fork builder…").setCta().onClick(() => new ForkPropertyPicker(this.plugin).open())
      );

    if (this.plugin.settings.propertyForks.length) {
      for (const def of [...this.plugin.settings.propertyForks]) {
        // Intuitive rename catch: if the source or target property no longer
        // exists in the vault, the fork is probably broken (a property rename
        // in the All Properties view rewrites keys but leaves the fork def
        // pointing at the old name). Flag it and offer a one-click fix.
        const sourceMissing = !this.plugin.propertyCache.usage(def.source);
        const targetMissing = !this.plugin.propertyCache.usage(def.target);
        const warn =
          def.ignoreWarning || (!sourceMissing && !targetMissing)
            ? ""
            : sourceMissing
              ? ` · ⚠ source “${def.source}” not found — renamed or removed?`
              : ` · ⚠ target “${def.target}” not found — a rename here means the fork recreates the old name`;
        const setting = new Setting(containerEl)
          .setName(`${def.source} → ${def.target}`)
          .setDesc(`${TRANSFORM_LABELS[def.transform]}${def.active === false ? " · paused" : ""}${warn}`);
        if (warn) setting.descEl.addClass("bases-toolbox-fr-warning");
        // Fix names inline (repoint a fork after a property rename).
        setting.addExtraButton((b) =>
          b
            .setIcon("pencil")
            .setTooltip("Edit source / target property names")
            .onClick(() => new ForkRenameModal(this.plugin, def, () => this.display()).open())
        );
        if (warn) {
          setting.addExtraButton((b) =>
            b
              .setIcon("bell-off")
              .setTooltip("Ignore this warning (the fork is fine as-is)")
              .onClick(() =>
                void (async () => {
                  def.ignoreWarning = true;
                  await this.plugin.savePluginData();
                  this.display();
                })()
              )
          );
        }
        setting.addToggle((t) =>
          t
            .setTooltip("Active — recompute the fork when the source changes")
            .setValue(def.active !== false)
            .onChange((v) =>
              void (async () => {
                def.active = v;
                await this.plugin.savePluginData();
                this.display();
              })()
            )
        );
        setting.addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("Delete (keeps existing property values; restorable below)")
            .onClick(() =>
              void (async () => {
                this.plugin.settings.propertyForks = this.plugin.settings.propertyForks.filter(
                  (d) => d !== def
                );
                this.plugin.settings.removedForks.unshift(def);
                this.plugin.settings.removedForks = this.plugin.settings.removedForks.slice(0, 20);
                await this.plugin.savePluginData();
                this.display();
              })()
            )
        );
      }
    }

    // Adopt fork-shaped properties that aren't tracked yet (e.g. forks made
    // before live-sync recording existed, or before the listing bug fix).
    const unmanaged = detectUnmanagedForks(this.plugin);
    if (unmanaged.length) {
      const adopt = async (defs: typeof unmanaged) => {
        for (const def of defs) this.plugin.settings.propertyForks.push({ ...def, active: true });
        await this.plugin.savePluginData();
        this.display();
      };
      new Setting(containerEl)
        .setName("Detected forks not yet managed")
        .setDesc(
          "Fork-shaped properties found in your vault that aren't tracked here. Adopt one to manage it — pause, edit, or keep it in live sync."
        )
        .setHeading()
        .addButton((b) =>
          b
            .setButtonText(`Adopt all (${unmanaged.length})`)
            .onClick(() => void adopt(unmanaged))
        );
      for (const def of unmanaged) {
        const count = this.plugin.propertyCache.usage(def.target)?.count ?? 0;
        new Setting(containerEl)
          .setName(`${def.source} → ${def.target}`)
          .setDesc(`${TRANSFORM_LABELS[def.transform]} · found in ${count} file${count === 1 ? "" : "s"}`)
          .addButton((b) =>
            b
              .setButtonText("Adopt")
              .setCta()
              .onClick(() => void adopt([def]))
          );
      }
    }

    // Restore deleted forks.
    if (this.plugin.settings.removedForks.length) {
      new Setting(containerEl).setName("Recently removed forks").setHeading();
      for (const def of [...this.plugin.settings.removedForks]) {
        new Setting(containerEl)
          .setName(`${def.source} → ${def.target}`)
          .setDesc(TRANSFORM_LABELS[def.transform])
          .addExtraButton((b) =>
            b
              .setIcon("rotate-ccw")
              .setTooltip("Restore this fork (re-adds it, active)")
              .onClick(() =>
                void (async () => {
                  this.plugin.settings.removedForks = this.plugin.settings.removedForks.filter(
                    (d) => d !== def
                  );
                  this.plugin.settings.propertyForks.push({ ...def, active: true });
                  await this.plugin.savePluginData();
                  this.display();
                })()
              )
          )
          .addExtraButton((b) =>
            b
              .setIcon("x")
              .setTooltip("Forget this removed fork")
              .onClick(() =>
                void (async () => {
                  this.plugin.settings.removedForks = this.plugin.settings.removedForks.filter(
                    (d) => d !== def
                  );
                  await this.plugin.savePluginData();
                  this.display();
                })()
              )
          );
      }
    }

    const pinned = Object.entries(this.plugin.settings.allowedValues);
    if (pinned.length) {
      new Setting(containerEl)
        .setName("Pinned allowed values")
        .setDesc("Properties whose values are restricted to a pinned list (pin more from the property index).")
        .setHeading();
      for (const [prop, values] of pinned) {
        new Setting(containerEl)
          .setName(prop)
          .setDesc(`${values.length} allowed: ${values.slice(0, 8).join(", ")}${values.length > 8 ? "…" : ""}`)
          .addExtraButton((b) =>
            b
              .setIcon("trash")
              .setTooltip("Remove pin")
              .onClick(() =>
                void (async () => {
                  delete this.plugin.settings.allowedValues[prop];
                  await this.plugin.savePluginData();
                  this.display();
                })()
              )
          );
      }
    }

    new Setting(containerEl)
      .setName("Read-only bases")
      .setDesc("Lock bases so their cells can't be edited (guards against accidental edits/deletes). Links and the date-picker stay clickable.")
      .setHeading();

    new Setting(containerEl)
      .setName("Make all bases read-only")
      .setDesc("When on, every base is read-only. When off, only the bases listed below are.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.readOnlyAllBases).onChange(async (v) => {
          this.plugin.settings.readOnlyAllBases = v;
          await this.plugin.savePluginData();
          applyReadOnly(this.plugin);
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Also prevent adding rows")
      .setDesc("On read-only bases, also hide the toolbar “New” button so rows can't be added. Off = read-only locks editing but rows can still be appended.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.readOnlyBlockNewRow).onChange(async (v) => {
          this.plugin.settings.readOnlyBlockNewRow = v;
          await this.plugin.savePluginData();
          applyReadOnly(this.plugin);
        })
      );

    if (!this.plugin.settings.readOnlyAllBases) {
      const roList = this.plugin.settings.readOnlyBases;
      new Setting(containerEl)
        .setName("Individually read-only bases")
        .setDesc(roList.length ? "" : "None yet \u2014 add one to lock just that base.")
        .addButton((b) =>
          b
            .setButtonText("Add a base\u2026")
            .onClick(() => new ReadOnlyBasePicker(this.plugin, () => this.display()).open())
        );
      for (const path of [...roList]) {
        const exists = this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFile;
        new Setting(containerEl)
          .setName(path)
          .setDesc(exists ? "" : "\u26a0 this .base no longer exists")
          .addExtraButton((b) =>
            b
              .setIcon("x")
              .setTooltip("Make editable again (remove from read-only)")
              .onClick(async () => {
                this.plugin.settings.readOnlyBases = this.plugin.settings.readOnlyBases.filter((p) => p !== path);
                await this.plugin.savePluginData();
                applyReadOnly(this.plugin);
                this.display();
              })
          );
      }
    }

    new Setting(containerEl)
      .setName("Companion notes")
      .setDesc("Companions make non-Markdown files queryable in Bases. Run via the command \u201cCreate companion notes for non-Markdown files\u201d.")
      .setHeading();

    new Setting(containerEl)
      .setName("Companion destination")
      .setDesc("Empty = companions live adjacent to their files. A folder path collects them there instead (mirroring the source structure).")
      .addText((t) => {
        t.setPlaceholder("(adjacent)");
        t.setValue(this.plugin.settings.companionsFolder);
        t.onChange(async (v) => {
          this.plugin.settings.companionsFolder = v.trim().replace(/^\/+|\/+$/g, "");
          await this.plugin.savePluginData();
        });
      });

    new Setting(containerEl)
      .setName("Whole vault")
      .setDesc("Auto mode companions every eligible file in the vault. Off by default — scope to folders below instead.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.companionVaultWide).onChange(async (v) => {
          this.plugin.settings.companionVaultWide = v;
          await this.plugin.savePluginData();
        })
      );

    new Setting(containerEl)
      .setName("Companion folders")
      .setDesc("Auto mode only companions files under these folders (one path per line). Ignored when Whole vault is on.")
      .addTextArea((t) => {
        t.setPlaceholder("Attachments\nProjects/assets");
        t.setValue(this.plugin.settings.companionFolders);
        t.onChange(async (v) => {
          this.plugin.settings.companionFolders = v;
          await this.plugin.savePluginData();
        });
      });

    this.renderCompanionExtensions(containerEl);

    new Setting(containerEl)
      .setName("Auto-create companions for new files")
      .setDesc("When a non-excluded file is added to the vault, its companion is created automatically. Turning this on also companions eligible files that already exist.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.companionAuto).onChange((v) =>
          void (async () => {
            this.plugin.settings.companionAuto = v;
            await this.plugin.savePluginData();
            if (v) {
              const n = await companionExistingFiles(this.plugin);
              new Notice(
                n
                  ? `Auto companions on. Companioned ${n} existing file${n === 1 ? "" : "s"}.`
                  : "Auto companions on."
              );
            }
          })()
        )
      );

    new Setting(containerEl)
      .setName("History cap")
      .setDesc(
        "Max operations to keep in the change history. Leave empty for no cap. Lowering it drops the oldest entries immediately."
      )
      .addText((t) => {
        t.setPlaceholder("No cap");
        t.setValue(this.plugin.settings.historyCap?.toString() ?? "");
        t.onChange(async (v) => {
          const trimmed = v.trim();
          const n = Number(trimmed);
          if (trimmed !== "" && (!Number.isInteger(n) || n < 1)) return; // ignore invalid input
          this.plugin.settings.historyCap = trimmed === "" ? null : n;
          this.plugin.trimHistory();
          await this.plugin.savePluginData();
        });
      });

    new Setting(containerEl)
      .setName("Clear change history")
      .setDesc("Removes all logged operations. Reverting them is no longer possible.")
      .addButton((b) => {
        const label = () =>
          `Clear (${this.plugin.history.length} entr${this.plugin.history.length === 1 ? "y" : "ies"})`;
        let armed = false;
        b.setButtonText(label()).onClick(async () => {
          if (!armed) {
            armed = true;
            b.setButtonText("Click again to confirm");
            b.buttonEl.addClass("mod-warning");
            return;
          }
          await this.plugin.clearHistory();
          armed = false;
          b.setButtonText(label());
          b.buttonEl.removeClass("mod-warning");
        });
      });

    this.renderReference(containerEl);
  }

  /**
   * A full, in-app catalogue of everything the plugin offers — commands,
   * panels, and automatic features — so users never have to leave Obsidian to
   * discover what's here. Collapsed by default to keep settings tidy.
   */
  private renderReference(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Reference").setHeading();
    const details = containerEl.createEl("details", { cls: "bases-toolbox-ref" });
    details.createEl("summary", {
      text: "Everything in Bases Toolbox — commands, panels & features",
    });

    const groups: { title: string; note?: string; items: [string, string][] }[] = [
      {
        title: "Panels & tabs",
        note: "Open from the launcher (ribbon), the command palette, or the commands below. Each can live in the sidebar or a tab — use the tab-header actions to move it.",
        items: [
          ["Property index", "An always-complete, searchable list of every frontmatter property in your vault — each value it takes and the files using that value — so you can review, rename, delete, pin allowed values, or open the files. Unlike the Bases filter dropdown it never “forgets” a property. Also on the left ribbon (table icon)."],
          ["Find & replace", "Change a property's values across the whole vault: pick the property, pick one value (or “all values”), preview exactly which files change (old → new) as a checklist, and apply only the ones you check. An empty replacement clears the value."],
          ["Bulk file change history", "A log of every change these tools make — find & replace, merges, format fixes, property removals, and so on. Expand an entry to see the per-file before → after, then revert it — all of it, or just the files you pick (with an option to force-overwrite files that were edited since)."],
          ["Property format doctor", "Finds values that don't match their property's assigned type — e.g. a date property holding “March 4, 2024”, or an aliases property holding a bare word — shows a suggested fix you can edit, and applies only what you check. Nothing is ever erased. Ignore any you're happy to leave as-is (it re-flags if the value later changes)."],
          ["Conditional formatting", "Color Bases rows or cells by their values, using rules you define — e.g. color a row red when Status = “blocked”, or highlight duplicate values. Manage the rules in a side panel or in settings; the panel pops out to its own tab."],
        ],
      },
      {
        title: "Commands",
        note: "Run from the command palette (Cmd/Ctrl-P), or the launcher.",
        items: [
          ["Find and replace property values", "Opens the Find & Replace tab (see above)."],
          ["Undo last change", "Reverts the most recent change made by these tools — find & replace, a merge, format fixes, and so on. (Everything is also individually revertible from the History tab.)"],
          ["Convert or fork a property's format", "Bases expects dates as YYYY-MM-DD and links as [[wikilinks]], but you might store them differently. This normalizes dates or (un)wraps wikilinks — either in place, or into a SECOND property that stays in sync with the original, so you keep your format AND the one Bases wants."],
          ["Audit pinned allowed values", "You can “pin” the set of values a property is allowed to have (from the property index). This lists any value currently outside that set and lets you fix it (find & replace) or accept it (add to the allowed list)."],
          ["Compute rollup into property", "For each note in the open base, gathers the notes linked to it (incoming or outgoing) and aggregates them — count of linked notes, or sum / average / min / max of a number property on them — writing the result into a property you name. E.g. give every Project a “task-count” of the Tasks that link to it, or a “total-hours”. One-shot and revertible; re-run to refresh."],
          ["Migrate inline fields to properties", "Converts inline “key:: value” fields written in a note's body into real frontmatter properties that Bases can use."],
          ["Merge current note into another", "Combines the current note — its body and its properties — into another note you pick, then tidies up (re-points links, trashes the source). Recorded to History, so the whole merge can be reverted."],
          ["Find duplicate notes", "Finds notes that are near-duplicates of each other (by a heuristic you can tune) so you can merge them. Pick which note to keep; the rest merge into it with their bodies combined in creation-date order. Each merge is revertible from History."],
          ["Create companion notes for non-Markdown files", "Bases can only query Markdown notes. This creates a small Markdown “companion” beside a PDF/image/etc. that mirrors the file's metadata as properties, so those files appear in Bases."],
          ["Stamp file metadata into note properties", "Writes the file's created/modified dates into frontmatter so they're durable (survive sync/export) and usable in Bases."],
          ["Import CSV as notes", "Turns each row of a CSV into a note, with the columns becoming frontmatter properties."],
          ["Export base results as CSV", "Exports the rows the open base currently shows to a CSV file."],
          ["Bulk edit properties of base results", "Set, append to, remove from, or clear a property across every note the open base returns — in one action."],
          ["Zoom into focused cell", "Opens a large editor for the Bases cell you're on, for comfortable editing of long values."],
          ["Toggle base filters", "Temporarily disable (and later re-enable) a base's filters without editing the .base file."],
          ["Toggle read-only for this base / all bases", "Lock a base (or every base) so its cells can't be edited — guards against accidental edits and deletes. Links and the date-picker stay clickable. Manage the list under Settings → Read-only bases."],
          ["Add or fix a base formula column", "Add a computed (formula) column to a base by writing it into the .base file, and repair Obsidian's empty-formula glitch — a blank formula the Bases UI locks you out of editing. Never writes an empty formula."],
          ["Toggle number guard", "Stops number properties from changing when you accidentally press arrow keys or scroll over them."],
          ["Toggle digits-only typing", "On number properties, ignores keystrokes that aren't digits, so a stray letter can't sneak in."],
          ["Toggle multiline list cells", "In Bases tables, stacks a list property's values one per line instead of a single row of pills."],
          ["Open Bases Toolbox launcher / property index / settings", "Shortcuts that open the launcher, the property index, or these settings."],
          ["Open conditional formatting rules / panel", "Jump to the rules editor here in settings, or open the manager as a side panel."],
        ],
      },
      {
        title: "Bases built-in properties (add these when the picker “forgets” them)",
        note: "Obsidian's Bases property menu sometimes drops the built-in file attributes. They are NOT formulas — re-add one by its identifier: in a table view open the column/property menu and pick it under “File”, or edit the .base file's `order:` list and type the identifier. For a formatted or computed column (e.g. a readable date), make a formula instead — add a block like `formulas:` then `created: file.ctime`, and reference it as `formula.created`. Bases Toolbox's “Add or fix a base formula column” command writes these for you (and repairs the empty-formula glitch), and — while the base is open — embeds Obsidian's own formula editor for autocomplete + live validation. The Formula Forge community plugin is complementary — reusable global functions + rendering formulas in note bodies.",
        items: [
          ["file.name", "the note's name (without extension)"],
          ["file.ext", "file extension"],
          ["file.path · file.folder", "full path · containing folder path"],
          ["file.size", "file size in bytes"],
          ["file.ctime · file.mtime", "created time · modified time"],
          ["file.tags", "every tag in the note (frontmatter + body)"],
          ["file.links · file.backlinks · file.embeds", "outgoing links · backlinks · embeds"],
          ["file.properties", "all frontmatter properties on the file"],
          [
            "Recipe — XLOOKUP (look up a linked note's value)",
            "If a property links to another note, a formula can pull that note's property in — like Excel's XLOOKUP. Simple names: `linkProp.asFile().properties.otherProp`. Names with spaces/symbols: `note[\"Account\"].asFile().properties[\"Account Holder Name\"]`. Add it under `formulas:` and reference as `formula.<name>`. (A plain Bases formula, not a plugin feature.)",
          ],
        ],
      },
      {
        title: "Automatic features",
        note: "Active in the background once enabled — no command needed.",
        items: [
          ["Conditional formatting", "Applies your coloring rules to Bases rows/cells live as the table renders."],
          ["Number guard & digits-only typing", "Protects number properties from accidental edits — arrow keys, scroll wheel, and stray non-digit keys."],
          ["Multiline list cells", "Shows a list property's values stacked vertically in Bases tables (toggle above)."],
          ["Allowed-value dropdowns", "When you pin a set of allowed values to a property, editing that property offers them as a pick-list."],
          ["Property forks (live sync)", "A forked property automatically recomputes whenever its source property changes, keeping the two formats in sync."],
          ["Embed options", "Display flags for embedded bases — e.g. ![[My Base.base|bases-no-toolbar]] hides the toolbar, |bases-no-header hides the header."],
          ["Auto companions", "When enabled, any new non-Markdown file added to your vault (or a chosen folder) automatically gets a companion note."],
        ],
      },
    ];

    for (const g of groups) {
      details.createEl("div", { cls: "bases-toolbox-ref-group", text: g.title });
      if (g.note) details.createEl("div", { cls: "bases-toolbox-ref-note", text: g.note });
      const list = details.createDiv({ cls: "bases-toolbox-ref-list" });
      for (const [term, desc] of g.items) {
        const item = list.createDiv({ cls: "bases-toolbox-ref-item" });
        item.createEl("strong", { text: term });
        item.createSpan({ text: ` — ${desc}` });
      }
    }
  }

  private saveAndPaint(): void {
    void this.plugin.savePluginData();
    scheduleRedecorate(this.plugin);
    this.plugin.refreshCfUi("settings"); // mirror into any open CF panel
  }

  private renderFormatRules(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Conditional formatting")
      .setDesc("Color Bases rows or cells by property value. Rules apply top to bottom; the first match wins (per row, and per cell).")
      .setHeading()
      .settingEl.setAttribute("data-bt-section", "formatting");

    new Setting(containerEl)
      .setName("Enable conditional formatting")
      .setDesc("Master switch. Turn off to suspend every rule at once (nothing is deleted) and clear all applied colors.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.cfEnabled).onChange((v) => {
          this.plugin.settings.cfEnabled = v;
          this.saveAndPaint();
        })
      );

    const rules = this.plugin.settings.formatRules;
    const list = containerEl.createDiv({ cls: "bases-toolbox-cf-list" });
    if (!rules.length) {
      list.createDiv({ cls: "bases-toolbox-fr-info", text: "No rules yet — add one below." });
    }
    rules.forEach((rule, i) => this.renderRuleRow(list, rule, i));
    this.renderAddRule(containerEl);
  }

  private renderRuleRow(list: HTMLElement, rule: FormatRule, index: number): void {
    const rules = this.plugin.settings.formatRules;
    const row = list.createDiv({ cls: "bases-toolbox-cf-rule" });

    const grip = row.createSpan({ cls: "bases-toolbox-cf-grip", attr: { "aria-label": "Drag to reorder" } });
    setIcon(grip, "grip-vertical");
    installCfRowDrag(row, grip, index, rules.length, (from, to) => {
      reorderRules(rules, from, to);
      this.saveAndPaint();
      this.display();
    });
    // Up/down stacked into a column on the left of the row.
    const reorderStack = row.createDiv({ cls: "bases-toolbox-cf-reorder" });

    const swatch = row.createDiv({ cls: "bases-toolbox-cf-swatch" });
    const paintSwatch = () => swatch.setCssStyles({ backgroundColor: ruleSwatchColor(rule) });
    paintSwatch();

    const name = row.createEl("input", {
      type: "text",
      cls: "bases-toolbox-cf-name",
      attr: { placeholder: "name", "aria-label": "Rule name (optional)" },
    });
    name.value = rule.name ?? "";
    name.addEventListener("input", () => {
      rule.name = name.value.trim() || undefined;
      this.saveAndPaint();
    });

    const prop = row.createEl("input", {
      type: "text",
      cls: "bases-toolbox-cf-prop",
      attr: { placeholder: "property" },
    });
    prop.value = rule.property;
    attachPropertySuggest(this.plugin, prop);
    prop.addEventListener("input", () => {
      rule.property = prop.value.trim();
      this.saveAndPaint();
    });

    const op = row.createEl("select", { cls: "dropdown bases-toolbox-cf-op" });
    for (const [k, label] of Object.entries(OP_LABELS)) op.createEl("option", { value: k, text: label });
    op.value = rule.op;

    const val = row.createEl("input", {
      type: "text",
      cls: "bases-toolbox-cf-val",
      attr: { placeholder: "value" },
    });
    val.value = rule.value;
    attachValueSuggest(this.plugin, val, () => rule.property);
    const syncVal = () =>
      val.setCssStyles({ display: VALUELESS_OPS.has(rule.op) ? "none" : "" });
    syncVal();
    op.addEventListener("change", () => {
      rule.op = op.value as FormatOp;
      syncVal();
      this.saveAndPaint();
    });
    val.addEventListener("input", () => {
      rule.value = val.value;
      this.saveAndPaint();
    });

    const scope = row.createEl("select", { cls: "dropdown bases-toolbox-cf-scope" });
    scope.createEl("option", { value: "row", text: "Row" });
    scope.createEl("option", { value: "cell", text: "Cell" });
    scope.value = rule.scope ?? "row";
    scope.addEventListener("change", () => {
      rule.scope = scope.value as FormatScope;
      this.saveAndPaint();
    });

    // Which sheets (bases) this rule applies to — all, or a chosen subset.
    const sheetsBtn = row.createEl("button", { cls: "bases-toolbox-cf-sheets" });
    const sheetLabel = () =>
      rule.bases?.length ? `${rule.bases.length} sheet${rule.bases.length === 1 ? "" : "s"}` : "All sheets";
    sheetsBtn.setText(sheetLabel());
    sheetsBtn.setAttribute("aria-label", "Choose which bases this rule applies to");
    sheetsBtn.addEventListener("click", () => {
      new BaseScopeModal(this.plugin, rule.bases ?? [], (sel) => {
        rule.bases = sel.length ? sel : undefined;
        sheetsBtn.setText(sheetLabel());
        this.saveAndPaint();
      }).open();
    });

    const color = row.createEl("select", { cls: "dropdown bases-toolbox-cf-colorsel" });
    for (const c of Object.keys(RULE_COLORS)) color.createEl("option", { value: c, text: colorLabel(c) });
    color.createEl("option", { value: CUSTOM_COLOR, text: colorLabel(CUSTOM_COLOR) });
    color.value = rule.color;

    const custom = row.createEl("input", { type: "color", cls: "bases-toolbox-color-input" });
    custom.value = rule.customColor ?? DEFAULT_CUSTOM_HEX;
    const syncCustom = () =>
      custom.setCssStyles({ display: rule.color === CUSTOM_COLOR ? "" : "none" });
    syncCustom();
    color.addEventListener("change", () => {
      rule.color = color.value;
      syncCustom();
      paintSwatch();
      this.saveAndPaint();
    });
    custom.addEventListener("input", () => {
      rule.customColor = custom.value;
      paintSwatch();
      this.saveAndPaint();
    });

    const enabled = row.createEl("input", { type: "checkbox", cls: "bases-toolbox-cf-enabled" });
    enabled.checked = rule.enabled;
    enabled.setAttribute("aria-label", "Enable rule");
    enabled.addEventListener("change", () => {
      rule.enabled = enabled.checked;
      this.saveAndPaint();
    });

    const mkBtn = (
      icon: string,
      label: string,
      disabled: boolean,
      fn: () => void,
      parent: HTMLElement = row,
      extraCls = ""
    ) => {
      const b = parent.createEl("button", {
        cls: `bases-toolbox-cf-btn clickable-icon ${extraCls}`.trim(),
        attr: { "aria-label": label },
      });
      setIcon(b, icon);
      b.disabled = disabled;
      b.addEventListener("click", fn);
    };
    mkBtn("chevron-up", "Move up", index === 0, () => {
      [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]];
      this.saveAndPaint();
      this.display();
    }, reorderStack);
    mkBtn("chevron-down", "Move down", index === rules.length - 1, () => {
      [rules[index + 1], rules[index]] = [rules[index], rules[index + 1]];
      this.saveAndPaint();
      this.display();
    }, reorderStack);
    mkBtn("copy", "Duplicate rule", false, () => {
      rules.splice(index + 1, 0, { ...rule, id: `${Date.now()}-${rules.length}` });
      this.saveAndPaint();
      this.display();
    });
    mkBtn("trash", "Delete rule", false, () => {
      this.plugin.settings.formatRules = rules.filter((r) => r !== rule);
      this.saveAndPaint();
      this.display();
    }, row, "bases-toolbox-cf-trash");

    // Flag a rule that duplicates the condition of an earlier one (redundant).
    const dupOf = findDuplicateRule(rules, rule, index);
    if (dupOf !== -1 && dupOf < index) {
      row.addClass("bases-toolbox-cf-dup");
      const msg = `Duplicate condition — same as rule #${dupOf + 1} above`;
      row.setAttribute("aria-label", msg);
      row.setAttribute("title", msg);
    }
  }

  private renderCompanionExtensions(containerEl: HTMLElement): void {
    const excluded = parseExts(this.plugin.settings.companionExcludeExts);
    const setExcluded = async (next: Set<string>) => {
      this.plugin.settings.companionExcludeExts = [...next].sort().join(", ");
      await this.plugin.savePluginData();
      this.display();
    };

    // Add-to-blacklist text box.
    let addEl: HTMLInputElement | null = null;
    const add = () => {
      const v = (addEl?.value ?? "").trim().toLowerCase().replace(/^\./, "");
      if (!v) return;
      excluded.add(v);
      void setExcluded(excluded);
    };
    new Setting(containerEl)
      .setName("Excluded extensions")
      .setDesc("Companions are created for every non-Markdown file EXCEPT these extensions. Click a chip to remove it; click a detected extension below to exclude it.")
      .addText((t) => {
        t.setPlaceholder(".tmp");
        addEl = t.inputEl;
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        });
      })
      .addExtraButton((b) => b.setIcon("plus").setTooltip("Exclude this extension").onClick(add));

    // Excluded chips (X to remove).
    const exclDiv = containerEl.createDiv({ cls: "bases-toolbox-chips" });
    if (!excluded.size) {
      exclDiv.createSpan({ cls: "bases-toolbox-chips-empty", text: "Nothing excluded — every non-Markdown file gets a companion." });
    } else {
      for (const ext of [...excluded].sort()) {
        const chip = exclDiv.createSpan({ cls: "bases-toolbox-chip" });
        chip.createSpan({ text: `.${ext}` });
        setIcon(chip.createSpan({ cls: "bases-toolbox-chip-icon" }), "x");
        chip.setAttribute("aria-label", `Stop excluding .${ext}`);
        chip.addEventListener("click", () => {
          excluded.delete(ext);
          void setExcluded(excluded);
        });
      }
    }

    // Detected extensions in the vault (not excluded) — click to exclude.
    const detected = vaultExtensions(this.plugin).filter((e) => !excluded.has(e));
    new Setting(containerEl)
      .setName("Extensions in your vault")
      .setDesc("Non-Markdown file types found in this vault. Click one to exclude it from companioning.");
    const detDiv = containerEl.createDiv({ cls: "bases-toolbox-chips" });
    if (!detected.length) {
      detDiv.createSpan({ cls: "bases-toolbox-chips-empty", text: "None (or all are already excluded)." });
    } else {
      for (const ext of detected) {
        const chip = detDiv.createSpan({ cls: "bases-toolbox-chip bases-toolbox-chip-muted" });
        chip.createSpan({ text: `.${ext}` });
        setIcon(chip.createSpan({ cls: "bases-toolbox-chip-icon" }), "plus");
        chip.setAttribute("aria-label", `Exclude .${ext}`);
        chip.addEventListener("click", () => {
          excluded.add(ext);
          void setExcluded(excluded);
        });
      }
    }
  }

  private renderAddRule(containerEl: HTMLElement): void {
    // A custom flex row (matching the rule rows) instead of a Setting — the
    // Setting name column truncates to "A… r…" once the controls get wide.
    const row = containerEl.createDiv({ cls: "bases-toolbox-cf-rule bases-toolbox-cf-add" });
    row.createSpan({ cls: "bases-toolbox-cf-addlabel", text: "Add formatting rule" });

    const propEl = row.createEl("input", {
      type: "text",
      cls: "bases-toolbox-cf-prop",
      attr: { placeholder: "property" },
    });
    attachPropertySuggest(this.plugin, propEl);
    const opEl = row.createEl("select", { cls: "dropdown bases-toolbox-cf-op" });
    for (const [k, label] of Object.entries(OP_LABELS)) opEl.createEl("option", { value: k, text: label });
    const valEl = row.createEl("input", {
      type: "text",
      cls: "bases-toolbox-cf-val",
      attr: { placeholder: "value" },
    });
    attachValueSuggest(this.plugin, valEl, () => propEl.value.trim());
    const scopeEl = row.createEl("select", { cls: "dropdown bases-toolbox-cf-scope" });
    scopeEl.createEl("option", { value: "row", text: "Row" });
    scopeEl.createEl("option", { value: "cell", text: "Cell" });
    const colorEl = row.createEl("select", { cls: "dropdown bases-toolbox-cf-colorsel" });
    for (const c of Object.keys(RULE_COLORS)) colorEl.createEl("option", { value: c, text: colorLabel(c) });
    colorEl.createEl("option", { value: CUSTOM_COLOR, text: colorLabel(CUSTOM_COLOR) });
    const customEl = row.createEl("input", { type: "color", cls: "bases-toolbox-color-input" });
    customEl.value = DEFAULT_CUSTOM_HEX;
    customEl.setCssStyles({ display: "none" });
    colorEl.addEventListener("change", () =>
      customEl.setCssStyles({ display: colorEl.value === CUSTOM_COLOR ? "" : "none" })
    );

    const addBtn = row.createEl("button", { cls: "mod-cta", text: "Add" });
    addBtn.addEventListener("click", () => {
      const property = propEl.value.trim();
      if (!property) return;
      const colorKey = colorEl.value;
      const candidate: FormatRule = {
        id: `${Date.now()}-${this.plugin.settings.formatRules.length}`,
        property,
        op: opEl.value as FormatOp,
        value: valEl.value,
        scope: scopeEl.value as FormatScope,
        color: colorKey,
        ...(colorKey === CUSTOM_COLOR ? { customColor: customEl.value } : {}),
        enabled: true,
      };
      // Refuse an exact-condition duplicate of an existing rule.
      const dup = findDuplicateRule(this.plugin.settings.formatRules, candidate);
      if (dup !== -1) {
        new Notice(`That condition already exists (rule #${dup + 1}).`);
        return;
      }
      this.plugin.settings.formatRules.push(candidate);
      this.saveAndPaint();
      this.display();
    });
  }

}
