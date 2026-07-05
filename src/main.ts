import { App, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, debounce, setIcon } from "obsidian";
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
  installConditionalFormatting,
  ruleSwatchColor,
  scheduleRedecorate,
  BaseScopeModal,
  VALUELESS_OPS,
} from "./conditional-format";
import { attachPropertySuggest, attachValueSuggest } from "./suggest";
import { exportBaseCsv } from "./csv-export";
import { CsvImportModal } from "./csv-import";
import { installEmbedOptions } from "./embed-options";
import { openFilterToggle } from "./filter-toggle";
import { ConditionalFormatView, VIEW_TYPE_CONDITIONAL_FORMAT, openConditionalFormatView } from "./conditional-format-view";
import { LauncherView, VIEW_TYPE_LAUNCHER, openLauncher } from "./launcher";
import { FormatDoctorView, VIEW_TYPE_FORMAT_DOCTOR, openFormatDoctor } from "./format-doctor";
import { PropertySuggestModal } from "./find-replace";
import { FindReplaceView, VIEW_TYPE_FIND_REPLACE } from "./find-replace-view";
import { undoLatest } from "./history";
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

    const dirty = () => this.propertyCache.markDirty();
    this.registerEvent(this.app.metadataCache.on("changed", dirty));
    this.registerEvent(this.app.metadataCache.on("deleted", dirty));
    this.registerEvent(this.app.vault.on("rename", dirty));

    // Warn (once, persistently) when a pinned property has out-of-list values,
    // with a one-click path to the audit. Re-checked as the vault changes.
    const checkPins = debounce(() => this.refreshPinViolationNotice(), 1500, false);
    this.app.workspace.onLayoutReady(() => this.refreshPinViolationNotice());
    this.registerEvent(this.app.metadataCache.on("resolved", () => checkPins()));

    this.registerView(VIEW_TYPE_PROPERTY_INDEX, (leaf) => new PropertyIndexView(leaf, this));
    this.registerView(VIEW_TYPE_FIND_REPLACE, (leaf) => new FindReplaceView(leaf, this));
    this.registerView(VIEW_TYPE_HISTORY, (leaf) => new HistoryView(leaf, this));
    this.registerView(VIEW_TYPE_FORMAT_DOCTOR, (leaf) => new FormatDoctorView(leaf, this));
    this.registerView(VIEW_TYPE_CONDITIONAL_FORMAT, (leaf) => new ConditionalFormatView(leaf, this));
    this.registerView(VIEW_TYPE_LAUNCHER, (leaf) => new LauncherView(leaf, this));
    this.registerView(VIEW_TYPE_DUPLICATE_FINDER, (leaf) => new DuplicateFinderView(leaf, this));

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
      name: "Frontmatter (properties & values) history",
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
      name: "Import CSV as notes",
      callback: () => new CsvImportModal(this).open(),
    });

    this.addCommand({
      id: "export-base-csv",
      name: "Export base results as CSV",
      callback: () => void exportBaseCsv(this),
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
      id: "open-launcher",
      name: "Open Bases Toolbox launcher",
      callback: () => void openLauncher(this),
    });

    this.addRibbonIcon("layout-dashboard", "Bases Toolbox — launch a feature", () =>
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

  async addHistoryEntry(entry: HistoryEntry): Promise<void> {
    this.history.push(entry);
    this.trimHistory();
    await this.savePluginData();
  }

  /** Drops the oldest entries when a cap is set. */
  trimHistory(): void {
    const cap = this.settings.historyCap;
    if (cap !== null && cap > 0 && this.history.length > cap)
      this.history = this.history.slice(-cap);
  }

  async clearHistory(): Promise<void> {
    this.history = [];
    await this.savePluginData();
  }

  private async loadPluginData(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData> & {
      lastOperation?: HistoryEntry | null;
    };
    this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    this.history = data.history ?? [];
    this.disabledFilters = data.disabledFilters ?? {};
    // Migrate the pre-history single-undo slot.
    if (data.lastOperation) this.history.push(data.lastOperation);
  }

  async savePluginData(): Promise<void> {
    const data: PluginData = {
      settings: this.settings,
      history: this.history,
      disabledFilters: this.disabledFilters,
    };
    await this.saveData(data);
  }
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
          await this.plugin.savePluginData();
        })
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
        "Max find & replace operations to keep in the history. Leave empty for no cap. Lowering it drops the oldest entries immediately."
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
      .setName("Clear find & replace history")
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
          ["Frontmatter (properties & values) history", "A log of every change these tools make. Expand an entry to see the per-file before → after, then revert it — all of it, or just the files you pick (with an option to force-overwrite files that were edited since)."],
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
          ["Toggle number guard", "Stops number properties from changing when you accidentally press arrow keys or scroll over them."],
          ["Toggle digits-only typing", "On number properties, ignores keystrokes that aren't digits, so a stray letter can't sneak in."],
          ["Toggle multiline list cells", "In Bases tables, stacks a list property's values one per line instead of a single row of pills."],
          ["Open Bases Toolbox launcher / property index / settings", "Shortcuts that open the launcher, the property index, or these settings."],
          ["Open conditional formatting rules / panel", "Jump to the rules editor here in settings, or open the manager as a side panel."],
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
  }

  private renderFormatRules(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Conditional formatting")
      .setDesc("Color Bases rows or cells by property value. Rules apply top to bottom; the first match wins (per row, and per cell).")
      .setHeading()
      .settingEl.setAttribute("data-bt-section", "formatting");

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

    const swatch = row.createDiv({ cls: "bases-toolbox-cf-swatch" });
    const paintSwatch = () => swatch.setCssStyles({ backgroundColor: ruleSwatchColor(rule) });
    paintSwatch();

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

    const mkBtn = (icon: string, label: string, disabled: boolean, fn: () => void) => {
      const b = row.createEl("button", {
        cls: "bases-toolbox-cf-btn clickable-icon",
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
    });
    mkBtn("chevron-down", "Move down", index === rules.length - 1, () => {
      [rules[index + 1], rules[index]] = [rules[index], rules[index + 1]];
      this.saveAndPaint();
      this.display();
    });
    mkBtn("trash", "Delete rule", false, () => {
      this.plugin.settings.formatRules = rules.filter((r) => r !== rule);
      this.saveAndPaint();
      this.display();
    });

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
