import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  env,
  internalMutation,
  mutation,
} from "./_generated/server";
import {
  BudgetHaltError,
  callStructured,
  RECEIPT_SCHEMA,
  RECEIPT_SYSTEM_PROMPT,
  TerminalExtractionError,
} from "./ai";

/** Manual receipt intake (paste / photo) — the same pipeline the forwarded
 * email path uses, minus the mailbox. Forwarding stays available. */

const MAX_PASTE_CHARS = 15_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_MANUAL_PER_DAY = 20;

/** Ledger row for a manual receipt; enforces the same per-user daily cap as
 * inbound mail. Returns null when capped. */
export const beginManualReceipt = internalMutation({
  args: { userId: v.id("users"), kind: v.string(), token: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const dayStart = Date.now() - 24 * 60 * 60 * 1000;
    const recent = await ctx.db
      .query("emailsProcessed")
      .withIndex("by_userId", (q) =>
        q.eq("userId", args.userId).gte("_creationTime", dayStart),
      )
      .take(MAX_MANUAL_PER_DAY + 1);
    if (recent.filter((r) => r.classification === "receipt").length >= MAX_MANUAL_PER_DAY) {
      return null;
    }
    const messageId = `${args.kind}:${args.token}`;
    await ctx.db.insert("emailsProcessed", {
      messageId,
      userId: args.userId,
      classification: "receipt",
      itemIdsCreated: [],
    });
    return messageId;
  },
});

async function runExtraction(
  ctx: Parameters<typeof callStructured>[0] & { runMutation: Function },
  args: {
    userId: Id<"users">;
    messageId: string;
    userText: string;
    imageDataUrl?: string;
  },
): Promise<{ itemsCreated: number }> {
  let result: Record<string, unknown>;
  try {
    result = await callStructured(ctx, {
      purpose: args.imageDataUrl !== undefined ? "receipt-photo" : "receipt-paste",
      model: env.OPENAI_MODEL_CHEAP ?? "gpt-5.6-luna",
      system: RECEIPT_SYSTEM_PROMPT,
      user: args.userText,
      imageDataUrl: args.imageDataUrl,
      schemaName: "receipt_extraction",
      schema: RECEIPT_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 2_000,
    });
  } catch (error) {
    if (error instanceof BudgetHaltError) {
      throw new Error("Receipt reading is briefly unavailable — try again shortly.");
    }
    if (error instanceof TerminalExtractionError) {
      throw new Error("Couldn't read that receipt. Try a clearer photo or paste the text.");
    }
    throw error;
  }
  return await ctx.runMutation(internal.items.createFromExtraction, {
    messageId: args.messageId,
    userId: args.userId,
    extraction: result,
  });
}

/** Paste receipt text (order confirmation copied from an email or app). */
export const ingestPastedReceipt = action({
  args: { text: v.string() },
  returns: v.object({ itemsCreated: v.number() }),
  handler: async (ctx, args): Promise<{ itemsCreated: number }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("not signed in");
    const text = args.text.trim();
    if (text.length < 20) throw new Error("That looks too short to be a receipt.");
    const messageId: string | null = await ctx.runMutation(
      internal.receipts.beginManualReceipt,
      { userId, kind: "paste", token: crypto.randomUUID() },
    );
    if (messageId === null) throw new Error("Daily receipt limit reached — try again tomorrow.");
    return await runExtraction(ctx, {
      userId,
      messageId,
      userText: text.slice(0, MAX_PASTE_CHARS),
    });
  },
});

/** Upload URL for a receipt photo (camera roll or camera on mobile). */
export const generateReceiptUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("not signed in");
    return await ctx.storage.generateUploadUrl();
  },
});

/** Read an uploaded receipt photo with the vision model, then run the same
 * item pipeline. The stored blob is deleted once read. */
export const ingestUploadedReceipt = action({
  args: { storageId: v.id("_storage") },
  returns: v.object({ itemsCreated: v.number() }),
  handler: async (ctx, args): Promise<{ itemsCreated: number }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("not signed in");
    const blob = await ctx.storage.get(args.storageId);
    if (blob === null) throw new Error("upload not found");
    if (blob.size > MAX_IMAGE_BYTES) {
      await ctx.storage.delete(args.storageId);
      throw new Error("That image is too large (8 MB max).");
    }
    const type = blob.type || "image/jpeg";
    if (!type.startsWith("image/")) {
      await ctx.storage.delete(args.storageId);
      throw new Error("Please upload a photo of the receipt (PDF support is coming).");
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const dataUrl = `data:${type};base64,${btoa(binary)}`;
    const messageId: string | null = await ctx.runMutation(
      internal.receipts.beginManualReceipt,
      { userId, kind: "photo", token: crypto.randomUUID() },
    );
    if (messageId === null) {
      await ctx.storage.delete(args.storageId);
      throw new Error("Daily receipt limit reached — try again tomorrow.");
    }
    try {
      return await runExtraction(ctx, {
        userId,
        messageId,
        userText: "Extract every purchased product from this receipt photo.",
        imageDataUrl: dataUrl,
      });
    } finally {
      // The photo has been read; we keep the extracted items, not the image.
      await ctx.storage.delete(args.storageId);
    }
  },
});
