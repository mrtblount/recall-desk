/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import { adjudicationUserPrompt, candidateCodesLine, enteredVia } from "./match";
import { recallCodeKeys } from "./recalls";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** Shaped like a real openFDA drug row after mapFdaRecord (title/productDesc
 * = product_description with the NDC, description ending in "Codes: …"). */
function fdaDoc(overrides: Record<string, unknown> = {}) {
  return {
    source: "fda" as const,
    sourceId: "D-0001-2026",
    url: "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts",
    title: "Rosuvastatin Calcium Tablets, 10 mg, 90 count bottle, Rx only, NDC 60505-4379-3",
    description:
      "Failed dissolution specifications. Distribution: Nationwide. Codes: Lot #: D2402443, D2402444, Exp 03/2027",
    brandNames: ["Apotex Corp."],
    productDesc: "Rosuvastatin Calcium Tablets, 10 mg, 90 count bottle, Rx only, NDC 60505-4379-3",
    upcs: [],
    hazard: "Class II — Failed dissolution specifications.",
    remedySummary: "Voluntary: Firm initiated.",
    remedyOptions: [],
    publishedAt: 1_757_000_000_000,
    contentHash: "hash-a",
    ...overrides,
  };
}

async function codeRows(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("recallUpcs").collect()).map((r) => r.upc).sort(),
  );
}

test("recallCodeKeys: UPCs verbatim plus ndc:-prefixed normalized NDCs, deduped", () => {
  expect(
    recallCodeKeys({
      source: "fda",
      upcs: ["012345678905", "012345678905"],
      productDesc: "Widget NDC 60505-4379-3",
      description: "Codes: NDC 60505-4379-3; also 0264-7750-00",
    }),
  ).toEqual(["012345678905", "ndc:60505-4379-03", "ndc:00264-7750-00"]);
  expect(recallCodeKeys({ source: "fda", upcs: [], productDesc: "", description: "" })).toEqual([]);
  // A CPSC model range shaped like an NDC is NOT a drug code.
  expect(
    recallCodeKeys({ source: "cpsc", upcs: [], productDesc: "Models 12345-6789-01 through 12345-6789-09", description: "" }),
  ).toEqual([]);
});

test("upsert writes ndc: keys to recallUpcs without touching the recall doc or its hash", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.recalls.upsertBatchFromCrawl, { docs: [fdaDoc()] });
  expect(await codeRows(t)).toEqual(["ndc:60505-4379-03"]);
  const [recall] = await t.run(async (ctx) => await ctx.db.query("recalls").collect());
  expect(recall.contentHash).toBe("hash-a");
  expect(recall).not.toHaveProperty("ndcs");
  // Re-crawl of identical content: still one key, nothing duplicated.
  await t.mutation(internal.recalls.upsertBatchFromCrawl, { docs: [fdaDoc()] });
  expect(await codeRows(t)).toEqual(["ndc:60505-4379-03"]);
});

test("content change re-syncs keys: dropped NDC row deleted, new NDC and UPC rows added", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.recalls.upsertBatchFromCrawl, { docs: [fdaDoc()] });
  await t.mutation(internal.recalls.upsertBatchFromCrawl, {
    docs: [
      fdaDoc({
        contentHash: "hash-b",
        title: "Rosuvastatin Calcium Tablets, 10 mg and 20 mg",
        productDesc: "Rosuvastatin Calcium Tablets, 20 mg, NDC 60505-4380-3",
        upcs: ["036000291452"],
      }),
    ],
  });
  expect(await codeRows(t)).toEqual(["036000291452", "ndc:60505-4380-03"]);
  const rows = await t.run(async (ctx) => await ctx.db.query("recalls").collect());
  expect(rows).toHaveLength(1);
});

test("backfillUpcsBatch adds missing ndc: keys to pre-existing rows and is idempotent", async () => {
  const t = convexTest(schema, modules);
  // Simulate a row written before NDC keys existed: recall present, only
  // its UPC row in recallUpcs.
  const recallId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("recalls", {
      ...fdaDoc({ upcs: ["012345678905"] }),
      lastSeenAt: 1,
      status: "active",
    });
    await ctx.db.insert("recallUpcs", { upc: "012345678905", recallId: id });
    return id;
  });
  const first = await t.mutation(internal.recalls.backfillUpcsBatch, { cursor: null });
  expect(first).toEqual({ nextCursor: null, upserted: 1 });
  expect(await codeRows(t)).toEqual(["012345678905", "ndc:60505-4379-03"]);
  const second = await t.mutation(internal.recalls.backfillUpcsBatch, { cursor: null });
  expect(second.upserted).toBe(0);
  const rows = await t.run(async (ctx) =>
    await ctx.db
      .query("recallUpcs")
      .withIndex("by_recallId", (q) => q.eq("recallId", recallId))
      .collect(),
  );
  expect(rows).toHaveLength(2);
});

test("candidatesForItem finds a recall by NDC alone — zero title overlap, no UPC", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.recalls.upsertBatchFromCrawl, { docs: [fdaDoc()] });
  const itemId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "owner@four30.co", userTag: "t1" });
    return await ctx.db.insert("items", {
      userId,
      sourceMessageId: "photo:abc",
      product: "Rx fill", // shares no token with the recall title
      ndc: "60505-4379-03",
      lot: "D2402444",
      confidence: 0.9,
      status: "active",
    });
  });
  const found = await t.query(internal.match.candidatesForItem, { itemId });
  expect(found).not.toBeNull();
  expect(found!.candidates).toHaveLength(1);
  const [c] = found!.candidates;
  expect(c.prefilterScore).toBeGreaterThanOrEqual(100); // NDC 60 + lot 40
  expect(c.reasons).toEqual([
    "NDC 60505-4379-03 listed in the recall",
    "lot D2402444 listed in the recall",
  ]);
});

test("candidatesForItem: a different NDC for the same drug is not surfaced via the code path", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.recalls.upsertBatchFromCrawl, { docs: [fdaDoc()] });
  const itemId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "owner@four30.co", userTag: "t1" });
    return await ctx.db.insert("items", {
      userId,
      sourceMessageId: "manual:xyz",
      product: "Rx fill",
      ndc: "72205-0003-99", // Novadoz, not Apotex
      confidence: 0.5,
      status: "active",
    });
  });
  const found = await t.query(internal.match.candidatesForItem, { itemId });
  expect(found!.candidates).toEqual([]);
});

test("enteredVia derives the intake channel from the ledger id prefix", () => {
  expect(enteredVia("photo:1a2b")).toBe("photo");
  expect(enteredVia("paste:1a2b")).toBe("paste");
  expect(enteredVia("manual:1a2b")).toBe("manual");
  expect(enteredVia("<CAF+abc@mail.gmail.com>")).toBe("email");
  expect(enteredVia("photos:oops")).toBe("email"); // exact prefix only
});

test("candidateCodesLine lists NDCs and the Codes: tail; 'none listed' otherwise", () => {
  const line = candidateCodesLine(fdaDoc());
  expect(line).toBe("NDC 60505-4379-03 | Lot #: D2402443, D2402444, Exp 03/2027");
  expect(
    candidateCodesLine({
      source: "fda",
      title: "T",
      brandNames: [],
      productDesc: "Plain widget",
      upcs: [],
      description: "No codes here.",
    }),
  ).toBe("none listed");
  // Codes tail is capped at 400 chars — the same window the lot prefilter scans.
  const long = candidateCodesLine(
    fdaDoc({ description: `Codes: ${"L".repeat(500)}`, productDesc: "x", title: "x" }),
  );
  expect(long).toHaveLength(400);
  // NDC mining is FDA-only: the same text on a CPSC row yields no NDC line.
  expect(candidateCodesLine(fdaDoc({ source: "cpsc" }))).toBe("Lot #: D2402443, D2402444, Exp 03/2027");
});

test("adjudicationUserPrompt carries ndc/lot/entry channel, the manual caveat, and per-candidate codes", () => {
  const manual = adjudicationUserPrompt(
    {
      sourceMessageId: "manual:1",
      product: "Rosuvastatin 10 mg",
      brand: "Novadoz",
      model: undefined,
      upc: undefined,
      ndc: "72205-0003-99",
      lot: undefined,
    },
    [{ ...fdaDoc(), status: "active" }],
  );
  expect(manual).toContain("ndc: 72205-0003-99");
  expect(manual).toContain("lot: unknown");
  expect(manual).toContain("entered via: manual");
  expect(manual).toContain("typed in by the user from memory");
  expect(manual).toContain("codes: NDC 60505-4379-03 | Lot #: D2402443");
  expect(manual).toContain("status: active");

  const photo = adjudicationUserPrompt(
    { sourceMessageId: "photo:1", product: "P", lot: "D2402443" },
    [],
  );
  expect(photo).toContain("entered via: photo");
  expect(photo).toContain("lot: D2402443");
  expect(photo).not.toContain("from memory");
});

test("recall-side sweep reaches NDC-only and UPC-only items whose text shares no words with the title", async () => {
  const t = convexTest(schema, modules);
  const { byNdc, byUpc, unrelated } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "owner@four30.co", userTag: "t9" });
    const base = { userId, confidence: 0.9, status: "active" as const };
    const byNdc = await ctx.db.insert("items", {
      ...base, sourceMessageId: "photo:a", product: "Monthly prescription",
      searchText: "Monthly prescription", ndc: "60505-4379-03",
    });
    const byUpc = await ctx.db.insert("items", {
      ...base, sourceMessageId: "paste:b", product: "Thing", searchText: "Thing", upc: "036000291452",
    });
    const unrelated = await ctx.db.insert("items", {
      ...base, sourceMessageId: "manual:c", product: "Garden hose", searchText: "Garden hose",
    });
    return { byNdc, byUpc, unrelated };
  });
  await t.mutation(internal.recalls.upsertBatchFromCrawl, {
    docs: [fdaDoc({ upcs: ["036000291452"] })],
  });
  const [recall] = await t.run(async (ctx) => await ctx.db.query("recalls").collect());
  const affected = await t.query(internal.match.itemsPlausiblyAffected, { recallId: recall._id });
  expect(affected).toContain(byNdc);
  expect(affected).toContain(byUpc);
  expect(affected).not.toContain(unrelated);
});
