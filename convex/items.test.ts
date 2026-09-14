/// <reference types="vite/client" />
import workpool from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** Item inserts enqueue adjudication on the llmPool workpool in the same
 * transaction, so the component must be registered for these tests. */
function setup() {
  const t = convexTest(schema, modules);
  workpool.register(t, "llmPool");
  return t;
}

async function newUser(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", { email: "owner@four30.co", userTag: "t1" });
  });
}

test("addManualItem creates an item at confidence 0.5 with a ledger row and ticker bump", async () => {
  const t = setup();
  const userId = await newUser(t);
  const asOwner = t.withIdentity({ subject: `${userId}|session1` });
  const { itemId } = await asOwner.mutation(api.items.addManualItem, {
    product: "  Stanley 16 oz rubber mallet ",
    brand: "Stanley",
    model: "",
    purchaseDate: "2026-02",
    retailer: "Home Depot",
  });
  const item = await t.run(async (ctx) => await ctx.db.get("items", itemId));
  expect(item).toMatchObject({
    userId,
    product: "Stanley 16 oz rubber mallet",
    brand: "Stanley",
    purchaseDate: "2026-02",
    retailer: "Home Depot",
    confidence: 0.5,
    status: "active",
    searchText: "Stanley 16 oz rubber mallet Stanley",
  });
  expect(item!.model).toBeUndefined(); // "" → absent, never stored empty
  expect(item!.category).toBeUndefined();
  expect(item!.sourceMessageId.startsWith("manual:")).toBe(true);

  const ledger = await t.run(async (ctx) =>
    await ctx.db
      .query("emailsProcessed")
      .withIndex("by_messageId", (q) => q.eq("messageId", item!.sourceMessageId))
      .unique(),
  );
  expect(ledger).toMatchObject({ userId, classification: "receipt", itemIdsCreated: [itemId] });

  const stats = await t.run(async (ctx) => await ctx.db.query("publicStats").unique());
  expect(stats!.itemsMonitored).toBe(1);
});

test("addManualItem rejects a 1-char product, a malformed date, and signed-out callers", async () => {
  const t = setup();
  const userId = await newUser(t);
  const asOwner = t.withIdentity({ subject: `${userId}|session1` });
  await expect(
    asOwner.mutation(api.items.addManualItem, { product: "x" }),
  ).rejects.toThrow(/Give the item a name/);
  await expect(
    asOwner.mutation(api.items.addManualItem, { product: "   a   " }), // 1 char after trim
  ).rejects.toThrow(/Give the item a name/);
  await expect(
    asOwner.mutation(api.items.addManualItem, { product: "Mallet", purchaseDate: "Feb 2026" }),
  ).rejects.toThrow(/2026-02/);
  await expect(
    asOwner.mutation(api.items.addManualItem, { product: "Mallet", brand: "b".repeat(121) }),
  ).rejects.toThrow(/too long/);
  await expect(
    t.mutation(api.items.addManualItem, { product: "Mallet" }),
  ).rejects.toThrow(/not signed in/);
  // A full-day date is accepted too (the month input yields YYYY-MM; a text
  // fallback may yield YYYY-MM-DD).
  const { itemId } = await asOwner.mutation(api.items.addManualItem, {
    product: "Mallet",
    purchaseDate: "2026-02-06",
  });
  expect(itemId).toBeTruthy();
  const items = await t.run(async (ctx) => await ctx.db.query("items").collect());
  expect(items).toHaveLength(1); // none of the rejected calls stored anything
});

test("addManualItem shares the manual daily cap with pasted/photographed receipts", async () => {
  const t = setup();
  const userId = await newUser(t);
  await t.run(async (ctx) => {
    for (let i = 0; i < 20; i++) {
      await ctx.db.insert("emailsProcessed", {
        messageId: `paste:${i}`,
        userId,
        classification: "receipt",
        itemIdsCreated: [],
      });
    }
  });
  const asOwner = t.withIdentity({ subject: `${userId}|session1` });
  await expect(
    asOwner.mutation(api.items.addManualItem, { product: "Husky 10 lb sledge hammer" }),
  ).rejects.toThrow("Daily limit reached — try again tomorrow.");
  // Another user is unaffected: the cap is per user.
  const otherId = await t.run(async (ctx) =>
    await ctx.db.insert("users", { email: "other@four30.co", userTag: "t2" }),
  );
  const asOther = t.withIdentity({ subject: `${otherId}|session1` });
  const { itemId } = await asOther.mutation(api.items.addManualItem, { product: "Play sand" });
  expect(itemId).toBeTruthy();
});

test("createFromExtraction stores ndc normalized + lot uppercased and never an item without a product", async () => {
  const t = setup();
  const userId = await newUser(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("emailsProcessed", {
      messageId: "photo:abc",
      userId,
      classification: "receipt",
      itemIdsCreated: [],
    });
  });
  const out = await t.mutation(internal.items.createFromExtraction, {
    messageId: "photo:abc",
    userId,
    extraction: {
      is_receipt: true,
      retailer: "Stop & Shop Pharmacy",
      order_date: "2026-09-11",
      confidence: 0.9,
      items: [
        {
          product: "Rosuvastatin Calcium 10 mg tablets",
          brand: "Novadoz Pharmaceuticals",
          model: "",
          upc: "",
          ndc: "NDC#72205-0003-99",
          lot: " ab12cd ",
          category: "medication",
          quantity: 1,
        },
        // No product → must be skipped even though other fields are present.
        { product: "  ", brand: "Ghost", model: "", upc: "", ndc: "", lot: "", category: "", quantity: 1 },
        // 5-4-1 print form pads to 5-4-2; an unparseable NDC is dropped, not stored.
        { product: "Metformin 500 mg", brand: "", model: "", upc: "", ndc: "60505-4379-3", lot: "", category: "medication", quantity: 2 },
        { product: "Widget", brand: "", model: "", upc: "", ndc: "not-an-ndc", lot: "", category: "", quantity: 1 },
      ],
    },
  });
  expect(out.itemsCreated).toBe(3);
  const items = await t.run(async (ctx) => await ctx.db.query("items").collect());
  expect(items).toHaveLength(3);
  expect(items.some((i) => i.brand === "Ghost")).toBe(false);
  expect(items.every((i) => i.product.trim().length > 0)).toBe(true);

  const rosu = items.find((i) => i.product.startsWith("Rosuvastatin"));
  expect(rosu).toMatchObject({
    ndc: "72205-0003-99",
    lot: "AB12CD",
    category: "medication",
    brand: "Novadoz Pharmaceuticals",
    purchaseDate: "2026-09-11",
    retailer: "Stop & Shop Pharmacy",
    confidence: 0.9,
    sourceMessageId: "photo:abc",
  });
  expect(rosu!.model).toBeUndefined();

  const metformin = items.find((i) => i.product === "Metformin 500 mg");
  expect(metformin!.ndc).toBe("60505-4379-03");
  expect(metformin!.lot).toBeUndefined();
  expect(metformin!.quantity).toBe(2);

  const widget = items.find((i) => i.product === "Widget");
  expect(widget!.ndc).toBeUndefined();

  const ledger = await t.run(async (ctx) =>
    await ctx.db
      .query("emailsProcessed")
      .withIndex("by_messageId", (q) => q.eq("messageId", "photo:abc"))
      .unique(),
  );
  expect(ledger!.itemIdsCreated).toHaveLength(3);
  const stats = await t.run(async (ctx) => await ctx.db.query("publicStats").unique());
  expect(stats!.itemsMonitored).toBe(3);

  // Idempotent: a second call for the same ledger row creates nothing.
  const again = await t.mutation(internal.items.createFromExtraction, {
    messageId: "photo:abc",
    userId,
    extraction: { is_receipt: true, retailer: "", order_date: "", confidence: 1, items: [
      { product: "Dup", brand: "", model: "", upc: "", ndc: "", lot: "", category: "", quantity: 1 },
    ] },
  });
  expect(again.itemsCreated).toBe(0);
});
