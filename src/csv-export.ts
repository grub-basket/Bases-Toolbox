import { Notice, TFile, parseYaml } from "obsidian";
import type BasesToolboxPlugin from "./main";
import { toCsvCell } from "./csv-core";
import { findKey } from "./scan";

/**
 * Exports the active base view's current results as clean CSV — wikilinks
 * unwrapped, lists joined with "; ", proper quoting — copied to the clipboard
 * and written next to the .base file. Columns follow the view's order.
 */
export async function exportBaseCsv(plugin: BasesToolboxPlugin): Promise<void> {
  const app = plugin.app;
  const view = app.workspace.activeLeaf?.view as unknown as {
    getViewType?: () => string;
    file?: TFile;
    controller?: { results?: unknown };
  };
  if (view?.getViewType?.() !== "bases" || !view.file) {
    new Notice("Open a base first — export works on the active base view.");
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
  const viewLabel = view.file
    ? document
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

  await navigator.clipboard.writeText(csv);
  const outPath = view.file.path.replace(/\.base$/, "") + " export.csv";
  const existing = app.vault.getAbstractFileByPath(outPath);
  if (existing instanceof TFile) await app.vault.modify(existing, csv);
  else await app.vault.create(outPath, csv);
  new Notice(`Exported ${files.length} rows → "${outPath}" (also on the clipboard).`);
}
