import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type BasesToolboxPlugin from "./main";
import {
  BaseScopeModal,
  CUSTOM_COLOR,
  DEFAULT_CUSTOM_HEX,
  FormatOp,
  FormatRule,
  FormatScope,
  OP_LABELS,
  RULE_COLORS,
  colorLabel,
  ruleSwatchColor,
  scheduleRedecorate,
} from "./conditional-format";

export const VIEW_TYPE_CONDITIONAL_FORMAT = "bases-toolbox-conditional-format";

/**
 * A sidebar panel (also openable as a main tab) for managing conditional
 * formatting rules. Same model as the settings editor, but laid out
 * vertically so each control gets full width in a narrow pane.
 */
export class ConditionalFormatView extends ItemView {
  icon = "paintbrush";
  private plugin: BasesToolboxPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: BasesToolboxPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CONDITIONAL_FORMAT;
  }

  getDisplayText(): string {
    return "Conditional formatting";
  }

  async onOpen(): Promise<void> {
    this.render();
    // Reflect edits made elsewhere (settings) when this view regains focus.
    this.registerEvent(this.app.workspace.on("layout-change", () => this.render()));
  }

  private save(): void {
    void this.plugin.savePluginData();
    scheduleRedecorate(this.plugin);
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("bases-toolbox-cfview");

    const bar = root.createDiv({ cls: "bases-toolbox-index-toolbar" });
    bar.createSpan({
      cls: "bases-toolbox-fr-info",
      text: "Color rows or cells by value. Top to bottom; first match wins.",
    });
    const popout = bar.createSpan({ cls: "bases-toolbox-index-btn clickable-icon" });
    setIcon(popout, "picture-in-picture-2");
    popout.setAttribute("aria-label", "Open in a main tab");
    popout.addEventListener("click", () => void this.openInMainTab());

    const rules = this.plugin.settings.formatRules;
    if (!rules.length) {
      root.createDiv({ cls: "bases-toolbox-fr-info", text: "No rules yet — add one below." });
    }
    rules.forEach((rule, i) => this.renderCard(root, rule, i));
    this.renderAddCard(root);
  }

  private renderCard(root: HTMLElement, rule: FormatRule, index: number): void {
    const rules = this.plugin.settings.formatRules;
    const card = root.createDiv({ cls: "bases-toolbox-cfcard" });

    // header: swatch + enabled + reorder + delete
    const head = card.createDiv({ cls: "bases-toolbox-cfcard-head" });
    const swatch = head.createDiv({ cls: "bases-toolbox-cf-swatch" });
    swatch.setCssStyles({ backgroundColor: ruleSwatchColor(rule) });
    const summary = head.createSpan({ cls: "bases-toolbox-cfcard-summary" });
    summary.setText(
      `${rule.property || "(property)"} ${OP_LABELS[rule.op]}${
        rule.op === "empty" || rule.op === "not-empty" ? "" : ` ${rule.value}`
      }`
    );
    const enabled = head.createEl("input", { type: "checkbox" });
    enabled.checked = rule.enabled;
    enabled.setAttribute("aria-label", "Enable rule");
    enabled.addEventListener("change", () => {
      rule.enabled = enabled.checked;
      this.save();
    });
    const mkBtn = (icon: string, label: string, disabled: boolean, fn: () => void) => {
      const b = head.createEl("button", {
        cls: "bases-toolbox-cf-btn clickable-icon",
        attr: { "aria-label": label },
      });
      setIcon(b, icon);
      b.disabled = disabled;
      b.addEventListener("click", fn);
    };
    mkBtn("chevron-up", "Move up", index === 0, () => {
      [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]];
      this.save();
      this.render();
    });
    mkBtn("chevron-down", "Move down", index === rules.length - 1, () => {
      [rules[index + 1], rules[index]] = [rules[index], rules[index + 1]];
      this.save();
      this.render();
    });
    mkBtn("trash", "Delete rule", false, () => {
      this.plugin.settings.formatRules = rules.filter((r) => r !== rule);
      this.save();
      this.render();
    });

    // body: stacked controls
    const body = card.createDiv({ cls: "bases-toolbox-cfcard-body" });
    const prop = body.createEl("input", { type: "text", attr: { placeholder: "property" } });
    prop.value = rule.property;
    prop.addEventListener("input", () => {
      rule.property = prop.value.trim();
      summary.setText(prop.value);
      this.save();
    });

    const opRow = body.createDiv({ cls: "bases-toolbox-cfcard-row" });
    const op = opRow.createEl("select", { cls: "dropdown" });
    for (const [k, label] of Object.entries(OP_LABELS)) op.createEl("option", { value: k, text: label });
    op.value = rule.op;
    const val = opRow.createEl("input", { type: "text", attr: { placeholder: "value" } });
    val.value = rule.value;
    const syncVal = () =>
      val.setCssStyles({ display: rule.op === "empty" || rule.op === "not-empty" ? "none" : "" });
    syncVal();
    op.addEventListener("change", () => {
      rule.op = op.value as FormatOp;
      syncVal();
      this.save();
    });
    val.addEventListener("input", () => {
      rule.value = val.value;
      this.save();
    });

    const styleRow = body.createDiv({ cls: "bases-toolbox-cfcard-row" });
    const scope = styleRow.createEl("select", { cls: "dropdown" });
    scope.createEl("option", { value: "row", text: "Row" });
    scope.createEl("option", { value: "cell", text: "Cell" });
    scope.value = rule.scope ?? "row";
    scope.addEventListener("change", () => {
      rule.scope = scope.value as FormatScope;
      this.save();
    });
    const color = styleRow.createEl("select", { cls: "dropdown" });
    for (const c of Object.keys(RULE_COLORS)) color.createEl("option", { value: c, text: colorLabel(c) });
    color.createEl("option", { value: CUSTOM_COLOR, text: colorLabel(CUSTOM_COLOR) });
    color.value = rule.color;
    const custom = styleRow.createEl("input", { type: "color", cls: "bases-toolbox-color-input" });
    custom.value = rule.customColor ?? DEFAULT_CUSTOM_HEX;
    const syncCustom = () =>
      custom.setCssStyles({ display: rule.color === CUSTOM_COLOR ? "" : "none" });
    syncCustom();
    color.addEventListener("change", () => {
      rule.color = color.value;
      syncCustom();
      swatch.setCssStyles({ backgroundColor: ruleSwatchColor(rule) });
      this.save();
    });
    custom.addEventListener("input", () => {
      rule.customColor = custom.value;
      swatch.setCssStyles({ backgroundColor: ruleSwatchColor(rule) });
      this.save();
    });

    const sheets = body.createEl("button", { cls: "bases-toolbox-cf-sheets" });
    const sheetLabel = () =>
      rule.bases?.length ? `${rule.bases.length} sheet${rule.bases.length === 1 ? "" : "s"}` : "All sheets";
    sheets.setText(sheetLabel());
    sheets.addEventListener("click", () => {
      new BaseScopeModal(this.plugin, rule.bases ?? [], (sel) => {
        rule.bases = sel.length ? sel : undefined;
        sheets.setText(sheetLabel());
        this.save();
      }).open();
    });
  }

  private renderAddCard(root: HTMLElement): void {
    const card = root.createDiv({ cls: "bases-toolbox-cfcard bases-toolbox-cfcard-add" });
    card.createDiv({ cls: "bases-toolbox-cfcard-summary", text: "Add rule" });
    const body = card.createDiv({ cls: "bases-toolbox-cfcard-body" });
    const prop = body.createEl("input", { type: "text", attr: { placeholder: "property" } });
    const opRow = body.createDiv({ cls: "bases-toolbox-cfcard-row" });
    const op = opRow.createEl("select", { cls: "dropdown" });
    for (const [k, label] of Object.entries(OP_LABELS)) op.createEl("option", { value: k, text: label });
    const val = opRow.createEl("input", { type: "text", attr: { placeholder: "value" } });
    const styleRow = body.createDiv({ cls: "bases-toolbox-cfcard-row" });
    const scope = styleRow.createEl("select", { cls: "dropdown" });
    scope.createEl("option", { value: "row", text: "Row" });
    scope.createEl("option", { value: "cell", text: "Cell" });
    const color = styleRow.createEl("select", { cls: "dropdown" });
    for (const c of Object.keys(RULE_COLORS)) color.createEl("option", { value: c, text: colorLabel(c) });
    color.createEl("option", { value: CUSTOM_COLOR, text: colorLabel(CUSTOM_COLOR) });
    const add = body.createEl("button", { cls: "mod-cta", text: "Add rule" });
    add.addEventListener("click", () => {
      const property = prop.value.trim();
      if (!property) return;
      this.plugin.settings.formatRules.push({
        id: `${Date.now()}-${this.plugin.settings.formatRules.length}`,
        property,
        op: op.value as FormatOp,
        value: val.value,
        scope: scope.value as FormatScope,
        color: color.value,
        enabled: true,
      });
      this.save();
      this.render();
    });
  }

  private async openInMainTab(): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_CONDITIONAL_FORMAT, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}

export async function openConditionalFormatView(
  plugin: BasesToolboxPlugin,
  mainTab = false
): Promise<void> {
  const { workspace } = plugin.app;
  const existing = workspace.getLeavesOfType(VIEW_TYPE_CONDITIONAL_FORMAT)[0];
  if (existing && !mainTab) {
    await workspace.revealLeaf(existing);
    return;
  }
  const leaf = mainTab ? workspace.getLeaf("tab") : workspace.getRightLeaf(false);
  if (!leaf) return;
  await leaf.setViewState({ type: VIEW_TYPE_CONDITIONAL_FORMAT, active: true });
  await workspace.revealLeaf(leaf);
}
