/** Pure prefilter scoring for item-recall candidacy. Unit-tested. */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "with", "in", "on", "by",
  "due", "to", "recall", "recalls", "recalled", "hazard", "risk", "sold",
  "model", "new", "set", "pack", "count", "oz", "inch", "black", "white",
]);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

export type ScoreInput = {
  item: {
    product: string;
    brand?: string;
    model?: string;
    upc?: string;
    /** National Drug Code, normalized 5-4-2 (see ndc.ts). */
    ndc?: string;
    /** Lot / batch as printed (uppercased upstream). */
    lot?: string;
  };
  recall: {
    title: string;
    brandNames: string[];
    productDesc: string;
    upcs: string[];
    /** NDCs mined from productDesc + description, normalized 5-4-2. */
    ndcs: string[];
    /** Free text carrying lot/batch codes — the FDA "Codes: Lot #: …"
     * part lives in description, so callers pass description here. */
    codeText: string;
  };
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whole-token, case-insensitive presence. Alphanumeric lookarounds instead
 * of \b: \b flips meaning when the needle starts or ends on a non-word
 * character (a lot like "#4471"), while what we actually need is "not glued
 * to other letters/digits" — lot "2402443" must not hit inside "D2402443",
 * and "D2402443" must not hit inside "D24024431".
 */
export function hasWholeToken(haystack: string, needle: string): boolean {
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(needle)}(?![A-Za-z0-9])`, "i");
  return re.test(haystack);
}

/** Lots shorter than this ("12", "A1") are too common to be evidence. */
const MIN_LOT_LENGTH = 4;

/**
 * Candidate score. UPC equality is near-proof; an NDC match pins the exact
 * drug/labeler/package; a lot match is strong but lots are reused across
 * products, so it ranks below NDC; an exact model token is very strong;
 * brand + product token overlap builds the rest. Deterministic and cheap —
 * runs in a query over search-index hits only.
 */
export function itemRecallScore({ item, recall }: ScoreInput): {
  score: number;
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];
  const recallText = `${recall.title} ${recall.brandNames.join(" ")} ${recall.productDesc}`.toLowerCase();

  if (item.upc && recall.upcs.includes(item.upc)) {
    score += 100;
    reasons.push(`UPC ${item.upc} listed in the recall`);
  }
  if (item.ndc && recall.ndcs.includes(item.ndc)) {
    score += 60;
    reasons.push(`NDC ${item.ndc} listed in the recall`);
  }
  const lot = item.lot?.trim() ?? "";
  // An all-numeric "lot" under six digits is indistinguishable from a year,
  // a count, or one segment of an NDC/UPC in the recall text (hyphens and
  // spaces are token boundaries), so it needs a letter or six-plus digits.
  if (lot.length >= MIN_LOT_LENGTH && (/[A-Za-z]/.test(lot) || lot.length >= 6)) {
    // Lots are printed in the title/productDesc for some sources and in the
    // description's "Codes:" tail for FDA — search all three.
    const lotText = `${recall.title} ${recall.productDesc} ${recall.codeText}`;
    if (hasWholeToken(lotText, lot)) {
      score += 40;
      reasons.push(`lot ${lot} listed in the recall`);
    }
  }
  if (item.model && item.model.length >= 3) {
    const model = item.model.toLowerCase();
    if (recallText.includes(model)) {
      score += 40;
      reasons.push(`model "${item.model}" appears in the recall`);
    }
  }
  if (item.brand) {
    const brandTokens = tokenize(item.brand);
    const hits = brandTokens.filter((t) => recallText.includes(t));
    if (hits.length > 0 && hits.length === brandTokens.length) {
      score += 15;
      reasons.push(`brand "${item.brand}" matches`);
    }
  }
  const productTokens = tokenize(item.product);
  const productHits = productTokens.filter((t) => recallText.includes(t));
  score += productHits.length * 3;
  if (productHits.length >= 2) {
    reasons.push(`product terms: ${productHits.slice(0, 5).join(", ")}`);
  }
  return { score, reasons };
}

/** Below this, a recall is not worth an LLM's time for this item. */
export const CANDIDATE_MIN_SCORE = 15;
