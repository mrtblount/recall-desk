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
import { bareAddress, stripControl } from "./emailParse";
import { sendGuarded } from "./mail";
import { baseDomain } from "./remedySanitize";
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
    // Draft-only: allowing edits on an approved claim opened a race where a
    // second approval double-sent while the first was in flight (review).
    if (claim.state !== "draft") {
      throw new Error("only a draft can be edited");
    }
    // Reject, never silently truncate — the human gate means what the user
    // approves on screen is byte-for-byte what sends.
    if (args.draftSubject !== undefined && args.draftSubject.length > 200) {
      throw new Error("subject is limited to 200 characters");
    }
    if (args.draftBody !== undefined && args.draftBody.length > 4000) {
      throw new Error("message is limited to 4000 characters");
    }
    await ctx.db.patch("claims", args.claimId, {
      ...(args.recipient !== undefined ? { recipient: args.recipient.trim() } : {}),
      ...(args.draftSubject !== undefined ? { draftSubject: args.draftSubject } : {}),
      ...(args.draftBody !== undefined ? { draftBody: args.draftBody } : {}),
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

/** Atomically claim the send slot: approved -> sending, returning the exact
 * snapshot to transmit. Any other state aborts — this makes sendClaim
 * idempotent under re-invocation and kills the double-send race. */
export const markSending = internalMutation({
  args: { claimId: v.id("claims") },
  returns: v.union(
    v.object({ recipient: v.string(), subject: v.string(), body: v.string() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const claim = await ctx.db.get("claims", args.claimId);
    if (claim === null || claim.state !== "approved") return null;
    await ctx.db.patch("claims", args.claimId, { state: "sending" });
    return {
      recipient: claim.recipient,
      subject: claim.draftSubject,
      body: claim.draftBody,
    };
  },
});

/** The actual outbound send — through the hard allowlist guard.
 * try covers ONLY the send: a bookkeeping failure after a successful send
 * must never masquerade as a send failure (that path double-sent). */
export const sendClaim = internalAction({
  args: { claimId: v.id("claims") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const inboxId = env.AGENTMAIL_RECEIPTS_ADDRESS;
    if (!inboxId) throw new Error("receipts inbox not configured");
    const snapshot = await ctx.runMutation(internal.claims.markSending, {
      claimId: args.claimId,
    });
    if (snapshot === null) return null;
    let sent: { threadId: string; messageId: string };
    try {
      sent = await sendGuarded({
        inboxId,
        to: snapshot.recipient,
        subject: snapshot.subject,
        text: snapshot.body,
      });
    } catch (error) {
      await ctx.runMutation(internal.claims.recordSendFailure, {
        claimId: args.claimId,
        error: String(error).slice(0, 300),
      });
      return null;
    }
    // The send is a fact now. Retry the recording once; if it still fails,
    // rethrow — the claim stays visibly in "sending", never back to draft.
    try {
      await ctx.runMutation(internal.claims.recordSent, {
        claimId: args.claimId,
        threadId: sent.threadId,
        messageId: sent.messageId,
      });
    } catch {
      await ctx.runMutation(internal.claims.recordSent, {
        claimId: args.claimId,
        threadId: sent.threadId,
        messageId: sent.messageId,
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
    // Precondition: only the in-flight send may record; a stale/duplicate
    // job must not clobber a later state.
    if (claim.state !== "sending" || claim.threadId !== undefined) {
      if (claim.threadId === args.threadId) return null; // idempotent re-run
      await ctx.db.insert("claimEvents", {
        claimId: args.claimId,
        kind: "note",
        payload: { note: "duplicate send bookkeeping ignored" },
      });
      return null;
    }
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
    const claim = await ctx.db.get("claims", args.claimId);
    if (claim === null) return null;
    // Only an in-flight send may fall back to draft; anything else (already
    // sent/replied) just records the event.
    if (claim.state !== "sending" && claim.state !== "approved") {
      await ctx.db.insert("claimEvents", {
        claimId: args.claimId,
        kind: "note",
        payload: { note: `late send-failure ignored: ${args.error.slice(0, 120)}` },
      });
      return null;
    }
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
    const RANK: Record<string, number> = {
      draft: 0, approved: 1, sending: 2, sent: 3, delivered: 4, replied: 5, completed: 6,
    };
    if (type === "message.delivered" && (RANK[claim.state] ?? 0) < RANK.delivered) {
      await ctx.db.patch("claims", claim._id, { state: "delivered" });
      await ctx.db.insert("claimEvents", { claimId: claim._id, kind: "delivered" });
    }
    if (type === "message.bounced") {
      await ctx.db.insert("claimEvents", {
        claimId: claim._id,
        kind: "bounced",
        payload: { threadId },
      });
      // A bounce is actionable: back to draft so the user can fix the
      // address and re-approve — unless a reply already arrived.
      if ((RANK[claim.state] ?? 0) < RANK.replied) {
        await ctx.db.patch("claims", claim._id, { state: "draft" });
      }
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
  // Flood cap: an attacker on the thread must not bury the real reply.
  const existingEvents = await ctx.db
    .query("claimEvents")
    .withIndex("by_claimId", (q) => q.eq("claimId", claim._id))
    .take(40);
  const inboundCount = existingEvents.filter(
    (e) => e.kind === "inbound_reply" || e.kind === "unverified_inbound",
  ).length;
  if (inboundCount >= 15) {
    console.warn(`claim ${claim._id}: inbound event cap reached — message dropped from timeline`);
    return claim._id;
  }
  // Sender verification: anyone who learns the outbound Message-ID can join
  // the thread via In-Reply-To — thread membership alone proves nothing.
  // Only mail from the claim recipient's address (or its registrable
  // domain) advances state; anything else is recorded as unverified.
  const from = bareAddress(message.from ?? "");
  const recipient = claim.recipient.toLowerCase();
  const fromDomain = from.split("@")[1] ?? "";
  const recipientDomain = recipient.split("@")[1] ?? "";
  const verified =
    from !== "" &&
    (from === recipient ||
      (fromDomain !== "" && baseDomain(fromDomain) === baseDomain(recipientDomain)));
  const preview = stripControl((message.preview ?? message.text ?? "").slice(0, 500));
  if (!verified) {
    await ctx.db.insert("claimEvents", {
      claimId: claim._id,
      kind: "unverified_inbound",
      payload: { from, preview },
    });
    return claim._id;
  }
  const RANK: Record<string, number> = {
    draft: 0, approved: 1, sending: 2, sent: 3, delivered: 4, replied: 5, completed: 6,
  };
  if ((RANK[claim.state] ?? 0) < RANK.replied) {
    await ctx.db.patch("claims", claim._id, { state: "replied" });
    const match = await ctx.db.get("matches", claim.matchId);
    if (match !== null) {
      await ctx.db.patch("matches", claim.matchId, { state: "acknowledged" });
    }
  }
  await ctx.db.insert("claimEvents", {
    claimId: claim._id,
    kind: "inbound_reply",
    payload: { from, preview },
  });
  return claim._id;
}

/** Close the loop: the user marks a replied claim done. Owner-checked. */
export const markClaimCompleted = mutation({
  args: { claimId: v.id("claims") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("not signed in");
    const claim = await ctx.db.get("claims", args.claimId);
    if (claim === null || claim.userId !== userId) throw new Error("claim not found");
    if (claim.state !== "replied" && claim.state !== "delivered" && claim.state !== "sent") {
      throw new Error("only an active claim can be completed");
    }
    await ctx.db.patch("claims", args.claimId, { state: "completed" });
    await ctx.db.insert("claimEvents", { claimId: args.claimId, kind: "completed" });
    const match = await ctx.db.get("matches", claim.matchId);
    if (match !== null) await ctx.db.patch("matches", claim.matchId, { state: "resolved" });
    return null;
  },
});

/** Cron hook: claims stuck in 'approved' (scheduler died before markSending)
 * fall back to draft after 10 minutes with an explanatory event. Claims
 * stuck in 'sending' >30 min get a warning note — the send MAY have gone
 * out, so we never silently re-enable a duplicate approval. */
export const recoverStuckClaims = internalMutation({
  args: {},
  returns: v.object({ recovered: v.number() }),
  handler: async (ctx) => {
    const claims = await ctx.db.query("claims").take(200);
    const now = Date.now();
    let recovered = 0;
    for (const claim of claims) {
      const age = now - claim._creationTime;
      void age;
      const events = await ctx.db
        .query("claimEvents")
        .withIndex("by_claimId", (q) => q.eq("claimId", claim._id))
        .take(40);
      const lastEventAt = events.reduce((m, e) => Math.max(m, e._creationTime), 0);
      const staleFor = now - Math.max(lastEventAt, claim._creationTime);
      if (claim.state === "approved" && staleFor > 10 * 60 * 1000) {
        await ctx.db.patch("claims", claim._id, { state: "draft" });
        await ctx.db.insert("claimEvents", {
          claimId: claim._id,
          kind: "send_failed",
          payload: { error: "send did not start — approve again" },
        });
        recovered++;
      } else if (
        claim.state === "sending" &&
        staleFor > 30 * 60 * 1000 &&
        !events.some((e) => e.kind === "note" && (e.payload as { note?: string } | undefined)?.note?.startsWith("send status unknown"))
      ) {
        await ctx.db.insert("claimEvents", {
          claimId: claim._id,
          kind: "note",
          payload: { note: "send status unknown — the email may have gone out; contact support before retrying" },
        });
        recovered++;
      }
    }
    return { recovered };
  },
});

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
