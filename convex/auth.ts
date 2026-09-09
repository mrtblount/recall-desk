import { Email } from "@convex-dev/auth/providers/Email";
import { convexAuth } from "@convex-dev/auth/server";
import { env, type MutationCtx } from "./_generated/server";
import { userTagFromSeed } from "./tags";

/**
 * Email OTP over AgentMail's REST API (email is this product's interface —
 * even sign-in goes through the sponsor stack). Until AGENTMAIL_API_KEY and
 * AGENTMAIL_OTP_INBOX_ID are set on the deployment, the code is logged
 * loudly instead so dev sign-in works end to end.
 * TODO(key): verify the exact send endpoint path against the AgentMail docs
 * during the M6 smoke test before first real send.
 */
export const recallOtp = Email({
  id: "recall-otp",
  maxAge: 60 * 15, // 15 minutes — always set explicitly (default is 24h)
  async generateVerificationToken() {
    const random = crypto.getRandomValues(new Uint32Array(1))[0];
    return String(random % 100_000_000).padStart(8, "0");
  },
  async sendVerificationRequest({ identifier: email, token }) {
    const apiKey = env.AGENTMAIL_API_KEY;
    const inboxId = env.AGENTMAIL_OTP_INBOX_ID;
    if (!apiKey || !inboxId) {
      console.warn(
        `[dev-otp] AgentMail not configured — sign-in code for this attempt: ${token}`,
      );
      return;
    }
    const res = await fetch(
      `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: [email],
          subject: `${token} is your Recall Desk sign-in code`,
          text: `Your Recall Desk sign-in code is ${token}. It expires in 15 minutes. If you didn't request it, ignore this email.`,
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`AgentMail OTP send failed (${res.status})`);
    }
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [recallOtp],
  callbacks: {
    /** Fires on code-send AND on verification (type 'email' then
     * 'verification'); the guard makes it idempotent. Stamps the immutable
     * userTag used in the ingest alias. */
    async afterUserCreatedOrUpdated(authCtx, { userId }) {
      // The callback ctx is typed against Convex Auth's own data model,
      // which doesn't know our users extension/index — cast to ours.
      const ctx = authCtx as unknown as MutationCtx;
      const user = await ctx.db.get("users", userId);
      if (user === null || user.userTag !== undefined) return;
      for (let bump = 0; bump < 10; bump++) {
        const tag = userTagFromSeed(`${userId}:${bump}`);
        const taken = await ctx.db
          .query("users")
          .withIndex("by_userTag", (q) => q.eq("userTag", tag))
          .unique();
        if (taken === null) {
          await ctx.db.patch("users", userId, { userTag: tag });
          return;
        }
      }
      throw new Error("could not allocate a unique userTag");
    },
  },
});
