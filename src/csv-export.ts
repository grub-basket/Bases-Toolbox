import { ItemView, Notice, TFile, parseYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { toCsvCell } from "./csv-core";
import { findKey } from "./scan";

/**
 * Exports the active base view's current results as clean CSV — wikilinks
 * unwrapped, lists joined with "; ", proper quoting — copied to the clipboard
 * and written next to the .base file. Columns follow the view's order.
 */
type BaseView = { getViewType?: () => string; file?: TFile; controller?: { results?: unknown } };
const isBaseView = (v: unknown): v is BaseView =>
  !!v && (v as BaseView).getViewType?.() === "bases" && !!(v as BaseView).file;

export async function exportBaseCsv(plugin: BasesToolboxPlugin): Promise<void> {
  const app = plugin.app;
  // Prefer the focused base, but fall back to any open base — so export works
  // when triggered from the CSV tab / launcher / a sidebar (which leaves a
  // non-base view focused). The success notice names the file it wrote.
  let view: unknown = app.workspace.getActiveViewOfType(ItemView);
  const fromActive = isBaseView(view);
  if (!fromActive) {
    view = app.workspace.getLeavesOfType("bases").map((l) => l.view).find(isBaseView) ?? null;
  }
  if (!isBaseView(view) || !view.file) {
    new Notice("Open a base first — export works on an open base view.");
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
