import { ItemView, Notice, TFile, WorkspaceLeaf, debounce } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { normalizeDate } from "./csv-core";
import { findKey, getPropertyType, valueToDisplay } from "./scan";
import { ChangeRecord } from "./types";
import { installRefocusRefresh, openFileFromView } from "./view-refresh";

export const VIEW_TYPE_FORMAT_DOCTOR = "bases-toolbox-format-doctor";

/**
 * Property format doctor: finds values that don't match their property's
 * assigned type (the mismatches Obsidian flags but "fixes" destructively —
 * sometimes erasing the value). Every issue shows what the type expects with
 * an example, a pre-filled SUGGESTED fix the user can edit, and applies only
 * what's checked — through the history engine, so it's revertible. Values
 * are never cleared: an empty input means "skip", not "erase".
 */

interface TypeSpec {
  /** Human explanation of the expected format. */
  expects: string;
  example: string;
  /** Is this cache value well-formed for the type? */
  valid: (v: unknown) => boolean;
  /** A safe auto-suggestion (display text for the input), or null. */
  suggest: (v: unknown) => string | null;
  /** Parse the user's input text into a frontmatter value, or null if invalid. */
  parse: (text: string) => unknown;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function realDate(s: string): boolean {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return false;
  const mo = +m[2];
  const d = +m[3];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
}

const isScalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

function toList(text: string, stripHash: boolean): string[] {
  return text
    .split(/[;\n]/)
    .map((s) => s.trim())
    .map((s) => (stripHash ? s.replace(/^#+/, "") : s))
    .filter(Boolean);
}

function listSpec(kind: string, stripHash: boolean): TypeSpec {
  return {
    expects: `a list of ${kind} — separate items with ";"`,
    example: stripHash ? "project; urgent" : "first item; second item",
    valid: (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
    suggest: (v) => {
      if (Array.isArray(v)) return v.map((x) => valueToDisplay(x)).join("; "); // non-string items
      if (isScalar(v) && v !== null) {
        const s = String(v);
        return toList(s, stripHash).join("; ");
      }
      return null;
    },
    parse: (text) => {
      const items = toList(text, stripHash);
      return items.length ? items : null;
    },
  };
}

const SPECS: Record<string, TypeSpec> = {
  text: {
    expects: "a single line of text",
    example: "any words you like",
    valid: (v) => typeof v === "string",
    suggest: (v) => {
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      if (Array.isArray(v) && v.every(isScalar)) return v.map((x) => String(x ?? "")).join(", ");
      return null;
    },
    parse: (text) => text,
  },
  number: {
    expects: "a plain number (no units or words)",
    example: "42 or 3.14 or -7",
    valid: (v) => typeof v === "number",
    suggest: (v) => {
      if (typeof v !== "string") return null;
      const t = v.trim().replace(",", ".");
      return t !== "" && !Number.isNaN(Number(t)) ? String(Number(t)) : null;
    },
    parse: (text) => {
      const t = text.trim().replace(",", ".");
      const n = Number(t);
      return t !== "" && !Number.isNaN(n) ? n : null;
    },
  },
  checkbox: {
    expects: "true or false",
    example: "true",
    valid: (v) => typeof v === "boolean",
    suggest: (v) => {
      const s = String(v).trim().toLowerCase();
      if (["true", "yes", "y", "1", "on", "checked"].includes(s)) return "true";
      if (["false", "no", "n", "0", "off", "unchecked"].includes(s)) return "false";
      return null;
    },
    parse: (text) => {
      const s = text.trim().toLowerCase();
      if (["true", "yes", "y", "1", "on"].includes(s)) return true;
      if (["false", "no", "n", "0", "off"].includes(s)) return false;
      return null;
    },
  },
  date: {
    expects: "a date as YYYY-MM-DD",
    example: "2026-07-02",
    valid: (v) => typeof v === "string" && DATE_RE.test(v) && realDate(v),
    suggest: (v) => {
      if (typeof v !== "string") return null;
      if (DATETIME_RE.test(v)) return v.slice(0, 10); // datetime in a date slot
      const n = normalizeDate(v);
      return DATE_RE.test(n) && realDate(n) ? n : null;
    },
    parse: (text) => {
      const n = normalizeDate(text.trim());
      return DATE_RE.test(n) && realDate(n) ? n : null;
    },
  },
  datetime: {
    expects: "date and time as YYYY-MM-DDTHH:MM",
    example: "2026-07-02T09:30",
    valid: (v) => typeof v === "string" && DATETIME_RE.test(v) && realDate(v),
    suggest: (v) => {
      if (typeof v !== "string") return null;
      if (DATE_RE.test(v) && realDate(v)) return `${v}T00:00`; // date in a datetime slot
      const n = normalizeDate(v);
      return DATE_RE.test(n) && realDate(n) ? `${n}T00:00` : null;
    },
    parse: (text) => {
      const t = text.trim();
      if (DATETIME_RE.test(t) && realDate(t)) return t;
      if (DATE_RE.test(t) && realDate(t)) return `${t}T00:00`;
      const n = normalizeDate(t);
      return DATE_RE.test(n) && realDate(n) ? `${n}T00:00` : null;
    },
  },
  multitext: listSpec("text items", false),
  aliases: listSpec("alternative names", false),
  tags: listSpec("tags (no # needed)", true),
};

export interface FormatIssue {
  file: TFile;
  property: string;
  widget: string;
  current: unknown;
  suggestion: string | null;
}

/** Scans the vault for values that don't match their property's assigned type. */
export function scanFormatIssues(plugin: BasesToolboxPlugin): FormatIssue[] {
  const issues: FormatIssue[] = [];
  for (const usage of plugin.propertyCache.get()) {
    const widget = getPropertyType(plugin.app, usage.name);
    const spec = widget ? SPECS[widget] : undefined;
    if (!spec) continue; // unassigned or link-ish types (file/folder/property): no expectation
    for (const file of usage.files) {
      const fm = (plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<
        string,
        unknown
      >;
      const key = findKey(fm, usage.name);
      if (key === null) continue;
      const v = fm[key];
      if (v === null || v === undefined) continue; // empty is Obsidian's business, not a mismatch
      if (spec.valid(v)) continue;
      issues.push({
        file,
        property: usage.name,
        widget: widget as string,
        current: v,
        suggestion: spec.suggest(v),
      });
    }
  }
  return issues;
}

export class FormatDoctorView extends ItemView {
  icon = "stethoscope";
  private plugin: BasesToolboxPlugin;
  private inputs = new Map<FormatIssue, { cb: HTMLInputElement; input: HTMLInputElement }>();
  /**
   * Re-scan whenever the metadata cache settles. Fixes the "shows 2 of 10" bug:
   * an initial render / Rescan / Apply can run while Obsidian is still reparsing
   * (frontmatter reads back empty → issues vanish). Debounced, and skipped while
   * a suggestion input is focused so it never clobbers what you're typing.
   */
  private scheduleRefresh = debounce(
    () => {
      if (this.isEditing()) return;
      this.plugin.propertyCache.markDirty();
      this.render();
    },
    400,
    true
  );

  constructor(leaf: WorkspaceLeaf, plugin: BasesToolboxPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  /** True while the user is typing in one of the suggestion inputs. */
  private isEditing(): boolean {
    const ae = activeDocument.activeElement;
    return ae instanceof HTMLInputElement && ae.classList.contains("bases-toolbox-doctor-input");
  }

  getViewType(): string {
    return VIEW_TYPE_FORMAT_DOCTOR;
  }

  getDisplayText(): string {
    return "Property format doctor";
  }

  async onOpen(): Promise<void> {
    this.render();
    // Keep the list correct as the cache finishes loading / as the vault changes.
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleRefresh()));
    installRefocusRefresh(this, () => {
      if (!this.isEditing()) this.render();
    });
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("bases-toolbox-frv");
    this.inputs.clear();

    const issues = scanFormatIssues(this.plugin);
    if (!issues.length) {
      root.createDiv({
        cls: "bases-toolbox-fr-info",
        text: "No format mismatches — every typed property value matches its assigned type.",
      });
      return;
    }

    root.createDiv({
      cls: "bases-toolbox-fr-info",
      text:
        `${issues.length} value${issues.length === 1 ? "" : "s"} don't match their property's assigned type. ` +
        "Each row shows a suggested correction you can edit before applying. Nothing is ever erased: an empty input means the row is skipped, and every applied fix is revertible from history.",
    });

    const byProp = new Map<string, FormatIssue[]>();
    for (const issue of issues) {
      byProp.set(issue.property, [...(byProp.get(issue.property) ?? []), issue]);
    }

    for (const [property, group] of byProp) {
      const spec = SPECS[group[0].widget];
      const box = root.createDiv({ cls: "bases-toolbox-dup-group" });
      const header = box.createDiv({ cls: "bases-toolbox-index-prop-header" });
      header.createSpan({ cls: "bases-toolbox-index-prop-name", text: property });
      header.createSpan({ cls: "bases-toolbox-index-prop-type", text: group[0].widget });
      header.createSpan({
        cls: "bases-toolbox-index-prop-count",
        text: `${group.length} file${group.length === 1 ? "" : "s"}`,
      });
      box.createDiv({
        cls: "bases-toolbox-fr-info",
        text: `Expects ${spec.expects} — e.g. ${spec.example}`,
      });

      for (const issue of group) {
        const row = box.createDiv({ cls: "bases-toolbox-frv-row" });
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = issue.suggestion !== null;
        const link = row.createSpan({ cls: "bases-toolbox-frv-path", text: issue.file.path });
        link.addEventListener("click", () => void openFileFromView(this, issue.file));
        row.createSpan({
          cls: "bases-toolbox-frv-diff",
          text: `now: ${valueToDisplay(issue.current)}`,
        });
        const input = row.createEl("input", {
          type: "text",
          cls: "bases-toolbox-doctor-input",
          attr: { placeholder: issue.suggestion === null ? `needs a human — e.g. ${spec.example}` : "" },
        });
        if (issue.suggestion !== null) input.value = issue.suggestion;
        input.addEventListener("input", () => {
          cb.checked = input.value.trim() !== "";
          input.removeClass("bases-toolbox-doctor-invalid");
        });
        this.inputs.set(issue, { cb, input });
      }
    }

    const footer = root.createDiv({ cls: "bases-toolbox-frv-bar" });
    const apply = footer.createEl("button", { text: "Apply checked fixes", cls: "mod-cta" });
    apply.addEventListener("click", () => void this.apply());
    const rescan = footer.createEl("button", { text: "Rescan" });
    rescan.addEventListener("click", () => this.render());
  }

  private async apply(): Promise<void> {
    const changes: ChangeRecord[] = [];
    let invalid = 0;
    for (const [issue, { cb, input }] of this.inputs) {
      const text = input.value.trim();
      if (!cb.checked || text === "") continue; // skip — never erase
      const spec = SPECS[issue.widget];
      const value = spec.parse(text);
      if (value === null || !spec.valid(value)) {
        invalid++;
        input.addClass("bases-toolbox-doctor-invalid");
        continue; // still not the right format — leave the file untouched
      }
      await this.app.fileManager.processFrontMatter(issue.file, (fm) => {
        const key = findKey(fm, issue.property);
        if (key === null) return;
        if (JSON.stringify(fm[key]) !== JSON.stringify(issue.current)) return; // changed since scan
        changes.push({
          path: issue.file.path,
          property: issue.property,
          oldValue: Array.isArray(fm[key]) ? (fm[key] as unknown[]).slice() : fm[key],
          newValue: Array.isArray(value) ? value.slice() : value,
        });
        fm[key] = value;
      });
    }
    if (changes.length) {
      await this.plugin.addHistoryEntry({
        property: "(format fixes)",
        find: null,
        replace: "corrected to assigned types",
        timestamp: Date.now(),
        changes,
        source: "format doctor",
      });
    }
    new Notice(
      `Fixed ${changes.length} value${changes.length === 1 ? "" : "s"}` +
        (invalid ? ` — ${invalid} input${invalid === 1 ? "" : "s"} still not in the expected format (marked red, files untouched)` : "") +
        (changes.length ? ". Revertible from history." : ".")
    );
    if (invalid) return; // keep the red-marked inputs so the user can correct them
    // Our writes trigger metadata "resolved" → scheduleRefresh re-renders once
    // the cache has settled (no more half-updated frontmatter). Also schedule
    // directly in case "resolved" had already fired for these files.
    this.scheduleRefresh();
  }
}

export async function openFormatDoctor(plugin: BasesToolboxPlugin): Promise<void> {
  const { workspace } = plugin.app;
  let leaf = workspace.getLeavesOfType(VIEW_TYPE_FORMAT_DOCTOR)[0];
  if (!leaf) {
    leaf = workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_FORMAT_DOCTOR, active: true });
  }
  await workspace.revealLeaf(leaf);
  if (leaf.view instanceof FormatDoctorView) leaf.view.render();
}
