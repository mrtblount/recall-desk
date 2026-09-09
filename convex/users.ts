import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { env, query } from "./_generated/server";

/**
 * The signed-in user's desk header: identity + their dedicated ingest
 * alias. The alias becomes live the moment the shared receipts inbox exists
 * (AGENTMAIL_RECEIPTS_ADDRESS env, set during the M6 key smoke test);
 * until then the UI shows it as "activating".
 */
export const myDesk = query({
  args: {},
  returns: v.union(
    v.object({
      email: v.union(v.string(), v.null()),
      userTag: v.union(v.string(), v.null()),
      ingestAddress: v.union(v.string(), v.null()),
      itemsCount: v.number(),
      matchesCount: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const user = await ctx.db.get("users", userId);
    if (user === null) return null;
    const base = env.AGENTMAIL_RECEIPTS_ADDRESS ?? null;
    const ingestAddress =
      base !== null && user.userTag !== undefined
        ? base.replace("@", `+${user.userTag}@`)
        : null;
    const items = await ctx.db
      .query("items")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .take(101);
    return {
      email: user.email ?? null,
      userTag: user.userTag ?? null,
      ingestAddress,
      itemsCount: items.length,
      matchesCount: 0, // matches land in M7
    };
  },
});
