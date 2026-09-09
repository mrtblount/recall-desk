import { authTables } from "@convex-dev/auth/server";
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
  /** Set when a match sweep was dropped by the per-run cap; drained by cron. */
  needsMatchSweep: v.optional(v.boolean()),
  /** Set whenever a detail scrape reported (even a null remedyUrl), so the
   * backfill converges instead of re-scraping no-link pages forever. */
  detailScrapedAt: v.optional(v.number()),
  contentHash: v.string(),
  status: vRecallStatus,
});

// Lane B tables (users, items, matches, claims, claimEvents, emailsProcessed)
// land with auth in M5/M6 — items/matches/claims need Id<"users">, which does
// not exist until authTables is added. Logged as a Session M2 decision.
export default defineSchema({
  ...authTables,

  /** Convex Auth's users table, extended with Recall Desk fields. The base
   * fields/indexes must match authTables.users exactly. */
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    /** Short unique tag baked into the user's ingest alias
     * (receipts+<tag>@…). Stamped at signup, immutable. */
    userTag: v.optional(v.string()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("by_userTag", ["userTag"]),

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
    /** Set when extraction is enqueued; cleared on save. Suppresses
     * duplicate extractions from concurrent first-matches. */
    extractionEnqueuedAt: v.optional(v.number()),
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

  /** A user's watched inventory, extracted from forwarded receipts. */
  items: defineTable({
    userId: v.id("users"),
    sourceMessageId: v.string(),
    product: v.string(),
    brand: v.optional(v.string()),
    model: v.optional(v.string()),
    upc: v.optional(v.string()),
    category: v.optional(v.string()),
    purchaseDate: v.optional(v.string()),
    retailer: v.optional(v.string()),
    quantity: v.optional(v.number()),
    confidence: v.number(),
    status: v.union(v.literal("active"), v.literal("dismissed")),
    /** product+brand+model, for the recall-side sweep's search index. */
    searchText: v.optional(v.string()),
    /** Set when adjudication was budget-halted; a cron retries and clears. */
    needsAdjudication: v.optional(v.boolean()),
  })
    .index("by_userId", ["userId"])
    .searchIndex("search_items", { searchField: "searchText" }),

  /** UPC -> recall lookup so UPC-exact matches bypass the title search
   * entirely (title tokens can miss; the UPC cannot). Maintained in the
   * same mutation as every recalls write. */
  recallUpcs: defineTable({
    upc: v.string(),
    recallId: v.id("recalls"),
  })
    .index("by_upc", ["upc"])
    .index("by_recallId", ["recallId"]),

  /** A confirmed item-recall match. One row per (itemId, recallId). */
  matches: defineTable({
    userId: v.id("users"),
    itemId: v.id("items"),
    recallId: v.id("recalls"),
    matchScore: v.number(), // adjudicator confidence 0-1
    prefilterScore: v.number(), // token/UPC score that made it a candidate
    matchRationale: v.string(),
    /** Deterministic prefilter evidence (mechanically true of the docs). */
    prefilterReasons: v.optional(v.array(v.string())),
    /** Stamped before each alert attempt (bounded double-send window). */
    notifyAttemptedAt: v.optional(v.number()),
    state: v.union(
      v.literal("new"),
      v.literal("notified"),
      v.literal("claim_ready"),
      v.literal("claim_sent"),
      v.literal("acknowledged"),
      v.literal("resolved"),
      v.literal("dismissed"),
    ),
  })
    .index("by_userId", ["userId"])
    .index("by_itemId_and_recallId", ["itemId", "recallId"])
    .index("by_recallId", ["recallId"])
    .index("by_state", ["state"]),

  /** A claim against one match: drafted -> approved -> sent -> delivered ->
   * replied -> completed. threadId keys inbound reply routing. */
  claims: defineTable({
    matchId: v.id("matches"),
    userId: v.id("users"),
    channel: v.union(v.literal("email"), v.literal("portal_checklist")),
    recipient: v.string(),
    draftSubject: v.string(),
    draftBody: v.string(),
    threadId: v.optional(v.string()),
    sentMessageId: v.optional(v.string()),
    state: v.union(
      v.literal("draft"),
      v.literal("approved"),
      v.literal("sending"),
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("replied"),
      v.literal("completed"),
    ),
  })
    .index("by_matchId", ["matchId"])
    .index("by_userId", ["userId"])
    .index("by_threadId", ["threadId"]),

  /** Append-only claim timeline. */
  claimEvents: defineTable({
    claimId: v.id("claims"),
    kind: v.union(
      v.literal("drafted"),
      v.literal("edited"),
      v.literal("approved"),
      v.literal("sent"),
      v.literal("send_failed"),
      v.literal("delivered"),
      v.literal("bounced"),
      v.literal("inbound_reply"),
      v.literal("unverified_inbound"),
      v.literal("completed"),
      v.literal("note"),
    ),
    payload: v.optional(v.any()),
  }).index("by_claimId", ["claimId"]),

  /** Idempotency ledger for inbound mail — one row per message_id, written
   * transactionally with any follow-up enqueue. Raw bodies live in the
   * AgentMail component's inboundMessages table. */
  emailsProcessed: defineTable({
    messageId: v.string(),
    inboxId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    userId: v.optional(v.id("users")),
    fromAddress: v.optional(v.string()),
    classification: v.union(
      v.literal("receipt"),
      v.literal("claim_reply"),
      v.literal("unknown"),
      v.literal("unroutable"),
      v.literal("error"),
    ),
    itemIdsCreated: v.array(v.id("items")),
    error: v.optional(v.string()),
  })
    .index("by_messageId", ["messageId"])
    .index("by_userId", ["userId"]),

  /** Budget guard singleton (hard constraint #7): daily + total LLM spend.
   * Updated in the same mutation as every llmUsage insert. */
  llmBudget: defineTable({
    day: v.string(),
    dayUsd: v.number(),
    totalUsd: v.number(),
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
