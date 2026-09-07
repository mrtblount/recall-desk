import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { crawlPool } from "./pools";
import schema, { recallDoc, vSource } from "./schema";

/** What a crawl produces: everything except the server-stamped fields. */
export const crawlInput = recallDoc.omit(
  "lastSeenAt",
  "status",
  "detailScrapedAt",
);

/**
 * Idempotent upsert keyed on [source, sourceId]:
 * - new recall            -> insert (status "active") and bump the ticker
 * - same contentHash      -> touch lastSeenAt only
 * - different contentHash -> archive the prior version to recallRevisions,
 *   then REPLACE the row. Replace, not patch: undefined optional args are
 *   stripped in transit, so patch could never clear a field the source
 *   removed — the row would diverge from its own contentHash forever.
 * Stats are maintained in this same mutation so they can never drift.
 */
export const upsertBatchFromCrawl = internalMutation({
  args: {
    docs: v.array(crawlInput),
    // Max fresh detail scrapes to enqueue IN THIS TRANSACTION for changed
    // rows. Enqueueing here (workpool's primary pattern) makes the hash
    // write and the scrape enqueue atomic — an action dying between the two
    // could otherwise orphan changed rows from enrichment forever.
    maxDetailScrapes: v.optional(v.number()),
  },
  returns: v.object({
    inserted: v.number(),
    updated: v.number(),
    unchanged: v.number(),
    changedIds: v.array(v.id("recalls")),
    detailScrapesEnqueued: v.number(),
  }),
  handler: async (ctx, args) => {
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    const changedIds: Array<Id<"recalls">> = [];
    let detailScrapesEnqueued = 0;
    const maxDetailScrapes = args.maxDetailScrapes ?? 0;
    const now = Date.now();
    const enqueueScrape = async (recallId: Id<"recalls">) => {
      if (detailScrapesEnqueued >= maxDetailScrapes) return;
      await crawlPool.enqueueAction(
        ctx,
        internal.crawl.detail.scrapeRecallDetail,
        // fresh: a change was just detected, so any cached copy is stale by
        // construction.
        { recallId, fresh: true },
      );
      detailScrapesEnqueued++;
    };
    for (const doc of args.docs) {
      const existing = await ctx.db
        .query("recalls")
        .withIndex("by_source_and_sourceId", (q) =>
          q.eq("source", doc.source).eq("sourceId", doc.sourceId),
        )
        .unique();
      if (existing === null) {
        const id = await ctx.db.insert("recalls", {
          ...doc,
          lastSeenAt: now,
          status: "active",
        });
        changedIds.push(id);
        await enqueueScrape(id);
        inserted++;
      } else if (existing.contentHash === doc.contentHash) {
        await ctx.db.patch("recalls", existing._id, { lastSeenAt: now });
        unchanged++;
      } else {
        const {
          _id,
          _creationTime,
          lastSeenAt: _lastSeenAt,
          status: _status,
          ...prior
        } = existing;
        await ctx.db.insert("recallRevisions", {
          recallId: existing._id,
          crawledAt: now,
          contentHash: existing.contentHash,
          snapshot: prior,
        });
        await ctx.db.replace("recalls", existing._id, {
          ...doc,
          // remedyUrl is enrichment from the Firecrawl detail scrape, not an
          // API field — preserve it through content replaces; the re-enqueued
          // detail scrape refreshes it if the notice changed.
          remedyUrl: doc.remedyUrl ?? existing.remedyUrl,
          lastSeenAt: now,
          status: existing.status,
        });
        changedIds.push(existing._id);
        await enqueueScrape(existing._id);
        updated++;
      }
    }
    const stats = await ctx.db.query("publicStats").unique();
    if (stats === null) {
      await ctx.db.insert("publicStats", {
        recallsTracked: inserted,
        itemsMonitored: 0,
        matchesFound: 0,
        lastCrawlAt: now,
      });
    } else {
      await ctx.db.patch("publicStats", stats._id, {
        recallsTracked: stats.recallsTracked + inserted,
        lastCrawlAt: now,
      });
    }
    return { inserted, updated, unchanged, changedIds, detailScrapesEnqueued };
  },
});

export const getById = internalQuery({
  args: { id: v.id("recalls") },
  returns: v.union(schema.doc("recalls"), v.null()),
  handler: async (ctx, args) => await ctx.db.get("recalls", args.id),
});

/** Written by the Firecrawl detail scrape (convex/crawl/detail.ts).
 * null clears the field (patching undefined removes it) so a page that lost
 * its remedy link — or a bogus earlier extraction — self-heals on re-scrape. */
export const enrichFromDetail = internalMutation({
  args: { recallId: v.id("recalls"), remedyUrl: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const recall = await ctx.db.get("recalls", args.recallId);
    if (recall === null) return null;
    const next = args.remedyUrl ?? undefined;
    await ctx.db.patch("recalls", args.recallId, {
      remedyUrl: next,
      detailScrapedAt: Date.now(),
    });
    return null;
  },
});

/** Backfill helper: recalls never detail-scraped, newest first, bounded.
 * Keyed on detailScrapedAt (not remedyUrl) so pages that legitimately have
 * no manufacturer link are not re-scraped on every backfill run. */
export const idsMissingRemedyUrl = internalQuery({
  args: { limit: v.number() },
  returns: v.array(v.id("recalls")),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(1, args.limit), 300);
    const out: Array<Id<"recalls">> = [];
    const rows = ctx.db.query("recalls").withIndex("by_publishedAt").order("desc");
    for await (const row of rows) {
      if (row.detailScrapedAt === undefined) out.push(row._id);
      if (out.length >= limit) break;
    }
    return out;
  },
});

/** Public board feed: newest first, optionally filtered to one source. */
export const recentRecalls = query({
  args: {
    paginationOpts: paginationOptsValidator,
    source: v.optional(vSource),
  },
  returns: paginationResultValidator(schema.doc("recalls")),
  handler: async (ctx, args) => {
    if (args.source !== undefined) {
      const source = args.source;
      return await ctx.db
        .query("recalls")
        .withIndex("by_source_and_publishedAt", (q) => q.eq("source", source))
        .order("desc")
        .paginate(args.paginationOpts);
    }
    return await ctx.db
      .query("recalls")
      .withIndex("by_publishedAt")
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

/** Full-text search over recall titles (titles carry brand + product).
 * Powers the board search box; bounded to 30 hits. */
export const searchRecalls = query({
  args: { query: v.string() },
  returns: v.array(schema.doc("recalls")),
  handler: async (ctx, args) => {
    const q = args.query.trim();
    if (q.length === 0) return [];
    return await ctx.db
      .query("recalls")
      .withSearchIndex("search_title", (s) => s.search("title", q))
      .take(30);
  },
});

/** Public ticker counters. Null lastCrawlAt means the corpus is still empty. */
export const stats = query({
  args: {},
  returns: v.object({
    recallsTracked: v.number(),
    itemsMonitored: v.number(),
    matchesFound: v.number(),
    lastCrawlAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx) => {
    const stats = await ctx.db.query("publicStats").unique();
    if (stats === null) {
      return {
        recallsTracked: 0,
        itemsMonitored: 0,
        matchesFound: 0,
        lastCrawlAt: null,
      };
    }
    return {
      recallsTracked: stats.recallsTracked,
      itemsMonitored: stats.itemsMonitored,
      matchesFound: stats.matchesFound,
      lastCrawlAt: stats.lastCrawlAt ?? null,
    };
  },
});
