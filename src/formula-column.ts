import { FuzzySuggestModal, Modal, Notice, Setting, TFile, parseYaml, stringifyYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { activeBaseView } from "./base-detect";
import { FormulaField, formulaLanguageExtension, mountFormulaField } from "./formula-editor";
import type { Extension } from "@codemirror/state";

/**
 * Add / fix a base FORMULA column by editing the `.base` file directly.
 *
 * Bases stores computed columns as a top-level `formulas:` map ( `name: expr` )
 * referenced in a view's `order:` as `formula.<name>`. A plugin can't inject a
 * computed column through a live API (Bases only exposes view-type factories),
 * but the `.base` file IS the API — so we read/mutate/write it (same approach as
 * the filter toggle).
 *
 * This also works around a real Obsidian bug: a formula column created with an
 * EMPTY expression glitches into an un-editable state — you can't type an
 * expression into it, and reopening the base / restarting doesn't clear it, so
 * the only in-app fix is delete + recreate. Because we edit the file, we can (a)
 * refuse to ever write an empty formula, and (b) repair an already-broken empty
 * one by writing an expression straight into the file.
 */

/** Valid `formula.<name>` reference needs a dotted-path-safe key. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type ViewNode = Record<string, unknown> & { name?: unknown; order?: unknown };

export function openFormulaColumn(plugin: BasesToolboxPlugin): void {
  const active = activeBaseView(plugin.app)?.file ?? plugin.app.workspace.getActiveFile();
  if (active?.extension === "base") {
    new FormulaColumnModal(plugin, active).open();
  } else {
    new FormulaBasePickerModal(plugin).open();
  }
}

class FormulaBasePickerModal extends FuzzySuggestModal<TFile> {
  constructor(private plugin: BasesToolboxPlugin) {
    super(plugin.app);
    this.setPlaceholder("Pick a base to add a formula column to…");
  }
  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((f) => f.extension === "base");
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    new FormulaColumnModal(this.plugin, f).open();
  }
}

export class FormulaColumnModal extends Modal {
  private newName = "";
  private addToView = "__all__"; // view name, "__all__", or "__none__"
  private fields: FormulaField[] = [];
  private newField: FormulaField | null = null;

  constructor(
    private plugin: BasesToolboxPlugin,
    private file: TFile
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText(`Formula columns: ${this.file.basename}`);
    void this.render();
  }

  onClose(): void {
    for (const f of this.fields) f.destroy();
    this.fields = [];
    this.newField = null;
  }

  private track(f: FormulaField): FormulaField {
    this.fields.push(f);
    return f;
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    for (const f of this.fields) f.destroy();
    this.fields = [];
    contentEl.empty();

    let doc: Record<string, unknown>;
    try {
      doc = (parseYaml(await this.app.vault.read(this.file)) ?? {}) as Record<string, unknown>;
    } catch {
      contentEl.createDiv({ cls: "bases-toolbox-fr-warning", text: "Could not parse this .base file." });
      return;
    }

    const formulas = (doc.formulas ?? {}) as Record<string, unknown>;
    const views = (Array.isArray(doc.views) ? doc.views : []) as ViewNode[];
    // Obsidian's own formula editor extension (autocomplete + validation) —
    // available only while the base is open; null → plain-input fallback.
    const ext: Extension | null = formulaLanguageExtension(this.plugin.app, this.file);

    contentEl.createDiv({
      cls: "bases-toolbox-fr-info",
      text:
        "A formula is a computed column, written straight into the .base file as “formula.<name>”. " +
        "Editing here also fixes Obsidian's empty-formula glitch (a blank formula the Bases UI won't let you edit).",
    });
    contentEl.createDiv({
      cls: "bases-toolbox-fr-info",
      text: ext
        ? "These fields are Obsidian's own formula editor — autocomplete (functions + property/column names) and inline syntax validation as you type. Formula Forge is complementary: reusable global functions + rendering formulas in notes."
        : "Open this base in a tab to get Obsidian's formula autocomplete + validation in these fields; otherwise they're plain text (no syntax check here). Formula Forge adds reusable global functions + note-body rendering.",
    });

    // ---- Existing formulas: edit expression / repair empty / remove ----
    const names = Object.keys(formulas);
    if (names.length) {
      new Setting(contentEl).setName("Existing formulas").setHeading();
      for (const name of names) {
        const expr = typeof formulas[name] === "string" ? (formulas[name] as string) : "";
        const isEmpty = expr.trim() === "";
        const setting = new Setting(contentEl).setName(`formula.${name}`);
        if (isEmpty) {
          setting.setDesc("⚠ Empty — this is the glitched state Bases can't edit. Enter an expression to repair it.");
          setting.descEl.addClass("bases-toolbox-fr-warning");
        }
        const field = this.track(
          mountFormulaField(setting.controlEl, expr, ext, { placeholder: "e.g. file.ctime" })
        );
        setting.addExtraButton((b) =>
          b
            .setIcon("check")
            .setTooltip("Save this expression")
            .onClick(() =>
              void (async () => {
                const draft = field.getValue();
                if (draft === "") {
                  new Notice("Empty formulas trigger the Bases glitch — enter an expression, or remove the formula.");
                  return;
                }
                await this.rewriteBase((d) => {
                  const f = (d.formulas ?? {}) as Record<string, unknown>;
                  f[name] = draft;
                  d.formulas = f;
                  return true;
                });
                new Notice(`Saved formula.${name}.`);
                void this.render();
              })()
            )
        );
        setting.addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("Remove this formula (and its column from every view)")
            .onClick(() =>
              void (async () => {
                await this.rewriteBase((d) => this.removeFormula(d, name));
                new Notice(`Removed formula.${name}.`);
                void this.render();
              })()
            )
        );
      }
    }

    // ---- Add a new formula column ----
    new Setting(contentEl).setName("Add a formula column").setHeading();

    new Setting(contentEl)
      .setName("Name")
      .setDesc("Letters, digits, underscore. Referenced as “formula.<name>”.")
      .addText((t) =>
        t.setPlaceholder("created").onChange((v) => (this.newName = v.trim()))
      );

    const formulaSetting = new Setting(contentEl)
      .setName("Formula")
      .setDesc("A Bases expression, e.g. file.ctime, or note.price * 1.2. Must not be empty.");
    this.newField = this.track(
      mountFormulaField(formulaSetting.controlEl, "", ext, { placeholder: "file.ctime" })
    );

    new Setting(contentEl)
      .setName("Show in")
      .setDesc("Add the column to a view's order. Views without an explicit order are left alone (add the column from the base UI).")
      .addDropdown((dd) => {
        dd.addOption("__all__", "All views");
        for (const v of views) {
          const n = typeof v.name === "string" ? v.name : "";
          if (n) dd.addOption(n, `View: ${n}`);
        }
        dd.addOption("__none__", "Just define it (don't add a column)");
        dd.setValue(this.addToView);
        dd.onChange((v) => (this.addToView = v));
      });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Add formula column")
        .setCta()
        .onClick(() => void this.addFormula())
    );
  }

  private async addFormula(): Promise<void> {
    const name = this.newName;
    const expr = (this.newField?.getValue() ?? "").trim();
    if (!NAME_RE.test(name)) {
      new Notice("Give the formula a simple name (letters, digits, underscore; can't start with a digit).");
      return;
    }
    if (expr === "") {
      // The whole point: never create the empty formula that glitches Bases.
      new Notice("Enter a formula expression — an empty formula triggers the Obsidian bug this feature avoids.");
      return;
    }

    let clash = false;
    let addedToView = false;
    await this.rewriteBase((doc) => {
      const formulas = (doc.formulas ?? {}) as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(formulas, name)) {
        clash = true;
        return false;
      }
      formulas[name] = expr;
      doc.formulas = formulas;

      const ref = `formula.${name}`;
      const views = (Array.isArray(doc.views) ? doc.views : []) as ViewNode[];
      const addToOrder = (v: ViewNode) => {
        if (!Array.isArray(v.order)) return; // don't fabricate an order (would hide other columns)
        const order = v.order as unknown[];
        if (!order.includes(ref)) order.push(ref);
        addedToView = true;
      };
      if (this.addToView === "__all__") views.forEach(addToOrder);
      else if (this.addToView !== "__none__") {
        const v = views.find((x) => x.name === this.addToView);
        if (v) addToOrder(v);
      }
      return true;
    });

    if (clash) {
      new Notice(`A formula named “${name}” already exists — edit it above.`);
      return;
    }
    new Notice(
      `Added formula.${name}.` +
        (this.addToView === "__none__"
          ? " Defined only — add the column from the base's column menu."
          : addedToView
            ? " Column added."
            : " (That view has no explicit column order — add the column from the base UI.)")
    );
    this.newName = "";
    void this.render();
  }

  /** Deletes a formula and strips its `formula.<name>` column from every view. */
  private removeFormula(doc: Record<string, unknown>, name: string): boolean {
    const formulas = (doc.formulas ?? {}) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(formulas, name)) return false;
    delete formulas[name];
    if (Object.keys(formulas).length === 0) delete doc.formulas;
    else doc.formulas = formulas;
    const ref = `formula.${name}`;
    const views = (Array.isArray(doc.views) ? doc.views : []) as ViewNode[];
    for (const v of views) {
      if (!Array.isArray(v.order)) continue;
      v.order = (v.order as unknown[]).filter((c) => c !== ref);
    }
    return true;
  }

  /** read → parseYaml → mutate → stringifyYaml → write. Returns whether it wrote. */
  private async rewriteBase(mutate: (doc: Record<string, unknown>) => boolean): Promise<boolean> {
    const raw = await this.app.vault.read(this.file);
    let doc: Record<string, unknown>;
    try {
      doc = (parseYaml(raw) ?? {}) as Record<string, unknown>;
    } catch {
      new Notice("Could not parse this .base file.");
      return false;
    }
    if (!mutate(doc)) return false;
    await this.app.vault.modify(this.file, stringifyYaml(doc));
    return true;
  }
}
