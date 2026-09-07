import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import { v } from "convex/values";
import { components, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { crawlPool } from "../pools";
import { extractRemedyUrl } from "./extract";

const firecrawl = new FirecrawlClient(components.firecrawl);

/** Hard cap per enqueue call — hackathon constraint #7 caps any single crawl
 * run at 300 pages through the workpool. Never raise to make a test pass. */
export const MAX_DETAIL_SCRAPES_PER_RUN = 300;

/**
 * Firecrawl-scrape one recall's official notice page and pull out the
 * manufacturer's remedy-portal URL (the input M8's remedy crawler needs —
 * the SaferProducts JSON API does not carry it). Runs on crawlPool.
 */
export const scrapeRecallDetail = internalAction({
  args: { recallId: v.id("recalls") },
  returns: v.object({ remedyUrlFound: v.boolean() }),
  handler: async (ctx, args) => {
    const recall = await ctx.runQuery(internal.recalls.getById, {
      id: args.recallId,
    });
    if (recall === null) return { remedyUrlFound: false };
    // Enrichment scrape: Firecrawl's default cache (2 days) is fine here and
    // saves credits; change DETECTION (M4) uses changeTracking instead.
    const doc = await firecrawl.scrape(ctx, recall.url, {
      formats: ["markdown"],
      onlyMainContent: true,
      timeout: 60_000,
    });
    const raw: unknown = doc;
    let markdown = "";
    if (typeof raw === "object" && raw !== null) {
      const r = raw as Record<string, unknown>;
      if (typeof r.markdown === "string") markdown = r.markdown;
      else if (
        typeof r.data === "object" &&
        r.data !== null &&
        typeof (r.data as Record<string, unknown>).markdown === "string"
      ) {
        markdown = (r.data as Record<string, unknown>).markdown as string;
      }
    }
    if (markdown === "") {
      console.warn(`detail scrape returned no markdown for ${recall.url}`);
      return { remedyUrlFound: false };
    }
    const remedyUrl = extractRemedyUrl(markdown);
    if (remedyUrl !== null) {
      await ctx.runMutation(internal.recalls.enrichFromDetail, {
        recallId: args.recallId,
        remedyUrl,
      });
    }
    return { remedyUrlFound: remedyUrl !== null };
  },
});

/**
 * Manual/one-off: enqueue detail scrapes for recalls that have no remedyUrl
 * yet (e.g. the initial 193-recall backfill), respecting the 300-page cap.
 */
export const backfillDetails = internalAction({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ enqueued: v.number() }),
  // Explicit annotations break the TS circularity from referencing
  // internal.crawl.detail.* inside its own file (per Convex guidelines).
  handler: async (ctx, args): Promise<{ enqueued: number }> => {
    const limit = Math.min(args.limit ?? 100, MAX_DETAIL_SCRAPES_PER_RUN);
    const ids: Array<Id<"recalls">> = await ctx.runQuery(
      internal.recalls.idsMissingRemedyUrl,
      { limit },
    );
    for (const recallId of ids) {
      await crawlPool.enqueueAction(
        ctx,
        internal.crawl.detail.scrapeRecallDetail,
        { recallId },
      );
    }
    console.log(`backfillDetails: enqueued ${ids.length} detail scrapes`);
    return { enqueued: ids.length };
  },
});
