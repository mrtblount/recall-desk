import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import schema from "../schema";
import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import { components } from "../_generated/api";
import { fetchAndMapCpsc, sha256Hex, upsertInBatches, type CrawlDoc } from "./cpsc";
import { MAX_DETAIL_SCRAPES_PER_RUN } from "./detail";
import { FDA_LANES, fdaWindowUrls, mapFdaRecord, type CrawlDocWithStatus } from "./fda";
import {
  FSIS_API_URL,
  FSIS_FETCH_HEADERS,
  FSIS_MIN_EXPECTED_RECORDS,
  mapFsisRecord,
} from "./fsis";

const firecrawl = new FirecrawlClient(components.firecrawl);

const CPSC_LISTING_KEY = "cpsc-listing";
const FDA_LISTING_KEY = "fda-listing";
const FSIS_LISTING_KEY = "fsis-listing";
/** Rolling re-check window: CPSC republishes changed recalls, and the API is
 * queried by LAST publish date, so 14 days catches every recent update while
 * staying one cheap request. */
const WINDOW_DAYS = 14;

/** Idempotent registry seeding — safe to run on every deploy. */
export const ensureSeeds = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const seeds = [
      {
        key: CPSC_LISTING_KEY,
        url: "https://www.saferproducts.gov/RestWebServices/Recall?format=json",
        cadenceMinutes: 120,
      },
      // openFDA refreshes weekly; daily polling is ample safety margin.
      { key: FDA_LISTING_KEY, url: "https://api.fda.gov", cadenceMinutes: 720 },
      { key: FSIS_LISTING_KEY, url: FSIS_API_URL, cadenceMinutes: 360 },
    ];
    for (const seed of seeds) {
      const existing = await ctx.db
        .query("feedSources")
        .withIndex("by_key", (q) => q.eq("key", seed.key))
        .unique();
      if (existing === null) {
        await ctx.db.insert("feedSources", {
          key: seed.key,
          kind: "listing" as const,
          url: seed.url,
          cadenceMinutes: seed.cadenceMinutes,
          enabled: true,
        });
      }
    }
    return null;
  },
});

async function hashDocs(
  mapped: Array<Omit<CrawlDocWithStatus, "contentHash">>,
): Promise<CrawlDocWithStatus[]> {
  const out: CrawlDocWithStatus[] = [];
  for (const doc of mapped) {
    out.push({ ...doc, contentHash: await sha256Hex(JSON.stringify(doc)) });
  }
  return out;
}

/** openFDA: dual windows (report_date for new, termination_date for
 * closures). A 404 means zero matches in the window, not an error. */
async function fetchFda(sinceYYYYMMDD: string, todayYYYYMMDD: string): Promise<{
  fetched: number;
  skipped: number;
  docs: CrawlDocWithStatus[];
}> {
  const bySourceId = new Map<string, Omit<CrawlDocWithStatus, "contentHash">>();
  let fetched = 0;
  let skipped = 0;
  for (const lane of FDA_LANES) {
    for (const url of fdaWindowUrls(lane, sinceYYYYMMDD, todayYYYYMMDD)) {
      const res = await fetch(url);
      if (res.status === 404) continue; // empty window
      if (!res.ok) throw new Error(`openFDA ${lane} returned ${res.status}`);
      const json: unknown = await res.json();
      const results =
        typeof json === "object" && json !== null && Array.isArray((json as Record<string, unknown>).results)
          ? ((json as Record<string, unknown>).results as unknown[])
          : [];
      for (const raw of results) {
        fetched++;
        if (typeof raw !== "object" || raw === null) {
          skipped++;
          continue;
        }
        const mapped = mapFdaRecord(raw as Record<string, unknown>);
        if (mapped === null) {
          skipped++;
          continue;
        }
        bySourceId.set(mapped.sourceId, mapped); // closure window wins over dup
      }
    }
  }
  return { fetched, skipped, docs: await hashDocs([...bySourceId.values()]) };
}

/** FSIS: full English feed each run (tiny: ~900KB, ~1.2k records); direct
 * fetch with the Akamai-passing header set, Firecrawl as the fallback
 * fetcher when the direct path is denied from this IP. */
async function fetchFsis(ctx: Parameters<typeof upsertInBatches>[0]): Promise<{
  fetched: number;
  skipped: number;
  docs: CrawlDocWithStatus[];
  via: string;
}> {
  let body = "";
  let via = "direct";
  try {
    const res = await fetch(FSIS_API_URL, { headers: FSIS_FETCH_HEADERS });
    if (res.ok) {
      body = await res.text();
    } else {
      console.warn(`FSIS direct fetch denied (${res.status}); falling back to Firecrawl`);
    }
  } catch (error) {
    console.warn(`FSIS direct fetch failed (${String(error)}); falling back to Firecrawl`);
  }
  if (!body.trim().startsWith("[")) {
    via = "firecrawl";
    const doc: unknown = await firecrawl.scrape(ctx as never, FSIS_API_URL, {
      formats: ["rawHtml"],
      onlyMainContent: false,
      maxAge: 0,
      timeout: 120_000,
    });
    let raw = "";
    if (typeof doc === "object" && doc !== null) {
      const r = doc as Record<string, unknown>;
      raw = typeof r.rawHtml === "string" ? r.rawHtml : typeof r.html === "string" ? r.html : "";
    }
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end <= start) throw new Error("FSIS: no JSON array via Firecrawl");
    body = raw
      .slice(start, end + 1)
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
  }
  const json: unknown = JSON.parse(body);
  if (!Array.isArray(json)) throw new Error("FSIS: expected a JSON array");
  if (json.length < FSIS_MIN_EXPECTED_RECORDS) {
    throw new Error(`FSIS: only ${json.length} records — refusing a suspiciously small feed`);
  }
  const mapped: Array<Omit<CrawlDocWithStatus, "contentHash">> = [];
  let skipped = 0;
  for (const raw of json) {
    if (typeof raw !== "object" || raw === null) {
      skipped++;
      continue;
    }
    const m = mapFsisRecord(raw as Record<string, unknown>);
    if (m === null) {
      skipped++;
      continue;
    }
    mapped.push(m);
  }
  return { fetched: json.length, skipped, docs: await hashDocs(mapped), via };
}

export const listDueFeeds = internalQuery({
  args: { now: v.number() },
  returns: v.array(schema.doc("feedSources")),
  handler: async (ctx, args) => {
    const feeds = await ctx.db.query("feedSources").take(50);
    // 5-minute slack so a cron that fires slightly early still runs the feed.
    return feeds.filter(
      (f) =>
        f.enabled &&
        (f.lastCrawledAt === undefined ||
          args.now - f.lastCrawledAt >= f.cadenceMinutes * 60_000 - 300_000),
    );
  },
});

export const markFeedCrawled = internalMutation({
  args: { feedId: v.id("feedSources"), crawledAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("feedSources", args.feedId, {
      lastCrawledAt: args.crawledAt,
    });
    return null;
  },
});

/**
 * Cron target (every 2h): run every enabled feed that is due, upsert, then
 * enqueue Firecrawl detail scrapes for the recalls that changed — so new
 * recalls appear and get enriched with no manual action.
 */
export const runDueFeeds = internalAction({
  args: {},
  returns: v.object({ feedsRun: v.number(), changed: v.number() }),
  handler: async (ctx) => {
    // Self-seeding: a fresh deployment must not depend on anyone remembering
    // to run ensureSeeds — an empty registry would make every cron tick a
    // silent no-op forever.
    await ctx.runMutation(internal.crawl.feeds.ensureSeeds, {});
    const now = Date.now();
    const due = await ctx.runQuery(internal.crawl.feeds.listDueFeeds, { now });
    let feedsRun = 0;
    let changed = 0;
    const since = new Date(now - WINDOW_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const sinceCompact = since.replace(/-/g, "");
    const todayCompact = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
    for (const feed of due) {
      try {
        let docs: CrawlDoc[] | CrawlDocWithStatus[] = [];
        let fetched = 0;
        let skipped = 0;
        let extra = "";
        if (feed.key === CPSC_LISTING_KEY) {
          ({ docs, fetched, skipped } = await fetchAndMapCpsc(since));
        } else if (feed.key === FDA_LISTING_KEY) {
          ({ docs, fetched, skipped } = await fetchFda(sinceCompact, todayCompact));
        } else if (feed.key === FSIS_LISTING_KEY) {
          const r = await fetchFsis(ctx);
          docs = r.docs;
          fetched = r.fetched;
          skipped = r.skipped;
          extra = ` via=${r.via}`;
        } else {
          console.warn(`runDueFeeds: no handler for feed key ${feed.key}`);
          continue;
        }
        const totals = await upsertInBatches(ctx, docs, MAX_DETAIL_SCRAPES_PER_RUN);
        await ctx.runMutation(internal.crawl.feeds.markFeedCrawled, {
          feedId: feed._id,
          crawledAt: now,
        });
        feedsRun++;
        changed += totals.changedIds.length;
        console.log(
          `feed ${feed.key}: fetched=${fetched} skipped=${skipped} inserted=${totals.inserted} updated=${totals.updated} unchanged=${totals.unchanged} detailScrapesEnqueued=${totals.detailScrapesEnqueued}${extra}`,
        );
      } catch (error) {
        // One broken feed must not block the others; the next due tick retries.
        console.error(`feed ${feed.key} failed: ${String(error)}`);
      }
    }
    return { feedsRun, changed };
  },
});
