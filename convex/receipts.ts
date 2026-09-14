import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  type ActionCtx,
  env,
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
} from "./_generated/server";
import {
  BudgetHaltError,
  callStructured,
  RECEIPT_SCHEMA,
  RECEIPT_SYSTEM_PROMPT,
  TerminalExtractionError,
} from "./ai";
import { sniffImage } from "./imageSniff";
import { receiptCapReached } from "./intakeCap";

/** Manual receipt intake (paste / photo) — the same pipeline the forwarded
 * email path uses, minus the mailbox. Forwarding stays available. */

const MAX_PASTE_CHARS = 15_000;
/** The browser downscales every photo to <=2048 px JPEG (~0.3-1.5 MB), so
 * these caps are headroom, not targets. The action runs in the default
 * 64 MiB isolate: bytes + base64 + the JSON request body must all fit, so
 * the total stays well under a third of it (review finding). */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_PHOTOS = 4;

/** Ledger row for a manual intake (paste / photo / typed-in item); enforces
 * the same per-user daily cap as inbound mail. Returns the new messageId, or
 * null when capped. Plain helper so a MUTATION (items.addManualItem) can call
 * it directly in its own transaction instead of nesting ctx.runMutation. */
export async function beginManualLedger(
  ctx: MutationCtx,
  args: { userId: Id<"users">; kind: string; token: string },
): Promise<string | null> {
  if (await receiptCapReached(ctx, args.userId)) return null;
  const messageId = `${args.kind}:${args.token}`;
  await ctx.db.insert("emailsProcessed", {
    messageId,
    userId: args.userId,
    classification: "receipt",
    itemIdsCreated: [],
    manual: true,
  });
  return messageId;
}

/** Action-facing wrapper around beginManualLedger (actions have no ctx.db). */
export const beginManualReceipt = internalMutation({
  args: { userId: v.id("users"), kind: v.string(), token: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => await beginManualLedger(ctx, args),
});

async function runExtraction(
  ctx: ActionCtx,
  args: {
    userId: Id<"users">;
    messageId: string;
    userText: string;
    imageDataUrls?: string[];
  },
): Promise<{ itemsCreated: number }> {
  let result: Record<string, unknown>;
  try {
    result = await callStructured(ctx, {
      purpose: args.imageDataUrls !== undefined ? "receipt-photo" : "receipt-paste",
      model: env.OPENAI_MODEL_CHEAP ?? "gpt-5.6-luna",
      system: RECEIPT_SYSTEM_PROMPT,
      user: args.userText,
      imageDataUrls: args.imageDataUrls,
      schemaName: "receipt_extraction",
      schema: RECEIPT_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 2_000,
    });
  } catch (error) {
    // The row keeps counting toward the daily budget (it cost a call) but is
    // marked so it never reads as a receipt that silently produced nothing.
    if (error instanceof BudgetHaltError || error instanceof TerminalExtractionError) {
      await ctx.runMutation(internal.email.markLedgerError, {
        messageId: args.messageId,
        error: String(error).slice(0, 300),
        keepReceiptClassification: false,
      });
    }
    if (error instanceof BudgetHaltError) {
      throw new ConvexError("Receipt reading is briefly unavailable — try again shortly.");
    }
    if (error instanceof TerminalExtractionError) {
      throw new ConvexError("Couldn't read that receipt. Try a clearer photo or paste the text.");
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
    if (text.length < 20) throw new ConvexError("That looks too short to be a receipt.");
    const messageId: string | null = await ctx.runMutation(
      internal.receipts.beginManualReceipt,
      { userId, kind: "paste", token: crypto.randomUUID() },
    );
    if (messageId === null) throw new ConvexError("Daily limit reached — try again tomorrow.");
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

/** Base64 via a chunked loop — String.fromCharCode(...bytes) on a whole 8 MB
 * photo would blow the argument limit. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Best-effort delete of every uploaded blob. Runs in a `finally`, so a
 * delete failure must NOT replace the user-facing error already in flight —
 * log it loudly instead (a lingering photo is a privacy problem to chase). */
async function deleteBlobs(ctx: ActionCtx, storageIds: Id<"_storage">[]): Promise<void> {
  for (const storageId of storageIds) {
    try {
      await ctx.storage.delete(storageId);
    } catch (error) {
      console.error(`!!! receipt photo ${storageId} was not deleted: ${String(error)}`);
    }
  }
}

const HEIC_MESSAGE =
  "That's an iPhone HEIC photo we couldn't convert in your browser — try taking the photo again with the camera option, or share it as JPEG.";
const UNSUPPORTED_MESSAGE = "Please upload a photo or screenshot (JPG, PNG, WebP, HEIC).";

/** Size/type of an uploaded blob from the system table — checked BEFORE the
 * blob is materialized in the action's memory (review finding: fetching an
 * oversized upload first could OOM the isolate and skip the cleanup). */
export const uploadMeta = internalQuery({
  args: { storageId: v.id("_storage") },
  returns: v.union(v.object({ size: v.number() }), v.null()),
  handler: async (ctx, args) => {
    const meta = await ctx.db.system.get("_storage", args.storageId);
    return meta === null ? null : { size: meta.size };
  },
});

/** Read 1..4 uploaded receipt / product photos with the vision model, then
 * run the same item pipeline. Every photo blob is deleted once read (or on
 * any failure) — we keep the extracted items, never the image.
 *
 * Trust boundary: a storage id is just a string the client sends, and the
 * platform records no uploader, so a caller could name a blob it did not
 * upload (remedy-page markdown ids are visible to matched users). The bytes
 * are therefore sniffed, and ONLY blobs that read as a photo are ever sent
 * to OpenAI or deleted here; anything else is left for the hourly orphan
 * sweep. The client-supplied blob.type is never trusted either — OpenAI
 * sniffs bytes too, and used to answer a HEIC with an opaque 400. */
export const ingestUploadedReceipt = action({
  args: { storageIds: v.array(v.id("_storage")) },
  returns: v.object({ itemsCreated: v.number() }),
  handler: async (ctx, args): Promise<{ itemsCreated: number }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("not signed in");
    // Dedupe defensively: a repeated id would be read twice and deleted twice.
    const storageIds = [...new Set(args.storageIds)];
    const photoIds: Id<"_storage">[] = [];
    try {
      if (storageIds.length < 1 || storageIds.length > MAX_PHOTOS) {
        throw new ConvexError(`Choose 1 to ${MAX_PHOTOS} photos at a time.`);
      }
      const imageDataUrls: string[] = [];
      let totalBytes = 0;
      for (const storageId of storageIds) {
        const meta: { size: number } | null = await ctx.runQuery(internal.receipts.uploadMeta, { storageId });
        if (meta === null) throw new ConvexError("upload not found");
        if (meta.size > MAX_IMAGE_BYTES) {
          throw new ConvexError("That image is too large (6 MB max).");
        }
        totalBytes += meta.size;
        if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
          throw new ConvexError("Those photos add up to more than 12 MB — try fewer or smaller photos.");
        }
        const blob = await ctx.storage.get(storageId);
        if (blob === null) throw new ConvexError("upload not found");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const sniffed = sniffImage(bytes);
        if (sniffed.kind === "heic") {
          photoIds.push(storageId);
          throw new ConvexError(HEIC_MESSAGE);
        }
        if (sniffed.kind !== "raster") throw new ConvexError(UNSUPPORTED_MESSAGE);
        photoIds.push(storageId);
        // Sniffed type, never blob.type: the data URL label must match the bytes.
        imageDataUrls.push(`data:${sniffed.mime};base64,${bytesToBase64(bytes)}`);
      }
      const messageId: string | null = await ctx.runMutation(
        internal.receipts.beginManualReceipt,
        { userId, kind: "photo", token: crypto.randomUUID() },
      );
      if (messageId === null) throw new ConvexError("Daily limit reached — try again tomorrow.");
      const n = imageDataUrls.length;
      return await runExtraction(ctx, {
        userId,
        messageId,
        userText: `Extract every purchased/owned product from these receipt or product photos (${n} photo${n === 1 ? "" : "s"}).`,
        imageDataUrls,
      });
    } finally {
      await deleteBlobs(ctx, photoIds);
    }
  },
});

/** Hourly cron: delete storage blobs older than an hour that nothing
 * references. Receipt photos are normally deleted by the action that reads
 * them, but a client can upload and then never call it (tab closed, network
 * gone, a size guard tripped first); a pharmacy receipt must not sit in
 * storage for that. remedyPages markdown blobs are the only other storage
 * users — they are referenced within the transaction that creates them. */
export const sweepOrphanedUploads = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), scanned: v.number() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    const files = await ctx.db.system.query("_storage").order("asc").take(200);
    const referenced = new Set<string>();
    for (const page of await ctx.db.query("remedyPages").take(2000)) {
      if (page.markdownStorageId !== undefined) referenced.add(page.markdownStorageId);
    }
    let deleted = 0;
    for (const file of files) {
      if (file._creationTime > cutoff) break; // ascending: the rest are newer
      if (referenced.has(file._id)) continue;
      await ctx.storage.delete(file._id);
      deleted++;
    }
    if (deleted > 0) console.warn(`sweepOrphanedUploads: deleted ${deleted} unreferenced blob(s)`);
    return { deleted, scanned: files.length };
  },
});
