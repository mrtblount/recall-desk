import type { CrawlDoc } from "./cpsc";

export type CrawlDocWithStatus = CrawlDoc & {
  statusOverride?: "active" | "expanded" | "closed";
};

/**
 * openFDA enforcement lanes (verified live 2026-09-07). Device is excluded:
 * it skews clinical/hospital and dilutes the everyday-consumer corpus.
 * Records carry NO per-record URL — cards link to FDA's IRES search app.
 */
export const FDA_LANES = ["food", "drug"] as const;
/** Cards link to FDA's human recalls page: enforcement records carry no
 * per-record URL, and IRES bot-walls non-browser clients (302 -> abuse
 * apology, skeptic-verified), so it cannot be health-checked or trusted. */
export const FDA_RECALLS_URL =
  "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts";

function asString(x: unknown): string {
  return typeof x === "string" ? x : "";
}

function cap(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** YYYYMMDD (openFDA) -> ms since epoch (UTC). */
function parseFdaDate(s: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isFinite(ts) ? ts : null;
}

/** UPC/GTIN digits buried in free text ("UPC No. 632687615989", "UPC: ..."). */
export function extractUpcsFromText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:UPC|GTIN)[^0-9]{0,12}(\d[\d\s-]{6,18}\d)/gi)) {
    const digits = m[1].replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 14 && !out.includes(digits)) {
      out.push(digits);
    }
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Map one openFDA enforcement record (fields verified live 2026-09-07).
 * Returns null when identity fields are missing — never invents values.
 */
export function mapFdaRecord(rec: Record<string, unknown>): Omit<CrawlDocWithStatus, "contentHash"> | null {
  const recallNumber = asString(rec.recall_number).trim();
  const productDescription = asString(rec.product_description).trim();
  const publishedAt = parseFdaDate(asString(rec.report_date));
  // "N/A" recall numbers exist in BOTH food and drug lanes (skeptic-verified)
  // and would collide under one upsert key — skip degenerate identities.
  if (
    recallNumber === "" ||
    recallNumber.toUpperCase() === "N/A" ||
    productDescription === "" ||
    publishedAt === null
  ) {
    return null;
  }
  const firm = asString(rec.recalling_firm).trim();
  const classification = asString(rec.classification).trim(); // "Class I|II|III"
  const reason = asString(rec.reason_for_recall).trim();
  const status = asString(rec.status).trim(); // Ongoing|Completed|Terminated|Pending
  const distribution = asString(rec.distribution_pattern).trim();
  const quantity = asString(rec.product_quantity).trim();
  const voluntary = asString(rec.voluntary_mandated).trim();
  const notification = asString(rec.initial_firm_notification).trim();

  const codeText = [
    asString(rec.code_info),
    asString(rec.more_code_info),
    productDescription,
  ].join(" ");

  const descriptionParts = [
    reason,
    distribution ? `Distribution: ${distribution}.` : "",
    quantity ? `Quantity: ${quantity}.` : "",
    asString(rec.code_info).trim() ? `Codes: ${cap(asString(rec.code_info), 400)}` : "",
  ].filter((p) => p !== "");

  return {
    source: "fda" as const,
    sourceId: recallNumber,
    url: FDA_RECALLS_URL,
    title: cap(productDescription, 200),
    description: cap(descriptionParts.join(" "), 4000),
    brandNames: firm ? [cap(firm, 160)] : [],
    productDesc: cap(productDescription, 1500),
    upcs: extractUpcsFromText(codeText),
    hazard: cap(classification ? `${classification} — ${reason}` : reason, 2000),
    remedySummary: cap(
      [voluntary, notification ? `Customers notified by ${notification.toLowerCase()}.` : ""]
        .filter((p) => p !== "")
        .join(". "),
      2000,
    ),
    remedyOptions: [],
    remedyUrl: undefined,
    consumerContact: undefined,
    imageUrl: undefined,
    imageCaption: undefined,
    unitsText: quantity ? cap(quantity, 120) : undefined,
    publishedAt,
    statusOverride:
      status === "Completed" || status === "Terminated" ? ("closed" as const) : undefined,
  };
}

/** Build the two windowed request URLs for one lane (new + closures). */
export function fdaWindowUrls(lane: string, sinceYYYYMMDD: string, todayYYYYMMDD: string): string[] {
  const base = `https://api.fda.gov/${lane}/enforcement.json`;
  const range = (field: string) =>
    `${base}?search=${field}:%5B${sinceYYYYMMDD}+TO+${todayYYYYMMDD}%5D&sort=${field}:asc&limit=1000`;
  return [range("report_date"), range("termination_date")];
}
