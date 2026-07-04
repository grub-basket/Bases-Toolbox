import { Modal, Notice, Setting, TFile, parseYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { openFindReplaceView } from "./find-replace-view";
import { PropertyUsage, findKey, valueToDisplay } from "./scan";

/**
 * Pinned allowed values per property: a value picker appears when editing a
 * pinned property (frontmatter panel or Bases cell), and an audit command
 * reports values outside the pinned set.
 *
 * Prior art: Better Properties (https://github.com/unxok/obsidian-better-properties)
 * and Metadata Menu (https://github.com/mdelobelle/metadatamenu) offer richer
 * select-style fields; this is the lightweight, Bases-friendly slice.
 */

export function allowedFor(plugin: BasesToolboxPlugin, property: string): string[] | null {
  return plugin.settings.allowedValues[property.toLowerCase()] ?? null;
}

/**
 * Values of a pinned property that fall outside its allowed list (the same test
 * the audit uses, so the pin's red flag and the audit always agree). Empty if
 * the property isn't pinned.
 */
export function pinViolations(plugin: BasesToolboxPlugin, usage: PropertyUsage): [string, number][] {
  const allowed = allowedFor(plugin, usage.name);
  if (!allowed) return [];
  return [...usage.values.entries()].filter(([v]) => !allowed.includes(v));
}

/** Does any pinned property currently have a value outside its allowed list? */
export function anyPinViolations(plugin: BasesToolboxPlugin): boolean {
  for (const property of Object.keys(plugin.settings.allowedValues)) {
    const usage = plugin.propertyCache.usage(property);
    if (usage && pinViolations(plugin, usage).length) return true;
  }
  return false;
}

/* ---------- pin configuration ---------- */

export class PinValuesModal extends Modal {
  private plugin: BasesToolboxPlugin;
  private usage: PropertyUsage;
  private checks = new Map<string, HTMLInputElement>();
  private extraEl: HTMLTextAreaElement | null = null;

  constructor(plugin: BasesToolboxPlugin, usage: PropertyUsage) {
    super(plugin.app);
    this.plugin = plugin;
    this.usage = usage;
  }

  onOpen(): void {
    this.titleEl.setText(`Pin allowed values: ${this.usage.name}`);
    const { contentEl } = this;
    const pinned = allowedFor(this.plugin, this.usage.name);

    contentEl.createDiv({
      cls: "bases-toolbox-fr-info",
      text: "Pinned values appear as a picker when editing this property, and the audit command flags anything outside the list.",
    });

    const list = contentEl.createDiv({ cls: "bases-toolbox-pin-list" });
    for (const [display, count] of [...this.usage.values.entries()].sort((a, b) => b[1] - a[1])) {
      const row = list.createDiv({ cls: "bases-toolbox-dup-row" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = pinned ? pinned.includes(display) : true;
      this.checks.set(display, cb);
      row.createSpan({ text: ` ${display} ` });
      row.createSpan({ cls: "bases-toolbox-index-prop-count", text: String(count) });
    }

    new Setting(contentEl)
      .setName("Additional allowed values")
      .setDesc("One per line — values that are allowed but not currently used.")
      .addTextArea((t) => {
        const extras = (pinned ?? []).filter((v) => !this.usage.values.has(v));
        t.setValue(extras.join("\n"));
        this.extraEl = t.inputEl;
      });

    const buttons = new Setting(contentEl);
    buttons.addButton((b) =>
      b
        .setButtonText("Save pin")
        .setCta()
        .onClick(async () => {
          const values = [...this.checks.entries()].filter(([, cb]) => cb.checked).map(([v]) => v);
          for (const line of (this.extraEl?.value ?? "").split("\n")) {
            const v = line.trim();
            if (v && !values.includes(v)) values.push(v);
          }
          this.plugin.settings.allowedValues[this.usage.name.toLowerCase()] = values;
          await this.plugin.savePluginData();
          new Notice(`Pinned ${values.length} allowed value${values.length === 1 ? "" : "s"} for ${this.usage.name}.`);
          this.close();
        })
    );
    if (pinned) {
      buttons.addButton((b) =>
        b.setButtonText("Clear pin").onClick(async () => {
          delete this.plugin.settings.allowedValues[this.usage.name.toLowerCase()];
          await this.plugin.savePluginData();
          new Notice(`Cleared the pin for ${this.usage.name}.`);
          this.close();
        })
      );
    }
  }
}

/* ---------- value picker on focus ---------- */

let menuEl: HTMLElement | null = null;

function dismissMenu(): void {
  menuEl?.remove();
  menuEl = null;
}

/** Resolves what property (and file) an editable element edits, cheaply. */
function resolveEditor(
  plugin: BasesToolboxPlugin,
  el: HTMLElement
): { file: TFile; property: string } | null {
  const prop = el.closest<HTMLElement>(".metadata-property");
  if (prop) {
    // Only offer the value picker on the VALUE side of the row — never when
    // editing the property NAME/key (the key input is its own field).
    if (el.closest(".metadata-property-key")) return null;
    const key = prop.getAttribute("data-property-key");
    const file = plugin.app.workspace.getActiveFile();
    return key && file ? { file, property: key } : null;
  }
  return null; // Bases cells are resolved async in showPickerForBasesCell
}

async function resolveBasesCellSync(
  plugin: BasesToolboxPlugin,
  td: HTMLElement
): Promise<{ file: TFile; property: string } | null> {
  const app = plugin.app;
  const row = td.closest(".bases-tr");
  const href = row?.querySelector("[data-href]")?.getAttribute("data-href");
  const file = href ? app.vault.getAbstractFileByPath(href) : null;
  if (!(file instanceof TFile)) return null;
  const embed = td.closest(".bases-embed");
  const baseFile = embed
    ? app.metadataCache.getFirstLinkpathDest(
        (embed.getAttribute("src") ?? "").split("#")[0],
        app.workspace.getActiveFile()?.path ?? ""
      )
    : app.workspace.getActiveFile();
  if (!(baseFile instanceof TFile) || baseFile.extension !== "base") return null;
  try {
    const doc = (parseYaml(await app.vault.read(baseFile)) ?? {}) as Record<string, unknown>;
    const views = Array.isArray(doc.views) ? (doc.views as Record<string, unknown>[]) : [];
    const scope = (embed ?? td.closest(".view-content")) as HTMLElement | null;
    const label = scope?.querySelector(".bases-toolbar-views-menu")?.textContent?.trim();
    const view = views.find((v) => v.name === label) ?? views[0];
    const order = Array.isArray(view?.order) ? (view.order as unknown[]) : [];
    const index = row ? Array.from(row.querySelectorAll(".bases-td")).indexOf(td) : -1;
    const raw = order[index];
    if (typeof raw !== "string" || raw.startsWith("file.") || raw.startsWith("formula.")) return null;
    return { file, property: raw.replace(/^note\./, "") };
  } catch {
    return null;
  }
}

function showPicker(
  plugin: BasesToolboxPlugin,
  anchor: HTMLElement,
  file: TFile,
  property: string,
  values: string[]
): void {
  dismissMenu();
  const rect = anchor.getBoundingClientRect();
  menuEl = activeDocument.body.createDiv({ cls: "bases-toolbox-picker" });
  menuEl.setCssStyles({ left: `${rect.left}px`, top: `${rect.bottom + 2}px` });
  for (const value of values) {
    const item = menuEl.createDiv({ cls: "bases-toolbox-picker-item", text: value });
    // mousedown fires before the input's blur, so the pick isn't lost
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      void plugin.app.fileManager.processFrontMatter(file, (fm) => {
        const key = findKey(fm, property) ?? property;
        const cur = fm[key];
        if (Array.isArray(cur)) {
          if (!cur.some((x) => valueToDisplay(x) === value)) cur.push(value);
          fm[key] = cur;
        } else fm[key] = value;
      });
      dismissMenu();
    });
  }
}

export function installAllowedValuePicker(plugin: BasesToolboxPlugin): void {
  plugin.registerDomEvent(
    activeDocument,
    "focusin",
    (e: FocusEvent) => {
      dismissMenu();
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      const editable =
        el.instanceOf(HTMLInputElement) || el.instanceOf(HTMLTextAreaElement) || el.isContentEditable;
      if (!editable) return;

      const direct = resolveEditor(plugin, el);
      if (direct) {
        const values = allowedFor(plugin, direct.property);
        if (values?.length) showPicker(plugin, el, direct.file, direct.property, values);
        return;
      }
      const td = el.closest<HTMLElement>(".bases-td");
      if (!td) return;
      void resolveBasesCellSync(plugin, td).then((resolved) => {
        if (!resolved) return;
        // Bases juggles focus while opening the inline editor, so accept any
        // focus that is still inside the same cell (and anchor to it).
        const ae = activeDocument.activeElement;
        const anchor =
          ae instanceof HTMLElement && td.contains(ae) ? ae : el.isConnected ? el : null;
        if (!anchor) return;
        const values = allowedFor(plugin, resolved.property);
        if (values?.length) showPicker(plugin, anchor, resolved.file, resolved.property, values);
      });
    },
    { capture: true }
  );
  plugin.registerDomEvent(
    activeDocument,
    "focusout",
    () =>
      window.setTimeout(() => {
        // Keep the picker while focus stays inside an editable cell/property —
        // dismissing on every focus transition would kill the picker the
        // moment it opens (focus moving INTO the editor is itself a focusout).
        const ae = activeDocument.activeElement;
        if (ae instanceof HTMLElement && ae.closest(".bases-td, .metadata-property")) return;
        dismissMenu();
      }, 150),
    { capture: true }
  );
  plugin.registerDomEvent(activeDocument, "keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") dismissMenu();
  });
  plugin.register(dismissMenu);
}

/* ---------- audit ---------- */

export class AllowedValuesAuditModal extends Modal {
  private plugin: BasesToolboxPlugin;

  constructor(plugin: BasesToolboxPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.setText("Pinned allowed-values audit");
    const { contentEl } = this;
    const pins = Object.entries(this.plugin.settings.allowedValues);
    if (!pins.length) {
      contentEl.createDiv({
        cls: "bases-toolbox-fr-info",
        text: "No pinned properties yet. Pin allowed values from the property index (pin icon).",
      });
      return;
    }

    let total = 0;
    for (const [property, allowed] of pins) {
      const usage = this.plugin.propertyCache.usage(property);
      if (!usage) continue;
      const bad = [...usage.values.entries()].filter(([v]) => !allowed.includes(v));
      if (!bad.length) continue;
      new Setting(contentEl).setName(usage.name).setHeading();
      for (const [value, count] of bad) {
        total++;
        new Setting(contentEl)
          .setName(value)
          .setDesc(`${count} file${count === 1 ? "" : "s"} — not in the allowed list`)
          .addButton((b) =>
            b.setButtonText("Find & replace").onClick(() => {
              void openFindReplaceView(this.plugin, usage.name, value);
              this.close();
            })
          );
      }
    }
    if (!total) {
      contentEl.createDiv({
        cls: "bases-toolbox-fr-info",
        text: `All values of ${pins.length} pinned propert${pins.length === 1 ? "y" : "ies"} are within their allowed lists.`,
      });
    }
  }
}
