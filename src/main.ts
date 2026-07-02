import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from "obsidian";
import { PropertySuggestModal } from "./find-replace";
import { HistoryModal, undoLatest } from "./history";
import { installNumberGuard } from "./number-guard";
import { PropertyIndexView, VIEW_TYPE_PROPERTY_INDEX } from "./property-index";
import { BasesToolboxSettings, DEFAULT_SETTINGS, HistoryEntry, PluginData } from "./types";

export default class BasesToolboxPlugin extends Plugin {
  settings: BasesToolboxSettings = { ...DEFAULT_SETTINGS };
  history: HistoryEntry[] = [];

  async onload(): Promise<void> {
    await this.loadPluginData();

    installNumberGuard(this);

    this.registerView(VIEW_TYPE_PROPERTY_INDEX, (leaf) => new PropertyIndexView(leaf, this));

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
      callback: () => new HistoryModal(this).open(),
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
    document.body.removeClass("bases-toolbox-multiline-lists");
  }

  applyMultilineListCells(): void {
    document.body.toggleClass("bases-toolbox-multiline-lists", this.settings.multilineListCells);
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
    // Migrate the pre-history single-undo slot.
    if (data.lastOperation) this.history.push(data.lastOperation);
  }

  async savePluginData(): Promise<void> {
    const data: PluginData = { settings: this.settings, history: this.history };
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
        'Number properties only accept digits, "." and "-" — other character keys (like "e") are swallowed. Editing and shortcut keys still work.'
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
}
