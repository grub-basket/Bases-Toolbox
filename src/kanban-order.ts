import { Modal, Notice, Setting, TFile, parseYaml, stringifyYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { activeBaseView } from "./base-detect";
import { activeBaseResults } from "./bulk-edit";
import { findKey, isUnsafeKey } from "./scan";
import { attachPropertySuggest } from "./suggest";
import { ChangeRecord } from "./types";

/**
 * Manual card ordering for a base's KANBAN view.
 *
 * The problem this solves: Obsidian's Bases kanban orders the cards inside each
 * column by the base's `sort` spec — so there's no persistent "I dragged this
 * card above that one" position. Reload and the cards snap back to the sort.
 *
 * The cheap, robust fix (the shape the user asked for): give the base a numeric
 * order property, seed it — SPACED, so a card can be slotted between two others
 * without renumbering the world — and point the kanban view's sort at it. Now
 * the column order is a real, editable, persistent thing. Reseed at any time
 * from a chosen basis (creation date, modification date, name, or the current
 * display order). Every write is revertible from the bulk file change history.
 *
 * Two writes, two history entries (so either can be reverted on its own):
 *  - the per-note order values (frontmatter — one entry, like a rollup);
 *  - the kanban view(s) `sort:` in the `.base` file (a whole-file snapshot).
 *
 * NOTE (intentionally left for a follow-up): capturing a *drag* to rewrite the
 * order automatically depends on how the live kanban renders + reorders its
 * cards in the DOM, which needs verifying against a running insider build. This
 * module is the persistence substrate that drag-capture (or explicit move
 * up/down controls) will sit on top of.
 */

type Basis = "created" | "modified" | "name" | "current";

const BASIS_LABEL: Record<Basis, string> = {
  created: "Creation date (oldest first)",
  modified: "Modification date (oldest first)",
  name: "File name (A→Z)",
  current: "Current display order",
};

const DEFAULT_PROP = "sort-order";
const DEFAULT_SPACING = 10;

type ViewNode = Record<string, unknown> & { type?: unknown; name?: unknown; sort?: unknown };

function kanbanViews(doc: Record<string, unknown>): ViewNode[] {
  const views = Array.isArray(doc.views) ? (doc.views as ViewNode[]) : [];
  return views.filter((v) => v.type === "kanban");
}

/** Order the files for seeding, per the chosen basis. `current` keeps the
 * order Bases already returned the results in (its result Map key order). */
function orderFiles(files: TFile[], basis: Basis): TFile[] {
  const out = [...files];
  if (basis === "current") return out;
  if (basis === "name") out.sort((a, b) => a.basename.localeCompare(b.basename));
  else if (basis === "created") out.sort((a, b) => a.stat.ctime - b.stat.ctime || a.path.localeCompare(b.path));
  else out.sort((a, b) => a.stat.mtime - b.stat.mtime || a.path.localeCompare(b.path));
  return out;
}

export function openKanbanOrder(plugin: BasesToolboxPlugin): void {
  const view = activeBaseView(plugin.app);
  const target = activeBaseResults(plugin);
  if (!view || !target) {
    new Notice(
      "Open a base first — manual card ordering runs on the active base's kanban. (If a base IS open, Obsidian's internals may have changed; tell the plugin author.)"
    );
    return;
  }
  if (!target.files.length) {
    new Notice("The base has no markdown results to order.");
    return;
  }
  new KanbanOrderModal(plugin, view.file, target.files, target.name).open();
}

class KanbanOrderModal extends Modal {
  private prop = DEFAULT_PROP;
  private basis: Basis = "created";
  private spacing = DEFAULT_SPACING;
  private setSort = true;
  private running = false;

  constructor(
    private plugin: BasesToolboxPlugin,
    private baseFile: TFile,
    private files: TFile[],
    private baseName: string
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const n = this.files.length;
    this.titleEl.setText(`Kanban order: ${this.baseName} (${n} card${n === 1 ? "" : "s"})`);
    this.modalEl.addClass("bases-toolbox-csv-modal");
    const { contentEl } = this;

    contentEl.createDiv({
      cls: "bases-toolbox-fr-info",
      text:
        "Gives this base a numeric order property and points the kanban's sort at it, so cards keep a manual, persistent order inside each column. " +
        "Run it again any time to re-seed. Both the order values and the sort change are revertible from the bulk file change history.",
    });

    new Setting(contentEl)
      .setName("Order property")
      .setDesc("The numeric frontmatter property that holds each card's position. Created if it doesn't exist.")
      .addText((t) => {
        t.setPlaceholder(DEFAULT_PROP).setValue(this.prop);
        attachPropertySuggest(this.plugin, t.inputEl);
        t.onChange((v) => (this.prop = v.trim()));
      });

    new Setting(contentEl)
      .setName("Seed order from")
      .setDesc("The starting order to lay the cards out in. You can reorder freely afterwards.")
      .addDropdown((dd) => {
        for (const [k, label] of Object.entries(BASIS_LABEL)) dd.addOption(k, label);
        dd.setValue(this.basis);
        dd.onChange((v) => (this.basis = v as Basis));
      });

    new Setting(contentEl)
      .setName("Spacing")
      .setDesc("Gap between consecutive cards (10, 20, 30…). A bigger gap leaves more room to drop a card between two others without renumbering.")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(this.spacing));
        t.onChange((v) => {
          const n2 = Number(v);
          this.spacing = Number.isFinite(n2) && n2 >= 1 ? Math.floor(n2) : DEFAULT_SPACING;
        });
      });

    new Setting(contentEl)
      .setName("Point the kanban's sort at this property")
      .setDesc("Sets every kanban view in this base to sort by the order property (ascending), so the order actually takes effect. Off = only write the values.")
      .addToggle((tg) => tg.setValue(this.setSort).onChange((v) => (this.setSort = v)));

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Set up ordering")
          .setCta()
          .onClick((e) => {
            const btn = e.target as HTMLButtonElement;
            if (btn.disabled) return;
            btn.disabled = true;
            void this.run().finally(() => (btn.disabled = false));
          })
      )
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }

  private async run(): Promise<void> {
    if (this.running) return;
    const prop = this.prop.trim() || DEFAULT_PROP;
    if (isUnsafeKey(prop)) {
      new Notice(`"${prop}" is a reserved name and can't be used as a property.`);
      return;
    }
    this.running = true;
    try {
      // 1. Seed the order values (frontmatter) — one revertible entry.
      const ordered = orderFiles(this.files, this.basis);
      const changes: ChangeRecord[] = [];
      let pos = this.spacing;
      for (const file of ordered) {
        const value = pos;
        pos += this.spacing;
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          const key = findKey(fm, prop);
          const existed = key !== null;
          const cur = existed ? fm[key as string] : undefined;
          if (existed && cur === value) return;
          changes.push({
            path: file.path,
            property: prop,
            oldValue: existed ? cur : undefined,
            newValue: value,
            ...(existed ? {} : { created: true }),
          });
          fm[key ?? prop] = value;
        });
      }
      if (changes.length) {
        await this.plugin.addHistoryEntry({
          property: prop,
          find: null,
          replace: `seeded kanban order for ${changes.length} card${changes.length === 1 ? "" : "s"}`,
          timestamp: Date.now(),
          changes,
          source: "kanban order",
        });
      }

      // 2. Point the kanban view(s) sort at the property — one snapshot entry.
      let sortedViews = 0;
      let hadKanban = true;
      if (this.setSort) {
        const res = await this.applySort(prop);
        sortedViews = res.count;
        hadKanban = res.hadKanban;
      }

      const seededMsg = changes.length
        ? `Ordered ${changes.length} card${changes.length === 1 ? "" : "s"} by ${BASIS_LABEL[this.basis].toLowerCase()}`
        : `Order values were already up to date`;
      const sortMsg = !this.setSort
        ? ""
        : hadKanban
          ? sortedViews
            ? `; ${sortedViews} kanban view${sortedViews === 1 ? "" : "s"} now sort by "${prop}"`
            : `; kanban views already sorted by "${prop}"`
          : `; no kanban view found in this base — add one, then run this again (or the values just won't take effect yet)`;
      new Notice(`${seededMsg}${sortMsg}.`, 8000);
      this.close();
    } catch (e) {
      new Notice(`Kanban order failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.running = false;
    }
  }

  /** Set `sort: [{property, direction: ASC}]` on every kanban view; snapshot
   * the .base into history first. Returns how many views changed. */
  private async applySort(prop: string): Promise<{ count: number; hadKanban: boolean }> {
    const before = await this.app.vault.read(this.baseFile);
    let doc: Record<string, unknown>;
    try {
      doc = (parseYaml(before) ?? {}) as Record<string, unknown>;
    } catch {
      new Notice("Could not parse this .base file to set its sort.");
      return { count: 0, hadKanban: false };
    }
    const kviews = kanbanViews(doc);
    if (!kviews.length) return { count: 0, hadKanban: false };

    let count = 0;
    for (const v of kviews) {
      const want = [{ property: prop, direction: "ASC" }];
      if (JSON.stringify(v.sort) === JSON.stringify(want)) continue;
      v.sort = want;
      count++;
    }
    if (!count) return { count: 0, hadKanban: true };

    await this.app.vault.modify(this.baseFile, stringifyYaml(doc));
    await this.plugin.addHistoryEntry({
      property: `Kanban sort → "${prop}" in "${this.baseFile.basename}"`,
      find: null,
      replace: "",
      timestamp: Date.now(),
      changes: [],
      source: "kanban order sort",
      fileSnapshots: [{ path: this.baseFile.path, content: before, kind: "modified" }],
    });
    return { count, hadKanban: true };
  }
}
