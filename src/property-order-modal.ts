import { Modal, Notice, Setting, TFile, setIcon } from "obsidian";
import type BasesToolboxPlugin from "./main";
import type { BaseViewLike } from "./base-detect";
import { installCfRowDrag, reorderRules } from "./conditional-format";
import { noticeWithUndo } from "./history";
import { ConfirmModal, PromptModal } from "./property-delete";
import {
  OrderScope,
  PropertyOrderPreset,
  SCOPE_LABEL,
  UnlistedMode,
  applyOrder,
  keyCounts,
  planChanges,
  seedList,
  viewFiles,
  viewPropertyColumns,
  wholeBaseFiles,
} from "./property-order";
import { isUnsafeKey } from "./scan";
import { attachPropertySuggest } from "./suggest";

/** Above this many notes to change, ask before writing. */
const CONFIRM_OVER = 200;

export const UNLISTED_LABEL: Record<UnlistedMode, string> = {
  after: "Put them after the listed properties",
  "in-place": "Leave them where they are",
};

/**
 * Opens "Reorder properties". `baseView` is the base the user is looking at
 * (null when there isn't one — then only the whole vault can be the scope).
 */
export function openPropertyOrder(plugin: BasesToolboxPlugin, baseView: BaseViewLike | null): void {
  new PropertyOrderModal(plugin, baseView).open();
}

const lower = (s: string): string => s.toLowerCase();

class PropertyOrderModal extends Modal {
  private scopeFiles = new Map<OrderScope, TFile[]>();
  private orderScope: OrderScope = "vault";
  private counts = new Map<string, { name: string; count: number }>();
  /** The managed order. */
  private list: string[] = [];
  /** Keys the user took out of the list ("don't manage"), lowercase. */
  private removed = new Set<string>();
  private mode: UnlistedMode;
  private loaded: string | null = null;
  private running = false;

  private listEl!: HTMLElement;
  private unmanagedEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private presetEl!: HTMLElement;
  private orderHeading!: Setting;
  private applyBtn: HTMLButtonElement | null = null;

  constructor(
    private plugin: BasesToolboxPlugin,
    private baseView: BaseViewLike | null
  ) {
    super(plugin.app);
    this.mode = plugin.settings.propertyOrderUnlisted === "in-place" ? "in-place" : "after";
  }

  private get baseName(): string | null {
    return this.baseView?.file instanceof TFile ? this.baseView.file.basename : null;
  }

  onOpen(): void {
    this.titleEl.setText("Reorder properties");
    this.modalEl.addClass("bases-toolbox-po-modal");

    // Resolve the scopes this base can offer. Entire vault is always there.
    const vf = viewFiles(this.baseView);
    if (vf) this.scopeFiles.set("view", vf);
    const bf = this.baseView ? wholeBaseFiles(this.app, this.baseView) : null;
    if (bf) this.scopeFiles.set("base", bf);
    this.scopeFiles.set("vault", this.app.vault.getMarkdownFiles());
    this.orderScope = this.scopeFiles.has("view") ? "view" : "vault";

    this.counts = keyCounts(this.app, this.files);
    this.list = seedList(viewPropertyColumns(this.baseView), this.counts);
    this.render();
  }

  private get files(): TFile[] {
    return this.scopeFiles.get(this.orderScope) ?? [];
  }

  /* ---------------------------------------------------------------- render */

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createDiv({
      cls: "bases-toolbox-fr-info",
      text:
        "Sets the order properties appear in inside each note (what Obsidian's Properties view shows). Only the order changes — values stay exactly as they are, and nothing extra is written into your notes. A note missing a property just skips it. Revertible from the bulk file change history.",
    });
    contentEl.createDiv({
      cls: "bases-toolbox-fr-info bases-toolbox-po-yaml-note",
      text: "Heads-up: Obsidian rewrites the frontmatter when it saves it, so YAML comments in the reordered notes are dropped and quoting or spacing may be tidied.",
    });

    // ---- scope ----
    const scopeSetting = new Setting(contentEl).setName("Notes to reorder");
    if (!this.baseView) {
      scopeSetting.setDesc("No base is open, so this runs on every note in the vault. Open a base first to limit it to that base's notes.");
    } else if (!this.scopeFiles.has("base")) {
      scopeSetting.setDesc(`Base: ${this.baseName ?? "?"}. (“Whole base” isn't available on this Obsidian build.)`);
    } else {
      scopeSetting.setDesc(`Base: ${this.baseName ?? "?"}.`);
    }
    scopeSetting.addDropdown((dd) => {
      for (const s of ["view", "base", "vault"] as OrderScope[]) {
        const files = this.scopeFiles.get(s);
        if (!files) continue;
        dd.addOption(s, `${SCOPE_LABEL[s]} — ${files.length} note${files.length === 1 ? "" : "s"}`);
      }
      dd.setValue(this.orderScope);
      dd.onChange((v) => {
        this.orderScope = v as OrderScope;
        this.rescope();
      });
    });

    // ---- saved orders ----
    this.presetEl = contentEl.createDiv();
    this.renderPresets();

    // ---- unlisted ----
    new Setting(contentEl)
      .setName("Properties not in the list")
      .setDesc("What happens to a note's other properties. “Leave them where they are” keeps their positions and shuffles only the listed ones into the slots the listed ones already used.")
      .addDropdown((dd) => {
        for (const m of ["after", "in-place"] as UnlistedMode[]) dd.addOption(m, UNLISTED_LABEL[m]);
        dd.setValue(this.mode);
        dd.onChange((v) => {
          this.mode = v === "in-place" ? "in-place" : "after";
          this.renderPreview();
        });
      });

    // ---- the list ----
    this.orderHeading = new Setting(contentEl).setHeading();
    contentEl.createDiv({
      cls: "bases-toolbox-fr-info",
      text: "Drag the handle, or use the arrow buttons, to set the order. Remove a property to stop managing it (it's then treated as “not in the list”).",
    });
    this.listEl = contentEl.createDiv({ cls: "bases-toolbox-cm-list bases-toolbox-po-list" });

    // ---- add a property by name ----
    let addValue = "";
    const add = () => {
      const name = addValue.trim();
      if (!name) return;
      if (isUnsafeKey(name)) {
        new Notice(`“${name}” is a reserved name and can't be used as a property.`);
        return;
      }
      if (this.list.some((k) => lower(k) === lower(name))) {
        new Notice(`“${name}” is already in the list.`);
        return;
      }
      this.list.push(this.counts.get(lower(name))?.name ?? name);
      this.removed.delete(lower(name));
      addValue = "";
      addInput.value = "";
      this.renderList();
    };
    let addInput!: HTMLInputElement;
    new Setting(contentEl)
      .setName("Add a property")
      .setDesc("Add one these notes don't use yet, or one from another base — it goes to the end of the list.")
      .addText((t) => {
        addInput = t.inputEl;
        t.setPlaceholder("Property name");
        attachPropertySuggest(this.plugin, t.inputEl);
        t.onChange((v) => (addValue = v));
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        });
      })
      .addButton((b) => b.setButtonText("Add").onClick(add));

    this.unmanagedEl = contentEl.createDiv();

    // ---- preview + apply ----
    this.previewEl = contentEl.createDiv({ cls: "bases-toolbox-po-preview" });
    new Setting(contentEl)
      .addButton((b) => {
        this.applyBtn = b.buttonEl;
        b.setButtonText("Apply").setCta().onClick(() => void this.apply());
      })
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));

    this.renderList();
  }

  /** Scope changed: recount, and append keys the new scope brings (unless the
   * user removed them). Keys already listed stay put, even at zero notes. A
   * LOADED saved order is a deliberate list, so nothing is appended to it — the
   * new keys show under "Not in the list" instead (and Update won't grow it). */
  private rescope(): void {
    this.counts = keyCounts(this.app, this.files);
    const have = new Set(this.list.map(lower));
    if (this.loaded) {
      for (const l of this.counts.keys()) if (!have.has(l)) this.removed.add(l);
    }
    const extra = [...this.counts.entries()]
      .filter(([l]) => !have.has(l) && !this.removed.has(l))
      .sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name))
      .map(([, v]) => v.name);
    this.list.push(...extra);
    this.render();
  }

  private renderList(focus?: { key: string; act: string }): void {
    const scrollHost = this.contentEl;
    const top = scrollHost.scrollTop;
    this.listEl.empty();
    this.orderHeading.setName(`Order (${this.list.length})`);
    if (!this.list.length) {
      this.listEl.createDiv({
        cls: "bases-toolbox-fr-info",
        text: "The list is empty — add properties below, or load a saved order.",
      });
    }
    this.list.forEach((key, i) => this.renderRow(key, i));
    this.renderUnmanaged();
    this.renderPreview();
    scrollHost.scrollTop = top;
    if (focus) {
      const row = this.listEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(lower(focus.key))}"]`);
      const btn =
        row?.querySelector<HTMLButtonElement>(`[data-act="${focus.act}"]:not([disabled])`) ??
        row?.querySelector<HTMLButtonElement>("button:not([disabled])");
      btn?.focus();
    }
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, act: string, disabled: boolean, onClick: () => void): void {
    const b = parent.createEl("button", { cls: "clickable-icon bases-toolbox-po-btn", attr: { "aria-label": label, "data-act": act } });
    setIcon(b, icon);
    b.disabled = disabled;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      onClick();
    });
  }

  private renderRow(key: string, index: number): void {
    const row = this.listEl.createDiv({ cls: "bases-toolbox-cm-row bases-toolbox-po-row" });
    row.dataset.key = lower(key);
    const grip = row.createSpan({ cls: "bases-toolbox-cf-grip", attr: { "aria-hidden": "true" } });
    setIcon(grip, "grip-vertical");
    row.createSpan({ cls: "bases-toolbox-po-pos", text: String(index + 1) });
    row.createSpan({ cls: "bases-toolbox-cm-name", text: key });
    const n = this.counts.get(lower(key))?.count ?? 0;
    row.createSpan({ cls: "bases-toolbox-cm-badges", text: `${n} note${n === 1 ? "" : "s"}` });
    const actions = row.createDiv({ cls: "bases-toolbox-cm-actions" });
    const last = this.list.length - 1;
    this.iconButton(actions, "arrow-up", `Move “${key}” up`, "up", index === 0, () => this.move(index, index - 1));
    this.iconButton(actions, "arrow-down", `Move “${key}” down`, "down", index === last, () => this.move(index, index + 1));
    this.iconButton(actions, "x", `Stop managing “${key}”`, "remove", false, () => {
      this.list.splice(index, 1);
      this.removed.add(lower(key));
      const next = this.list[Math.min(index, this.list.length - 1)];
      this.renderList(next ? { key: next, act: "remove" } : undefined);
    });
    installCfRowDrag(row, grip, index, this.list.length, (from, to) => {
      const moved = this.list[from];
      reorderRules(this.list, from, to);
      this.renderList({ key: moved, act: "up" });
    });
  }

  private move(from: number, to: number): void {
    if (to < 0 || to >= this.list.length) return;
    const [k] = this.list.splice(from, 1);
    this.list.splice(to, 0, k);
    this.renderList({ key: k, act: to < from ? "up" : "down" });
  }

  /** Keys in scope that aren't in the list, with a button to put each back. */
  private renderUnmanaged(): void {
    this.unmanagedEl.empty();
    const have = new Set(this.list.map(lower));
    const rest = [...this.counts.entries()]
      .filter(([l]) => !have.has(l))
      .sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name));
    if (!rest.length) return;
    new Setting(this.unmanagedEl).setName(`Not in the list (${rest.length})`).setHeading();
    this.unmanagedEl.createDiv({
      cls: "bases-toolbox-fr-info",
      text: this.mode === "after"
        ? "These keep their relative order, after the listed properties."
        : "These stay where they are in each note.",
    });
    const list = this.unmanagedEl.createDiv({ cls: "bases-toolbox-cm-list" });
    for (const [l, v] of rest) {
      const row = list.createDiv({ cls: "bases-toolbox-cm-row" });
      row.createSpan({ cls: "bases-toolbox-cm-name", text: v.name });
      row.createSpan({ cls: "bases-toolbox-cm-badges", text: `${v.count} note${v.count === 1 ? "" : "s"}` });
      const actions = row.createDiv({ cls: "bases-toolbox-cm-actions" });
      this.iconButton(actions, "plus", `Add “${v.name}” to the end of the list`, "add", false, () => {
        this.list.push(v.name);
        this.removed.delete(l);
        this.renderList();
      });
    }
  }

  private renderPreview(): void {
    const files = this.files;
    const n = planChanges(this.app, files, this.list, this.mode).length;
    this.previewEl.setText(
      `${n} of ${files.length} note${files.length === 1 ? "" : "s"} will change` +
        (n === 0 && files.length ? " — they're already in this order." : ".")
    );
    if (this.applyBtn) this.applyBtn.disabled = n === 0 || this.running;
    // The unmanaged hint depends on the mode too.
    const hint = this.unmanagedEl?.querySelector(".bases-toolbox-fr-info");
    if (hint) {
      hint.setText(
        this.mode === "after"
          ? "These keep their relative order, after the listed properties."
          : "These stay where they are in each note."
      );
    }
  }

  /* --------------------------------------------------------------- presets */

  private renderPresets(): void {
    const el = this.presetEl;
    el.empty();
    const presets = this.plugin.settings.propertyOrders;
    const s = new Setting(el)
      .setName("Saved orders")
      .setDesc(this.loaded ? `Loaded: “${this.loaded}”.` : "Save this order to reuse it — on other bases, or in GridSense (export it from settings).");
    if (presets.length) {
      s.addDropdown((dd) => {
        dd.addOption("", "Load a saved order…");
        for (const p of presets) dd.addOption(p.name, p.name);
        dd.setValue(this.loaded && presets.some((p) => p.name === this.loaded) ? this.loaded : "");
        dd.onChange((v) => {
          const p = presets.find((x) => x.name === v);
          if (p) this.loadPreset(p);
        });
      });
    }
    s.addButton((b) => b.setButtonText("Save as…").onClick(() => this.saveAs()));
    if (this.loaded && presets.some((p) => p.name === this.loaded)) {
      s.addButton((b) =>
        b
          .setButtonText("Update")
          .setTooltip(`Overwrite “${this.loaded}” with the list and setting above`)
          .onClick(() => void this.updateLoaded())
      );
      s.addButton((b) => {
        b.setButtonText("Delete").onClick(() => this.deleteLoaded());
        b.buttonEl.addClass("bases-toolbox-po-danger");
      });
    }
  }

  private snapshot(name: string): PropertyOrderPreset {
    return { name, keys: [...this.list], unlisted: this.mode };
  }

  private loadPreset(p: PropertyOrderPreset): void {
    this.list = [...p.keys].map((k) => this.counts.get(lower(k))?.name ?? k);
    const have = new Set(this.list.map(lower));
    this.removed = new Set([...this.counts.keys()].filter((l) => !have.has(l)));
    this.mode = p.unlisted;
    this.loaded = p.name;
    this.render();
  }

  private saveAs(): void {
    new PromptModal(this.plugin, {
      title: "Save property order",
      body: "Name this order. A saved order with the same name is replaced (you'll be asked first).",
      initial: this.loaded ?? "",
      confirmText: "Save",
      onSubmit: (raw) => {
        const name = raw.trim();
        if (!name) return;
        const presets = this.plugin.settings.propertyOrders;
        const write = async () => {
          const i = presets.findIndex((p) => p.name === name);
          if (i >= 0) presets[i] = this.snapshot(name);
          else presets.push(this.snapshot(name));
          await this.plugin.savePluginData();
          this.loaded = name;
          this.renderPresets();
          new Notice(`Saved property order “${name}”.`);
        };
        if (presets.some((p) => p.name === name)) {
          new ConfirmModal(this.plugin, {
            title: "Replace saved order?",
            body: `A saved order called “${name}” already exists. Replace it with this one?`,
            confirmText: "Replace",
            danger: true,
            onConfirm: () => void write(),
          }).open();
        } else void write();
      },
    }).open();
  }

  private async updateLoaded(): Promise<void> {
    const name = this.loaded;
    if (!name) return;
    const presets = this.plugin.settings.propertyOrders;
    const i = presets.findIndex((p) => p.name === name);
    if (i < 0) return;
    presets[i] = this.snapshot(name);
    await this.plugin.savePluginData();
    new Notice(`Updated saved order “${name}”.`);
  }

  private deleteLoaded(): void {
    const name = this.loaded;
    if (!name) return;
    new ConfirmModal(this.plugin, {
      title: "Delete saved order?",
      body: `Delete the saved order “${name}”? Your notes aren't changed. (Export your orders from settings first if you might want it back.)`,
      confirmText: "Delete",
      danger: true,
      onConfirm: () =>
        void (async () => {
          this.plugin.settings.propertyOrders = this.plugin.settings.propertyOrders.filter((p) => p.name !== name);
          await this.plugin.savePluginData();
          this.loaded = null;
          this.renderPresets();
          new Notice(`Deleted saved order “${name}”.`);
        })(),
    }).open();
  }

  /* ----------------------------------------------------------------- apply */

  private async apply(): Promise<void> {
    if (this.running) return;
    const planned = planChanges(this.app, this.files, this.list, this.mode);
    if (!planned.length) {
      new Notice("Nothing to change — every note is already in this order.");
      return;
    }
    const go = () => void this.run(planned);
    if (planned.length > CONFIRM_OVER) {
      new ConfirmModal(this.plugin, {
        title: "Reorder properties in many notes?",
        body: `This rewrites the frontmatter of ${planned.length} notes (only the order of their properties). It's revertible from the bulk file change history.`,
        confirmText: `Reorder ${planned.length} notes`,
        onConfirm: go,
      }).open();
    } else go();
  }

  private async run(planned: ReturnType<typeof planChanges>): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (this.applyBtn) this.applyBtn.disabled = true;
    const list = [...this.list];
    const head = list.slice(0, 4).join(", ") + (list.length > 4 ? ", …" : "");
    const where = this.orderScope === "vault" ? "vault" : `${this.baseName ?? "base"} (${this.orderScope === "view" ? "view" : "whole base"})`;
    const label = `Property order in ${where}: ${head}`;
    try {
      const { entry, changed, failed } = await applyOrder(this.plugin, planned, list, this.mode, label);
      this.close();
      const fail = failed ? ` ${failed} couldn't be written (see the developer console).` : "";
      if (entry) {
        noticeWithUndo(this.plugin, `Reordered properties in ${changed} note${changed === 1 ? "" : "s"}.${fail}`, entry);
      } else {
        new Notice(`Nothing needed changing.${fail}`);
      }
    } catch (e) {
      new Notice(`Reorder properties failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running = false;
      if (this.applyBtn) this.applyBtn.disabled = false;
    }
  }
}
