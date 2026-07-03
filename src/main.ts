import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from "obsidian";
import { AllowedValuesAuditModal, installAllowedValuePicker } from "./allowed-values";
import { openBulkEdit } from "./bulk-edit";
import { CompanionNotesModal } from "./companion-notes";
import { installCellZoomTracking, openCellZoom } from "./cell-zoom";
import {
  CUSTOM_COLOR,
  DEFAULT_CUSTOM_HEX,
  FormatOp,
  FormatRule,
  OP_LABELS,
  RULE_COLORS,
  installConditionalFormatting,
  redecorateAll,
} from "./conditional-format";
import { exportBaseCsv } from "./csv-export";
import { CsvImportModal } from "./csv-import";
import { installEmbedOptions } from "./embed-options";
import { openFilterToggle } from "./filter-toggle";
import { FormatDoctorView, VIEW_TYPE_FORMAT_DOCTOR, openFormatDoctor } from "./format-doctor";
import { PropertySuggestModal } from "./find-replace";
import { FindReplaceView, VIEW_TYPE_FIND_REPLACE } from "./find-replace-view";
import { undoLatest } from "./history";
import { HistoryView, VIEW_TYPE_HISTORY, openHistoryView } from "./history-view";
import { InlineFieldMigratorModal } from "./inline-fields";
import { DuplicateFinderModal, startMerge } from "./merge";
import { installNumberGuard } from "./number-guard";
import { PropertyIndexView, VIEW_TYPE_PROPERTY_INDEX } from "./property-index";
import { ForkPropertyPicker, TRANSFORM_LABELS, installForkSync } from "./property-fork";
import { openRollup } from "./rollup";
import { PropertyCache } from "./scan";
import { BasesToolboxSettings, DEFAULT_SETTINGS, DisabledFilter, HistoryEntry, PluginData } from "./types";

export default class BasesToolboxPlugin extends Plugin {
  settings: BasesToolboxSettings = { ...DEFAULT_SETTINGS };
  history: HistoryEntry[] = [];
  disabledFilters: Record<string, DisabledFilter[]> = {};
  propertyCache: PropertyCache = new PropertyCache(this.app);

  async onload(): Promise<void> {
    await this.loadPluginData();

    installNumberGuard(this);
    installEmbedOptions(this);
    installCellZoomTracking(this);
    installConditionalFormatting(this);
    installAllowedValuePicker(this);
    installForkSync(this);

    const dirty = () => this.propertyCache.markDirty();
    this.registerEvent(this.app.metadataCache.on("changed", dirty));
    this.registerEvent(this.app.metadataCache.on("deleted", dirty));
    this.registerEvent(this.app.vault.on("rename", dirty));

    this.registerView(VIEW_TYPE_PROPERTY_INDEX, (leaf) => new PropertyIndexView(leaf, this));
    this.registerView(VIEW_TYPE_FIND_REPLACE, (leaf) => new FindReplaceView(leaf, this));
    this.registerView(VIEW_TYPE_HISTORY, (leaf) => new HistoryView(leaf, this));
    this.registerView(VIEW_TYPE_FORMAT_DOCTOR, (leaf) => new FormatDoctorView(leaf, this));

    this.addCommand({
      id: "find-replace-property-values",
      name: "Find & replace property values",
      callback: () => new PropertySuggestModal(this).open(),
    });

    this.addCommand({
      id: "undo-last-find-replace",
      name: "Undo last find & replace",
      callback: () => void undoLatest(this),
    });

    this.addCommand({
      id: "find-replace-history",
      name: "Find & replace history",
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
      name: "Audit allowed values",
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
      id: "companion-notes",
      name: "Create companion notes for non-Markdown files",
      callback: () => new CompanionNotesModal(this).open(),
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

    this.addRibbonIcon("table-properties", "Open property index", () =>
      void this.activatePropertyIndex()
    );

    this.addSettingTab(new BasesToolboxSettingTab(this.app, this));

    this.applyMultilineListCells();
  }

  onunload(): void {
    activeDocument.body.removeClass("bases-toolbox-multiline-lists");
  }

  applyMultilineListCells(): void {
    activeDocument.body.toggleClass("bases-toolbox-multiline-lists", this.settings.multilineListCells);
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

  constructor(app: App, plugin: BasesToolboxPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
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

    if (this.plugin.settings.propertyForks.length) {
      new Setting(containerEl)
        .setName("Live property forks")
        .setDesc("Forks recomputed automatically when their source property changes.")
        .setHeading();
      for (const def of [...this.plugin.settings.propertyForks]) {
        new Setting(containerEl)
          .setName(`${def.source} → ${def.target}`)
          .setDesc(TRANSFORM_LABELS[def.transform])
          .addExtraButton((b) =>
            b
              .setIcon("trash")
              .setTooltip("Stop syncing (properties stay as they are)")
              .onClick(() =>
                void (async () => {
                  this.plugin.settings.propertyForks = this.plugin.settings.propertyForks.filter(
                    (d) => d !== def
                  );
                  await this.plugin.savePluginData();
                  this.display();
                })()
              )
          );
      }
    }

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
  }

  private renderFormatRules(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Conditional formatting")
      .setDesc("Color Bases rows by property value. The first matching rule wins.")
      .setHeading();

    for (const rule of this.plugin.settings.formatRules) {
      const setting = new Setting(containerEl).setName(
        `${rule.property} ${OP_LABELS[rule.op]}${
          rule.op === "empty" || rule.op === "not-empty" ? "" : ` “${rule.value}”`
        }`
      );
      let ruleSwatch: HTMLInputElement | null = null;
      setting.addDropdown((dd) => {
        for (const c of Object.keys(RULE_COLORS)) dd.addOption(c, c);
        dd.addOption(CUSTOM_COLOR, "custom…");
        dd.setValue(rule.color);
        dd.onChange(async (v) => {
          rule.color = v;
          ruleSwatch?.setCssStyles({ display: v === CUSTOM_COLOR ? "" : "none" });
          await this.plugin.savePluginData();
          redecorateAll(this.plugin);
        });
      });
      ruleSwatch = setting.controlEl.createEl("input", { type: "color" });
      ruleSwatch.value = rule.customColor ?? DEFAULT_CUSTOM_HEX;
      ruleSwatch.setCssStyles({ display: rule.color === CUSTOM_COLOR ? "" : "none" });
      ruleSwatch.addEventListener("input", async () => {
        rule.customColor = ruleSwatch?.value ?? DEFAULT_CUSTOM_HEX;
        await this.plugin.savePluginData();
        redecorateAll(this.plugin);
      });
      setting.addToggle((t) =>
        t.setValue(rule.enabled).onChange(async (v) => {
          rule.enabled = v;
          await this.plugin.savePluginData();
          redecorateAll(this.plugin);
        })
      );
      setting.addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip("Delete rule")
          .onClick(() =>
            void (async () => {
              this.plugin.settings.formatRules = this.plugin.settings.formatRules.filter(
                (r) => r !== rule
              );
              await this.plugin.savePluginData();
              redecorateAll(this.plugin);
              this.display();
            })()
          )
      );
    }

    let propEl: HTMLInputElement | null = null;
    let valueEl: HTMLInputElement | null = null;
    let opEl: HTMLSelectElement | null = null;
    let colorEl: HTMLSelectElement | null = null;
    let swatchEl: HTMLInputElement | null = null;
    const addSetting = new Setting(containerEl)
      .setName("Add rule")
      .addText((t) => {
        t.setPlaceholder("property");
        propEl = t.inputEl;
      })
      .addDropdown((dd) => {
        for (const [op, label] of Object.entries(OP_LABELS)) dd.addOption(op, label);
        opEl = dd.selectEl;
      })
      .addText((t) => {
        t.setPlaceholder("value");
        valueEl = t.inputEl;
      })
      .addDropdown((dd) => {
        for (const c of Object.keys(RULE_COLORS)) dd.addOption(c, c);
        dd.addOption(CUSTOM_COLOR, "custom…");
        colorEl = dd.selectEl;
        dd.onChange((v) => {
          swatchEl?.setCssStyles({ display: v === CUSTOM_COLOR ? "" : "none" });
        });
      });
    swatchEl = addSetting.controlEl.createEl("input", { type: "color" });
    swatchEl.value = DEFAULT_CUSTOM_HEX;
    swatchEl.setCssStyles({ display: "none" });
    addSetting.addButton((b) =>
      b.setButtonText("Add").onClick(async () => {
        const property = propEl?.value.trim() ?? "";
        if (!property) return;
        const color = colorEl?.value ?? "red";
        const rule: FormatRule = {
          id: `${Date.now()}-${this.plugin.settings.formatRules.length}`,
          property,
          op: (opEl?.value ?? "equals") as FormatOp,
          value: valueEl?.value ?? "",
          color,
          ...(color === CUSTOM_COLOR ? { customColor: swatchEl?.value ?? DEFAULT_CUSTOM_HEX } : {}),
          enabled: true,
        };
        this.plugin.settings.formatRules.push(rule);
        await this.plugin.savePluginData();
        redecorateAll(this.plugin);
        this.display();
      })
    );
  }
}
