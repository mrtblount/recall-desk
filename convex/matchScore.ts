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
  };
  recall: {
    title: string;
    brandNames: string[];
    productDesc: string;
    upcs: string[];
  };
};

/**
 * Candidate score. UPC equality is near-proof; an exact model token is very
 * strong; brand + product token overlap builds the rest. Deterministic and
 * cheap — runs in a query over search-index hits only.
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
