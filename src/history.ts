import { Modal, Notice, Setting, TFile } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { findKey } from "./scan";
import { HistoryEntry } from "./types";

interface RevertReport {
  restored: number;
  /** Property gone from the file (deleted or renamed) — left alone. */
  propertyMissing: number;
  /** Value edited again since the operation — left alone. */
  valueChanged: number;
  /** File deleted or moved. */
  fileMissing: number;
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Best-effort revert: a file is only restored when the property still exists
 * in it and still holds the value the operation wrote. Renamed properties,
 * re-edited values, and missing files are skipped and counted, not clobbered.
 */
export async function revertEntry(
  plugin: BasesToolboxPlugin,
  entry: HistoryEntry
): Promise<RevertReport> {
  const report: RevertReport = { restored: 0, propertyMissing: 0, valueChanged: 0, fileMissing: 0 };
  for (const change of entry.changes) {
    const file = plugin.app.vault.getAbstractFileByPath(change.path);
    if (!(file instanceof TFile)) {
      report.fileMissing++;
      continue;
    }
    await plugin.app.fileManager.processFrontMatter(file, (fm) => {
      const key = findKey(fm, change.property);
      if (key === null) {
        report.propertyMissing++;
        return;
      }
      // Legacy entries (no newValue recorded) revert unconditionally.
      if (change.newValue !== undefined && !sameValue(fm[key], change.newValue)) {
        report.valueChanged++;
        return;
      }
      if (change.created) delete fm[key];
      else fm[key] = change.oldValue;
      report.restored++;
    });
  }
  entry.revertedAt = Date.now();
  await plugin.savePluginData();
  return report;
}

export function reportNotice(entry: HistoryEntry, r: RevertReport): void {
  const skipped: string[] = [];
  if (r.valueChanged) skipped.push(`${r.valueChanged} edited since`);
  if (r.propertyMissing) skipped.push(`${r.propertyMissing} property missing`);
  if (r.fileMissing) skipped.push(`${r.fileMissing} file missing`);
  new Notice(
    `Reverted “${entry.property}” in ${r.restored} of ${entry.changes.length} file${
      entry.changes.length === 1 ? "" : "s"
    }${skipped.length ? ` (skipped: ${skipped.join(", ")})` : ""}.`
  );
}

/** Reverts the newest entry that hasn't been reverted yet. */
export async function undoLatest(plugin: BasesToolboxPlugin): Promise<void> {
  const entry = [...plugin.history].reverse().find((e) => !e.revertedAt);
  if (!entry) {
    new Notice("Nothing to undo.");
    return;
  }
  reportNotice(entry, await revertEntry(plugin, entry));
}

export function describeEntry(entry: HistoryEntry): string {
  const from = entry.find === null ? "all values" : `“${entry.find}”`;
  const to = entry.replace.trim() === "" ? "(cleared)" : `“${entry.replace}”`;
  return `${entry.property}: ${from} → ${to}`;
}

export class HistoryModal extends Modal {
  private plugin: BasesToolboxPlugin;

  constructor(plugin: BasesToolboxPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.setText("Find & replace history");
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    if (!this.plugin.history.length) {
      contentEl.createDiv({ cls: "bases-toolbox-fr-info", text: "No operations yet." });
      return;
    }

    contentEl.createDiv({
      cls: "bases-toolbox-fr-info",
      text: "Reverts are best-effort: files whose value was edited again, whose property was renamed or removed, or that no longer exist are skipped.",
    });

    new Setting(contentEl)
      .setName(`${this.plugin.history.length} operation${this.plugin.history.length === 1 ? "" : "s"} logged`)
      .addButton((b) => {
        let armed = false;
        b.setButtonText("Clear history").onClick(async () => {
          if (!armed) {
            armed = true;
            b.setButtonText("Click again to confirm");
            b.buttonEl.addClass("mod-warning");
            return;
          }
          await this.plugin.clearHistory();
          this.render();
        });
      });

    for (const entry of [...this.plugin.history].reverse()) {
      const n = entry.changes.length;
      const when = new Date(entry.timestamp).toLocaleString();
      const setting = new Setting(contentEl)
        .setName(describeEntry(entry))
        .setDesc(`${when} · ${n} file${n === 1 ? "" : "s"} changed`);
      if (entry.revertedAt) {
        setting.controlEl.createSpan({
          cls: "bases-toolbox-history-reverted",
          text: "reverted",
        });
      } else {
        setting.addButton((b) =>
          b.setButtonText("Revert").onClick(async () => {
            b.setDisabled(true);
            reportNotice(entry, await revertEntry(this.plugin, entry));
            this.render();
          })
        );
      }
    }
  }
}
