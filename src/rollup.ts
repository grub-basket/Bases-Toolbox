import { Modal, Notice, Setting, TFile } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { activeBaseResults } from "./bulk-edit";
import { findKey } from "./scan";
import { ChangeRecord } from "./types";

type Direction = "incoming" | "outgoing";
type Agg = "count" | "sum" | "avg" | "min" | "max";

const AGG_LABELS: Record<Agg, string> = {
  count: "count of linked notes",
  sum: "sum of a property",
  avg: "average of a property",
  min: "minimum of a property",
  max: "maximum of a property",
};

/**
 * One-shot rollup: for every note in the active base's results, aggregate
 * over the notes linking to it (or linked from it) and write the result into
 * a real frontmatter property — which Bases can then display natively.
 * Logged in history, so the whole run is revertible. Re-run to refresh.
 */
export function openRollup(plugin: BasesToolboxPlugin): void {
  const target = activeBaseResults(plugin);
  if (!target) {
    new Notice(
      "Open a base first — rollups are computed for a base's results. (If a base IS open, Obsidian's internals may have changed; tell the plugin author.)"
    );
    return;
  }
  if (!target.files.length) {
    new Notice("The base has no markdown results.");
    return;
  }
  new RollupModal(plugin, target.files, target.name).open();
}

class RollupModal extends Modal {
  private plugin: BasesToolboxPlugin;
  private files: TFile[];
  private baseName: string;
  private direction: Direction = "incoming";
  private agg: Agg = "count";
  private sourcePropEl: HTMLInputElement | null = null;
  private targetPropEl: HTMLInputElement | null = null;
  private sourceSetting: Setting | null = null;
  private running = false;

  constructor(plugin: BasesToolboxPlugin, files: TFile[], baseName: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.files = files;
    this.baseName = baseName;
  }

  onOpen(): void {
    const n = this.files.length;
    this.titleEl.setText(`Rollup: ${this.baseName} (${n} file${n === 1 ? "" : "s"})`);
    const { contentEl } = this;

    new Setting(contentEl).setName("Linked notes").addDropdown((dd) => {
      dd.addOption("incoming", "notes linking TO each result");
      dd.addOption("outgoing", "notes each result links to");
      dd.setValue(this.direction);
      dd.onChange((v) => (this.direction = v as Direction));
    });

    new Setting(contentEl).setName("Aggregation").addDropdown((dd) => {
      for (const [agg, label] of Object.entries(AGG_LABELS)) dd.addOption(agg, label);
      dd.setValue(this.agg);
      dd.onChange((v) => {
        this.agg = v as Agg;
        this.sourceSetting?.settingEl.setCssStyles({ display: v === "count" ? "none" : "" });
      });
    });

    this.sourceSetting = new Setting(contentEl)
      .setName("Property to aggregate")
      .setDesc("Read from each linked note; non-numeric values are skipped.")
      .addText((t) => {
        t.setPlaceholder("e.g. hours");
        this.sourcePropEl = t.inputEl;
      });
    this.sourceSetting.settingEl.setCssStyles({ display: "none" });

    new Setting(contentEl)
      .setName("Write into property")
      .setDesc("Created on each result note. Logged in history — revertible. Re-run to refresh.")
      .addText((t) => {
        t.setPlaceholder("e.g. task-count");
        this.targetPropEl = t.inputEl;
      });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText(`Compute for ${n} file${n === 1 ? "" : "s"}`).setCta().onClick(() => void this.apply())
    );
  }

  private linkedFiles(file: TFile): TFile[] {
    const resolved = this.app.metadataCache.resolvedLinks;
    const paths =
      this.direction === "outgoing"
        ? Object.keys(resolved[file.path] ?? {})
        : Object.entries(resolved)
            .filter(([, links]) => (links as Record<string, number>)[file.path])
            .map(([from]) => from);
    return paths
      .map((p) => this.app.vault.getAbstractFileByPath(p))
      .filter((f): f is TFile => f instanceof TFile && f.extension === "md" && f.path !== file.path);
  }

  private async apply(): Promise<void> {
    if (this.running) return;
    const targetProp = this.targetPropEl?.value.trim() ?? "";
    const sourceProp = this.sourcePropEl?.value.trim() ?? "";
    if (!targetProp) {
      new Notice("Name the property to write into.");
      return;
    }
    if (this.agg !== "count" && !sourceProp) {
      new Notice("Name the property to aggregate.");
      return;
    }
    this.running = true;
    try {
      const changes: ChangeRecord[] = [];
      for (const file of this.files) {
        const linked = this.linkedFiles(file);
        let value: number | null;
        if (this.agg === "count") value = linked.length;
        else {
          const nums = linked
            .map((f) => {
              const fm = (this.app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as Record<string, unknown>;
              const key = findKey(fm, sourceProp);
              const raw = key === null ? undefined : fm[key];
              // only genuine numbers (or numeric strings) count — null/""/true
              // would coerce to 0/1 and silently poison sum/avg/min
              if (typeof raw === "number") return raw;
              if (typeof raw === "string" && raw.trim() !== "") return Number(raw);
              return NaN;
            })
            .filter((x) => !Number.isNaN(x));
          if (!nums.length) value = null;
          else if (this.agg === "sum") value = nums.reduce((a, b) => a + b, 0);
          else if (this.agg === "avg")
            value = Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) / 1000;
          else if (this.agg === "min") value = Math.min(...nums);
          else value = Math.max(...nums);
        }

        await this.app.fileManager.processFrontMatter(file, (fm) => {
          const key = findKey(fm, targetProp);
          const existed = key !== null;
          const cur = existed ? fm[key as string] : undefined;
          if (existed && JSON.stringify(cur) === JSON.stringify(value)) return;
          changes.push({
            path: file.path,
            property: targetProp,
            oldValue: existed ? cur : undefined,
            newValue: value,
            ...(existed ? {} : { created: true }),
          });
          fm[key ?? targetProp] = value;
        });
      }
      if (changes.length) {
        await this.plugin.addHistoryEntry({
          property: targetProp,
          find: null,
          replace: `rollup: ${this.agg}${this.agg === "count" ? "" : ` of ${sourceProp}`} (${this.direction})`,
          timestamp: Date.now(),
          changes,
          source: "rollup",
        });
      }
      new Notice(`${targetProp}: computed in ${changes.length} of ${this.files.length} files.`);
      this.close();
    } finally {
      this.running = false;
    }
  }
}
