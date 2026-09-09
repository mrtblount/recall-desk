import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  env,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { BudgetHaltError, callStructured, TerminalExtractionError } from "./ai";
import { sendGuarded } from "./mail";
import { CANDIDATE_MIN_SCORE, itemRecallScore } from "./matchScore";
import { llmPool } from "./pools";
import schema from "./schema";

const MAX_CANDIDATES = 6;

/**
 * Stage 1 — cheap prefilter, no LLM: full-text search over recall titles
 * with the item's own words, then deterministic token/UPC scoring. Only
 * active/expanded recalls become candidates.
 */
export const candidatesForItem = internalQuery({
  args: { itemId: v.id("items") },
  returns: v.union(
    v.object({
      item: schema.doc("items"),
      candidates: v.array(
        v.object({
          recall: schema.doc("recalls"),
          prefilterScore: v.number(),
          reasons: v.array(v.string()),
        }),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const item = await ctx.db.get("items", args.itemId);
    if (item === null || item.status !== "active") return null;
    const queryText = [item.brand, item.product, item.model]
      .filter(Boolean)
      .join(" ")
      .slice(0, 200);
    if (queryText.trim() === "") return { item, candidates: [] };
    const hits = await ctx.db
      .query("recalls")
      .withSearchIndex("search_title", (s) => s.search("title", queryText))
      .take(16);
    const scored = [];
    for (const recall of hits) {
      if (recall.status === "closed") continue;
      const { score, reasons } = itemRecallScore({
        item: {
          product: item.product,
          brand: item.brand,
          model: item.model,
          upc: item.upc,
        },
        recall: {
          title: recall.title,
          brandNames: recall.brandNames,
          productDesc: recall.productDesc,
          upcs: recall.upcs,
        },
      });
      if (score >= CANDIDATE_MIN_SCORE) {
        scored.push({ recall, prefilterScore: score, reasons });
      }
    }
    scored.sort((a, b) => b.prefilterScore - a.prefilterScore);
    return { item, candidates: scored.slice(0, MAX_CANDIDATES) };
  },
});

const ADJUDICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidate_index", "is_match", "confidence", "rationale"],
        properties: {
          candidate_index: { type: "number" },
          is_match: { type: "boolean" },
          confidence: { type: "number" },
          rationale: {
            type: "string",
            description:
              "1-2 sentences citing the SPECIFIC overlap (model number, UPC, product line) or why it is not the same product",
          },
        },
      },
    },
  },
} as const;

/**
 * Stage 2 — one comparative adjudication call per item over its candidates.
 * Never scans the corpus; the prefilter already bounded the work.
 */
export const adjudicateItem = internalAction({
  args: { itemId: v.id("items") },
  returns: v.object({ matchesCreated: v.number() }),
  handler: async (ctx, args) => {
    const found = await ctx.runQuery(internal.match.candidatesForItem, {
      itemId: args.itemId,
    });
    if (found === null || found.candidates.length === 0) {
      return { matchesCreated: 0 };
    }
    const { item, candidates } = found;

    const candidateBlock = candidates
      .map((c, i) => {
        const r = c.recall;
        return `[${i}] ${r.title}\n    brands: ${r.brandNames.slice(0, 5).join("; ") || "n/a"}\n    products: ${r.productDesc.slice(0, 300) || "n/a"}\n    upcs: ${r.upcs.slice(0, 8).join(", ") || "none listed"}\n    status: ${r.status}`;
      })
      .join("\n\n");

    let result: Record<string, unknown>;
    try {
      result = await callStructured(ctx, {
        purpose: "match-adjudication",
        model: env.OPENAI_MODEL_CHEAP ?? "gpt-5.6-luna",
        system:
          "You decide whether a consumer's purchased item is covered by official product recalls. " +
          "Be conservative: is_match only when the recall clearly covers this specific product/model/variant. " +
          "Same brand alone is NOT a match. Cite the specific overlap in the rationale.",
        user: `PURCHASED ITEM:\nproduct: ${item.product}\nbrand: ${item.brand ?? "unknown"}\nmodel: ${item.model ?? "unknown"}\nupc: ${item.upc ?? "unknown"}\n\nCANDIDATE RECALLS:\n${candidateBlock}`,
        schemaName: "recall_match_adjudication",
        schema: ADJUDICATION_SCHEMA as unknown as Record<string, unknown>,
        maxOutputTokens: 1_200,
      });
    } catch (error) {
      if (error instanceof BudgetHaltError || error instanceof TerminalExtractionError) {
        console.error(`adjudication for item ${args.itemId} halted: ${String(error)}`);
        return { matchesCreated: 0 };
      }
      throw error; // transient — pool retries
    }

    const verdicts = Array.isArray((result as { verdicts?: unknown }).verdicts)
      ? ((result as { verdicts: unknown[] }).verdicts as Array<Record<string, unknown>>)
      : [];
    const confirmed = [];
    for (const verdict of verdicts) {
      const idx = typeof verdict.candidate_index === "number" ? verdict.candidate_index : -1;
      if (verdict.is_match !== true || idx < 0 || idx >= candidates.length) continue;
      confirmed.push({
        recallId: candidates[idx].recall._id,
        prefilterScore: candidates[idx].prefilterScore,
        confidence:
          typeof verdict.confidence === "number"
            ? Math.max(0, Math.min(1, verdict.confidence))
            : 0.5,
        rationale: String(verdict.rationale ?? "").slice(0, 500),
      });
    }
    if (confirmed.length === 0) return { matchesCreated: 0 };

    const recorded: {
      created: Array<{ matchId: Id<"matches">; recallTitle: string; recallUrl: string; remedyUrl: string | null; hazard: string; remedyOption: string | null }>;
      userEmail: string | null;
    } = await ctx.runMutation(internal.match.recordMatches, {
      itemId: args.itemId,
      verdicts: confirmed,
    });

    // Alert email — through the hard allowlist guard, always.
    if (recorded.created.length > 0 && recorded.userEmail !== null) {
      const inboxId = env.AGENTMAIL_OTP_INBOX_ID;
      if (inboxId) {
        const lines = recorded.created.map(
          (c) =>
            `• ${c.recallTitle}\n  Hazard: ${c.hazard.split(/(?<=[.!?])\s/)[0] ?? c.hazard}\n  ${c.remedyOption ? `Remedy: ${c.remedyOption}\n  ` : ""}Official notice: ${c.recallUrl}${c.remedyUrl ? `\n  Start the remedy: ${c.remedyUrl}` : ""}`,
        );
        try {
          await sendGuarded({
            inboxId,
            to: recorded.userEmail,
            subject: `Recall match: ${item.product.slice(0, 80)}`,
            text: `Something you bought has been recalled.\n\nYour item: ${item.product}${item.brand ? ` (${item.brand})` : ""}\n\n${lines.join("\n\n")}\n\nReview it on your desk: https://tremendous-bullfrog-311.convex.site/\n\n— Recall Desk. You bought it. We watch it.`,
          });
          await ctx.runMutation(internal.match.markNotified, {
            matchIds: recorded.created.map((c) => c.matchId),
          });
        } catch (error) {
          // Allowlist rejection or send failure: matches stay "new" and
          // visible on the desk; nothing is lost.
          console.warn(`alert email skipped: ${String(error).slice(0, 200)}`);
        }
      }
    }
    return { matchesCreated: recorded.created.length };
  },
});

export const recordMatches = internalMutation({
  args: {
    itemId: v.id("items"),
    verdicts: v.array(
      v.object({
        recallId: v.id("recalls"),
        prefilterScore: v.number(),
        confidence: v.number(),
        rationale: v.string(),
      }),
    ),
  },
  returns: v.object({
    created: v.array(
      v.object({
        matchId: v.id("matches"),
        recallTitle: v.string(),
        recallUrl: v.string(),
        remedyUrl: v.union(v.string(), v.null()),
        hazard: v.string(),
        remedyOption: v.union(v.string(), v.null()),
      }),
    ),
    userEmail: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const item = await ctx.db.get("items", args.itemId);
    if (item === null) return { created: [], userEmail: null };
    const user = await ctx.db.get("users", item.userId);
    const created = [];
    for (const verdict of args.verdicts) {
      const existing = await ctx.db
        .query("matches")
        .withIndex("by_itemId_and_recallId", (q) =>
          q.eq("itemId", args.itemId).eq("recallId", verdict.recallId),
        )
        .unique();
      if (existing !== null) continue;
      const recall = await ctx.db.get("recalls", verdict.recallId);
      if (recall === null) continue;
      const matchId = await ctx.db.insert("matches", {
        userId: item.userId,
        itemId: args.itemId,
        recallId: verdict.recallId,
        matchScore: verdict.confidence,
        prefilterScore: verdict.prefilterScore,
        matchRationale: verdict.rationale,
        state: "new",
      });
      created.push({
        matchId,
        recallTitle: recall.title,
        recallUrl: recall.url,
        remedyUrl: recall.remedyUrl ?? null,
        hazard: recall.hazard,
        remedyOption: recall.remedyOptions[0] ?? null,
      });
    }
    if (created.length > 0) {
      const stats = await ctx.db.query("publicStats").unique();
      if (stats !== null) {
        await ctx.db.patch("publicStats", stats._id, {
          matchesFound: stats.matchesFound + created.length,
        });
      }
    }
    return { created, userEmail: user?.email ?? null };
  },
});

export const markNotified = internalMutation({
  args: { matchIds: v.array(v.id("matches")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const matchId of args.matchIds) {
      const match = await ctx.db.get("matches", matchId);
      if (match !== null && match.state === "new") {
        await ctx.db.patch("matches", matchId, { state: "notified" });
      }
    }
    return null;
  },
});

/** Recall-side trigger: a new/changed active recall sweeps existing items
 * with the cheap scorer; only plausible items get adjudicated. */
export const recallChanged = internalAction({
  args: { recallId: v.id("recalls") },
  returns: v.object({ itemsEnqueued: v.number() }),
  handler: async (ctx, args) => {
    const plausible: Array<Id<"items">> = await ctx.runQuery(
      internal.match.itemsPlausiblyAffected,
      { recallId: args.recallId },
    );
    for (const itemId of plausible) {
      await llmPool.enqueueAction(ctx, internal.match.adjudicateItem, { itemId });
    }
    return { itemsEnqueued: plausible.length };
  },
});

export const itemsPlausiblyAffected = internalQuery({
  args: { recallId: v.id("recalls") },
  returns: v.array(v.id("items")),
  handler: async (ctx, args) => {
    const recall = await ctx.db.get("recalls", args.recallId);
    if (recall === null || recall.status === "closed") return [];
    const items = await ctx.db.query("items").take(1000);
    const out: Array<Id<"items">> = [];
    for (const item of items) {
      if (item.status !== "active") continue;
      const { score } = itemRecallScore({
        item: {
          product: item.product,
          brand: item.brand,
          model: item.model,
          upc: item.upc,
        },
        recall: {
          title: recall.title,
          brandNames: recall.brandNames,
          productDesc: recall.productDesc,
          upcs: recall.upcs,
        },
      });
      if (score >= CANDIDATE_MIN_SCORE) out.push(item._id);
      if (out.length >= 10) break;
    }
    return out;
  },
});

/** One-off: adjudicate every active item (backfill for pre-matcher items). */
export const backfillUnmatched = internalAction({
  args: {},
  returns: v.object({ enqueued: v.number() }),
  handler: async (ctx) => {
    const itemIds: Array<Id<"items">> = await ctx.runQuery(
      internal.match.allActiveItemIds,
      {},
    );
    for (const itemId of itemIds) {
      await llmPool.enqueueAction(ctx, internal.match.adjudicateItem, { itemId });
    }
    return { enqueued: itemIds.length };
  },
});

export const allActiveItemIds = internalQuery({
  args: {},
  returns: v.array(v.id("items")),
  handler: async (ctx) => {
    const items = await ctx.db.query("items").take(500);
    return items.filter((i) => i.status === "active").map((i) => i._id);
  },
});

/** The signed-in user's matches joined with their item + recall. */
export const myMatches = query({
  args: {},
  returns: v.array(
    v.object({
      match: schema.doc("matches"),
      item: v.union(schema.doc("items"), v.null()),
      recall: v.union(schema.doc("recalls"), v.null()),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const matches = await ctx.db
      .query("matches")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .order("desc")
      .take(50);
    const out = [];
    for (const match of matches) {
      if (match.state === "dismissed") continue;
      out.push({
        match,
        item: await ctx.db.get("items", match.itemId),
        recall: await ctx.db.get("recalls", match.recallId),
      });
    }
    return out;
  },
});

/** Dismiss a match. Ownership derived server-side. */
export const dismissMatch = mutation({
  args: { matchId: v.id("matches") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("not signed in");
    const match = await ctx.db.get("matches", args.matchId);
    if (match === null || match.userId !== userId) throw new Error("match not found");
    await ctx.db.patch("matches", args.matchId, { state: "dismissed" });
    return null;
  },
});
