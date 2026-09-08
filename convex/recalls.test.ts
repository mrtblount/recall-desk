/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function doc(overrides: Record<string, unknown> = {}) {
  return {
    source: "cpsc" as const,
    sourceId: "10949",
    url: "https://cpsc.gov/Recalls/2026/example",
    title: "Example Product Recalled Due to Hazard",
    description: "This recall involves the example product.",
    brandNames: ["Acme Co."],
    productDesc: "Acme Example Product (model X1)",
    upcs: ["012345678905"],
    hazard: "Example hazard.",
    remedySummary: "Stop using and contact Acme.",
    remedyOptions: ["Refund"],
    publishedAt: 1_700_000_000_000,
    contentHash: "hash-a",
    ...overrides,
  };
}

test("upsert is idempotent: re-crawling the same content changes nothing", async () => {
  const t = convexTest(schema, modules);
  const first = await t.mutation(internal.recalls.upsertBatchFromCrawl, {
    docs: [doc()],
  });
  expect(first).toMatchObject({ inserted: 1, updated: 0, unchanged: 0 });
  const second = await t.mutation(internal.recalls.upsertBatchFromCrawl, {
    docs: [doc()],
  });
  expect(second).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
  const stats = await t.query(api.recalls.stats, {});
  expect(stats.recallsTracked).toBe(1);
  const rows = await t.run(async (ctx) => await ctx.db.query("recalls").collect());
  expect(rows).toHaveLength(1);
});

test("content change patches the recall and writes a revision row", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.recalls.upsertBatchFromCrawl, { docs: [doc()] });
  const changed = doc({
    title: "Example Product Recall EXPANDED to More Units",
    contentHash: "hash-b",
  });
  const result = await t.mutation(internal.recalls.upsertBatchFromCrawl, {
    docs: [changed],
  });
  expect(result).toMatchObject({ inserted: 0, updated: 1, unchanged: 0 });
  const rows = await t.run(async (ctx) => await ctx.db.query("recalls").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0].title).toBe("Example Product Recall EXPANDED to More Units");
  expect(rows[0].contentHash).toBe("hash-b");
  const revisions = await t.run(
    async (ctx) => await ctx.db.query("recallRevisions").collect(),
  );
  expect(revisions).toHaveLength(1);
  // The revision archives the SUPERSEDED version, not the new one.
  expect(revisions[0].contentHash).toBe("hash-a");
  expect(revisions[0].snapshot?.title).toBe(
    "Example Product Recalled Due to Hazard",
  );
  const stats = await t.query(api.recalls.stats, {});
  expect(stats.recallsTracked).toBe(1);
});

test("a re-crawl that drops an optional field clears it (replace, not patch)", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.recalls.upsertBatchFromCrawl, {
    docs: [doc({ imageUrl: "https://cpsc.gov/old.jpg", imageCaption: "Old photo" })],
  });
  await t.mutation(internal.recalls.upsertBatchFromCrawl, {
    docs: [doc({ title: "Republished without a photo", contentHash: "hash-b" })],
  });
  const rows = await t.run(async (ctx) => await ctx.db.query("recalls").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0].title).toBe("Republished without a photo");
  expect(rows[0].imageUrl).toBeUndefined();
  expect(rows[0].imageCaption).toBeUndefined();
  const revisions = await t.run(
    async (ctx) => await ctx.db.query("recallRevisions").collect(),
  );
  expect(revisions[0].snapshot?.imageUrl).toBe("https://cpsc.gov/old.jpg");
});

test("recentRecalls pages newest first", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.recalls.upsertBatchFromCrawl, {
    docs: [
      doc({ sourceId: "1", publishedAt: 1_000, contentHash: "h1" }),
      doc({ sourceId: "2", publishedAt: 3_000, contentHash: "h2" }),
      doc({ sourceId: "3", publishedAt: 2_000, contentHash: "h3" }),
    ],
  });
  const page1 = await t.query(api.recalls.recentRecalls, {
    paginationOpts: { numItems: 2, cursor: null },
  });
  expect(page1.page.map((r: { publishedAt: number }) => r.publishedAt)).toEqual([3_000, 2_000]);
  expect(page1.isDone).toBe(false);
  const page2 = await t.query(api.recalls.recentRecalls, {
    paginationOpts: { numItems: 2, cursor: page1.continueCursor },
  });
  expect(page2.page.map((r: { publishedAt: number }) => r.publishedAt)).toEqual([1_000]);
  expect(page2.isDone).toBe(true);
});

test("statusOverride applies on insert and update; expansion regex flips status", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.recalls.upsertBatchFromCrawl, {
    docs: [doc({ sourceId: "fda-1", source: "fda", statusOverride: "closed" })],
  });
  let rows = await t.run(async (ctx) => await ctx.db.query("recalls").collect());
  expect(rows[0].status).toBe("closed");

  await t.mutation(internal.recalls.upsertBatchFromCrawl, {
    docs: [doc({ sourceId: "10949", title: "Product Recall EXPANDED to More Units", contentHash: "h2" })],
  });
  await t.mutation(internal.recalls.upsertBatchFromCrawl, { docs: [doc()] }); // seed base first? (kept for ordering)
  const t2 = convexTest(schema, modules);
  await t2.mutation(internal.recalls.upsertBatchFromCrawl, { docs: [doc()] });
  await t2.mutation(internal.recalls.upsertBatchFromCrawl, {
    docs: [doc({ title: "Product Recall EXPANDED to Additional Units", contentHash: "h2" })],
  });
  rows = await t2.run(async (ctx) => await ctx.db.query("recalls").collect());
  expect(rows[0].status).toBe("expanded");
  const revisions = await t2.run(async (ctx) => await ctx.db.query("recallRevisions").collect());
  expect(revisions[0].diffSummary).toContain("title");
});
