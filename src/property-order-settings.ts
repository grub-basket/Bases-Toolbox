import { FuzzySuggestModal, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { ConfirmModal, PromptModal } from "./property-delete";
import { PropertyOrderPreset, UnlistedMode, exportJson, parseExport } from "./property-order";
import { UNLISTED_LABEL } from "./property-order-modal";
import { VaultInputSuggest } from "./suggest";

/**
 * Settings section "Property orders": the saved orders for "Reorder properties
 * in notes", plus export/import in the format shared with GridSense:
 *   { "format": "property-orders", "version": 1, "orders": [ … ] }
 */

const DEFAULT_EXPORT = "property-orders.json";

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Vault path for the export file, or an error message. Rejects `..` (the
 * value is typed by the user but still lands in a vault write). */
function exportPath(raw: string): { path: string } | { error: string } {
  let p = raw.trim() || DEFAULT_EXPORT;
  if (p.split(/[\\/]/).some((seg) => seg === "..")) return { error: "The export path can't contain “..”." };
  p = normalizePath(p);
  if (!p || p === "/") return { error: "Enter a file path for the export." };
  if (p.endsWith("/")) p += DEFAULT_EXPORT;
  if (!p.toLowerCase().endsWith(".json")) p += ".json";
  return { path: p };
}

export function renderPropertyOrderSettings(
  plugin: BasesToolboxPlugin,
  containerEl: HTMLElement,
  rerender: () => void
): void {
  const s = plugin.settings;
  new Setting(containerEl)
    .setName("Property orders")
    .setDesc(
      "Saved orders for “Reorder properties in notes”, which sets the order properties appear in inside each note. Export them to move them to another vault — or to GridSense, which reads the same file."
    )
    .setHeading();

  new Setting(containerEl)
    .setName("Properties not in the list")
    .setDesc("The default when reordering (you can change it each time): put the other properties after the listed ones, or leave them where they are.")
    .addDropdown((dd) => {
      for (const m of ["after", "in-place"] as UnlistedMode[]) dd.addOption(m, UNLISTED_LABEL[m]);
      dd.setValue(s.propertyOrderUnlisted);
      dd.onChange(async (v) => {
        s.propertyOrderUnlisted = v === "in-place" ? "in-place" : "after";
        await plugin.savePluginData();
      });
    });

  if (!s.propertyOrders.length) {
    containerEl.createDiv({
      cls: "bases-toolbox-fr-info setting-item-description",
      text: "No saved orders yet — save one from the Reorder properties dialog, or import a file below.",
    });
  }
  for (const preset of s.propertyOrders) {
    const shown = preset.keys.slice(0, 5).join(", ") + (preset.keys.length > 5 ? ", …" : "");
    new Setting(containerEl)
      .setName(preset.name)
      .setDesc(
        `${preset.keys.length} propert${preset.keys.length === 1 ? "y" : "ies"}${shown ? `: ${shown}` : ""} · others: ${
          preset.unlisted === "after" ? "after" : "left in place"
        }`
      )
      .addButton((b) =>
        b.setButtonText("Rename").onClick(() =>
          new PromptModal(plugin, {
            title: "Rename saved order",
            initial: preset.name,
            confirmText: "Rename",
            onSubmit: (raw) =>
              void (async () => {
                const name = raw.trim();
                if (!name || name === preset.name) return;
                if (s.propertyOrders.some((p) => p !== preset && p.name === name)) {
                  new Notice(`There's already a saved order called “${name}”.`);
                  return;
                }
                preset.name = name;
                await plugin.savePluginData();
                rerender();
              })(),
          }).open()
        )
      )
      .addButton((b) => {
        b.setButtonText("Delete").onClick(() =>
          new ConfirmModal(plugin, {
            title: "Delete saved order?",
            body: `Delete the saved order “${preset.name}”? Your notes aren't changed.`,
            confirmText: "Delete",
            danger: true,
            onConfirm: () =>
              void (async () => {
                s.propertyOrders = s.propertyOrders.filter((p) => p !== preset);
                await plugin.savePluginData();
                rerender();
              })(),
          }).open()
        );
        b.buttonEl.addClass("bases-toolbox-po-danger");
      });
  }

  // ---- export ----
  let pathValue = s.propertyOrderExportPath || DEFAULT_EXPORT;
  new Setting(containerEl)
    .setName("Export")
    .setDesc("Copies every saved order to the clipboard as JSON and also saves it as a file in your vault, at this path.")
    .addText((t) => {
      t.setPlaceholder(DEFAULT_EXPORT).setValue(pathValue);
      new VaultInputSuggest(plugin.app, t.inputEl, () => [
        ...plugin.app.vault
          .getFiles()
          .filter((f) => f.extension.toLowerCase() === "json")
          .map((f) => ({ value: f.path, note: "existing file — will ask before replacing" })),
        ...plugin.app.vault
          .getAllFolders(false)
          .filter((f) => f.path && f.path !== "/")
          .map((f) => ({ value: `${f.path}/${DEFAULT_EXPORT}`, note: "new file in this folder" })),
      ]);
      t.onChange((v) => (pathValue = v));
    })
    .addButton((b) =>
      b.setButtonText("Export").onClick(() => void exportOrders(plugin, pathValue))
    );

  // ---- import ----
  let pasted = "";
  const importSetting = new Setting(containerEl)
    .setName("Import")
    .setDesc("Paste an export (from here or from GridSense), or pick a .json file in your vault. Orders are merged by name; you're asked before one replaces a saved order with the same name.");
  importSetting.addTextArea((ta) => {
    ta.setPlaceholder('{ "format": "property-orders", … }');
    ta.inputEl.rows = 3;
    ta.inputEl.addClass("bases-toolbox-po-import");
    ta.onChange((v) => (pasted = v));
  });
  importSetting.addButton((b) =>
    b.setButtonText("Import pasted").onClick(() => {
      if (!pasted.trim()) {
        new Notice("Paste a property-orders export into the box first.");
        return;
      }
      importText(plugin, pasted, rerender);
    })
  );
  importSetting.addButton((b) =>
    b.setButtonText("Import file…").onClick(() => new JsonFilePicker(plugin, rerender).open())
  );
}

async function exportOrders(plugin: BasesToolboxPlugin, raw: string): Promise<void> {
  const presets = plugin.settings.propertyOrders;
  if (!presets.length) {
    new Notice("There are no saved orders to export yet.");
    return;
  }
  const res = exportPath(raw);
  if ("error" in res) {
    new Notice(res.error);
    return;
  }
  const { path } = res;
  const json = exportJson(presets);
  let copied = true;
  try {
    await navigator.clipboard.writeText(json);
  } catch {
    copied = false; // e.g. the window isn't focused — the file still gets written
  }
  const vault = plugin.app.vault;
  const write = async () => {
    try {
      const existing = vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) await vault.modify(existing, json);
      else {
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (dir && !(vault.getAbstractFileByPath(dir) instanceof TFolder)) await vault.createFolder(dir);
        await vault.create(path, json);
      }
      plugin.settings.propertyOrderExportPath = path;
      await plugin.savePluginData();
      new Notice(
        `Exported ${presets.length} saved order${presets.length === 1 ? "" : "s"} to “${path}”${
          copied ? " and copied them to the clipboard" : " (couldn't reach the clipboard — copy from the file)"
        }.`
      );
    } catch (e) {
      new Notice(`Couldn't write “${path}”: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const existing = vault.getAbstractFileByPath(path);
  if (existing && !(existing instanceof TFile)) {
    new Notice(`“${path}” is a folder — pick a file name.`);
    return;
  }
  if (existing instanceof TFile) {
    new ConfirmModal(plugin, {
      title: "Replace file?",
      body: `“${path}” already exists. Replace it with this export?${copied ? " (The JSON is already on your clipboard either way.)" : ""}`,
      confirmText: "Replace",
      danger: true,
      onConfirm: () => void write(),
    }).open();
  } else await write();
}

/** Parse + merge an export. Rejects other formats/versions with a Notice. */
export function importText(plugin: BasesToolboxPlugin, text: string, done: () => void): void {
  const parsed = parseExport(text);
  if (typeof parsed === "string") {
    new Notice(`Import failed: ${parsed}`, 8000);
    return;
  }
  const { orders, dropped } = parsed;
  if (!orders.length) {
    new Notice(`Nothing to import — the file has no usable orders${dropped ? ` (${dropped} invalid)` : ""}.`);
    return;
  }
  const mine = plugin.settings.propertyOrders;
  const byName = new Map(mine.map((p) => [p.name, p]));
  const fresh = orders.filter((o) => !byName.has(o.name));
  const same = orders.filter((o) => byName.has(o.name) && sameJson(byName.get(o.name), o));
  const conflicts = orders.filter((o) => byName.has(o.name) && !sameJson(byName.get(o.name), o));

  const commit = async (overwrite: boolean) => {
    for (const o of fresh) mine.push(o);
    let replaced = 0;
    if (overwrite) {
      for (const o of conflicts) {
        const i = mine.findIndex((p) => p.name === o.name);
        if (i >= 0) {
          mine[i] = o;
          replaced++;
        }
      }
    }
    await plugin.savePluginData();
    const parts = [`${fresh.length} added`];
    if (conflicts.length) parts.push(overwrite ? `${replaced} replaced` : `${conflicts.length} kept as they were`);
    if (same.length) parts.push(`${same.length} already identical`);
    if (dropped) parts.push(`${dropped} invalid skipped`);
    new Notice(`Imported property orders: ${parts.join(", ")}.`);
    done();
  };

  if (conflicts.length) {
    new ImportConflictModal(plugin, conflicts, (choice) => {
      if (choice === "cancel") return;
      void commit(choice === "overwrite");
    }).open();
  } else void commit(false);
}

/** "These saved orders already exist — replace them?" with three answers. */
class ImportConflictModal extends Modal {
  private answered = false;
  constructor(
    plugin: BasesToolboxPlugin,
    private conflicts: PropertyOrderPreset[],
    private onChoose: (c: "overwrite" | "keep" | "cancel") => void
  ) {
    super(plugin.app);
  }
  onOpen(): void {
    this.titleEl.setText("Replace saved orders?");
    const n = this.conflicts.length;
    this.contentEl.createEl("p", {
      text: `${n} order${n === 1 ? "" : "s"} in the import ${n === 1 ? "has" : "have"} the same name as one you've saved, with different contents:`,
    });
    const ul = this.contentEl.createEl("ul");
    for (const c of this.conflicts) ul.createEl("li", { text: c.name });
    const choose = (c: "overwrite" | "keep" | "cancel") => {
      this.answered = true;
      this.close();
      this.onChoose(c);
    };
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel import").onClick(() => choose("cancel")))
      .addButton((b) => b.setButtonText("Keep mine").onClick(() => choose("keep")))
      .addButton((b) => b.setButtonText("Replace with imported").setCta().onClick(() => choose("overwrite")));
  }
  onClose(): void {
    if (!this.answered) this.onChoose("cancel");
  }
}

/** Pick a vault .json file to import. */
class JsonFilePicker extends FuzzySuggestModal<TFile> {
  constructor(
    private plugin: BasesToolboxPlugin,
    private done: () => void
  ) {
    super(plugin.app);
    this.setPlaceholder("Pick a property-orders .json file…");
  }
  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === "json");
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    void this.app.vault.read(f).then(
      (text) => importText(this.plugin, text, this.done),
      (e) => new Notice(`Couldn't read “${f.path}”: ${e instanceof Error ? e.message : String(e)}`)
    );
  }
}
