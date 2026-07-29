import { App, Modal, TFile, setIcon } from "obsidian";
import type BasesToolboxPlugin from "./main";

/**
 * Aliased-link audit. Scans every note's frontmatter for internal links written
 * with an alias — `[[Target|Shown As]]` — inside property values, and groups
 * them by their link TARGET. The point isn't the aliases themselves but the
 * INCONSISTENCY they can hide: the same note referenced as `[[John|John S.]]`
 * in one value, `[[John|JS]]` in another, and plain `[[John]]` elsewhere. Those
 * read as different values in Bases (grouping/filtering by the shown text), so
 * they're the ones worth standardizing. Read-only — it surfaces, it doesn't
 * change anything.
 */

interface AliasOccurrence {
  file: TFile;
  property: string;
  raw: string; // the full [[…]] token as written
}

interface TargetGroup {
  target: string; // link target, first-seen casing
  /** Display form → where it occurs. Form is the alias, or PLAIN for `[[x]]`. */
  forms: Map<string, AliasOccurrence[]>;
  aliasedCount: number;
  inconsistent: boolean; // shown more than one way
}

const PLAIN = "\0plain"; // sentinel form-key for an un-aliased [[link]]
const LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** Target minus any #heading/^block, lowercased — Obsidian resolves links so. */
function normTarget(t: string): string {
  return t.split(/[#^]/)[0].trim().toLowerCase();
}

/** Resolve a link target to its actual note, ignoring #heading/^block. */
function resolveLinkDest(app: App, target: string, sourcePath: string): TFile | null {
  const linkpath = target.split(/[#^]/)[0].trim();
  if (!linkpath) return null;
  return app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
}

export function scanAliasedLinks(app: App): { groups: TargetGroup[]; totalAliased: number } {
  const byTarget = new Map<string, TargetGroup>();
  let totalAliased = 0;

  for (const file of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;
    for (const key of Object.keys(fm)) {
      if (key === "position") continue;
      const value = fm[key];
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        if (typeof item !== "string" || !item.includes("[[")) continue;
        LINK_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = LINK_RE.exec(item)) !== null) {
          const target = m[1].trim();
          const alias = m[2]?.trim();
          // Group by the RESOLVED note so different-path links to the same file
          // ([[a/Note|X]] and [[b/Note|Y]]) land together; fall back to the
          // normalized string when the link doesn't resolve to a file.
          const dest = resolveLinkDest(app, target, file.path);
          const groupKey = dest ? dest.path : normTarget(target);
          let g = byTarget.get(groupKey);
          if (!g) {
            g = { target: dest ? dest.basename : target, forms: new Map(), aliasedCount: 0, inconsistent: false };
            byTarget.set(groupKey, g);
          }
          const form = alias || PLAIN;
          const list = g.forms.get(form) ?? [];
          list.push({ file, property: key, raw: m[0] });
          g.forms.set(form, list);
          if (alias) {
            g.aliasedCount++;
            totalAliased++;
          }
        }
      }
    }
  }

  // Keep only targets that are aliased somewhere — a purely-plain link isn't the
  // concern. Flag the ones displayed more than one way.
  const groups: TargetGroup[] = [];
  for (const g of byTarget.values()) {
    if (g.aliasedCount === 0) continue;
    g.inconsistent = g.forms.size > 1;
    groups.push(g);
  }
  // Inconsistent first, then most-used.
  groups.sort(
    (a, b) => Number(b.inconsistent) - Number(a.inconsistent) || b.aliasedCount - a.aliasedCount
  );
  return { groups, totalAliased };
}

export class AliasedLinkAuditModal extends Modal {
  constructor(private plugin: BasesToolboxPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass("bases-toolbox-alias-modal");
    this.titleEl.setText("Aliased links in property values");
    const { contentEl } = this;
    const { groups, totalAliased } = scanAliasedLinks(this.app);

    if (!groups.length) {
      contentEl.createDiv({
        cls: "bases-toolbox-fr-info",
        text: "No property values use aliased internal links — nothing to standardize.",
      });
      return;
    }

    const inconsistent = groups.filter((g) => g.inconsistent).length;
    contentEl.createDiv({
      cls: "bases-toolbox-fr-info",
      text:
        `${totalAliased} aliased link${totalAliased === 1 ? "" : "s"} across ${groups.length} target note${groups.length === 1 ? "" : "s"}. ` +
        (inconsistent
          ? `⚠ ${inconsistent} target${inconsistent === 1 ? " is" : "s are"} shown more than one way — those are the ones worth standardizing (listed first).`
          : "All targets are shown consistently."),
    });

    for (const g of groups) this.renderGroup(contentEl, g);
  }

  private renderGroup(root: HTMLElement, g: TargetGroup): void {
    const box = root.createDiv({ cls: "bases-toolbox-alias-group" });
    const head = box.createDiv({ cls: "bases-toolbox-alias-head" });
    if (g.inconsistent) {
      const warn = head.createSpan({ cls: "bases-toolbox-alias-warn" });
      setIcon(warn, "alert-triangle");
      warn.setAttribute("aria-label", "Shown more than one way");
    }
    head.createSpan({ cls: "bases-toolbox-alias-target", text: `[[${g.target}]]` });
    const uses = [...g.forms.values()].reduce((n, o) => n + o.length, 0);
    head.createSpan({
      cls: "bases-toolbox-index-prop-count",
      text: `${uses} use${uses === 1 ? "" : "s"}`,
    });

    for (const [form, occs] of g.forms) {
      const fRow = box.createDiv({ cls: "bases-toolbox-alias-form" });
      fRow.createSpan({
        cls: "bases-toolbox-alias-formname",
        text: form === PLAIN ? "plain [[link]]" : `shown as “${form}”`,
      });
      fRow.createSpan({ cls: "bases-toolbox-index-prop-count", text: String(occs.length) });
      const list = fRow.createDiv({ cls: "bases-toolbox-alias-occs" });
      for (const occ of occs) {
        const a = list.createEl("a", {
          cls: "bases-toolbox-index-file-link",
          href: "#",
          text: `${occ.file.path} · ${occ.property}`,
        });
        a.addEventListener("click", (e) => {
          e.preventDefault();
          void this.app.workspace.getLeaf("tab").openFile(occ.file);
        });
      }
    }
  }
}
