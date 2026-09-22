import { v } from "convex/values";
import { internalAction } from "./_generated/server";

/**
 * One-off: copy the demo video into Convex file storage with an explicit
 * video/mp4 content type, so the storage URL plays inline. (The static-hosting
 * uploader has a fixed MIME list and serves .mp4 as application/octet-stream.)
 * Run: npx convex run --prod demo:storeDemoVideo '{"url":"https://…/demo.mp4"}'
 */
export const storeDemoVideo = internalAction({
  args: { url: v.string() },
  returns: v.object({ storageId: v.id("_storage"), url: v.string() }),
  handler: async (ctx, args) => {
    const res = await fetch(args.url);
    if (!res.ok) throw new Error(`fetch failed (${res.status})`);
    const blob = new Blob([await res.arrayBuffer()], { type: "video/mp4" });
    const storageId = await ctx.storage.store(blob);
    const url = await ctx.storage.getUrl(storageId);
    if (url === null) throw new Error("no url for stored video");
    return { storageId, url };
  },
});
