import { App, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, setIcon } from "obsidian";
import { AllowedValuesAuditModal, installAllowedValuePicker } from "./allowed-values";
import { openBulkEdit } from "./bulk-edit";
import { CompanionNotesModal, MetadataStampModal, installCompanionAuto } from "./companion-notes";
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
  installConditionalFormatting,
  ruleSwatchColor,
  scheduleRedecorate,
  BaseScopeModal,
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
import { ForkPropertyPicker, ForkRenameModal, TRANSFORM_LABELS, installForkSync } from "./property-fork";
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
      name: "Open conditional formatting rules",
      callback: () => this.openSettingsSection("formatting"),
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
        // Intuitive rename catch: if the source or target property no longer
        // exists in the vault, the fork is probably broken (a property rename
        // in the All Properties view rewrites keys but leaves the fork def
        // pointing at the old name). Flag it and offer a one-click fix.
        const sourceMissing = !this.plugin.propertyCache.usage(def.source);
        const targetMissing = !this.plugin.propertyCache.usage(def.target);
        const warn = sourceMissing
          ? ` · ⚠ source “${def.source}” not found — renamed or removed?`
          : targetMissing
            ? ` · ⚠ target “${def.target}” not found — a rename here means the fork recreates the old name`
            : "";
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

    // Add-fork builder access from settings.
    new Setting(containerEl)
      .setName("Add a fork")
      .setDesc("Convert or fork a property's format (dates, wikilinks). Enable live sync in the builder to list it above.")
      .addButton((b) =>
        b.setButtonText("Fork builder…").onClick(() => new ForkPropertyPicker(this.plugin).open())
      );

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
      .setName("Companion extensions")
      .setDesc("Only companion these extensions (comma separated). Empty = every non-Markdown file.")
      .addText((t) => {
        t.setPlaceholder("e.g. png, jpg, pdf");
        t.setValue(this.plugin.settings.companionExts);
        t.onChange(async (v) => {
          this.plugin.settings.companionExts = v.trim();
          await this.plugin.savePluginData();
        });
      });

    new Setting(containerEl)
      .setName("Auto-create companions for new files")
      .setDesc("When a matching non-Markdown file is added to the vault, its companion is created automatically (using the destination and extensions above).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.companionAuto).onChange(async (v) => {
          this.plugin.settings.companionAuto = v;
          await this.plugin.savePluginData();
        })
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
    const syncVal = () =>
      val.setCssStyles({ display: rule.op === "empty" || rule.op === "not-empty" ? "none" : "" });
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
  }

  private renderAddRule(containerEl: HTMLElement): void {
    // A custom flex row (matching the rule rows) instead of a Setting — the
    // Setting name column truncates to "A… r…" once the controls get wide.
    const row = containerEl.createDiv({ cls: "bases-toolbox-cf-rule bases-toolbox-cf-add" });
    row.createSpan({ cls: "bases-toolbox-cf-addlabel", text: "Add rule" });

    const propEl = row.createEl("input", {
      type: "text",
      cls: "bases-toolbox-cf-prop",
      attr: { placeholder: "property" },
    });
    const opEl = row.createEl("select", { cls: "dropdown bases-toolbox-cf-op" });
    for (const [k, label] of Object.entries(OP_LABELS)) opEl.createEl("option", { value: k, text: label });
    const valEl = row.createEl("input", {
      type: "text",
      cls: "bases-toolbox-cf-val",
      attr: { placeholder: "value" },
    });
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
      this.plugin.settings.formatRules.push({
        id: `${Date.now()}-${this.plugin.settings.formatRules.length}`,
        property,
        op: opEl.value as FormatOp,
        value: valEl.value,
        scope: scopeEl.value as FormatScope,
        color: colorKey,
        ...(colorKey === CUSTOM_COLOR ? { customColor: customEl.value } : {}),
        enabled: true,
      });
      this.saveAndPaint();
      this.display();
    });
  }

}
