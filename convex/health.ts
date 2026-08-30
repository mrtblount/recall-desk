import { v } from "convex/values";
import { query } from "./_generated/server";

/**
 * Liveness probe for the public shell. The hello-world page subscribes to this
 * so a deploy proves the frontend, the Convex deployment, and the reactive
 * client are all wired — not just that static files uploaded.
 */
export const ping = query({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    serverTime: v.number(),
    build: v.string(),
  }),
  handler: async () => ({
    ok: true,
    serverTime: Date.now(),
    build: "session-0",
  }),
});
