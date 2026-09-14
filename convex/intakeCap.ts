import type { Id } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";

/** Per-user receipt intake budget, shared by every door (forwarded email,
 * pasted text, photos, typed-in items): 20 per rolling 24 h. */
export const MAX_RECEIPTS_PER_USER_PER_DAY = 20;

/**
 * True when the user has used today's intake budget. Counts ledger rows that
 * are receipts OR any manual intake attempt — a manual row that later turned
 * out not to be a receipt still cost an LLM call, so it still counts (review
 * finding: the old count only looked at the 21 OLDEST rows in the window and
 * ignored non-receipt manual rows, so junk pastes were free and unlimited).
 * The filter runs over one user's single-day index range, so it is bounded.
 */
export async function receiptCapReached(
  ctx: { db: DatabaseReader },
  userId: Id<"users">,
): Promise<boolean> {
  const dayStart = Date.now() - 24 * 60 * 60 * 1000;
  const counted = await ctx.db
    .query("emailsProcessed")
    .withIndex("by_userId", (q) => q.eq("userId", userId).gte("_creationTime", dayStart))
    .filter((q) =>
      q.or(q.eq(q.field("classification"), "receipt"), q.eq(q.field("manual"), true)),
    )
    .take(MAX_RECEIPTS_PER_USER_PER_DAY);
  return counted.length >= MAX_RECEIPTS_PER_USER_PER_DAY;
}
