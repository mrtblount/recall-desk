import { AgentMail } from "@agentmail/convex";
import { vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { env, internalMutation, internalQuery } from "./_generated/server";
import { aliasTag, bareAddress, RECEIPT_HINT_RE } from "./emailParse";
import { llmPool } from "./pools";
import schema from "./schema";

/** Shared client: http.ts mounts its handleWebhook; the callback below runs
 * (via the component's callback workpool) on every inbound message. */
export const agentmail: AgentMail = new AgentMail(components.agentmail, {
  onMessageReceived: internal.email.onMessageReceived,
});

/** Per-user extraction budget (spam brake): beyond this many receipt
 * classifications per UTC day, further mail is ledgered as "unknown". */
const MAX_RECEIPTS_PER_USER_PER_DAY = 20;

function asString(x: unknown): string {
  return typeof x === "string" ? x : "";
}

export const ledgerByMessageId = internalQuery({
  args: { messageId: v.string() },
  returns: v.union(schema.doc("emailsProcessed"), v.null()),
  handler: async (ctx, args) =>
    await ctx.db
      .query("emailsProcessed")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .unique(),
});

/**
 * Inbound routing. Raw message is already persisted by the component.
 * SECURITY MODEL (review-hardened): routing is by plus-alias tag ONLY — the
 * From header is attacker-controlled and is never used to route. Mail to any
 * inbox other than the receipts inbox is ignored.
 */
export const onMessageReceived = internalMutation({
  args: { message: v.any(), thread: v.any(), eventId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const m = args.message as Record<string, unknown>;
    const messageId = asString(m.message_id);
    const inboxId = asString(m.inbox_id);
    if (messageId === "" || inboxId === "") return null;
    const receiptsInbox = (env.AGENTMAIL_RECEIPTS_ADDRESS ?? "").toLowerCase();
    if (receiptsInbox === "" || inboxId.toLowerCase() !== receiptsInbox) {
      console.log(`inbound to non-receipts inbox ${inboxId} — ignored`);
      return null;
    }
    const existing = await ctx.db
      .query("emailsProcessed")
      .withIndex("by_messageId", (q) => q.eq("messageId", messageId))
      .unique();
    if (existing !== null) return null;

    const from = bareAddress(asString(m.from));
    const recipients = [
      ...(Array.isArray(m.to) ? m.to : []),
      ...(Array.isArray(m.cc) ? m.cc : []),
    ].map((r) => asString(r));

    let userId = null;
    for (const r of recipients) {
      const tag = aliasTag(r);
      if (tag === null) continue;
      const user = await ctx.db
        .query("users")
        .withIndex("by_userTag", (q) => q.eq("userTag", tag))
        .unique();
      if (user !== null) {
        userId = user._id;
        break;
      }
    }

    let classification:
      | "receipt"
      | "unknown"
      | "unroutable" = "unroutable";
    if (userId !== null) {
      const looksLikeReceipt = RECEIPT_HINT_RE.test(
        `${asString(m.subject)} ${asString(m.preview)} ${asString(m.text).slice(0, 500)}`,
      );
      classification = looksLikeReceipt ? "receipt" : "unknown";
      if (classification === "receipt") {
        const dayStart = Date.now() - 24 * 60 * 60 * 1000;
        const recent = await ctx.db
          .query("emailsProcessed")
          .withIndex("by_userId", (q) =>
            q.eq("userId", userId).gte("_creationTime", dayStart),
          )
          .take(MAX_RECEIPTS_PER_USER_PER_DAY + 1);
        const receiptsToday = recent.filter((r) => r.classification === "receipt").length;
        if (receiptsToday >= MAX_RECEIPTS_PER_USER_PER_DAY) {
          console.warn(`per-user daily receipt cap hit for ${userId} — ledgered as unknown`);
          classification = "unknown";
        }
      }
    }

    await ctx.db.insert("emailsProcessed", {
      messageId,
      inboxId,
      threadId: asString(m.thread_id) || undefined,
      userId: userId ?? undefined,
      fromAddress: from || undefined,
      classification,
      itemIdsCreated: [],
    });

    if (classification === "receipt" && userId !== null) {
      await llmPool.enqueueAction(
        ctx,
        internal.ai.extractReceipt,
        { messageId, inboxId, userId },
        {
          onComplete: internal.email.onExtractionComplete,
          context: { messageId },
        },
      );
    }
    console.log(
      `inbound ${messageId.slice(0, 24)}…: classification=${classification} routed=${userId !== null}`,
    );
    return null;
  },
});

/** Pool completion: a permanently failed extraction must not vanish — mark
 * the ledger row so it is visible and excluded from stalled-retry. */
export const onExtractionComplete = internalMutation({
  args: vOnCompleteArgs(v.object({ messageId: v.string() })),
  returns: v.null(),
  handler: async (ctx, { context, result }) => {
    if (result.kind !== "failed") return null;
    const ledger = await ctx.db
      .query("emailsProcessed")
      .withIndex("by_messageId", (q) => q.eq("messageId", context.messageId))
      .unique();
    if (ledger === null || ledger.itemIdsCreated.length > 0) return null;
    await ctx.db.patch("emailsProcessed", ledger._id, {
      classification: "error",
      error: String(result.error).slice(0, 500),
    });
    return null;
  },
});

/** Terminal extraction failure recorded by the action itself (no retry). */
export const markLedgerError = internalMutation({
  args: {
    messageId: v.string(),
    error: v.string(),
    keepReceiptClassification: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ledger = await ctx.db
      .query("emailsProcessed")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .unique();
    if (ledger === null) return null;
    await ctx.db.patch("emailsProcessed", ledger._id, {
      // budget-halted rows KEEP "receipt" so the stalled-retry cron recovers
      // them after the daily reset; deterministic failures become "error".
      classification: args.keepReceiptClassification ? "receipt" : "error",
      error: args.error.slice(0, 500),
    });
    return null;
  },
});

/** Cron: re-enqueue receipts that never produced items (e.g. halted by the
 * daily budget guard) once they are >30 min old. Terminal errors ("error")
 * are excluded. Bounded sweep. */
export const retryStalledExtractions = internalMutation({
  args: {},
  returns: v.object({ reenqueued: v.number() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    const rows = await ctx.db.query("emailsProcessed").order("desc").take(300);
    let reenqueued = 0;
    for (const row of rows) {
      if (
        row.classification !== "receipt" ||
        row.itemIdsCreated.length > 0 ||
        row.error === undefined || // only rows that recorded a halt
        row._creationTime > cutoff ||
        row.userId === undefined ||
        row.inboxId === undefined
      ) {
        continue;
      }
      await ctx.db.patch("emailsProcessed", row._id, { error: undefined });
      await llmPool.enqueueAction(
        ctx,
        internal.ai.extractReceipt,
        { messageId: row.messageId, inboxId: row.inboxId, userId: row.userId },
        { onComplete: internal.email.onExtractionComplete, context: { messageId: row.messageId } },
      );
      reenqueued++;
      if (reenqueued >= 20) break;
    }
    if (reenqueued > 0) console.log(`retryStalledExtractions: re-enqueued ${reenqueued}`);
    return { reenqueued };
  },
});
