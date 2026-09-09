import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  env,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { BudgetHaltError, callStructured, TerminalExtractionError } from "./ai";
import { sendGuarded } from "./mail";
import schema from "./schema";

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body"],
  properties: {
    subject: { type: "string", description: "concise claim email subject naming the recall and product" },
    body: {
      type: "string",
      description:
        "plain-text claim email. Facts ONLY from the provided data; use [bracketed placeholders] for anything unknown (address, serial). Sign with the user's email.",
    },
  },
} as const;

/** Draft a claim email for one of the caller's matches (LLM, budget-guarded). */
export const draftClaim = action({
  args: { matchId: v.id("matches") },
  returns: v.union(v.id("claims"), v.null()),
  handler: async (ctx, args): Promise<Id<"claims"> | null> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("not signed in");
    const bundle: {
      itemText: string;
      recallText: string;
      procedureText: string;
      recipient: string;
      userEmail: string;
      existingClaimId: Id<"claims"> | null;
    } | null = await ctx.runQuery(internal.claims.draftContext, {
      matchId: args.matchId,
      userId,
    });
    if (bundle === null) throw new Error("match not found");
    if (bundle.existingClaimId !== null) return bundle.existingClaimId;

    let draft: Record<string, unknown>;
    try {
      draft = await callStructured(ctx, {
        purpose: "claim-drafting",
        model: env.OPENAI_MODEL_CHEAP ?? "gpt-5.6-luna",
        system:
          "You draft a polite, factual consumer recall-claim email. Use ONLY the facts provided. " +
          "Never invent model numbers, dates, addresses, or promises. For required information the data " +
          "does not contain, write a [bracketed placeholder] the user will fill in. " +
          "Keep it under 180 words. Sign with the user's email address.",
        user: `${bundle.itemText}\n\n${bundle.recallText}\n\n${bundle.procedureText}\n\nUser's email (signature): ${bundle.userEmail}`,
        schemaName: "claim_draft",
        schema: DRAFT_SCHEMA as unknown as Record<string, unknown>,
        maxOutputTokens: 700,
      });
    } catch (error) {
      if (error instanceof BudgetHaltError || error instanceof TerminalExtractionError) {
        throw new Error("Drafting is briefly unavailable — try again in a little while.");
      }
      throw error;
    }
    const claimId: Id<"claims"> = await ctx.runMutation(internal.claims.createDraft, {
      matchId: args.matchId,
      userId,
      recipient: bundle.recipient,
      draftSubject: String(draft.subject ?? "").slice(0, 200),
      draftBody: String(draft.body ?? "").slice(0, 4000),
    });
    return claimId;
  },
});

export const draftContext = internalQuery({
  args: { matchId: v.id("matches"), userId: v.id("users") },
  returns: v.union(
    v.object({
      itemText: v.string(),
      recallText: v.string(),
      procedureText: v.string(),
      recipient: v.string(),
      userEmail: v.string(),
      existingClaimId: v.union(v.id("claims"), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const match = await ctx.db.get("matches", args.matchId);
    if (match === null || match.userId !== args.userId) return null;
    const existing = await ctx.db
      .query("claims")
      .withIndex("by_matchId", (q) => q.eq("matchId", args.matchId))
      .unique();
    if (existing !== null) {
      return {
        itemText: "",
        recallText: "",
        procedureText: "",
        recipient: "",
        userEmail: "",
        existingClaimId: existing._id,
      };
    }
    const item = await ctx.db.get("items", match.itemId);
    const recall = await ctx.db.get("recalls", match.recallId);
    if (item === null || recall === null) return null;
    const user = await ctx.db.get("users", args.userId);
    const page = await ctx.db
      .query("remedyPages")
      .withIndex("by_recallId", (q) => q.eq("recallId", match.recallId))
      .unique();
    const procedure = (page?.extractedProcedure ?? {}) as {
      is_remedy_page?: boolean;
      summary?: string;
      options?: string[];
      required_fields?: Array<{ name: string }>;
      claim_email?: string;
    };
    const contactEmail =
      (procedure.claim_email ?? "") ||
      EMAIL_RE.exec(recall.consumerContact ?? "")?.[0] ||
      "";
    return {
      itemText: `PURCHASED ITEM: ${item.product}${item.brand ? ` | brand: ${item.brand}` : ""}${item.model ? ` | model: ${item.model}` : ""}${item.upc ? ` | UPC: ${item.upc}` : ""}${item.purchaseDate ? ` | purchased: ${item.purchaseDate}` : ""}${item.retailer ? ` | retailer: ${item.retailer}` : ""}`,
      recallText: `RECALL: ${recall.title} (official notice: ${recall.url})${recall.remedyOptions.length > 0 ? ` | remedy offered: ${recall.remedyOptions.join(", ")}` : ""}`,
      procedureText:
        procedure.is_remedy_page === true
          ? `REMEDY PAGE SAYS: ${procedure.summary ?? ""}${procedure.required_fields?.length ? ` | the form asks for: ${procedure.required_fields.map((f) => f.name).join(", ")}` : ""}`
          : "REMEDY PAGE: none available — write a general claim request.",
      recipient: contactEmail,
      userEmail: user?.email ?? "",
      existingClaimId: null,
    };
  },
});

export const createDraft = internalMutation({
  args: {
    matchId: v.id("matches"),
    userId: v.id("users"),
    recipient: v.string(),
    draftSubject: v.string(),
    draftBody: v.string(),
  },
  returns: v.id("claims"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("claims")
      .withIndex("by_matchId", (q) => q.eq("matchId", args.matchId))
      .unique();
    if (existing !== null) return existing._id;
    const claimId = await ctx.db.insert("claims", {
      matchId: args.matchId,
      userId: args.userId,
      channel: "email",
      recipient: args.recipient,
      draftSubject: args.draftSubject,
      draftBody: args.draftBody,
      state: "draft",
    });
    await ctx.db.insert("claimEvents", { claimId, kind: "drafted" });
    await ctx.db.patch("matches", args.matchId, { state: "claim_ready" });
    return claimId;
  },
});

/** Edit the draft (subject/body/recipient) before approval. Owner-checked. */
export const editClaimDraft = mutation({
  args: {
    claimId: v.id("claims"),
    recipient: v.optional(v.string()),
    draftSubject: v.optional(v.string()),
    draftBody: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("not signed in");
    const claim = await ctx.db.get("claims", args.claimId);
    if (claim === null || claim.userId !== userId) throw new Error("claim not found");
    if (claim.state !== "draft" && claim.state !== "approved") {
      throw new Error("claim is already sent");
    }
    await ctx.db.patch("claims", args.claimId, {
      ...(args.recipient !== undefined ? { recipient: args.recipient.trim() } : {}),
      ...(args.draftSubject !== undefined ? { draftSubject: args.draftSubject.slice(0, 200) } : {}),
      ...(args.draftBody !== undefined ? { draftBody: args.draftBody.slice(0, 4000) } : {}),
      state: "draft",
    });
    await ctx.db.insert("claimEvents", { claimId: args.claimId, kind: "edited" });
    return null;
  },
});

/** Approval is the human gate: nothing sends without it. Schedules the send. */
export const approveClaim = mutation({
  args: { claimId: v.id("claims") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("not signed in");
    const claim = await ctx.db.get("claims", args.claimId);
    if (claim === null || claim.userId !== userId) throw new Error("claim not found");
    if (claim.state !== "draft") throw new Error("only a draft can be approved");
    if (!EMAIL_RE.test(claim.recipient)) throw new Error("set a valid recipient first");
    await ctx.db.patch("claims", args.claimId, { state: "approved" });
    await ctx.db.insert("claimEvents", { claimId: args.claimId, kind: "approved" });
    // at-most-once send: scheduler, not a retrying pool.
    await ctx.scheduler.runAfter(0, internal.claims.sendClaim, { claimId: args.claimId });
    return null;
  },
});

export const getClaim = internalQuery({
  args: { claimId: v.id("claims") },
  returns: v.union(schema.doc("claims"), v.null()),
  handler: async (ctx, args) => await ctx.db.get("claims", args.claimId),
});

/** The actual outbound send — through the hard allowlist guard. */
export const sendClaim = internalAction({
  args: { claimId: v.id("claims") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const claim = await ctx.runQuery(internal.claims.getClaim, { claimId: args.claimId });
    if (claim === null || claim.state !== "approved") return null;
    const inboxId = env.AGENTMAIL_RECEIPTS_ADDRESS;
    if (!inboxId) throw new Error("receipts inbox not configured");
    try {
      const sent = await sendGuarded({
        inboxId,
        to: claim.recipient,
        subject: claim.draftSubject,
        text: claim.draftBody,
      });
      await ctx.runMutation(internal.claims.recordSent, {
        claimId: args.claimId,
        threadId: sent.threadId,
        messageId: sent.messageId,
      });
    } catch (error) {
      await ctx.runMutation(internal.claims.recordSendFailure, {
        claimId: args.claimId,
        error: String(error).slice(0, 300),
      });
    }
    return null;
  },
});

export const recordSent = internalMutation({
  args: { claimId: v.id("claims"), threadId: v.string(), messageId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const claim = await ctx.db.get("claims", args.claimId);
    if (claim === null) return null;
    await ctx.db.patch("claims", args.claimId, {
      state: "sent",
      threadId: args.threadId,
      sentMessageId: args.messageId,
    });
    await ctx.db.insert("claimEvents", { claimId: args.claimId, kind: "sent" });
    const match = await ctx.db.get("matches", claim.matchId);
    if (match !== null) await ctx.db.patch("matches", claim.matchId, { state: "claim_sent" });
    return null;
  },
});

export const recordSendFailure = internalMutation({
  args: { claimId: v.id("claims"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Back to draft so the user can adjust the recipient and retry —
    // an allowlist rejection during the hackathon lands here by design.
    await ctx.db.patch("claims", args.claimId, { state: "draft" });
    await ctx.db.insert("claimEvents", {
      claimId: args.claimId,
      kind: "send_failed",
      payload: { error: args.error },
    });
    return null;
  },
});

/** Every AgentMail webhook event: advance claim delivery states by thread. */
export const onMailEvent = internalMutation({
  args: { event: v.any() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = args.event as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";
    if (type !== "message.delivered" && type !== "message.bounced") return null;
    const message = (event.message ?? {}) as Record<string, unknown>;
    const threadId = typeof message.thread_id === "string" ? message.thread_id : "";
    if (threadId === "") return null;
    const claim = await ctx.db
      .query("claims")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .unique();
    if (claim === null) return null;
    if (type === "message.delivered" && claim.state === "sent") {
      await ctx.db.patch("claims", claim._id, { state: "delivered" });
      await ctx.db.insert("claimEvents", { claimId: claim._id, kind: "delivered" });
    }
    if (type === "message.bounced") {
      await ctx.db.insert("claimEvents", {
        claimId: claim._id,
        kind: "bounced",
        payload: { threadId },
      });
    }
    return null;
  },
});

/** Inbound message on a known claim thread -> timeline + state. Called from
 * email.onMessageReceived BEFORE receipt classification. Returns claimId if
 * the thread matched. */
export async function routeClaimReply(
  ctx: MutationCtx,
  threadId: string,
  message: { from?: string; preview?: string; text?: string },
): Promise<Id<"claims"> | null> {
  const claim = await ctx.db
    .query("claims")
    .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
    .unique();
  if (claim === null) return null;
  await ctx.db.patch("claims", claim._id, { state: "replied" });
  await ctx.db.insert("claimEvents", {
    claimId: claim._id,
    kind: "inbound_reply",
    payload: {
      from: message.from ?? "",
      preview: (message.preview ?? message.text ?? "").slice(0, 500),
    },
  });
  const match = await ctx.db.get("matches", claim.matchId);
  if (match !== null) {
    await ctx.db.patch("matches", claim.matchId, { state: "acknowledged" });
  }
  return claim._id;
}

/** The claim (if any) + timeline for one of the caller's matches. */
export const claimForMatch = query({
  args: { matchId: v.id("matches") },
  returns: v.union(
    v.object({
      claim: schema.doc("claims"),
      events: v.array(schema.doc("claimEvents")),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const claim = await ctx.db
      .query("claims")
      .withIndex("by_matchId", (q) => q.eq("matchId", args.matchId))
      .unique();
    if (claim === null || claim.userId !== userId) return null;
    const events = await ctx.db
      .query("claimEvents")
      .withIndex("by_claimId", (q) => q.eq("claimId", claim._id))
      .take(50);
    return { claim, events };
  },
});
