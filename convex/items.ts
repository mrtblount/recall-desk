import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { stripControl } from "./emailParse";
import { llmPool } from "./pools";
import schema from "./schema";

const emptyToUndef = (s: unknown): string | undefined => {
  const t = typeof s === "string" ? stripControl(s).trim() : "";
  return t === "" ? undefined : t;
};

/** Store extracted items; idempotent (no-ops if the ledger row already has
 * items); updates the ledger + public ticker in the same transaction. */
export const createFromExtraction = internalMutation({
  args: {
    messageId: v.string(),
    userId: v.id("users"),
    extraction: v.any(),
  },
  returns: v.object({ itemsCreated: v.number() }),
  handler: async (ctx, args) => {
    const ledger = await ctx.db
      .query("emailsProcessed")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .unique();
    if (ledger === null || ledger.itemIdsCreated.length > 0) {
      return { itemsCreated: 0 };
    }
    const e = args.extraction as Record<string, unknown>;
    const isReceipt = e.is_receipt === true;
    const confidence =
      typeof e.confidence === "number" ? Math.max(0, Math.min(1, e.confidence)) : 0;
    const retailer = emptyToUndef(e.retailer);
    const orderDate = emptyToUndef(e.order_date);
    const rawItems = Array.isArray(e.items) ? e.items.slice(0, 30) : [];

    if (!isReceipt || rawItems.length === 0) {
      await ctx.db.patch("emailsProcessed", ledger._id, {
        classification: "unknown",
      });
      return { itemsCreated: 0 };
    }

    const ids = [];
    for (const raw of rawItems) {
      if (typeof raw !== "object" || raw === null) continue;
      const it = raw as Record<string, unknown>;
      const product = emptyToUndef(it.product);
      if (product === undefined) continue;
      const upcDigits = (emptyToUndef(it.upc) ?? "").replace(/\D/g, "");
      ids.push(
        await ctx.db.insert("items", {
          userId: args.userId,
          sourceMessageId: args.messageId,
          product: product.slice(0, 300),
          brand: emptyToUndef(it.brand)?.slice(0, 120),
          model: emptyToUndef(it.model)?.slice(0, 120),
          upc: upcDigits.length >= 8 && upcDigits.length <= 14 ? upcDigits : undefined,
          category: emptyToUndef(it.category)?.slice(0, 60),
          purchaseDate: orderDate,
          retailer,
          quantity: typeof it.quantity === "number" && it.quantity > 0 ? it.quantity : undefined,
          confidence,
          status: "active",
        }),
      );
    }
    // Matcher trigger — transactional with the item inserts.
    for (const itemId of ids) {
      await llmPool.enqueueAction(ctx, internal.match.adjudicateItem, { itemId });
    }
    await ctx.db.patch("emailsProcessed", ledger._id, {
      itemIdsCreated: ids,
      error:
        rawItems.length >= 30 && Array.isArray(e.items) && e.items.length > 30
          ? `receipt listed ${e.items.length} items; first 30 kept`
          : undefined,
    });
    const stats = await ctx.db.query("publicStats").unique();
    if (stats === null) {
      await ctx.db.insert("publicStats", {
        recallsTracked: 0,
        itemsMonitored: ids.length,
        matchesFound: 0,
      });
    } else {
      await ctx.db.patch("publicStats", stats._id, {
        itemsMonitored: stats.itemsMonitored + ids.length,
      });
    }
    return { itemsCreated: ids.length };
  },
});

/** The signed-in user's ACTIVE watched items, newest first. */
export const myItems = query({
  args: {},
  returns: v.array(schema.doc("items")),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const rows = await ctx.db
      .query("items")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .order("desc")
      .take(100);
    return rows.filter((r) => r.status === "active");
  },
});

/** Remove an item from the watch list. Ownership derived server-side —
 * never from an argument (authz guideline). */
export const dismissItem = mutation({
  args: { itemId: v.id("items") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("not signed in");
    const item = await ctx.db.get("items", args.itemId);
    if (item === null || item.userId !== userId) {
      throw new Error("item not found");
    }
    await ctx.db.patch("items", args.itemId, { status: "dismissed" });
    return null;
  },
});
