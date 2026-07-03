import { FuzzySuggestModal, Modal, Notice, Setting, TFile } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { normalizeDate, stripWikilinks } from "./csv-core";
import { PropertyUsage, findKey, isUnsafeKey, valueToDisplay } from "./scan";
import { ChangeRecord } from "./types";

/**
 * Property fork / convert: transform a property's values vault-wide —
 * normalize dates to YYYY-MM-DD, unwrap wikilinks to raw text, or wrap raw
 * text in wikilinks — either IN PLACE or forked into a second property so a
 * user keeps the format they like AND the format Bases wants. Forks can be
 * kept in LIVE SYNC: whenever the source property changes, the fork is
 * recomputed. Everything is history-logged and revertible.
 */

export type ForkTransform = "date" | "strip-links" | "wrap-links" | "copy";

export const TRANSFORM_LABELS: Record<ForkTransform, string> = {
  date: "Normalize dates → YYYY-MM-DD",
  "strip-links": "Unwrap [[wikilinks]] → plain text",
  "wrap-links": "Wrap plain text → [[wikilinks]]",
  copy: "Copy as-is",
};

export interface PropertyForkDef {
  source: string;
  target: string;
  transform: ForkTransform;
}

function transformScalar(v: unknown, t: ForkTransform): unknown {
  if (v === null || v === undefined) return v;
  const s = String(v);
  switch (t) {
    case "date":
      return normalizeDate(s);
    case "strip-links":
      return stripWikilinks(s);
    case "wrap-links":
      return /^\[\[.*\]\]$/.test(s.trim()) ? s : `[[${stripWikilinks(s)}]]`;
    default:
      return v;
  }
}

export function transformValue(v: unknown, t: ForkTransform): unknown {
  if (Array.isArray(v)) return v.map((x) => transformScalar(x, t));
  return transformScalar(v, t);
}

/* ---------- one-shot apply ---------- */

export class ForkPropertyPicker extends FuzzySuggestModal<PropertyUsage> {
  private plugin: BasesToolboxPlugin;

  constructor(plugin: BasesToolboxPlugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.setPlaceholder("Pick a property to convert or fork…");
  }

  getItems(): PropertyUsage[] {
    return this.plugin.propertyCache.get();
  }

  getItemText(item: PropertyUsage): string {
    return `${item.name} (${item.count} file${item.count === 1 ? "" : "s"})`;
  }

  onChooseItem(item: PropertyUsage): void {
    new ForkModal(this.plugin, item).open();
  }
}

class ForkModal extends Modal {
  private plugin: BasesToolboxPlugin;
  private usage: PropertyUsage;
  private transform: ForkTransform = "date";
  private mode: "in-place" | "fork" = "fork";
  private liveSync = false;
  private targetEl: HTMLInputElement | null = null;
  private forkSettings: Setting[] = [];
  private previewEl: HTMLElement | null = null;
  private running = false;

  constructor(plugin: BasesToolboxPlugin, usage: PropertyUsage) {
    super(plugin.app);
    this.plugin = plugin;
    this.usage = usage;
  }

  onOpen(): void {
    this.titleEl.setText(`Convert / fork: ${this.usage.name}`);
    const { contentEl } = this;

    new Setting(contentEl).setName("Transform").addDropdown((dd) => {
      for (const [k, label] of Object.entries(TRANSFORM_LABELS)) dd.addOption(k, label);
      dd.setValue(this.transform);
      dd.onChange((v) => {
        this.transform = v as ForkTransform;
        this.updatePreview();
      });
    });

    new Setting(contentEl)
      .setName("Where to write")
      .setDesc("Fork keeps your original untouched and adds a second property in the new format.")
      .addDropdown((dd) => {
        dd.addOption("fork", "Fork into a new property (keep both)");
        dd.addOption("in-place", "Convert in place (replace the values)");
        dd.setValue(this.mode);
        dd.onChange((v) => {
          this.mode = v as "in-place" | "fork";
          for (const s of this.forkSettings) s.settingEl.setCssStyles({ display: v === "fork" ? "" : "none" });
          this.updatePreview();
        });
      });

    this.forkSettings.push(
      new Setting(contentEl).setName("Fork property name").addText((t) => {
        t.setValue(`${this.usage.name}-bases`);
        this.targetEl = t.inputEl;
      }),
      new Setting(contentEl)
        .setName("Keep in live sync")
        .setDesc("Whenever the original property changes, the fork is recomputed automatically. Manage active syncs in the plugin settings.")
        .addToggle((t) => t.setValue(this.liveSync).onChange((v) => (this.liveSync = v)))
    );

    this.previewEl = contentEl.createDiv({ cls: "bases-toolbox-fr-info" });
    this.updatePreview();

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Apply").setCta().onClick(() => void this.apply())
    );
  }

  private updatePreview(): void {
    if (!this.previewEl) return;
    const samples = [...this.usage.values.keys()].slice(0, 3);
    const lines = samples.map(
      (s) => `${s} → ${valueToDisplay(transformScalar(s, this.transform))}`
    );
    this.previewEl.setText(
      `${this.usage.count} file${this.usage.count === 1 ? "" : "s"}. Preview: ${lines.join("   ·   ")}`
    );
  }

  private async apply(): Promise<void> {
    if (this.running) return;
    const target = this.mode === "fork" ? (this.targetEl?.value.trim() ?? "") : this.usage.name;
    if (!target || isUnsafeKey(target)) {
      new Notice("Give the fork a valid property name.");
      return;
    }
    this.running = true;
    try {
      const changes = await applyFork(this.plugin, {
        source: this.usage.name,
        target,
        transform: this.transform,
      });
      if (this.mode === "fork" && this.liveSync) {
        this.plugin.settings.propertyForks.push({
          source: this.usage.name,
          target,
          transform: this.transform,
        });
        await this.plugin.savePluginData();
      }
      new Notice(
        `${this.usage.name}: ${this.mode === "fork" ? `forked into "${target}"` : "converted"} in ${changes} file${changes === 1 ? "" : "s"}.` +
          (this.mode === "fork" && this.liveSync ? " Live sync is on." : "")
      );
      this.close();
    } finally {
      this.running = false;
    }
  }
}

/** Applies a fork/convert to every file carrying the source property. */
export async function applyFork(
  plugin: BasesToolboxPlugin,
  def: PropertyForkDef,
  files?: TFile[]
): Promise<number> {
  const usage = plugin.propertyCache.usage(def.source);
  const targets = files ?? usage?.files ?? [];
  const changes: ChangeRecord[] = [];
  for (const file of targets) {
    await plugin.app.fileManager.processFrontMatter(file, (fm) => {
      const sourceKey = findKey(fm, def.source);
      if (sourceKey === null) return;
      const next = transformValue(fm[sourceKey], def.transform);
      const targetKey = findKey(fm, def.target) ?? def.target;
      const cur = Object.prototype.hasOwnProperty.call(fm, targetKey) ? fm[targetKey] : undefined;
      if (JSON.stringify(cur) === JSON.stringify(next)) return; // already in sync
      changes.push({
        path: file.path,
        property: def.target,
        oldValue: cur === undefined ? undefined : Array.isArray(cur) ? cur.slice() : cur,
        newValue: Array.isArray(next) ? next.slice() : next,
        ...(cur === undefined ? { created: true } : {}),
      });
      fm[targetKey] = next;
    });
  }
  if (changes.length) {
    await plugin.addHistoryEntry({
      property: def.target,
      find: null,
      replace: TRANSFORM_LABELS[def.transform],
      timestamp: Date.now(),
      changes,
      source: def.source === def.target ? "convert in place" : `fork of ${def.source}`,
    });
  }
  return changes.length;
}

/* ---------- live sync ---------- */

const syncing = new Set<string>();

export function installForkSync(plugin: BasesToolboxPlugin): void {
  plugin.registerEvent(
    plugin.app.metadataCache.on("changed", (file) => {
      if (!plugin.settings.propertyForks.length) return;
      if (!(file instanceof TFile) || file.extension !== "md") return;
      if (syncing.has(file.path)) return; // our own write triggered this event
      const fm = (plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<
        string,
        unknown
      >;
      for (const def of plugin.settings.propertyForks) {
        const sourceKey = findKey(fm, def.source);
        if (sourceKey === null) continue;
        const next = transformValue(fm[sourceKey], def.transform);
        const targetKey = findKey(fm, def.target) ?? def.target;
        const cur = Object.prototype.hasOwnProperty.call(fm, targetKey) ? fm[targetKey] : undefined;
        if (JSON.stringify(cur) === JSON.stringify(next)) continue;
        syncing.add(file.path);
        void plugin.app.fileManager
          .processFrontMatter(file, (liveFm) => {
            const sk = findKey(liveFm, def.source);
            if (sk === null) return;
            const value = transformValue(liveFm[sk], def.transform);
            liveFm[findKey(liveFm, def.target) ?? def.target] = value;
          })
          .finally(() => window.setTimeout(() => syncing.delete(file.path), 500));
      }
    })
  );
}
