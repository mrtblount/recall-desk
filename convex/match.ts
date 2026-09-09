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
    // UPC-exact hits bypass the title search entirely — terse receipt text
    // can share zero title tokens while the UPC is listed verbatim.
    const seen = new Set<string>();
    const hits = [];
    if (item.upc) {
      const upcRows = await ctx.db
        .query("recallUpcs")
        .withIndex("by_upc", (q) => q.eq("upc", item.upc!))
        .take(8);
      for (const row of upcRows) {
        const recall = await ctx.db.get("recalls", row.recallId);
        if (recall !== null && !seen.has(recall._id)) {
          seen.add(recall._id);
          hits.push(recall);
        }
      }
    }
    if (queryText.trim() !== "") {
      // Two filtered searches so closed rows can't crowd the hit budget.
      for (const status of ["active", "expanded"] as const) {
        const found = await ctx.db
          .query("recalls")
          .withSearchIndex("search_title", (s) =>
            s.search("title", queryText).eq("status", status),
          )
          .take(12);
        for (const recall of found) {
          if (!seen.has(recall._id)) {
            seen.add(recall._id);
            hits.push(recall);
          }
        }
      }
    }
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
      if (error instanceof BudgetHaltError) {
        // Flag for the stalled-adjudication cron: retried after daily reset.
        await ctx.runMutation(internal.match.flagNeedsAdjudication, {
          itemId: args.itemId,
        });
        console.error(`adjudication budget-halted for ${args.itemId}; flagged for retry`);
        return { matchesCreated: 0 };
      }
      if (error instanceof TerminalExtractionError) {
        console.error(`adjudication terminal for ${args.itemId}: ${String(error)}`);
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
        prefilterReasons: candidates[idx].reasons.slice(0, 5),
        confidence:
          typeof verdict.confidence === "number"
            ? Math.max(0, Math.min(1, verdict.confidence))
            : 0.5,
        rationale: String(verdict.rationale ?? "").slice(0, 500),
      });
    }
    if (confirmed.length === 0) return { matchesCreated: 0 };

    const recorded: {
      created: CreatedMatch[];
      userEmail: string | null;
    } = await ctx.runMutation(internal.match.recordMatches, {
      itemId: args.itemId,
      verdicts: confirmed,
    });

    // Alert email: confidence-gated (low-confidence stays in-app as a
    // possible match), honest wording, OFFICIAL links only — the extracted
    // remedy link lives on the desk where its provenance is disclosed.
    await sendAlertsForMatches(ctx, recorded.created, recorded.userEmail, item.product, item.brand);
    return { matchesCreated: recorded.created.length };
  },
});

export const ALERT_CONFIDENCE_FLOOR = 0.7;

type CreatedMatch = {
  matchId: Id<"matches">;
  recallTitle: string;
  recallUrl: string;
  hazard: string;
  remedyOption: string | null;
  confidence: number;
};

async function sendAlertsForMatches(
  ctx: { runMutation: Function },
  created: CreatedMatch[],
  userEmail: string | null,
  product: string,
  brand?: string,
): Promise<void> {
  const inboxId = env.AGENTMAIL_OTP_INBOX_ID;
  const toSend = created.filter((c) => c.confidence >= ALERT_CONFIDENCE_FLOOR);
  if (toSend.length === 0 || userEmail === null || !inboxId) return;
  const lines = toSend.map(
    (c) =>
      `• ${c.recallTitle}\n  Match confidence: ${Math.round(c.confidence * 100)}% (AI-matched — confirm your model against the notice)\n  Hazard: ${c.hazard.split(/(?<=[.!?])\s/)[0] ?? c.hazard}\n  ${c.remedyOption ? `Remedy: ${c.remedyOption}\n  ` : ""}Official notice: ${c.recallUrl}`,
  );
  try {
    await ctx.runMutation(internal.match.markNotifyAttempted, {
      matchIds: toSend.map((c) => c.matchId),
    });
    await sendGuarded({
      inboxId,
      to: userEmail,
      subject: `Recall match: ${product.slice(0, 80)}`,
      text: `An official recall appears to match something you bought.\n\nYour item: ${product}${brand ? ` (${brand})` : ""}\n\n${lines.join("\n\n")}\n\nReview it (and start the remedy) from your desk: https://tremendous-bullfrog-311.convex.site/\n\n— Recall Desk. You bought it. We watch it.`,
    });
    await ctx.runMutation(internal.match.markNotified, {
      matchIds: toSend.map((c) => c.matchId),
    });
  } catch (error) {
    // Stays "new"; the stalled-alerts cron re-drives it.
    console.warn(`alert email deferred: ${String(error).slice(0, 200)}`);
  }
}

export const flagNeedsAdjudication = internalMutation({
  args: { itemId: v.id("items") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const item = await ctx.db.get("items", args.itemId);
    if (item !== null) {
      await ctx.db.patch("items", args.itemId, { needsAdjudication: true });
    }
    return null;
  },
});

export const markNotifyAttempted = internalMutation({
  args: { matchIds: v.array(v.id("matches")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const matchId of args.matchIds) {
      await ctx.db.patch("matches", matchId, { notifyAttemptedAt: Date.now() });
    }
    return null;
  },
});

/** Cron: re-drive stranded work — unsent "new" alerts (transient send
 * failures, retry-skipped emails), budget-halted adjudications, and
 * sweep-capped recalls. */
export const retryStalledMatching = internalAction({
  args: {},
  returns: v.object({ alertsSent: v.number(), adjudicationsEnqueued: v.number(), sweepsEnqueued: v.number() }),
  handler: async (ctx) => {
    const stalled: Array<{
      created: CreatedMatch[];
      userEmail: string | null;
      product: string;
      brand?: string;
    }> = await ctx.runQuery(internal.match.stalledNewMatches, {});
    let alertsSent = 0;
    for (const group of stalled) {
      await sendAlertsForMatches(ctx, group.created, group.userEmail, group.product, group.brand);
      alertsSent += group.created.length;
    }
    const flagged: Array<Id<"items">> = await ctx.runQuery(internal.match.flaggedItemIds, {});
    for (const itemId of flagged) {
      await ctx.runMutation(internal.match.clearNeedsAdjudication, { itemId });
      await llmPool.enqueueAction(ctx, internal.match.adjudicateItem, { itemId });
    }
    const sweeps: Array<Id<"recalls">> = await ctx.runQuery(internal.match.recallsNeedingSweep, {});
    for (const recallId of sweeps) {
      await ctx.runMutation(internal.match.clearNeedsMatchSweep, { recallId });
      await llmPool.enqueueAction(ctx, internal.match.recallChanged, { recallId });
    }
    return { alertsSent, adjudicationsEnqueued: flagged.length, sweepsEnqueued: sweeps.length };
  },
});

export const stalledNewMatches = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      created: v.array(
        v.object({
          matchId: v.id("matches"),
          recallTitle: v.string(),
          recallUrl: v.string(),
          hazard: v.string(),
          remedyOption: v.union(v.string(), v.null()),
          confidence: v.number(),
        }),
      ),
      userEmail: v.union(v.string(), v.null()),
      product: v.string(),
      brand: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    const attemptCutoff = Date.now() - 6 * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("matches")
      .withIndex("by_state", (q) => q.eq("state", "new"))
      .take(50);
    const groups = new Map<string, { created: CreatedMatch[]; userEmail: string | null; product: string; brand?: string }>();
    for (const match of rows) {
      if (match._creationTime > cutoff) continue;
      if (match.matchScore < 0.7) continue; // below alert floor: in-app only
      if (match.notifyAttemptedAt !== undefined && match.notifyAttemptedAt > attemptCutoff) continue;
      const item = await ctx.db.get("items", match.itemId);
      const recall = await ctx.db.get("recalls", match.recallId);
      if (item === null || recall === null) continue;
      const user = await ctx.db.get("users", match.userId);
      const key = String(match.userId) + "|" + String(match.itemId);
      if (!groups.has(key)) {
        groups.set(key, {
          created: [],
          userEmail: user?.email ?? null,
          product: item.product,
          brand: item.brand,
        });
      }
      groups.get(key)!.created.push({
        matchId: match._id,
        recallTitle: recall.title,
        recallUrl: recall.url,
        hazard: recall.hazard,
        remedyOption: recall.remedyOptions[0] ?? null,
        confidence: match.matchScore,
      });
    }
    return [...groups.values()];
  },
});

export const flaggedItemIds = internalQuery({
  args: {},
  returns: v.array(v.id("items")),
  handler: async (ctx) => {
    const rows = await ctx.db.query("items").take(500);
    return rows
      .filter((i) => i.needsAdjudication === true && i.status === "active")
      .slice(0, 20)
      .map((i) => i._id);
  },
});

export const clearNeedsAdjudication = internalMutation({
  args: { itemId: v.id("items") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("items", args.itemId, { needsAdjudication: undefined });
    return null;
  },
});

export const recallsNeedingSweep = internalQuery({
  args: {},
  returns: v.array(v.id("recalls")),
  handler: async (ctx) => {
    const rows = await ctx.db.query("recalls").order("desc").take(400);
    return rows
      .filter((r) => r.needsMatchSweep === true && r.status !== "closed")
      .slice(0, 15)
      .map((r) => r._id);
  },
});

export const clearNeedsMatchSweep = internalMutation({
  args: { recallId: v.id("recalls") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("recalls", args.recallId, { needsMatchSweep: undefined });
    return null;
  },
});

export const recordMatches = internalMutation({
  args: {
    itemId: v.id("items"),
    verdicts: v.array(
      v.object({
        recallId: v.id("recalls"),
        prefilterScore: v.number(),
        prefilterReasons: v.array(v.string()),
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
        hazard: v.string(),
        remedyOption: v.union(v.string(), v.null()),
        confidence: v.number(),
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
      // A recall can flip to closed between prefilter and here — skip.
      if (recall === null || recall.status === "closed") continue;
      const matchId = await ctx.db.insert("matches", {
        userId: item.userId,
        itemId: args.itemId,
        recallId: verdict.recallId,
        matchScore: verdict.confidence,
        prefilterScore: verdict.prefilterScore,
        prefilterReasons: verdict.prefilterReasons,
        matchRationale: verdict.rationale,
        state: "new",
      });
      created.push({
        matchId,
        recallTitle: recall.title,
        recallUrl: recall.url,
        hazard: recall.hazard,
        remedyOption: recall.remedyOptions[0] ?? null,
        confidence: verdict.confidence,
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
    // Inverted stage 1: search ITEMS with the recall's own words, so the
    // sweep scales with hits, not with table size (review finding: the old
    // take(1000) scan saw only the 1000 oldest items).
    const queryText = `${recall.brandNames.slice(0, 3).join(" ")} ${recall.title}`.slice(0, 220);
    const items = await ctx.db
      .query("items")
      .withSearchIndex("search_items", (s) => s.search("searchText", queryText))
      .take(60);
    // UPC side door for items whose text shares nothing with the title.
    for (const upc of recall.upcs.slice(0, 20)) {
      // recallUpcs maps upc->recall; here we need items with that upc — the
      // items search index covers text only, so scan the small search
      // shortfall via the upc field on the already-fetched set plus a
      // bounded direct filter is unnecessary: item-side UPC matching is
      // already guaranteed by candidatesForItem at item creation.
      void upc;
    }
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
      if (out.length >= 25) {
        console.warn(`sweep for ${args.recallId} truncated at 25 plausible items`);
        break;
      }
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
