import { AgentMail } from "@agentmail/convex";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { llmPool } from "./pools";
import schema from "./schema";

/** Shared client: http.ts mounts its handleWebhook; the callback below runs
 * (via the component's callback workpool) on every inbound message. */
export const agentmail: AgentMail = new AgentMail(components.agentmail, {
  onMessageReceived: internal.email.onMessageReceived,
});

const ALIAS_TAG_RE = /recalldesk\+([a-z0-9]+)@agentmail\.to/i;

function asString(x: unknown): string {
  return typeof x === "string" ? x : "";
}

function bareAddress(formatted: string): string {
  const m = /<([^>]+)>/.exec(formatted);
  return (m ? m[1] : formatted).trim().toLowerCase();
}

const RECEIPT_HINT_RE =
  /receipt|order|invoice|purchase|confirmation|shipped|delivery|your (order|package)/i;

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
 * Inbound routing. Raw message is already persisted by the component before
 * this runs. Idempotent via the emailsProcessed ledger; the extraction
 * enqueue is transactional with the ledger insert.
 */
export const onMessageReceived = internalMutation({
  args: { message: v.any(), thread: v.any(), eventId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const m = args.message as Record<string, unknown>;
    const messageId = asString(m.message_id);
    const inboxId = asString(m.inbox_id);
    if (messageId === "" || inboxId === "") {
      console.warn("inbound message missing message_id/inbox_id — skipped");
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
    ].map((r) => bareAddress(asString(r)));

    // Route: the plus-alias tag is authoritative; fall back to a VERIFIED
    // sender address (unverified rows can be minted by anyone typing an
    // email into sign-in — never route on them).
    let userId = null;
    for (const r of recipients) {
      const tagMatch = ALIAS_TAG_RE.exec(r);
      if (tagMatch) {
        const user = await ctx.db
          .query("users")
          .withIndex("by_userTag", (q) => q.eq("userTag", tagMatch[1].toLowerCase()))
          .unique();
        if (user !== null) {
          userId = user._id;
          break;
        }
      }
    }
    if (userId === null && from !== "") {
      const user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", from))
        .unique();
      if (user !== null && user.emailVerificationTime !== undefined) {
        userId = user._id;
      }
    }

    const looksLikeReceipt = RECEIPT_HINT_RE.test(
      `${asString(m.subject)} ${asString(m.preview)} ${asString(m.text).slice(0, 500)}`,
    );
    const classification =
      userId === null ? "unroutable" : looksLikeReceipt ? "receipt" : "unknown";

    await ctx.db.insert("emailsProcessed", {
      messageId,
      threadId: asString(m.thread_id) || undefined,
      userId: userId ?? undefined,
      fromAddress: from || undefined,
      classification,
      itemIdsCreated: [],
    });

    if (classification === "receipt" && userId !== null) {
      await llmPool.enqueueAction(ctx, internal.ai.extractReceipt, {
        messageId,
        inboxId,
        userId,
      });
    }
    console.log(
      `inbound ${messageId.slice(0, 24)}…: classification=${classification} routed=${userId !== null}`,
    );
    return null;
  },
});
