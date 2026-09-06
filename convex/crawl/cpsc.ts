import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { crawlInput } from "../recalls";

type CrawlDoc = Infer<typeof crawlInput>;

const API_BASE = "https://www.saferproducts.gov/RestWebServices/Recall?format=json";
const BATCH_SIZE = 40;

function asString(x: unknown): string {
  return typeof x === "string" ? x : "";
}

function cap(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Pull the `key` string out of each element of a CPSC list-of-objects field. */
function stringsFrom(list: unknown, key: string, max: number, each: number): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const el of list) {
    if (typeof el !== "object" || el === null) continue;
    const val = (el as Record<string, unknown>)[key];
    const s = asString(val).trim();
    if (s.length > 0 && !out.includes(cap(s, each))) out.push(cap(s, each));
    if (out.length >= max) break;
  }
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Map one raw CPSC SaferProducts API record (verified live 2026-09-06) to the
 * corpus shape. Returns null for records missing the identity fields; the
 * caller counts those as skipped instead of inventing values.
 */
function mapRecall(rec: Record<string, unknown>): Omit<CrawlDoc, "contentHash"> | null {
  const recallId = rec.RecallID;
  const title = cap(asString(rec.Title), 500);
  const url = asString(rec.URL);
  if (typeof recallId !== "number" || title === "" || url === "") return null;

  // Dates arrive as "2026-09-03T00:00:00" with no zone — pin to UTC.
  const dateStr = asString(rec.RecallDate) || asString(rec.LastPublishDate);
  const publishedAt = Date.parse(
    /(Z|[+-]\d\d:?\d\d)$/.test(dateStr) ? dateStr : `${dateStr}Z`,
  );
  if (!Number.isFinite(publishedAt)) return null;

  const products = Array.isArray(rec.Products) ? rec.Products : [];
  const productNames: string[] = [];
  let unitsText: string | undefined;
  for (const p of products) {
    if (typeof p !== "object" || p === null) continue;
    const pr = p as Record<string, unknown>;
    const name = asString(pr.Name).trim();
    const model = asString(pr.Model).trim();
    if (name) productNames.push(model ? `${name} (model ${model})` : name);
    if (unitsText === undefined && asString(pr.NumberOfUnits).trim()) {
      unitsText = cap(asString(pr.NumberOfUnits), 120);
    }
  }

  const upcs: string[] = [];
  if (Array.isArray(rec.ProductUPCs)) {
    for (const el of rec.ProductUPCs) {
      if (typeof el !== "object" || el === null) continue;
      for (const val of Object.values(el as Record<string, unknown>)) {
        const s = asString(val).replace(/\D/g, "");
        if (s.length >= 8 && s.length <= 14 && !upcs.includes(s)) upcs.push(s);
      }
      if (upcs.length >= 50) break;
    }
  }

  const brandNames = [
    ...stringsFrom(rec.Manufacturers, "Name", 8, 160),
    ...stringsFrom(rec.Importers, "Name", 8, 160),
    ...stringsFrom(rec.Distributors, "Name", 8, 160),
    ...stringsFrom(rec.Retailers, "Name", 8, 160),
  ].filter((name, i, all) => all.indexOf(name) === i);

  const images = Array.isArray(rec.Images) ? rec.Images : [];
  const firstImage =
    images.length > 0 && typeof images[0] === "object" && images[0] !== null
      ? (images[0] as Record<string, unknown>)
      : undefined;

  return {
    source: "cpsc" as const,
    sourceId: String(recallId),
    url,
    title,
    description: cap(asString(rec.Description), 4000),
    brandNames,
    productDesc: cap(productNames.join("; "), 1500),
    upcs,
    hazard: cap(stringsFrom(rec.Hazards, "Name", 4, 1500).join(" "), 2000),
    remedySummary: cap(stringsFrom(rec.Remedies, "Name", 4, 1500).join(" "), 2000),
    remedyOptions: stringsFrom(rec.RemedyOptions, "Option", 6, 60),
    remedyUrl: undefined,
    consumerContact: cap(asString(rec.ConsumerContact), 500) || undefined,
    imageUrl: firstImage ? asString(firstImage.URL) || undefined : undefined,
    imageCaption: firstImage ? cap(asString(firstImage.Caption), 300) || undefined : undefined,
    unitsText,
    publishedAt,
  };
}

/**
 * M2 manual seed / M3 cron target: fetch the CPSC SaferProducts JSON API
 * (the structured listing source; Firecrawl owns detail pages, agencies
 * without JSON feeds, and remedy portals) and upsert idempotently.
 */
export const seedFromApi = internalAction({
  args: { since: v.optional(v.string()) },
  returns: v.object({
    fetched: v.number(),
    skipped: v.number(),
    inserted: v.number(),
    updated: v.number(),
    unchanged: v.number(),
  }),
  handler: async (ctx, args) => {
    const since =
      args.since ??
      new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      throw new Error(`since must be YYYY-MM-DD, got: ${since}`);
    }
    const res = await fetch(`${API_BASE}&RecallDateStart=${since}`);
    if (!res.ok) {
      throw new Error(`CPSC API returned ${res.status}`);
    }
    const json: unknown = await res.json();
    if (!Array.isArray(json)) {
      throw new Error("CPSC API: expected a JSON array");
    }

    const docs: CrawlDoc[] = [];
    let skipped = 0;
    for (const raw of json) {
      if (typeof raw !== "object" || raw === null) {
        skipped++;
        continue;
      }
      const mapped = mapRecall(raw as Record<string, unknown>);
      if (mapped === null) {
        skipped++;
        continue;
      }
      // Key order is fixed by the mapper's literal, so stringify is stable.
      docs.push({ ...mapped, contentHash: await sha256Hex(JSON.stringify(mapped)) });
    }

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const result: { inserted: number; updated: number; unchanged: number } =
        await ctx.runMutation(internal.recalls.upsertBatchFromCrawl, {
          docs: docs.slice(i, i + BATCH_SIZE),
        });
      inserted += result.inserted;
      updated += result.updated;
      unchanged += result.unchanged;
    }
    console.log(
      `CPSC seed since ${since}: fetched=${json.length} skipped=${skipped} inserted=${inserted} updated=${updated} unchanged=${unchanged}`,
    );
    return { fetched: json.length, skipped, inserted, updated, unchanged };
  },
});
