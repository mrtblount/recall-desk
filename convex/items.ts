import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  type MutationCtx,
  query,
} from "./_generated/server";
import { stripControl } from "./emailParse";
import { isValidGtin } from "./gtin";
import { normalizeNdc } from "./ndc";
import { llmPool } from "./pools";
import { beginManualLedger } from "./receipts";
import schema from "./schema";

/** Trim, drop bidi/zero-width controls, and collapse ALL whitespace (CR/LF
 * included) to one space — these strings are interpolated line-by-line into
 * prompts and an email subject, so a newline is an injection vector. */
const emptyToUndef = (s: unknown): string | undefined => {
  const t = typeof s === "string" ? stripControl(s).replace(/\s+/g, " ").trim() : "";
  return t === "" ? undefined : t;
};

/** A YYYY-MM-DD (or YYYY-MM) date string, or undefined — the model is told
 * to use ISO dates, but a stray "02/06/26" must not be stored as a date. */
const isoDate = (s: unknown): string | undefined => {
  const t = emptyToUndef(s);
  return t !== undefined && /^\d{4}-\d{2}(-\d{2})?$/.test(t) ? t : undefined;
};

/** Everything a watched item needs at insert time; the two doors (LLM
 * extraction and typed-in manual entry) both build one of these. */
type NewItem = {
  userId: Id<"users">;
  sourceMessageId: string;
  product: string;
  brand?: string;
  model?: string;
  upc?: string;
  ndc?: string;
  lot?: string;
  category?: string;
  purchaseDate?: string;
  retailer?: string;
  quantity?: number;
  confidence: number;
};

/** Insert one watched item and enqueue its adjudication in the SAME
 * transaction — the matcher trigger must never be able to drift from the
 * insert. searchText (product + brand + model) feeds the recall-side sweep's
 * search index. */
export async function insertItem(ctx: MutationCtx, item: NewItem): Promise<Id<"items">> {
  const itemId = await ctx.db.insert("items", {
    userId: item.userId,
    sourceMessageId: item.sourceMessageId,
    searchText: [item.product, item.brand, item.model].filter(Boolean).join(" "),
    product: item.product,
    brand: item.brand,
    model: item.model,
    upc: item.upc,
    ndc: item.ndc,
    lot: item.lot,
    category: item.category,
    purchaseDate: item.purchaseDate,
    retailer: item.retailer,
    quantity: item.quantity,
    confidence: item.confidence,
    status: "active",
  });
  await llmPool.enqueueAction(ctx, internal.match.adjudicateItem, { itemId });
  return itemId;
}

/** Public ticker counter; updated in the same mutation as the item writes
 * (never counted via .collect()). */
export async function bumpItemsMonitored(ctx: MutationCtx, by: number): Promise<void> {
  if (by <= 0) return;
  const stats = await ctx.db.query("publicStats").unique();
  if (stats === null) {
    await ctx.db.insert("publicStats", {
      recallsTracked: 0,
      itemsMonitored: by,
      matchesFound: 0,
    });
  } else {
    await ctx.db.patch("publicStats", stats._id, {
      itemsMonitored: stats.itemsMonitored + by,
    });
  }
}

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
    const retailer = emptyToUndef(e.retailer)?.slice(0, 120);
    const orderDate = isoDate(e.order_date);
    const rawItems = Array.isArray(e.items) ? e.items.slice(0, 30) : [];

    if (!isReceipt || rawItems.length === 0) {
      await ctx.db.patch("emailsProcessed", ledger._id, {
        classification: "unknown",
      });
      return { itemsCreated: 0 };
    }

    const ids: Id<"items">[] = [];
    for (const raw of rawItems) {
      if (typeof raw !== "object" || raw === null) continue;
      const it = raw as Record<string, unknown>;
      const product = emptyToUndef(it.product);
      if (product === undefined) continue;
      const upcDigits = (emptyToUndef(it.upc) ?? "").replace(/\D/g, "");
      ids.push(
        await insertItem(ctx, {
          userId: args.userId,
          sourceMessageId: args.messageId,
          product: product.slice(0, 300),
          brand: emptyToUndef(it.brand)?.slice(0, 120),
          model: emptyToUndef(it.model)?.slice(0, 120),
          // Check digit, not just length: a misplaced phone number or DOB
          // must never become an exact-match lookup key.
          upc: isValidGtin(upcDigits) ? upcDigits : undefined,
          // Only a well-formed NDC is stored: the matcher does exact lookups
          // on it, so a half-read code must become "unknown", not a near-miss.
          ndc: normalizeNdc(emptyToUndef(it.ndc) ?? "") ?? undefined,
          lot: emptyToUndef(it.lot)?.toUpperCase().slice(0, 40),
          category: emptyToUndef(it.category)?.slice(0, 60),
          // Item-level date/retailer win: one upload can hold several
          // receipts (a pharmacy fill photographed with a hardware receipt).
          purchaseDate: isoDate(it.purchase_date) ?? orderDate,
          retailer: emptyToUndef(it.retailer)?.slice(0, 120) ?? retailer,
          quantity: typeof it.quantity === "number" && it.quantity > 0 ? it.quantity : undefined,
          confidence,
        }),
      );
    }
    await ctx.db.patch("emailsProcessed", ledger._id, {
      itemIdsCreated: ids,
      error:
        rawItems.length >= 30 && Array.isArray(e.items) && e.items.length > 30
          ? `receipt listed ${e.items.length} items; first 30 kept`
          : undefined,
    });
    await bumpItemsMonitored(ctx, ids.length);
    return { itemsCreated: ids.length };
  },
});

const PURCHASE_DATE_RE = /^\d{4}-\d{2}(-\d{2})?$/;

/** Optional free-text field from the manual form: trimmed, control chars
 * stripped, empty → undefined, over-long → a user-facing error (the form shows
 * action errors verbatim). */
function optionalField(value: string | undefined, label: string): string | undefined {
  const t = emptyToUndef(value);
  if (t !== undefined && t.length > 120) {
    throw new ConvexError(`${label} is too long (120 characters max)`);
  }
  return t;
}

/** "Just type the item": no receipt, the user describes what they own from
 * memory. Confidence is fixed at 0.5 — the adjudicator is told the text is
 * approximate and still demands a specific product/model/NDC overlap.
 * Shares the manual daily cap with pasted / photographed receipts. */
export const addManualItem = mutation({
  args: {
    product: v.string(),
    brand: v.optional(v.string()),
    model: v.optional(v.string()),
    purchaseDate: v.optional(v.string()),
    retailer: v.optional(v.string()),
  },
  returns: v.object({ itemId: v.id("items") }),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("not signed in");
    const product = emptyToUndef(args.product) ?? "";
    if (product.length < 2 || product.length > 200) {
      throw new ConvexError("Give the item a name (2–200 characters)");
    }
    const brand = optionalField(args.brand, "Brand");
    const model = optionalField(args.model, "Model");
    const retailer = optionalField(args.retailer, "Store");
    const purchaseDate = emptyToUndef(args.purchaseDate);
    if (purchaseDate !== undefined && !PURCHASE_DATE_RE.test(purchaseDate)) {
      throw new ConvexError("Bought-around should be a month like 2026-02 (or a day like 2026-02-06)");
    }
    // Same ledger rule as manual receipts, called directly (a mutation must
    // not nest ctx.runMutation for this); messageId "manual:<uuid>".
    const messageId = await beginManualLedger(ctx, {
      userId,
      kind: "manual",
      token: crypto.randomUUID(),
    });
    if (messageId === null) throw new ConvexError("Daily limit reached — try again tomorrow.");
    const itemId = await insertItem(ctx, {
      userId,
      sourceMessageId: messageId,
      product,
      brand,
      model,
      purchaseDate,
      retailer,
      confidence: 0.5,
    });
    const ledger = await ctx.db
      .query("emailsProcessed")
      .withIndex("by_messageId", (q) => q.eq("messageId", messageId))
      .unique();
    if (ledger !== null) {
      await ctx.db.patch("emailsProcessed", ledger._id, { itemIdsCreated: [itemId] });
    }
    await bumpItemsMonitored(ctx, 1);
    return { itemId };
  },
});

/** One-off: stamp searchText on pre-existing items. */
export const backfillSearchText = internalMutation({
  args: {},
  returns: v.object({ patched: v.number() }),
  handler: async (ctx) => {
    const rows = await ctx.db.query("items").take(500);
    let patched = 0;
    for (const item of rows) {
      if (item.searchText !== undefined) continue;
      await ctx.db.patch("items", item._id, {
        searchText: [item.product, item.brand, item.model].filter(Boolean).join(" "),
      });
      patched++;
    }
    return { patched };
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
