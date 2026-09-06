import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import schema, { recallDoc, vSource } from "./schema";

/** What a crawl produces: everything except the server-stamped fields. */
export const crawlInput = recallDoc.omit("lastSeenAt", "status");

/**
 * Idempotent upsert keyed on [source, sourceId]:
 * - new recall            -> insert (status "active") and bump the ticker
 * - same contentHash      -> touch lastSeenAt only
 * - different contentHash -> patch content + write a recallRevisions row
 * Stats are maintained in this same mutation so they can never drift.
 */
export const upsertBatchFromCrawl = internalMutation({
  args: { docs: v.array(crawlInput) },
  returns: v.object({
    inserted: v.number(),
    updated: v.number(),
    unchanged: v.number(),
  }),
  handler: async (ctx, args) => {
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    const now = Date.now();
    for (const doc of args.docs) {
      const existing = await ctx.db
        .query("recalls")
        .withIndex("by_source_and_sourceId", (q) =>
          q.eq("source", doc.source).eq("sourceId", doc.sourceId),
        )
        .unique();
      if (existing === null) {
        await ctx.db.insert("recalls", {
          ...doc,
          lastSeenAt: now,
          status: "active",
        });
        inserted++;
      } else if (existing.contentHash === doc.contentHash) {
        await ctx.db.patch("recalls", existing._id, { lastSeenAt: now });
        unchanged++;
      } else {
        await ctx.db.patch("recalls", existing._id, {
          ...doc,
          lastSeenAt: now,
        });
        await ctx.db.insert("recallRevisions", {
          recallId: existing._id,
          crawledAt: now,
          contentHash: doc.contentHash,
        });
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
    return { inserted, updated, unchanged };
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
