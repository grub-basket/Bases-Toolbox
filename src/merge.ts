import { FuzzySuggestModal, ItemView, Modal, Notice, Setting, TFile, WorkspaceLeaf } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { findKey, isUnsafeKey, valueToDisplay } from "./scan";
import { installMainTabAction, installSidebarAction, openFileFromView } from "./view-refresh";

/* ---------- merge core ---------- */

interface MergePlan {
  /** Keys copied from source (missing on target). */
  copied: string[];
  /** Keys where both are lists (or one is) — merged by union. */
  unioned: string[];
  /** Real scalar conflicts needing a decision. */
  conflicts: { key: string; targetValue: unknown; sourceValue: unknown }[];
}

function planMerge(targetFm: Record<string, unknown>, sourceFm: Record<string, unknown>): MergePlan {
  const plan: MergePlan = { copied: [], unioned: [], conflicts: [] };
  for (const [key, sv] of Object.entries(sourceFm)) {
    if (key === "position" || isUnsafeKey(key)) continue;
    const tk = findKey(targetFm, key);
    if (tk === null) {
      plan.copied.push(key);
      continue;
    }
    const tv = targetFm[tk];
    if (JSON.stringify(tv) === JSON.stringify(sv)) continue;
    if (Array.isArray(tv) || Array.isArray(sv)) plan.unioned.push(key);
    else plan.conflicts.push({ key, targetValue: tv, sourceValue: sv });
  }
  return plan;
}

function unionValues(a: unknown, b: unknown): unknown[] {
  const list = (v: unknown) => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]);
  const out = list(a).slice();
  for (const item of list(b)) {
    if (!out.some((x) => valueToDisplay(x) === valueToDisplay(item))) out.push(item);
  }
  return out;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** Rewrites wikilinks/embeds pointing at `source` to point at `target`. */
async function rewriteBacklinks(
  plugin: BasesToolboxPlugin,
  source: TFile,
  target: TFile
): Promise<number> {
  const app = plugin.app;
  let rewritten = 0;
  for (const [fromPath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
    if (!links[source.path] || fromPath === source.path || fromPath === target.path) continue;
    const from = app.vault.getAbstractFileByPath(fromPath);
    if (!(from instanceof TFile)) continue;
    const cache = app.metadataCache.getFileCache(from);
    const refs = [...(cache?.links ?? []), ...(cache?.embeds ?? [])].filter(
      (l) =>
        app.metadataCache.getFirstLinkpathDest(l.link.split("#")[0], fromPath)?.path === source.path
    );
    if (!refs.length) continue;
    let content = await app.vault.read(from);
    for (const ref of refs.sort((a, b) => b.position.start.offset - a.position.start.offset)) {
      const alias =
        ref.displayText && ref.displayText !== ref.link && ref.displayText !== source.basename
          ? ref.displayText
          : undefined;
      const newLink = app.fileManager.generateMarkdownLink(target, fromPath, undefined, alias);
      content =
        content.slice(0, ref.position.start.offset) + newLink + content.slice(ref.position.end.offset);
      rewritten++;
    }
    await app.vault.modify(from, content);
  }

  // Frontmatter wikilinks (properties) also need re-pointing — they live in
  // cache.frontmatterLinks with a dotted key path instead of offsets.
  for (const [fromPath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
    if (!links[source.path] || fromPath === source.path) continue;
    const from = app.vault.getAbstractFileByPath(fromPath);
    if (!(from instanceof TFile)) continue;
    const fmRefs = (app.metadataCache.getFileCache(from)?.frontmatterLinks ?? []).filter(
      (l) =>
        app.metadataCache.getFirstLinkpathDest(l.link.split("#")[0], fromPath)?.path === source.path
    );
    if (!fmRefs.length) continue;
    const newLink = app.fileManager.generateMarkdownLink(target, fromPath);
    await app.fileManager.processFrontMatter(from, (fm) => {
      for (const ref of fmRefs) {
        const path = ref.key.split(".");
        let obj: unknown = fm;
        for (let i = 0; i < path.length - 1; i++) {
          if (obj === null || typeof obj !== "object") return;
          obj = (obj as Record<string, unknown>)[path[i]];
        }
        const last = path[path.length - 1];
        if (obj !== null && typeof obj === "object") {
          (obj as Record<string, unknown>)[last] = newLink;
          rewritten++;
        }
      }
    });
  }
  return rewritten;
}

/**
 * Frontmatter-aware merge of `source` into `target`: keys missing on target
 * are copied, list-ish keys union, scalar conflicts resolve per `resolutions`
 * (default: keep target). Bodies are concatenated, backlinks re-pointed, and
 * the source goes to the vault trash (recoverable — no automated undo).
 */
export async function mergeNotes(
  plugin: BasesToolboxPlugin,
  target: TFile,
  source: TFile,
  resolutions: Record<string, "target" | "source"> = {}
): Promise<void> {
  const app = plugin.app;
  const sourceContent = await app.vault.read(source);
  const sourceFm = (app.metadataCache.getFileCache(source)?.frontmatter ?? {}) as Record<
    string,
    unknown
  >;

  let kept = 0;
  await app.fileManager.processFrontMatter(target, (fm) => {
    const plan = planMerge(fm, sourceFm);
    for (const key of plan.copied) fm[key] = sourceFm[key];
    for (const key of plan.unioned) {
      const tk = findKey(fm, key) ?? key;
      fm[tk] = unionValues(fm[tk], sourceFm[key]);
    }
    for (const c of plan.conflicts) {
      const tk = findKey(fm, c.key) ?? c.key;
      if (resolutions[c.key] === "source") fm[tk] = c.sourceValue;
      else kept++;
    }
  });

  const sourceBody = stripFrontmatter(sourceContent).trim();
  if (sourceBody) {
    await app.vault.process(target, (content) => `${content.trimEnd()}\n\n---\n\n${sourceBody}\n`);
  }

  const rewritten = await rewriteBacklinks(plugin, source, target);
  await app.fileManager.trashFile(source); // respects the user deletion preference

  new Notice(
    `Merged "${source.basename}" into "${target.basename}"` +
      (rewritten ? `, re-pointed ${rewritten} link${rewritten === 1 ? "" : "s"}` : "") +
      (kept ? ` (${kept} conflict${kept === 1 ? "" : "s"} kept the target's value)` : "") +
      ". Source moved to vault trash."
  );
}

/* ---------- pairwise merge UI ---------- */

export class MergeTargetPicker extends FuzzySuggestModal<TFile> {
  private plugin: BasesToolboxPlugin;
  private source: TFile;

  constructor(plugin: BasesToolboxPlugin, source: TFile) {
    super(plugin.app);
    this.plugin = plugin;
    this.source = source;
    this.setPlaceholder(`Merge "${source.basename}" into…`);
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((f) => f.path !== this.source.path);
  }

  getItemText(f: TFile): string {
    return f.path;
  }

  onChooseItem(f: TFile): void {
    new MergeConfirmModal(this.plugin, f, this.source).open();
  }
}

export function startMerge(plugin: BasesToolboxPlugin): void {
  const active = plugin.app.workspace.getActiveFile();
  if (!active || active.extension !== "md") {
    new Notice("Open the note you want to merge away (the source) first.");
    return;
  }
  new MergeTargetPicker(plugin, active).open();
}

class MergeConfirmModal extends Modal {
  private plugin: BasesToolboxPlugin;
  private target: TFile;
  private source: TFile;
  private resolutions: Record<string, "target" | "source"> = {};

  constructor(plugin: BasesToolboxPlugin, target: TFile, source: TFile) {
    super(plugin.app);
    this.plugin = plugin;
    this.target = target;
    this.source = source;
  }

  onOpen(): void {
    this.titleEl.setText(`Merge "${this.source.basename}" → "${this.target.basename}"`);
    const { contentEl } = this;
    const cache = (f: TFile) =>
      (this.app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as Record<string, unknown>;
    const plan = planMerge(cache(this.target), cache(this.source));

    const info: string[] = [];
    if (plan.copied.length) info.push(`copies ${plan.copied.join(", ")}`);
    if (plan.unioned.length) info.push(`merges lists ${plan.unioned.join(", ")}`);
    contentEl.createDiv({
      cls: "bases-toolbox-fr-info",
      text:
        `Properties: ${info.length ? info.join("; ") : "no additions"}. ` +
        "The source's body is appended to the target, links to the source are re-pointed, and the source goes to the vault trash.",
    });

    for (const c of plan.conflicts) {
      new Setting(contentEl)
        .setName(c.key)
        .setDesc("Both notes set this property — pick which value survives.")
        .addDropdown((dd) => {
          dd.addOption("target", `keep “${valueToDisplay(c.targetValue)}” (${this.target.basename})`);
          dd.addOption("source", `take “${valueToDisplay(c.sourceValue)}” (${this.source.basename})`);
          dd.setValue("target");
          this.resolutions[c.key] = "target";
          dd.onChange((v) => (this.resolutions[c.key] = v as "target" | "source"));
        });
    }

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Merge")
          .setCta()
          .onClick(async (evt) => {
            const btn = evt.target as HTMLButtonElement;
            if (btn.disabled) return;
            btn.disabled = true; // double-click would re-merge a trashed source
            await mergeNotes(this.plugin, this.target, this.source, this.resolutions);
            this.close();
          })
      )
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }
}

/* ---------- duplicate finder ---------- */

function normalizeName(basename: string): string {
  return basename
    .toLowerCase()
    .replace(/\s*(copy|copie|duplicate)(\s*\d*)?$/i, "")
    .replace(/\s*[-_(]?\s*\d+\s*[)]?$/, "")
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Shared duplicate-finder UI (scan controls + grouped results). Rendered into
 * either a modal or a workspace tab; the only difference is `openFile`, which
 * decides where a clicked note link lands.
 */
class DuplicateFinderPanel {
  private plugin: BasesToolboxPlugin;
  private openFile: (file: TFile) => void;
  private byName = true;
  private byBody = false;
  private propEl: HTMLInputElement | null = null;
  private resultsEl: HTMLElement | null = null;

  constructor(plugin: BasesToolboxPlugin, openFile: (file: TFile) => void) {
    this.plugin = plugin;
    this.openFile = openFile;
  }

  private get app() {
    return this.plugin.app;
  }

  render(contentEl: HTMLElement): void {
    new Setting(contentEl)
      .setName("Similar file names")
      .setDesc('Ignores case, punctuation, and trailing "copy"/number suffixes.')
      .addToggle((t) => t.setValue(this.byName).onChange((v) => (this.byName = v)));

    new Setting(contentEl)
      .setName("Same value of property")
      .setDesc("Notes sharing a value of this property group as duplicates. Leave empty to skip.")
      .addText((t) => {
        t.setPlaceholder("e.g. id");
        this.propEl = t.inputEl;
      });

    new Setting(contentEl)
      .setName("Identical body")
      .setDesc("Compares note bodies (frontmatter excluded). Reads every file — slower in big vaults.")
      .addToggle((t) => t.setValue(this.byBody).onChange((v) => (this.byBody = v)));

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Scan").setCta().onClick(() => void this.scan())
    );

    this.resultsEl = contentEl.createDiv();
  }

  private async scan(): Promise<void> {
    const root = this.resultsEl;
    if (!root) return;
    root.empty();
    root.createDiv({ cls: "bases-toolbox-fr-info", text: "Scanning…" });

    const prop = this.propEl?.value.trim() ?? "";
    const groups = new Map<string, TFile[]>();
    const add = (key: string, file: TFile) => {
      const g = groups.get(key) ?? [];
      if (!g.includes(file)) g.push(file);
      groups.set(key, g);
    };

    const files = this.app.vault.getMarkdownFiles();
    const bodies = new Map<TFile, string>();
    for (const file of files) {
      if (this.byName) add(`name:${normalizeName(file.basename)}`, file);
      if (prop) {
        const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<
          string,
          unknown
        >;
        const key = findKey(fm, prop);
        const v = key === null ? undefined : fm[key];
        if (v !== undefined && v !== null && v !== "") add(`prop:${valueToDisplay(v)}`, file);
      }
      if (this.byBody) {
        const body = stripFrontmatter(await this.app.vault.cachedRead(file)).trim();
        if (body) {
          add(`body:${simpleHash(body)}`, file);
          bodies.set(file, body);
        }
      }
    }

    // The 32-bit hash only buckets; verify EXACT body equality inside each
    // bucket so a crafted hash collision can't fake an "identical" pair.
    if (this.byBody) {
      for (const [key, group] of [...groups.entries()]) {
        if (!key.startsWith("body:") || group.length < 2) continue;
        groups.delete(key);
        const exact = new Map<string, TFile[]>();
        for (const f of group) {
          const b = bodies.get(f) ?? "";
          exact.set(b, [...(exact.get(b) ?? []), f]);
        }
        let i = 0;
        for (const g of exact.values()) if (g.length > 1) groups.set(`${key}:${i++}`, g);
      }
    }

    root.empty();
    const dupGroups = [...groups.entries()].filter(([, g]) => g.length > 1);
    if (!dupGroups.length) {
      root.createDiv({ cls: "bases-toolbox-fr-info", text: "No duplicate groups found." });
      return;
    }
    root.createDiv({
      cls: "bases-toolbox-fr-info",
      text: `${dupGroups.length} group${dupGroups.length === 1 ? "" : "s"} found. Pick the note to keep; the rest merge into it (conflicts keep the kept note's values).`,
    });

    for (const [key, group] of dupGroups) {
      const box = root.createDiv({ cls: "bases-toolbox-dup-group" });
      box.createDiv({
        cls: "bases-toolbox-dup-key",
        text: key.replace(/^name:/, "similar name: ").replace(/^prop:/, "value: ").replace(/^body:/, "identical body #"),
      });
      // No default keep — the user must explicitly pick the note to keep.
      let keep: TFile | null = null;
      const radioName = `bt-dup-${simpleHash(key)}`;
      for (const file of group) {
        const row = box.createDiv({ cls: "bases-toolbox-dup-row" });
        const radio = row.createEl("input", { type: "radio", attr: { name: radioName } });
        radio.addEventListener("change", () => {
          keep = file;
          resetMergeBtn();
        });
        const link = row.createEl("a", {
          cls: "bases-toolbox-dup-link",
          text: file.path,
          href: "#",
          attr: { "aria-label": "Open in a new tab" },
        });
        link.addEventListener("click", (e) => {
          e.preventDefault();
          this.openFile(file);
        });
        row.createSpan({
          cls: "bases-toolbox-index-prop-count",
          text: new Date(file.stat.mtime).toLocaleDateString(),
        });
      }
      const btn = box.createEl("button", { text: `Merge ${group.length - 1} into kept note` });
      let armed = false;
      // Disabled until a note is picked; picking one (or re-picking) also
      // disarms the confirm step so a changed choice can't merge on one click.
      function resetMergeBtn(): void {
        armed = false;
        btn.disabled = keep === null;
        btn.removeClass("mod-warning");
        btn.setText(`Merge ${group.length - 1} into kept note`);
      }
      resetMergeBtn();
      btn.addEventListener("click", () => void (async () => {
        if (!keep) return;
        if (!armed) {
          armed = true;
          btn.setText(`Really merge ${group.length - 1} note${group.length === 2 ? "" : "s"} away? Click again`);
          btn.addClass("mod-warning");
          return;
        }
        btn.disabled = true;
        const target = keep;
        for (const file of group) {
          if (file !== target) await mergeNotes(this.plugin, target, file);
        }
        box.createDiv({ cls: "bases-toolbox-fr-info", text: "Merged. Sources are in the vault trash." });
      })());
    }
  }
}

export const VIEW_TYPE_DUPLICATE_FINDER = "bases-toolbox-duplicate-finder";

/** Duplicate finder as a dialog. Note links open behind the modal in a new tab. */
export class DuplicateFinderModal extends Modal {
  private plugin: BasesToolboxPlugin;

  constructor(plugin: BasesToolboxPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.setText("Find duplicate notes");
    this.modalEl.addClass("bases-toolbox-csv-modal");
    // Add a shortcut to promote the dialog into a full tab, where clicked note
    // links land beside the finder instead of behind it.
    new Setting(this.contentEl)
      .setName("Prefer opening notes in tabs?")
      .setDesc("Run the duplicate finder as its own tab so opened notes sit alongside it.")
      .addButton((b) =>
        b.setButtonText("Open in a tab").onClick(() => {
          this.close();
          void openDuplicateFinderView(this.plugin);
        })
      );
    new DuplicateFinderPanel(this.plugin, (file) =>
      void this.app.workspace.getLeaf("tab").openFile(file)
    ).render(this.contentEl);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Duplicate finder as a workspace tab: clicked note links open in new tabs
 * beside it, so you can browse the candidates without dismissing the finder. */
export class DuplicateFinderView extends ItemView {
  icon = "copy";
  private plugin: BasesToolboxPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: BasesToolboxPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_DUPLICATE_FINDER;
  }

  getDisplayText(): string {
    return "Find duplicate notes";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("bases-toolbox-csv-modal", "bases-toolbox-dup-view");
    const inner = root.createDiv({ cls: "bases-toolbox-dup-view-inner" });
    new DuplicateFinderPanel(this.plugin, (file) => void openFileFromView(this, file)).render(inner);
    installMainTabAction(this);
    installSidebarAction(this);
  }
}

/** Opens (or reveals) the duplicate finder as a main-area tab. */
export async function openDuplicateFinderView(plugin: BasesToolboxPlugin): Promise<void> {
  const { workspace } = plugin.app;
  let leaf = workspace.getLeavesOfType(VIEW_TYPE_DUPLICATE_FINDER)[0];
  if (!leaf) {
    leaf = workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_DUPLICATE_FINDER, active: true });
  }
  await workspace.revealLeaf(leaf);
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}
