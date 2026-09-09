import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  env,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { BudgetHaltError, callStructured, TerminalExtractionError } from "./ai";
import { sha256Hex } from "./crawl/cpsc";
import { looksLikeBotWall, sanitizeClaimEmail, sanitizeClaimUrl } from "./remedySanitize";
import { llmPool } from "./pools";
import schema from "./schema";

const firecrawl = new FirecrawlClient(components.firecrawl);

/** Markdown above this goes to file storage instead of a document field. */
const INLINE_MARKDOWN_LIMIT = 200_000;

/**
 * Scrape a recall's manufacturer remedy page. waitFor gives JS portals
 * (the Louisville-class pages that serve only "enable JavaScript" to plain
 * HTTP) time to render. Runs on crawlPool.
 */
export const scrapeRemedyPage = internalAction({
  args: { recallId: v.id("recalls") },
  returns: v.object({ scraped: v.boolean() }),
  handler: async (ctx, args) => {
    const recall = await ctx.runQuery(internal.recalls.getById, { id: args.recallId });
    if (recall === null || recall.remedyUrl === undefined) return { scraped: false };

    const doc: unknown = await firecrawl.scrape(ctx, recall.remedyUrl, {
      formats: ["markdown"],
      onlyMainContent: true,
      waitFor: 3_000,
      timeout: 60_000,
    });
    let markdown = "";
    if (typeof doc === "object" && doc !== null) {
      const r = doc as Record<string, unknown>;
      if (typeof r.markdown === "string") markdown = r.markdown;
    }
    if (markdown.trim() === "") {
      console.warn(`remedy scrape returned no markdown for ${recall.remedyUrl}`);
      return { scraped: false };
    }
    if (looksLikeBotWall(markdown)) {
      // Saving a challenge page would permanently misread the portal as
      // unreadable; leave no row so the next trigger retries cleanly.
      console.warn(`remedy scrape hit a bot wall for ${recall.remedyUrl} — not saved`);
      return { scraped: false };
    }
    const contentHash = await sha256Hex(markdown);

    let markdownStorageId: Id<"_storage"> | undefined;
    let inlineMarkdown: string | undefined = markdown;
    if (markdown.length > INLINE_MARKDOWN_LIMIT) {
      markdownStorageId = await ctx.storage.store(
        new Blob([markdown], { type: "text/markdown" }),
      );
      inlineMarkdown = undefined;
    }
    await ctx.runMutation(internal.remedy.saveRemedyPage, {
      recallId: args.recallId,
      url: recall.remedyUrl,
      markdown: inlineMarkdown,
      markdownStorageId,
      contentHash,
    });
    return { scraped: true };
  },
});

/** Upsert the (single) remedy page per recall; enqueue extraction in the
 * same transaction when content is new or changed. */
export const saveRemedyPage = internalMutation({
  args: {
    recallId: v.id("recalls"),
    url: v.string(),
    markdown: v.optional(v.string()),
    markdownStorageId: v.optional(v.id("_storage")),
    contentHash: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("remedyPages")
      .withIndex("by_recallId", (q) => q.eq("recallId", args.recallId))
      .unique();
    if (existing !== null && existing.contentHash === args.contentHash) {
      // Same content — drop the superseded blob and keep prior extraction.
      if (args.markdownStorageId !== undefined) {
        await ctx.storage.delete(args.markdownStorageId);
      }
      const enqueueFresh =
        existing.extractionEnqueuedAt === undefined ||
        Date.now() - existing.extractionEnqueuedAt > 10 * 60 * 1000;
      if (existing.extractedProcedure === undefined && enqueueFresh) {
        await ctx.db.patch("remedyPages", existing._id, {
          extractionEnqueuedAt: Date.now(),
        });
        await llmPool.enqueueAction(ctx, internal.remedy.extractRemedyProcedure, {
          remedyPageId: existing._id,
        });
      }
      return null;
    }
    let remedyPageId: Id<"remedyPages">;
    if (existing === null) {
      remedyPageId = await ctx.db.insert("remedyPages", {
        recallId: args.recallId,
        url: args.url,
        markdown: args.markdown,
        markdownStorageId: args.markdownStorageId,
        crawledAt: Date.now(),
        contentHash: args.contentHash,
      });
    } else {
      if (
        existing.markdownStorageId !== undefined &&
        existing.markdownStorageId !== args.markdownStorageId
      ) {
        await ctx.storage.delete(existing.markdownStorageId);
      }
      await ctx.db.replace("remedyPages", existing._id, {
        recallId: args.recallId,
        url: args.url,
        markdown: args.markdown,
        markdownStorageId: args.markdownStorageId,
        crawledAt: Date.now(),
        contentHash: args.contentHash,
        extractionEnqueuedAt: Date.now(),
      });
      remedyPageId = existing._id;
    }
    if (existing === null) {
      await ctx.db.patch("remedyPages", remedyPageId, {
        extractionEnqueuedAt: Date.now(),
      });
    }
    await llmPool.enqueueAction(ctx, internal.remedy.extractRemedyProcedure, {
      remedyPageId,
    });
    return null;
  },
});

export const getRemedyPage = internalQuery({
  args: { remedyPageId: v.id("remedyPages") },
  returns: v.union(schema.doc("remedyPages"), v.null()),
  handler: async (ctx, args) => await ctx.db.get("remedyPages", args.remedyPageId),
});

const PROCEDURE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "is_remedy_page",
    "summary",
    "steps",
    "required_fields",
    "claim_url",
    "claim_email",
    "deadline",
    "options",
    "confidence",
  ],
  properties: {
    is_remedy_page: { type: "boolean" },
    summary: { type: "string", description: "1-2 sentence plain-language summary of the remedy" },
    steps: { type: "array", items: { type: "string" }, description: "ordered consumer actions, verbatim-faithful" },
    required_fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description"],
        properties: {
          name: { type: "string", description: "short field label, e.g. Model number" },
          description: { type: "string", description: "what the page asks for; empty string if self-evident" },
        },
      },
    },
    claim_url: { type: "string", description: "URL of the claim/registration form on THIS page; empty string if none" },
    claim_email: { type: "string", description: "contact email stated on the page; empty string if none" },
    deadline: { type: "string", description: "any stated deadline, verbatim; empty string if none" },
    options: { type: "array", items: { type: "string" }, description: "remedy options offered (refund, repair kit, gift card...)" },
    confidence: { type: "number" },
  },
} as const;

/** Remedy-page markdown -> structured claim procedure. Runs on llmPool. */
export const extractRemedyProcedure = internalAction({
  args: { remedyPageId: v.id("remedyPages") },
  returns: v.object({ extracted: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.runQuery(internal.remedy.getRemedyPage, {
      remedyPageId: args.remedyPageId,
    });
    if (page === null) return { extracted: false };
    let markdown = page.markdown ?? "";
    if (markdown === "" && page.markdownStorageId !== undefined) {
      const blob = await ctx.storage.get(page.markdownStorageId);
      if (blob !== null) markdown = await blob.text();
    }
    if (markdown.trim() === "") return { extracted: false };

    let result: Record<string, unknown>;
    try {
      result = await callStructured(ctx, {
        purpose: "remedy-procedure-extraction",
        model: env.OPENAI_MODEL_CHEAP ?? "gpt-5.6-luna",
        system:
          "You extract the consumer claim procedure from a manufacturer's product-recall remedy page. " +
          "Report ONLY what the page actually says — never invent steps, fields, deadlines, or contact details. " +
          "If this is not a recall remedy/registration page, set is_remedy_page to false. " +
          "Use empty strings for absent values.",
        user: markdown.slice(0, 18_000),
        schemaName: "remedy_procedure",
        schema: PROCEDURE_SCHEMA as unknown as Record<string, unknown>,
        maxOutputTokens: 1_600,
      });
    } catch (error) {
      if (error instanceof TerminalExtractionError) {
        await ctx.runMutation(internal.remedy.saveProcedure, {
          remedyPageId: args.remedyPageId,
          procedure: { is_remedy_page: false, error: String(error).slice(0, 300) },
        });
        return { extracted: false };
      }
      if (error instanceof BudgetHaltError) {
        console.error(`remedy extraction budget-halted for ${args.remedyPageId}`);
        return { extracted: false }; // stays unset; re-enqueued on next save/backfill
      }
      throw error;
    }
    // Trust boundary: the extracted claim URL/email become UI CTAs — they
    // must be grounded in the scraped page and share its domain.
    result.claim_url = sanitizeClaimUrl(
      String(result.claim_url ?? ""),
      page.url,
      markdown,
    );
    result.claim_email = sanitizeClaimEmail(String(result.claim_email ?? ""), markdown);
    await ctx.runMutation(internal.remedy.saveProcedure, {
      remedyPageId: args.remedyPageId,
      procedure: result,
      forContentHash: page.contentHash,
    });
    return { extracted: true };
  },
});

export const saveProcedure = internalMutation({
  args: {
    remedyPageId: v.id("remedyPages"),
    procedure: v.any(),
    forContentHash: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db.get("remedyPages", args.remedyPageId);
    if (page === null) return null;
    // A slow extraction of superseded content must not clobber the newer
    // page's extraction (which is already enqueued for the new hash).
    if (args.forContentHash !== undefined && page.contentHash !== args.forContentHash) {
      console.warn(`stale extraction dropped for ${args.remedyPageId}`);
      return null;
    }
    await ctx.db.patch("remedyPages", args.remedyPageId, {
      extractedProcedure: args.procedure,
      extractionEnqueuedAt: undefined,
    });
    return null;
  },
});

/** One-off: crawl remedy pages for every existing match's recall. */
export const backfillRemedyPages = internalAction({
  args: {},
  returns: v.object({ enqueued: v.number() }),
  handler: async (ctx) => {
    const recallIds: Array<Id<"recalls">> = await ctx.runQuery(
      internal.remedy.matchedRecallIdsMissingPages,
      {},
    );
    const { crawlPool } = await import("./pools");
    for (const recallId of recallIds) {
      await crawlPool.enqueueAction(ctx, internal.remedy.scrapeRemedyPage, { recallId });
    }
    return { enqueued: recallIds.length };
  },
});

/** Should this recall's remedy page be (re)scraped? Covers: no page yet,
 * extraction pending too long, retryable failed reads (>24h), a healed
 * remedyUrl differing from the stored page, and a 7-day freshness TTL
 * (hash dedupe makes unchanged re-scrapes cost one credit, no re-extract). */
export function needsRemedyScrape(
  page: { url: string; crawledAt: number; extractedProcedure?: unknown } | null,
  recall: { remedyUrl?: string },
  now: number,
): boolean {
  if (recall.remedyUrl === undefined) return false;
  if (page === null) return true;
  if (page.url !== recall.remedyUrl) return true;
  const proc = page.extractedProcedure as { is_remedy_page?: boolean } | undefined;
  if (proc === undefined) return now - page.crawledAt > 30 * 60 * 1000;
  if (proc.is_remedy_page !== true) return now - page.crawledAt > 24 * 60 * 60 * 1000;
  return now - page.crawledAt > 7 * 24 * 60 * 60 * 1000;
}

export const matchedRecallIdsMissingPages = internalQuery({
  args: {},
  returns: v.array(v.id("recalls")),
  handler: async (ctx) => {
    const matches = await ctx.db.query("matches").take(200);
    const out: Array<Id<"recalls">> = [];
    for (const match of matches) {
      if (out.includes(match.recallId)) continue;
      const recall = await ctx.db.get("recalls", match.recallId);
      if (recall === null || recall.remedyUrl === undefined) continue;
      const page = await ctx.db
        .query("remedyPages")
        .withIndex("by_recallId", (q) => q.eq("recallId", match.recallId))
        .unique();
      if (needsRemedyScrape(page, recall, Date.now())) {
        out.push(match.recallId);
      }
      if (out.length >= 5) break;
    }
    return out;
  },
});

/** The remedy view for one of the signed-in user's matches. */
export const remedyForMatch = query({
  args: { matchId: v.id("matches") },
  returns: v.union(
    v.object({
      match: schema.doc("matches"),
      item: v.union(schema.doc("items"), v.null()),
      recall: v.union(schema.doc("recalls"), v.null()),
      remedyPage: v.union(schema.doc("remedyPages"), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const match = await ctx.db.get("matches", args.matchId);
    if (match === null || match.userId !== userId) return null;
    const recall = await ctx.db.get("recalls", match.recallId);
    const remedyPage =
      recall === null
        ? null
        : await ctx.db
            .query("remedyPages")
            .withIndex("by_recallId", (q) => q.eq("recallId", recall._id))
            .unique();
    return {
      match,
      item: await ctx.db.get("items", match.itemId),
      recall,
      remedyPage,
    };
  },
});

/**
 * Capability probe (build-log evidence): compare what a plain HTTP client
 * sees vs what Firecrawl renders for a JS-only remedy portal, then run the
 * extractor. Stores nothing.
 */
export const probeRemedyPortal = internalAction({
  args: { url: v.string() },
  returns: v.object({
    plainHttpChars: v.number(),
    plainHttpSnippet: v.string(),
    firecrawlChars: v.number(),
    extractedSteps: v.number(),
    extractedFields: v.number(),
    isRemedyPage: v.boolean(),
  }),
  handler: async (ctx, args) => {
    let plain = "";
    try {
      const res = await fetch(args.url, { headers: { "User-Agent": "curl/8.0" } });
      plain = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    } catch {
      plain = "(fetch failed)";
    }
    const doc: unknown = await firecrawl.scrape(ctx, args.url, {
      formats: ["markdown"],
      onlyMainContent: true,
      waitFor: 3_000,
      timeout: 60_000,
    });
    const markdown =
      typeof doc === "object" && doc !== null && typeof (doc as Record<string, unknown>).markdown === "string"
        ? ((doc as Record<string, unknown>).markdown as string)
        : "";
    let steps = 0;
    let fields = 0;
    let isRemedy = false;
    if (markdown.trim() !== "") {
      try {
        const result = await callStructured(ctx, {
          purpose: "remedy-procedure-extraction",
          model: env.OPENAI_MODEL_CHEAP ?? "gpt-5.6-luna",
          system:
            "You extract the consumer claim procedure from a manufacturer's product-recall remedy page. Report ONLY what the page says. Use empty strings for absent values.",
          user: markdown.slice(0, 18_000),
          schemaName: "remedy_procedure",
          schema: PROCEDURE_SCHEMA as unknown as Record<string, unknown>,
          maxOutputTokens: 1_600,
        });
        isRemedy = result.is_remedy_page === true;
        steps = Array.isArray(result.steps) ? result.steps.length : 0;
        fields = Array.isArray(result.required_fields) ? result.required_fields.length : 0;
      } catch (error) {
        console.warn(`probe extraction failed: ${String(error).slice(0, 150)}`);
      }
    }
    return {
      plainHttpChars: plain.length,
      plainHttpSnippet: plain.slice(0, 120),
      firecrawlChars: markdown.length,
      extractedSteps: steps,
      extractedFields: fields,
      isRemedyPage: isRemedy,
    };
  },
});
