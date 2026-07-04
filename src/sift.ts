/**
 * Sift: lenient token filter for search/filter boxes.
 *
 * - Split the query on whitespace; EVERY token must appear (any order).
 * - Case-insensitive substring per token.
 * - Hyphen / underscore / whitespace are treated as equivalent, so a query of
 *   "fruit basket" matches a `fruit-basket` (or `fruit_basket`) property.
 *
 * An empty query matches everything.
 */

/** Lowercase and unify separators (-, _, whitespace) to single spaces. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[-_\s]+/g, " ").trim();
}

/** True if every whitespace-token of `query` is a substring of some target. */
export function siftMatch(query: string, ...targets: string[]): boolean {
  const tokens = normalize(query).split(" ").filter(Boolean);
  if (!tokens.length) return true;
  const hay = targets.map(normalize);
  return tokens.every((tok) => hay.some((h) => h.includes(tok)));
}
