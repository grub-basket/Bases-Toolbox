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
  // count candidate delimiters OUTSIDE quotes, else quoted commas skew the sniff
  const countOutsideQuotes = (line: string, ch: string): number => {
    let n = 0;
    let q = false;
    for (const c of line) {
      if (c === '"') q = !q;
      else if (c === ch && !q) n++;
    }
    return n;
  };
  const delim = countOutsideQuotes(firstLine, "\t") > countOutsideQuotes(firstLine, ",") ? "\t" : ",";

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

/**
 * Title Case with spaces ("account-holder-name" → "Account Holder Name"),
 * preserving existing caps ("USD" stays "USD"). Chosen consciously in the web
 * tool: display quality over formula ergonomics (spaced names need
 * note["Account Holder Name"] syntax in Bases formulas).
 */
export function toPropertyName(str: string): string {
  return (
    str
      .replace(/[_-]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") || "Column"
  );
}

export function guessType(header: string, samples: string[]): CsvType {
  const h = header.toLowerCase();
  const nonEmpty = samples.filter((v) => v.trim() !== "");
  // External URLs must NOT become "link": Obsidian's link type only resolves
  // internal [[wikilinks]], so `[[https://…]]` renders as a broken internal
  // link. Keep URL columns as text — the URL stays intact and clickable in
  // reading view. (This also drops the old "url" header → link mapping.)
  const looksUrl =
    nonEmpty.length > 0 && nonEmpty.every((v) => /^https?:\/\/\S+$/i.test(v.trim()));
  if (looksUrl) return "text";
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
  // "link" only for genuine internal-link columns (values are note names);
  // url-valued columns already returned "text" above.
  if (h.includes("link")) return "link";
  if (nonEmpty.length && nonEmpty.every((v) => !Number.isNaN(Number(v)))) return "number";
  return "text";
}

/**
 * Parses a "list" paste into rows/columns: records are separated by one or more
 * blank lines, and each record's non-empty lines become fields (columns) by
 * position. Unlike CSV there's no header row — headers are synthetic ("Column
 * 1..N") and every record is a data row. Column count is the most COMMON field
 * count across records, so an occasional stray line doesn't spawn a phantom
 * column; short records are padded, long ones truncated.
 *
 * Example (Chrome tab-export style): "Title\nhttps://…\n\nTitle2\nhttps://…"
 * → 2 columns, one row per title/URL pair.
 */
export function parseList(text: string): { headers: string[]; rows: string[][] } {
  const blocks = text
    .split(/\r?\n[ \t]*\r?\n+/) // blank (or whitespace-only) line(s) separate records
    .map((b) => b.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
    .filter((b) => b.length > 0);
  if (!blocks.length) return { headers: [], rows: [] };
  const freq = new Map<number, number>();
  for (const b of blocks) freq.set(b.length, (freq.get(b.length) ?? 0) + 1);
  let cols = 1;
  let best = 0;
  for (const [n, count] of freq) {
    if (count > best || (count === best && n > cols)) {
      best = count;
      cols = n;
    }
  }
  const headers = Array.from({ length: cols }, (_, i) => `Column ${i + 1}`);
  const rows = blocks.map((b) => Array.from({ length: cols }, (_, i) => b[i] ?? ""));
  return { headers, rows };
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
    if (n > 1 && n < 60000) {
      // compute in UTC, then rebuild as a local date so the local getters
      // below don't shift it a day west of UTC
      const u = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      d = new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
    }
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
      // One cell can hold multiple items, separated by ";" or ",".
      // Known gap (documented in the web tool too): "Doe, Jane" splits wrongly.
      return val.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    case "link":
      return `[[${val}]]`;
    default:
      return val;
  }
}

export function sanitizeFilename(str: string): string {
  return str.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || "untitled";
}

/**
 * Counts M/D/YYYY-style dates where day and month are both ≤ 12 — those are
 * ambiguous (3/4/2024 silently reads as March 4, US order). Surfaced as a
 * warning so the user can double-check.
 */
export function countAmbiguousDates(values: string[]): number {
  let n = 0;
  for (const v of values) {
    const m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/\d{4}$/);
    if (m && +m[1] <= 12 && +m[2] <= 12 && m[1] !== m[2]) n++;
  }
  return n;
}

/** Serializes one CSV cell for export: quote when needed, strip wikilinks. */
function toDelimitedCell(value: unknown, delim: "," | "\t"): string {
  let s: string;
  if (value === null || value === undefined) s = "";
  else if (Array.isArray(value)) s = value.map((v) => cleanValue(String(v))).join("; ");
  else s = cleanValue(String(value));
  // Neutralize spreadsheet formula injection (OWASP): a leading =, +, @,
  // tab or CR — or a leading - that isn't just a negative number — gets an
  // apostrophe prefix so Excel/LibreOffice treat the cell as text.
  if (/^[=+@\t\r]/.test(s) || (s.startsWith("-") && !/^-\d*\.?\d+$/.test(s))) {
    s = "'" + s;
  }
  const needsQuote = delim === "," ? /[",\n]/ : /["\t\n]/;
  return needsQuote.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsvCell(value: unknown): string {
  return toDelimitedCell(value, ",");
}

/** Same cleaning/quoting as toCsvCell but tab-delimited — for "Copy for Excel". */
export function toTsvCell(value: unknown): string {
  return toDelimitedCell(value, "\t");
}

/** Unwraps [[wikilinks]] (keeping aliases) to plain text. */
export function stripWikilinks(s: string): string {
  return cleanValue(s);
}

function cleanValue(s: string): string {
  return s.replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_, target, __, alias) => alias ?? target);
}
