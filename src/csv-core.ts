/**
 * Core CSV logic ported from the companion web app
 * (github.com/grub-basket/CSV-to-Obsidian-Properties-for-Bases), with the
 * line-splitting parser replaced by a state machine so quoted fields may
 * contain newlines, and without JSZip — the plugin writes into the vault.
 */

export const CSV_TYPES = ["text", "number", "date", "boolean", "list", "link"] as const;
export type CsvType = (typeof CSV_TYPES)[number];

export function parseCSV(text: string): string[][] {
  const nl = text.indexOf("\n");
  const firstLine = nl === -1 ? text : text.slice(0, nl);
  const delim =
    (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? "\t" : ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuote = false;
  let fieldStart = true;

  const endField = () => {
    row.push(cur.trim());
    cur = "";
    fieldStart = true;
  };
  const endRow = () => {
    endField();
    if (row.some((c) => c !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuote = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"' && fieldStart) {
      inQuote = true;
      fieldStart = false;
    } else if (ch === delim) endField();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      cur += ch;
      fieldStart = false;
    }
  }
  endRow();
  return rows;
}

export function toPropertyKey(str: string): string {
  return str
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "");
}

export function guessType(header: string, samples: string[]): CsvType {
  const h = header.toLowerCase();
  if (h.includes("date") || h.includes("time")) return "date";
  if (
    h.includes("amount") ||
    h.includes("balance") ||
    h.includes("total") ||
    h.includes("number") ||
    h.includes("num") ||
    h.includes("acct")
  )
    return "number";
  if (h.includes("link") || h.includes("url")) return "link";
  const nonEmpty = samples.filter((v) => v !== "");
  if (nonEmpty.length && nonEmpty.every((v) => !Number.isNaN(Number(v)))) return "number";
  return "text";
}

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

export function normalizeDate(val: string): string {
  val = val.trim();
  if (!val) return val;
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(val)) return val;

  let d: Date | null = null;
  let m = val.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // M/D/YYYY (US, Excel default)
  if (m) d = new Date(+m[3], +m[1] - 1, +m[2]);
  if (!d) {
    m = val.match(/^(\d{1,2})[-.](\d{1,2})[-.](\d{4})$/); // D-M-YYYY / D.M.YYYY
    if (m) d = new Date(+m[3], +m[2] - 1, +m[1]);
  }
  if (!d) {
    m = val.match(/^([a-zA-Z]+)\s+(\d{1,2}),?\s+(\d{4})$/); // January 5, 2024
    if (m && MONTHS[m[1].toLowerCase()] !== undefined)
      d = new Date(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  }
  if (!d) {
    m = val.match(/^(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})$/); // 5 January 2024
    if (m && MONTHS[m[2].toLowerCase()] !== undefined)
      d = new Date(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  }
  if (!d && /^\d+$/.test(val)) {
    const n = parseInt(val, 10); // Excel serial (epoch Dec 30 1899)
    if (n > 1 && n < 60000) d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
  }
  if (d && !Number.isNaN(d.getTime())) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  return val;
}

/** Converts one CSV cell to a frontmatter value for the chosen type. */
export function cellToValue(raw: string, type: CsvType): unknown {
  const val = raw.trim();
  if (val === "") return null;
  switch (type) {
    case "number": {
      const n = Number(val);
      return Number.isNaN(n) ? val : n;
    }
    case "boolean":
      return ["true", "1", "yes"].includes(val.toLowerCase());
    case "date":
      return normalizeDate(val);
    case "list":
      // Multi-value cells separated by ";" (or the whole cell as one item).
      return val.split(";").map((s) => s.trim()).filter(Boolean);
    case "link":
      return `[[${val}]]`;
    default:
      return val;
  }
}

export function sanitizeFilename(str: string): string {
  return str.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || "untitled";
}

/** Serializes one CSV cell for export: quote when needed, strip wikilinks. */
export function toCsvCell(value: unknown): string {
  let s: string;
  if (value === null || value === undefined) s = "";
  else if (Array.isArray(value)) s = value.map((v) => cleanValue(String(v))).join("; ");
  else s = cleanValue(String(value));
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function cleanValue(s: string): string {
  return s.replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_, target, __, alias) => alias ?? target);
}
