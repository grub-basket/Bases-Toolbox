import { FuzzySuggestModal, Modal, Notice, Setting, TFile, parseYaml, stringifyYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { DisabledFilter } from "./types";

interface FilterRow {
  scope: string; // "" = base-level
  conj: "and" | "or";
  text: string;
  enabled: boolean;
  toggleable: boolean;
}

type FiltersNode = { and?: unknown[]; or?: unknown[] } | string | undefined;

function rowsFromFilters(scope: string, filters: FiltersNode, rows: FilterRow[]): void {
  if (typeof filters === "string") {
    rows.push({ scope, conj: "and", text: filters, enabled: true, toggleable: true });
    return;
  }
  if (!filters || typeof filters !== "object") return;
  for (const conj of ["and", "or"] as const) {
    const arr = filters[conj];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (typeof item === "string") {
        rows.push({ scope, conj, text: item, enabled: true, toggleable: true });
      } else {
        rows.push({
          scope,
          conj,
          text: `(nested ${Object.keys(item ?? {}).join("/") || "group"} group)`,
          enabled: true,
          toggleable: false,
        });
      }
    }
  }
}

export class BaseFilePickerModal extends FuzzySuggestModal<TFile> {
  private plugin: BasesToolboxPlugin;

  constructor(plugin: BasesToolboxPlugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.setPlaceholder("Pick a base…");
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((f) => f.extension === "base");
  }

  getItemText(f: TFile): string {
    return f.path;
  }

  onChooseItem(f: TFile): void {
    new FilterToggleModal(this.plugin, f).open();
  }
}

export function openFilterToggle(plugin: BasesToolboxPlugin): void {
  const active = plugin.app.workspace.getActiveFile();
  if (active?.extension === "base") new FilterToggleModal(plugin, active).open();
  else new BaseFilePickerModal(plugin).open();
}

export class FilterToggleModal extends Modal {
  private plugin: BasesToolboxPlugin;
  private file: TFile;

  constructor(plugin: BasesToolboxPlugin, file: TFile) {
    super(plugin.app);
    this.plugin = plugin;
    this.file = file;
  }

  onOpen(): void {
    this.titleEl.setText(`Filters: ${this.file.basename}`);
    void this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    let doc: Record<string, unknown>;
    try {
      doc = (parseYaml(await this.app.vault.read(this.file)) ?? {}) as Record<string, unknown>;
    } catch {
      contentEl.createDiv({ text: "Could not parse this .base file." });
      return;
    }

    const rows: FilterRow[] = [];
    rowsFromFilters("", doc.filters as FiltersNode, rows);
    const views = Array.isArray(doc.views) ? (doc.views as Record<string, unknown>[]) : [];
    for (const view of views) {
      const name = typeof view.name === "string" ? view.name : "(unnamed view)";
      rowsFromFilters(name, view.filters as FiltersNode, rows);
    }
    for (const d of this.plugin.disabledFilters[this.file.path] ?? []) {
      rows.push({ ...d, enabled: false, toggleable: true });
    }

    if (!rows.length) {
      contentEl.createDiv({ cls: "bases-toolbox-fr-info", text: "This base has no filters." });
      return;
    }

    contentEl.createDiv({
      cls: "bases-toolbox-fr-info",
      text: "Toggling a filter off removes it from the .base file and remembers it here, so you can toggle it back on later.",
    });

    const scopes = [...new Set(rows.map((r) => r.scope))].sort();
    for (const scope of scopes) {
      new Setting(contentEl).setName(scope === "" ? "All views" : `View: ${scope}`).setHeading();
      for (const row of rows.filter((r) => r.scope === scope)) {
        const setting = new Setting(contentEl).setName(row.text);
        if (!row.toggleable) {
          setting.setDesc("Nested groups can't be toggled (yet) — edit the .base directly.");
          continue;
        }
        setting.addToggle((t) =>
          t.setValue(row.enabled).onChange(async () => {
            try {
              if (row.enabled) await this.disableFilter(row);
              else await this.enableFilter(row);
            } catch (e) {
              new Notice(`Filter toggle failed: ${e instanceof Error ? e.message : e}`);
            }
            await this.render();
          })
        );
      }
    }
  }

  /** Removes the condition from the .base file and stashes it in plugin data. */
  private async disableFilter(row: FilterRow): Promise<void> {
    await this.rewriteBase((doc) => {
      const holder = this.filtersHolder(doc, row.scope);
      if (!holder) return false;
      let filters = holder.obj[holder.key] as FiltersNode;
      // A bare-string filters value becomes {and: [text]} conceptually.
      if (typeof filters === "string") {
        if (filters !== row.text) return false;
        delete holder.obj[holder.key];
        return true;
      }
      if (!filters || typeof filters !== "object") return false;
      const arr = filters[row.conj];
      if (!Array.isArray(arr)) return false;
      const i = arr.findIndex((x) => x === row.text);
      if (i === -1) return false;
      arr.splice(i, 1);
      if (!arr.length) delete filters[row.conj];
      if (!Object.keys(filters).length) delete holder.obj[holder.key];
      return true;
    });
    const list = (this.plugin.disabledFilters[this.file.path] ??= []);
    list.push({ text: row.text, conj: row.conj, scope: row.scope });
    await this.plugin.savePluginData();
  }

  /** Re-inserts a stashed condition into the .base file. */
  private async enableFilter(row: FilterRow): Promise<void> {
    await this.rewriteBase((doc) => {
      const holder = this.filtersHolder(doc, row.scope, true);
      if (!holder) throw new Error(`view "${row.scope}" no longer exists`);
      let filters = holder.obj[holder.key] as FiltersNode;
      if (typeof filters === "string") {
        // promote the bare string into a conjunction alongside the re-enabled one
        filters = { and: [filters] };
      }
      if (!filters || typeof filters !== "object") filters = {};
      const arr = (filters[row.conj] ??= []);
      if (!arr.includes(row.text)) arr.push(row.text);
      holder.obj[holder.key] = filters;
      return true;
    });
    const list = this.plugin.disabledFilters[this.file.path] ?? [];
    const i = list.findIndex(
      (d) => d.text === row.text && d.conj === row.conj && d.scope === row.scope
    );
    if (i !== -1) list.splice(i, 1);
    if (!list.length) delete this.plugin.disabledFilters[this.file.path];
    await this.plugin.savePluginData();
  }

  /** Finds the object holding the `filters` key for a scope ("" = doc root). */
  private filtersHolder(
    doc: Record<string, unknown>,
    scope: string,
    forInsert = false
  ): { obj: Record<string, unknown>; key: string } | null {
    if (scope === "") return { obj: doc, key: "filters" };
    const views = Array.isArray(doc.views) ? (doc.views as Record<string, unknown>[]) : [];
    const view = views.find((v) => v.name === scope) ?? (forInsert ? null : null);
    return view ? { obj: view, key: "filters" } : null;
  }

  private async rewriteBase(
    mutate: (doc: Record<string, unknown>) => boolean
  ): Promise<void> {
    const raw = await this.app.vault.read(this.file);
    const doc = (parseYaml(raw) ?? {}) as Record<string, unknown>;
    if (!mutate(doc)) return;
    await this.app.vault.modify(this.file, stringifyYaml(doc));
  }
}
