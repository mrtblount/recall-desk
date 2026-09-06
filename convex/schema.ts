import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Recall corpus sources. NHTSA is informational-lane only (M11). */
export const vSource = v.union(
  v.literal("cpsc"),
  v.literal("fda"),
  v.literal("fsis"),
  v.literal("nhtsa"),
);

export const vRecallStatus = v.union(
  v.literal("active"),
  v.literal("expanded"),
  v.literal("closed"),
);

/**
 * One recall in the corpus. Always real crawled/fetched data — never invented
 * (hard constraint #9). contentHash covers every content field (not lastSeenAt
 * or status) so re-crawls are idempotent and changes are detectable.
 */
export const recallDoc = v.object({
  source: vSource,
  sourceId: v.string(),
  url: v.string(),
  title: v.string(),
  description: v.string(),
  brandNames: v.array(v.string()),
  productDesc: v.string(),
  upcs: v.array(v.string()),
  hazard: v.string(),
  remedySummary: v.string(),
  remedyOptions: v.array(v.string()),
  remedyUrl: v.optional(v.string()),
  consumerContact: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
  imageCaption: v.optional(v.string()),
  unitsText: v.optional(v.string()),
  publishedAt: v.number(),
  lastSeenAt: v.number(),
  contentHash: v.string(),
  status: vRecallStatus,
});

// Lane B tables (users, items, matches, claims, claimEvents, emailsProcessed)
// land with auth in M5/M6 — items/matches/claims need Id<"users">, which does
// not exist until authTables is added. Logged as a Session M2 decision.
export default defineSchema({
  /** Data-driven crawler registry (M3+): crons iterate enabled sources. */
  feedSources: defineTable({
    key: v.string(),
    kind: v.union(v.literal("listing"), v.literal("detail")),
    url: v.string(),
    cadenceMinutes: v.number(),
    lastCrawledAt: v.optional(v.number()),
    lastHash: v.optional(v.string()),
    enabled: v.boolean(),
  }).index("by_key", ["key"]),

  recalls: defineTable(recallDoc)
    .index("by_source_and_sourceId", ["source", "sourceId"])
    .index("by_publishedAt", ["publishedAt"])
    .index("by_source_and_publishedAt", ["source", "publishedAt"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["source", "status"],
    }),

  /** One row per detected content change of a recall. Each row ARCHIVES the
   * superseded version (its hash + full content snapshot) so the M4 diff
   * showcase can reconstruct what changed even though the recalls row was
   * replaced in the same mutation. */
  recallRevisions: defineTable({
    recallId: v.id("recalls"),
    crawledAt: v.number(),
    contentHash: v.string(),
    snapshot: v.optional(recallDoc.omit("lastSeenAt", "status")),
    diffSummary: v.optional(v.string()),
  }).index("by_recallId", ["recallId"]),

  /** Firecrawl-scraped manufacturer remedy pages + extracted procedures (M8). */
  remedyPages: defineTable({
    recallId: v.id("recalls"),
    url: v.string(),
    markdown: v.optional(v.string()),
    markdownStorageId: v.optional(v.id("_storage")),
    extractedProcedure: v.optional(v.any()),
    crawledAt: v.number(),
    contentHash: v.string(),
  }).index("by_recallId", ["recallId"]),

  /** Singleton counters for the public ticker; updated in the same mutations
   * that write the underlying rows (never counted via .collect()). */
  publicStats: defineTable({
    recallsTracked: v.number(),
    itemsMonitored: v.number(),
    matchesFound: v.number(),
    lastCrawlAt: v.optional(v.number()),
  }),

  /** Token/cost ledger for every OpenAI call (budget guard, M6+). */
  llmUsage: defineTable({
    day: v.string(), // YYYY-MM-DD (UTC)
    model: v.string(),
    purpose: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    costUsd: v.number(),
  }).index("by_day", ["day"]),
});
