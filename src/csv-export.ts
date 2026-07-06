import { CachedMetadata, Notice, TFile, getAllTags, parseYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { activeBaseView } from "./base-detect";
import { ALWAYS_IGNORE_EXT, parseExts } from "./companion-notes";
import { toCsvCell, toTsvCell } from "./csv-core";
import { findKey } from "./scan";

/**
 * Exports the active base view's current results as clean CSV — wikilinks
 * unwrapped, lists joined with "; ", proper quoting — copied to the clipboard
 * and written next to the .base file. Columns follow the view's order.
 */

/**
 * Exports the ACTIVE base view (command path): uses the base's live results and
 * its current column order. Errors when the focused view isn't a base — the
 * folder-scan export (modal/tab) is the base-independent path.
 */
export async function exportBaseCsv(plugin: BasesToolboxPlugin): Promise<void> {
  const app = plugin.app;
  const view = activeBaseView(app);
  if (!view) {
    new Notice(
      "Open a base first — this command exports the active base view's results."
    );
    return;
  }
  const results = view.controller?.results;
  if (!(results instanceof Map)) {
    new Notice("Couldn't read the base's results (Obsidian internals may have changed).");
    return;
  }
  const files = [...results.keys()].filter((f): f is TFile => f instanceof TFile);

  let doc: Record<string, unknown> = {};
  try {
    doc = (parseYaml(await app.vault.read(view.file)) ?? {}) as Record<string, unknown>;
  } catch {
    /* fall through to default columns */
  }
  const views = Array.isArray(doc.views) ? (doc.views as Record<string, unknown>[]) : [];
  // Which named view (column order) is showing — read from the base's OWN leaf
  // container, not the globally-active leaf (which may be a different view when
  // the base isn't focused).
  const viewLabel = (view.containerEl ?? activeDocument)
    .querySelector(".bases-toolbar-views-menu")
    ?.textContent?.trim();
  const activeView = views.find((v) => v.name === viewLabel) ?? views[0];
  let order = (Array.isArray(activeView?.order) ? activeView.order : []).filter(
    (k): k is string => typeof k === "string"
  );
  if (!order.length) order = ["file.name"];

  const header = order.map((k) => toCsvCell(k.replace(/^note\./, "")));
  const lines = [header.join(",")];
  for (const file of files) {
    const fm = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
    const cells = order.map((k) => {
      if (k === "file.name") return toCsvCell(file.basename);
      if (k === "file.path") return toCsvCell(file.path);
      if (k.startsWith("file.") || k.startsWith("formula.")) return toCsvCell("");
      const key = findKey(fm, k.replace(/^note\./, ""));
      return toCsvCell(key === null ? "" : fm[key]);
    });
    lines.push(cells.join(","));
  }
  const csv = lines.join("\n");

  const outPath = view.file.path.replace(/\.base$/, "") + " export.csv";
  const existing = app.vault.getAbstractFileByPath(outPath);
  if (existing instanceof TFile) await app.vault.modify(existing, csv);
  else await app.vault.create(outPath, csv);
  let onClipboard = true;
  try {
    await navigator.clipboard.writeText(csv); // throws when window unfocused
  } catch {
    onClipboard = false;
  }
  new Notice(
    `Exported ${files.length} rows → "${outPath}"${onClipboard ? " (also on the clipboard)" : ""}.`
  );
}

/* ---------- folder-scan export (no open base needed) ---------- */

export interface FolderCsvData {
  columns: string[];
  rows: { name: string; fm: Record<string, unknown> }[];
}

/**
 * Scans a folder's markdown for frontmatter and unions every key found — the
 * approach from the standalone web exporter, but reading Obsidian's already-
 * parsed metadata cache. Needs no base open, so it can drive a picker.
 */
function normFolder(folderPath: string): string {
  return folderPath.replace(/^\/+|\/+$/g, "");
}

/** Is `file` inside `norm` (optionally recursively), and not under any ignored folder? */
function fileInScope(file: TFile, norm: string, recursive: boolean, ignored: string[]): boolean {
  const parent = file.parent?.path === "/" ? "" : (file.parent?.path ?? "");
  const inF = norm === "" ? (recursive ? true : parent === "") : recursive ? file.path.startsWith(`${norm}/`) : parent === norm;
  if (!inF) return false;
  return !ignored.some((dir) => file.path.startsWith(`${dir}/`));
}

export function scanFolderCsv(
  plugin: BasesToolboxPlugin,
  folderPath: string,
  recursive: boolean,
  ignore: string[] = []
): FolderCsvData {
  const app = plugin.app;
  const norm = normFolder(folderPath);
  const ignored = ignore.map(normFolder).filter(Boolean);
  const columns: string[] = [];
  const seen = new Set<string>();
  const rows: { name: string; fm: Record<string, unknown> }[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (!fileInScope(f, norm, recursive, ignored)) continue;
    const fm = (app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(fm)) {
      if (k === "position" || seen.has(k)) continue;
      seen.add(k);
      columns.push(k);
    }
    rows.push({ name: f.basename, fm });
  }
  return { columns, rows };
}

/** Subfolders (recursive) under `folderPath` that hold any file — for the
 * export's "ignore these folders" checklist. */
export function subfoldersOf(plugin: BasesToolboxPlugin, folderPath: string): string[] {
  const norm = normFolder(folderPath);
  const set = new Set<string>();
  for (const f of plugin.app.vault.getFiles()) {
    let p = f.parent;
    while (p && p.path && p.path !== "/") {
      const pp = p.path;
      if ((norm === "" || pp === norm || pp.startsWith(`${norm}/`)) && pp !== norm) set.add(pp);
      p = p.parent;
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Non-markdown files in scope (images, PDFs, …) that a CSV export skips —
 * offered up so the user can companion them. Excludes the same things the
 * companion feature always ignores (.edtz, .base, and .md.* derivatives). */
export function nonMdFilesInScope(
  plugin: BasesToolboxPlugin,
  folderPath: string,
  recursive: boolean,
  ignore: string[] = []
): TFile[] {
  const norm = normFolder(folderPath);
  const ignored = ignore.map(normFolder).filter(Boolean);
  // Skip what the companion feature skips: hard-ignored exts, the user's own
  // exclude list (which now defaults to include "base"), and .md.* derivatives.
  const userExclude = parseExts(plugin.settings.companionExcludeExts);
  return plugin.app.vault.getFiles().filter((f) => {
    const ext = f.extension.toLowerCase();
    return (
      f.extension !== "md" &&
      !ALWAYS_IGNORE_EXT.has(ext) &&
      !userExclude.has(ext) &&
      !f.name.includes(".md.") &&
      fileInScope(f, norm, recursive, ignored)
    );
  });
}

/** Renders scanned rows as CSV (comma) or, for "Copy for Excel", TSV (tab). */
export function folderCsvToText(data: FolderCsvData, delim: "," | "\t"): string {
  const cell = delim === "," ? toCsvCell : toTsvCell;
  const lines = [["file name", ...data.columns].map(cell).join(delim)];
  for (const row of data.rows) {
    lines.push([cell(row.name), ...data.columns.map((k) => cell(row.fm[k] ?? ""))].join(delim));
  }
  return lines.join("\n");
}

/** All folder paths that contain markdown (for the export picker), root first. */
export function folderPaths(plugin: BasesToolboxPlugin): string[] {
  const set = new Set<string>();
  for (const f of plugin.app.vault.getMarkdownFiles()) {
    let p = f.parent;
    while (p && p.path && p.path !== "/") {
      set.add(p.path);
      p = p.parent;
    }
  }
  return ["/", ...[...set].sort((a, b) => a.localeCompare(b))];
}

/* ---------- base-scan export (pick a .base file, no need to open it) ---------- */

/** All .base file paths in the vault (for the export picker). */
export function basePaths(plugin: BasesToolboxPlugin): string[] {
  return plugin.app.vault
    .getFiles()
    .filter((f) => f.extension === "base")
    .map((f) => f.path)
    .sort((a, b) => a.localeCompare(b));
}

function isoDateTime(ms: number): string {
  // Local, second-precision, spreadsheet-friendly: "YYYY-MM-DD HH:mm:ss".
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Resolves one base "order" key to a cell value for a file. Computed columns
 * (formulas, link lists) that need Bases' live engine come back blank. */
function resolveBaseCell(
  file: TFile,
  fm: Record<string, unknown>,
  cache: CachedMetadata | null,
  key: string
): unknown {
  switch (key) {
    case "file.name":
      return file.basename;
    case "file.path":
      return file.path;
    case "file.folder":
      return file.parent && file.parent.path !== "/" ? file.parent.path : "";
    case "file.ext":
      return file.extension;
    case "file.size":
      return file.stat.size;
    case "file.ctime":
      return isoDateTime(file.stat.ctime);
    case "file.mtime":
      return isoDateTime(file.stat.mtime);
    case "file.tags":
      return (getAllTags(cache ?? ({} as CachedMetadata)) ?? []).map((t) => t.replace(/^#/, ""));
  }
  // Other file.* / formula.* need the live query engine — leave blank.
  if (key.startsWith("file.") || key.startsWith("formula.")) return "";
  const k = findKey(fm, key.replace(/^note\./, ""));
  return k === null ? "" : fm[k];
}

/** Collects the leaf filter expression strings from a parsed filter tree —
 * NOT via JSON.stringify, which escapes the quotes and defeats the regex. */
function filterClauses(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (typeof n === "string") out.push(n);
    else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === "object") Object.values(n).forEach(walk);
  };
  walk(node);
  return out;
}

export interface BaseViewInfo {
  name: string;
  /** This view's own filter expressions (added on top of the base filters). */
  filters: string[];
  /** The raw (un-flattened) filter tree — needed to honor `not(...)` scoping. */
  filtersRaw: unknown;
  /** The view's column order (raw identifiers). */
  order: string[];
}

export interface BaseInfo {
  /** Base-level filters, applied to every view. */
  baseFilters: string[];
  /** The raw base-level filter tree. */
  baseFiltersRaw: unknown;
  views: BaseViewInfo[];
}

/**
 * Determines the folder scope of a base's filters WITHOUT flattening away the
 * `not`/`or` structure. Collects `inFolder(...)` folders from positive (non-
 * negated) positions only — so `not(file.inFolder("Archive"))` no longer scopes
 * the export TO Archive. `approximate` is true when the filters have logic we
 * don't evaluate (negation, or any non-inFolder / non-`file.ext` clause), so the
 * caller can flag the result as a best-effort superset.
 */
export function baseFolderScope(...trees: unknown[]): { folders: string[]; approximate: boolean } {
  const folders = new Set<string>();
  let approximate = false;
  const walk = (node: unknown, negated: boolean): void => {
    if (typeof node === "string") {
      const matches = [...node.matchAll(/inFolder\(\s*["']([^"']+)["']\s*\)/g)];
      if (matches.length) {
        if (negated) approximate = true; // a not(inFolder) — can't use it as an include
        else matches.forEach((m) => folders.add(m[1].replace(/^\/+|\/+$/g, "")));
      } else if (!/^\s*file\.ext\s*[=!<>]=?\s*["']?\w+["']?\s*$/.test(node)) {
        approximate = true; // some other condition (status ==, etc.) we don't evaluate
      }
    } else if (Array.isArray(node)) {
      node.forEach((n) => walk(n, negated));
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "not") {
          approximate = true;
          walk(v, !negated);
        } else {
          walk(v, negated); // and / or
        }
      }
    }
  };
  trees.forEach((t) => walk(t, false));
  return { folders: [...folders], approximate };
}

/**
 * Reads a .base file's structure — base-level filters and each view's own
 * filters and column order — so the export UI can show what each view covers
 * and let the user pick one. No open base needed.
 */
export async function readBaseInfo(plugin: BasesToolboxPlugin, basePath: string): Promise<BaseInfo> {
  const app = plugin.app;
  const f = app.vault.getAbstractFileByPath(basePath);
  if (!(f instanceof TFile)) return { baseFilters: [], baseFiltersRaw: undefined, views: [] };
  let doc: Record<string, unknown> = {};
  try {
    doc = (parseYaml(await app.vault.read(f)) ?? {}) as Record<string, unknown>;
  } catch {
    /* empty base */
  }
  const rawViews = Array.isArray(doc.views) ? (doc.views as Record<string, unknown>[]) : [];
  const views: BaseViewInfo[] = rawViews.map((v, i) => ({
    name: typeof v?.name === "string" ? v.name : `View ${i + 1}`,
    filters: filterClauses(v?.filters),
    filtersRaw: v?.filters,
    order: (Array.isArray(v?.order) ? (v.order as unknown[]) : []).filter(
      (k): k is string => typeof k === "string"
    ),
  }));
  return { baseFilters: filterClauses(doc.filters), baseFiltersRaw: doc.filters, views };
}

/**
 * A plain-language rendering of a .base file — filters, formulas, and each
 * view's filters/columns/sort/grouping — to sit next to the CSV and cover what
 * CSV can't (so the user can rebuild formulas/grouping in their spreadsheet).
 */
export async function baseSummaryText(plugin: BasesToolboxPlugin, basePath: string): Promise<string> {
  const app = plugin.app;
  const f = app.vault.getAbstractFileByPath(basePath);
  if (!(f instanceof TFile)) return "";
  let doc: Record<string, unknown> = {};
  try {
    doc = (parseYaml(await app.vault.read(f)) ?? {}) as Record<string, unknown>;
  } catch {
    /* empty */
  }

  const stem = (basePath.split("/").pop() ?? basePath).replace(/\.base$/, "");
  const L: string[] = [];
  L.push(`# ${stem} — base summary`);
  L.push("");
  L.push(
    "A plain-language description of this base, to fill the gaps a CSV export can't: filters, formulas, sorting, and grouping. The CSV holds the raw property/file values; recreate the rest in your spreadsheet using the definitions below."
  );
  L.push("");

  const baseFilters = filterClauses(doc.filters);
  L.push("## Base filters (apply to every view)");
  L.push(baseFilters.length ? baseFilters.map((c) => `- ${c}`).join("\n") : "- (none)");
  L.push("");

  if (doc.formulas && typeof doc.formulas === "object") {
    L.push("## Formulas (not in the CSV — rebuild as spreadsheet formulas)");
    for (const [name, expr] of Object.entries(doc.formulas as Record<string, unknown>)) {
      L.push(`- formula.${name} = ${String(expr)}`);
    }
    L.push("");
  }

  const views = Array.isArray(doc.views) ? (doc.views as Record<string, unknown>[]) : [];
  for (const v of views) {
    L.push(`## View: ${typeof v.name === "string" ? v.name : "(unnamed)"} — ${v.type ?? "table"}`);
    const vf = filterClauses(v.filters);
    if (vf.length) {
      L.push("Filters:");
      vf.forEach((c) => L.push(`- ${c}`));
    }
    const order = (Array.isArray(v.order) ? (v.order as unknown[]) : []).filter(
      (k): k is string => typeof k === "string"
    );
    if (order.length) {
      L.push("Columns (in order):");
      order.forEach((k) => L.push(`- ${k}`));
    }
    const sort = v.sort ?? (v as Record<string, unknown>).sortBy;
    if (sort) L.push(`Sort: ${JSON.stringify(sort)}`);
    const group = (v as Record<string, unknown>).groupBy ?? (v as Record<string, unknown>).group_by;
    if (group) L.push(`Group by: ${JSON.stringify(group)}`);
    L.push("");
  }

  L.push("---");
  L.push(
    "Note: formula columns and any grouping/sorting are NOT in the CSV — the CSV is a flat table of the notes' property and file.* values. Rebuild formulas, groups, and sort order in your spreadsheet from the definitions above."
  );
  L.push("");
  return L.join("\n");
}

/**
 * Exports one view of a base WITHOUT opening it: folder scope from the base +
 * view `file.inFolder(...)` filters (best-effort — other filter logic isn't
 * evaluated), columns from that view's `order`. For a base's exact live
 * filtered results with formula columns, use exportBaseCsv on the open base.
 */
export async function scanBaseView(
  plugin: BasesToolboxPlugin,
  basePath: string,
  viewIndex: number
): Promise<{ data: FolderCsvData; folders: string[]; approximate: boolean }> {
  const app = plugin.app;
  const info = await readBaseInfo(plugin, basePath);
  const view =
    info.views[viewIndex] ?? info.views[0] ?? { name: "", filters: [], filtersRaw: undefined, order: [] };
  // Walk the RAW trees so a not(inFolder(...)) doesn't invert the scope.
  const { folders, approximate } = baseFolderScope(info.baseFiltersRaw, view.filtersRaw);

  const order = view.order.length ? view.order : ["file.name"];
  const dataCols = order.filter((k) => k !== "file.name");
  const headers = dataCols.map((k) => k.replace(/^note\./, ""));

  const files = app.vault.getMarkdownFiles().filter((f) => {
    if (!folders.length) return true; // whole-vault base
    return folders.some((dir) => (dir === "" ? true : f.path.startsWith(`${dir}/`)));
  });

  const rows = files.map((f) => {
    const cache = app.metadataCache.getFileCache(f);
    const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
    const rowFm: Record<string, unknown> = {};
    dataCols.forEach((k, i) => (rowFm[headers[i]] = resolveBaseCell(f, fm, cache, k)));
    return { name: f.basename, fm: rowFm };
  });

  return { data: { columns: headers, rows }, folders, approximate };
}
