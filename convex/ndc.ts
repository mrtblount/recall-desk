/**
 * National Drug Code helpers — pure, no Convex imports, unit-tested.
 *
 * An NDC is printed in one of three 10-digit configurations (4-4-2, 5-3-2,
 * 5-4-1) or the 11-digit 5-4-2 billing form. Pharmacy receipts, Rx labels and
 * openFDA enforcement records all print it with hyphens, so hyphenated input is
 * unambiguous and normalizes to the 5-4-2 form (zero-pad each segment). Eleven
 * bare digits are already 5-4-2. Ten bare digits are ambiguous and rejected —
 * a wrong guess would create false matches on a safety surface.
 */

/** Labeler 4-5 digits, product 3-4, package 1-2 — the only printed shapes.
 * Anything looser would accept an ISO date ("2026-09-11") as an NDC. */
const HYPHENATED_RE = /^(\d{4,5})[-\s](\d{3,4})[-\s](\d{1,2})$/;

/** Normalize an NDC to "NNNNN-NNNN-NN", or null when it isn't one. */
export function normalizeNdc(raw: string): string | null {
  const s = raw.trim().replace(/^ndc\s*#?\s*:?\s*/i, "").trim();
  const hy = HYPHENATED_RE.exec(s);
  if (hy) {
    return `${hy[1].padStart(5, "0")}-${hy[2].padStart(4, "0")}-${hy[3].padStart(2, "0")}`;
  }
  if (/^\d{11}$/.test(s)) {
    return `${s.slice(0, 5)}-${s.slice(5, 9)}-${s.slice(9, 11)}`;
  }
  return null;
}

/**
 * Every hyphenated NDC in free text (with or without an "NDC" prefix),
 * normalized and deduped. Segment lengths 4-5 / 3-4 / 1-2 exclude phone
 * numbers (3-3-4) and ISO dates (4-2-2).
 */
export function extractNdcs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<!\d)(\d{4,5})-(\d{3,4})-(\d{1,2})(?!\d)/g)) {
    const normalized = normalizeNdc(m[0]);
    if (normalized !== null && !out.includes(normalized)) out.push(normalized);
    if (out.length >= 50) break;
  }
  return out;
}

/** The recallUpcs lookup key for an NDC (the table also holds UPC digits). */
export function ndcKey(normalized: string): string {
  return `ndc:${normalized}`;
}
