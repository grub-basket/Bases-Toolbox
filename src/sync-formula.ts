import { Modal, Notice, Setting, TFile, parseYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { activeBaseView, type BaseViewLike } from "./base-detect";
import { findKey, isUnsafeKey } from "./scan";
import { ChangeRecord } from "./types";
import {
  type FormulaDef,
  entrySupportsFormulas,
  formulasFromDoc,
  readFormulaValue,
} from "./formula-value";

/**
 * The active base's live results as file → results-entry, its display name, and
 * the `.base` file backing it. Mirrors the defensive `controller.results` access
 * that Bulk Edit and Compute Rollup already use — undocumented Bases internals,
 * probed so a core change degrades to a clear notice instead of wrong behavior.
 */
type EntriesTarget = { name: string; baseFile: TFile; entries: Map<TFile, unknown> };

function activeBaseResultEntries(plugin: BasesToolboxPlugin): EntriesTarget | null {
  const view = activeBaseView(plugin.app);
  if (!view) return null;
  const results = (view as BaseViewLike).controller?.results;
  if (!(results instanceof Map)) return null;
  const entries = new Map<TFile, unknown>();
  for (const [f, entry] of results.entries()) {
    if (f instanceof TFile && f.extension === "md") entries.set(f, entry);
  }
  return { name: view.file.basename, baseFile: view.file, entries };
}

/** The formulas a `.base` defines (top-level `formulas:` map, name → expression). */
async function readFormulas(plugin: BasesToolboxPlugin, baseFile: TFile): Promise<FormulaDef[]> {
  try {
    return formulasFromDoc(parseYaml(await plugin.app.vault.read(baseFile)));
  } catch {
    /* empty / unparseable base */
    return [];
  }
}

/**
 * One-shot formula sync: for every note in the active base's results, evaluate a
 * formula column via the live Bases engine and write the result into a real
 * frontmatter property — which Bases (and everything else) can then read as a
 * plain value. Logged in history, so the whole run is revertible. Re-run to
 * refresh. The sibling of Compute Rollup, for computed columns instead of links.
 */
export async function openSyncFormula(plugin: BasesToolboxPlugin): Promise<void> {
  const target = activeBaseResultEntries(plugin);
  if (!target) {
    new Notice(
      "Open a base first — formulas are synced from a base's results. (If a base IS open, Obsidian's internals may have changed; tell the plugin author.)"
    );
    return;
  }
  if (!target.entries.size) {
    new Notice("The base has no markdown results.");
    return;
  }
  const formulas = await readFormulas(plugin, target.baseFile);
  if (!formulas.length) {
    new Notice("This base defines no formulas. Add a formula to the base first, then sync it into a property.");
    return;
  }
  new SyncFormulaModal(plugin, target, formulas).open();
}

class SyncFormulaModal extends Modal {
  private plugin: BasesToolboxPlugin;
  private target: EntriesTarget;
  private formulas: FormulaDef[];
  private formula: string;
  private targetPropEl: HTMLInputElement | null = null;
  private running = false;

  constructor(plugin: BasesToolboxPlugin, target: EntriesTarget, formulas: FormulaDef[]) {
    super(plugin.app);
    this.plugin = plugin;
    this.target = target;
    this.formulas = formulas;
    this.formula = formulas[0].name;
  }

  onOpen(): void {
    const n = this.target.entries.size;
    this.titleEl.setText(`Sync formula: ${this.target.name} (${n} file${n === 1 ? "" : "s"})`);
    const { contentEl } = this;

    new Setting(contentEl)
      .setName("Formula")
      .setDesc("The computed column to evaluate for each result.")
      .addDropdown((dd) => {
        for (const f of this.formulas) dd.addOption(f.name, `${f.name}  =  ${f.expr}`);
        dd.setValue(this.formula);
        dd.onChange((v) => {
          this.formula = v;
          // Keep the default target-property name in step with the picked formula
          // until the user types their own.
          if (this.targetPropEl && !this.targetPropEl.dataset.touched) this.targetPropEl.value = v;
        });
      });

    new Setting(contentEl)
      .setName("Write into property")
      .setDesc("Created on each result note. Logged in history — revertible. Re-run to refresh.")
      .addText((t) => {
        t.setPlaceholder("e.g. priority-score");
        t.setValue(this.formula);
        this.targetPropEl = t.inputEl;
        t.inputEl.addEventListener("input", () => (t.inputEl.dataset.touched = "1"));
      });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(`Sync for ${n} file${n === 1 ? "" : "s"}`)
        .setCta()
        .onClick(() => void this.apply())
    );
  }

  private async apply(): Promise<void> {
    if (this.running) return;
    const targetProp = this.targetPropEl?.value.trim() ?? "";
    if (!targetProp) {
      new Notice("Name the property to write into.");
      return;
    }
    if (isUnsafeKey(targetProp)) {
      new Notice(`"${targetProp}" is a reserved name and can't be used as a property.`);
      return;
    }
    // Probe the engine once up front: if the results entry doesn't expose the
    // formula-evaluation API, bail with a clear notice rather than writing nulls
    // across the whole base.
    const first = this.target.entries.values().next().value;
    if (!entrySupportsFormulas(first)) {
      new Notice(
        "Couldn't read the base's formula results — Obsidian's internals may have changed. Tell the plugin author."
      );
      return;
    }

    this.running = true;
    try {
      const changes: ChangeRecord[] = [];
      for (const [file, entry] of this.target.entries) {
        const value = readFormulaValue(entry, this.formula);
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
          replace: `sync-formula: ${this.formula}`,
          timestamp: Date.now(),
          changes,
          source: "sync-formula",
        });
      }
      new Notice(`${targetProp}: synced in ${changes.length} of ${this.target.entries.size} files.`);
      this.close();
    } finally {
      this.running = false;
    }
  }
}
