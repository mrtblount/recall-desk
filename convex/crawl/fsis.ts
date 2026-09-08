import type { CrawlDocWithStatus } from "./fda";

/**
 * USDA FSIS recall API (verified live 2026-09-07). One JSON array of every
 * recall + public health alert since 2014; English-only via the language
 * param. Sits behind Akamai Bot Manager: the exact header set below passes;
 * anything less returns a 403 edgesuite page. When the direct fetch is
 * denied (e.g. from a datacenter IP), the caller falls back to fetching the
 * same URL through Firecrawl.
 */
export const FSIS_API_URL =
  "https://www.fsis.usda.gov/fsis/api/recall/v/1?field_translation_language=en";

export const FSIS_FETCH_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
};

/** Guard against a silently empty/filtered response replacing the corpus. */
export const FSIS_MIN_EXPECTED_RECORDS = 1000;

function asString(x: unknown): string {
  return typeof x === "string" ? x : "";
}

function cap(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Decode the HTML entities observed corpus-wide and strip tags. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** The action sentence(s) from an FSIS summary, verbatim. */
export function extractFsisRemedy(summary: string): string {
  const sentences = summary.split(/(?<=[.!?])\s+/);
  const hits = sentences.filter((s) =>
    /urged not to|should not (be )?(consume|use)|do not (consume|use)|thrown away|discard|returned to the place of purchase/i.test(s),
  );
  return hits.slice(0, 2).join(" ");
}

function strings(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((x) => asString(x)).filter((s) => s.trim() !== "");
}

/**
 * Map one FSIS record. Verified semantics: field_recall_type is THE status
 * field (field_active_notice is unreliable); expansions arrive as NEW
 * records whose recall number ends in -EXP; recall numbers need .trim();
 * all field_recall_url values are http:// (rewritten to https).
 */
export function mapFsisRecord(rec: Record<string, unknown>): Omit<CrawlDocWithStatus, "contentHash"> | null {
  if (asString(rec.langcode) !== "" && asString(rec.langcode) !== "English") return null;
  const recallNumber = asString(rec.field_recall_number).trim();
  const title = stripHtml(asString(rec.field_title));
  const publishedAt = Date.parse(`${asString(rec.field_recall_date).trim()}T00:00:00Z`);
  if (recallNumber === "" || title === "" || !Number.isFinite(publishedAt)) return null;

  const recallType = asString(rec.field_recall_type).trim();
  const riskLevel = asString(rec.field_risk_level).trim();
  const reasons = strings(rec.field_recall_reason);
  const summary = stripHtml(asString(rec.field_summary));
  const products = strings(rec.field_product_items).map((p) =>
    stripHtml(p.replace(/^[••]\s*\t?/, "")),
  );
  const states = [...new Set(strings(rec.field_states))];
  const url = asString(rec.field_recall_url).trim().replace(/^http:\/\//, "https://");

  const isExpansion = /-EXP\s*$/i.test(recallNumber);
  // Assert the state we know — an undefined override could never REOPEN a
  // closed row when FSIS flips a record back to Active (review finding).
  const statusOverride =
    recallType === "Closed Recall"
      ? ("closed" as const)
      : isExpansion
        ? ("expanded" as const)
        : ("active" as const);

  const hazardParts = [
    recallType === "Public Health Alert" ? "Public health alert" : "",
    [reasons.join(", "), riskLevel ? `(${riskLevel})` : ""].filter((p) => p !== "").join(" "),
  ].filter((p) => p !== "");

  return {
    source: "fsis" as const,
    sourceId: recallNumber,
    url: url !== "" ? url : "https://www.fsis.usda.gov/recalls",
    title: cap(title, 300),
    description: cap(summary, 4000),
    brandNames: [],
    productDesc: cap(products.join("; "), 1500),
    upcs: [],
    hazard: cap(hazardParts.join(" — "), 2000),
    // Sourced from the official summary (FSIS notices carry an "urged not
    // to consume… should be thrown away or returned" sentence); empty when
    // absent — never synthesized.
    remedySummary: cap(extractFsisRemedy(summary), 2000),
    remedyOptions: [],
    remedyUrl: undefined,
    consumerContact: undefined,
    imageUrl: undefined,
    imageCaption: undefined,
    unitsText: states.length > 0 ? cap(`Distributed in ${states.length} state${states.length === 1 ? "" : "s"}`, 120) : undefined,
    publishedAt,
    statusOverride,
  };
}
