import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import schema from "../schema";
import { fetchAndMapCpsc, upsertInBatches } from "./cpsc";
import { MAX_DETAIL_SCRAPES_PER_RUN } from "./detail";

const CPSC_LISTING_KEY = "cpsc-listing";
/** Rolling re-check window: CPSC republishes changed recalls, and the API is
 * queried by LAST publish date, so 14 days catches every recent update while
 * staying one cheap request. */
const WINDOW_DAYS = 14;

/** Idempotent registry seeding — safe to run on every deploy. */
export const ensureSeeds = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("feedSources")
      .withIndex("by_key", (q) => q.eq("key", CPSC_LISTING_KEY))
      .unique();
    if (existing === null) {
      await ctx.db.insert("feedSources", {
        key: CPSC_LISTING_KEY,
        kind: "listing",
        url: "https://www.saferproducts.gov/RestWebServices/Recall?format=json",
        cadenceMinutes: 120,
        enabled: true,
      });
    }
    return null;
  },
});

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
    for (const feed of due) {
      if (feed.key !== CPSC_LISTING_KEY) {
        console.warn(`runDueFeeds: no handler for feed key ${feed.key}`);
        continue;
      }
      const since = new Date(now - WINDOW_DAYS * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const { docs, fetched, skipped } = await fetchAndMapCpsc(since);
      const totals = await upsertInBatches(
        ctx,
        docs,
        MAX_DETAIL_SCRAPES_PER_RUN,
      );
      await ctx.runMutation(internal.crawl.feeds.markFeedCrawled, {
        feedId: feed._id,
        crawledAt: now,
      });
      feedsRun++;
      changed += totals.changedIds.length;
      console.log(
        `feed ${feed.key}: fetched=${fetched} skipped=${skipped} inserted=${totals.inserted} updated=${totals.updated} unchanged=${totals.unchanged} detailScrapesEnqueued=${totals.detailScrapesEnqueued}`,
      );
    }
    return { feedsRun, changed };
  },
});
