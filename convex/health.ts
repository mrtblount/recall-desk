import { v } from "convex/values";
import { query } from "./_generated/server";

/**
 * Liveness probe for the public shell. The hello-world page subscribes to this
 * so a deploy proves the frontend, the Convex deployment, and the reactive
 * client are all wired — not just that static files uploaded.
 *
 * Deliberately no wall-clock read: Convex queries are cached and are not
 * re-run because time passes, so a timestamp here would be misleading.
 */
export const ping = query({
  args: {},
  returns: v.object({ ok: v.boolean(), build: v.string() }),
  handler: async () => ({ ok: true, build: "session-0" }),
});
