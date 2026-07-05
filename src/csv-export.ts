import { CachedMetadata, ItemView, Notice, TFile, getAllTags, parseYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { toCsvCell, toTsvCell } from "./csv-core";
import { findKey } from "./scan";

/**
 * Exports the active base view's current results as clean CSV — wikilinks
 * unwrapped, lists joined with "; ", proper quoting — copied to the clipboard
 * and written next to the .base file. Columns follow the view's order.
 */
type BaseView = { getViewType?: () => string; file?: TFile; controller?: { results?: unknown } };
const isBaseView = (v: unknown): v is BaseView =>
  !!v && (v as BaseView).getViewType?.() === "bases" && !!(v as BaseView).file;

/**
 * Exports the ACTIVE base view (command path): uses the base's live results and
 * its current column order. Errors when the focused view isn't a base — the
 * folder-scan export (modal/tab) is the base-independent path.
 */
export async function exportBaseCsv(plugin: BasesToolboxPlugin): Promise<void> {
  const app = plugin.app;
  const view = app.workspace.getActiveViewOfType(ItemView) as unknown;
  if (!isBaseView(view) || !view.file) {
    new Notice("Focus a base first — this command exports the active base view.");
    return;
  }
  const fromActive = true;
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
  // The active-view toolbar tells us which named view (column order) is showing.
  // Only meaningful when the base itself is focused; otherwise use its first view.
  const viewLabel = fromActive
    ? activeDocument
        .querySelector(".workspace-leaf.mod-active .bases-toolbar-views-menu")
        ?.textContent?.trim()
    : undefined;
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
export function scanFolderCsv(
  plugin: BasesToolboxPlugin,
  folderPath: string,
  recursive: boolean
): FolderCsvData {
  const app = plugin.app;
  const norm = folderPath.replace(/^\/+|\/+$/g, "");
  const inFolder = (f: TFile): boolean => {
    const parent = f.parent?.path === "/" ? "" : (f.parent?.path ?? "");
    if (norm === "") return recursive ? true : parent === "";
    return recursive ? f.path.startsWith(`${norm}/`) : parent === norm;
  };
  const columns: string[] = [];
  const seen = new Set<string>();
  const rows: { name: string; fm: Record<string, unknown> }[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (!inFolder(f)) continue;
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

/**
 * Reads a .base file and exports the notes it covers WITHOUT opening it: folder
 * scope comes from the base's `file.inFolder(...)` filters (best-effort — other
 * filter logic isn't evaluated), columns from the first view's `order`. For a
 * base's live filtered results with exact column order, use exportBaseCsv on the
 * open base instead.
 */
export async function scanBaseCsv(
  plugin: BasesToolboxPlugin,
  basePath: string
): Promise<{ data: FolderCsvData; folders: string[]; approximate: boolean }> {
  const app = plugin.app;
  const baseFile = app.vault.getAbstractFileByPath(basePath);
  if (!(baseFile instanceof TFile)) return { data: { columns: [], rows: [] }, folders: [], approximate: false };

  let doc: Record<string, unknown> = {};
  try {
    doc = (parseYaml(await app.vault.read(baseFile)) ?? {}) as Record<string, unknown>;
  } catch {
    /* empty base */
  }

  // Collect the leaf filter expressions (strings) from the parsed tree — NOT
  // from JSON.stringify, which escapes the quotes and defeats the regex.
  const clauses: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === "string") clauses.push(node);
    else if (Array.isArray(node)) node.forEach(collect);
    else if (node && typeof node === "object") Object.values(node).forEach(collect);
  };
  collect(doc.filters);

  const folders = clauses.flatMap((c) =>
    [...c.matchAll(/inFolder\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1].replace(/^\/+|\/+$/g, ""))
  );
  // We evaluate inFolder scope and ignore a plain file.ext == "md". Any other
  // clause means the result is a best-effort superset of the base's rows.
  const handled = (c: string): boolean =>
    /^\s*file\.inFolder\(/.test(c) ||
    /^\s*file\.ext\s*[=!<>]=?\s*["']?\w+["']?\s*$/.test(c);
  const approximate = clauses.some((c) => !handled(c));

  const views = Array.isArray(doc.views) ? (doc.views as Record<string, unknown>[]) : [];
  const rawOrder = (Array.isArray(views[0]?.order) ? (views[0].order as unknown[]) : []).filter(
    (k): k is string => typeof k === "string"
  );
  const order = rawOrder.length ? rawOrder : ["file.name"];
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
