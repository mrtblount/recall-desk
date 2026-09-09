/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { routeClaimReply } from "./claims";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function setup(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "owner@four30.co", userTag: "t1" });
    const recallId = await ctx.db.insert("recalls", {
      source: "cpsc", sourceId: "1", url: "https://cpsc.gov/x", title: "T",
      description: "", brandNames: [], productDesc: "", upcs: [], hazard: "h",
      remedySummary: "", remedyOptions: [], publishedAt: 1, lastSeenAt: 1,
      contentHash: "h", status: "active",
    });
    const itemId = await ctx.db.insert("items", {
      userId, sourceMessageId: "m", product: "P", confidence: 1, status: "active",
    });
    const matchId = await ctx.db.insert("matches", {
      userId, itemId, recallId, matchScore: 0.9, prefilterScore: 20,
      matchRationale: "r", state: "claim_ready",
    });
    const claimId = await ctx.db.insert("claims", {
      matchId, userId, channel: "email", recipient: "claims@maker.example",
      draftSubject: "s", draftBody: "b", state: "draft",
    });
    return { userId, claimId, matchId };
  });
}

test("approved claims cannot be edited; markSending is single-shot", async () => {
  const t = convexTest(schema, modules);
  const { userId, claimId } = await setup(t);
  const asOwner = t.withIdentity({ subject: `${userId}|session1` });
  await asOwner.mutation(api.claims.approveClaim, { claimId });
  await expect(
    asOwner.mutation(api.claims.editClaimDraft, { claimId, draftBody: "changed" }),
  ).rejects.toThrow();
  const snap1 = await t.mutation(internal.claims.markSending, { claimId });
  expect(snap1).not.toBeNull();
  const snap2 = await t.mutation(internal.claims.markSending, { claimId });
  expect(snap2).toBeNull(); // second in-flight send aborts
});

test("spoofed thread replies never advance state; verified ones do", async () => {
  const t = convexTest(schema, modules);
  const { claimId, matchId } = await setup(t);
  await t.run(async (ctx) => {
    await ctx.db.patch("claims", claimId, { state: "sent", threadId: "th1" });
  });
  await t.run(async (ctx) => {
    await routeClaimReply(ctx, "th1", {
      from: "attacker@evil.example",
      preview: "Your claim is approved! Visit evil.example",
    });
  });
  let claim = await t.run(async (ctx) => await ctx.db.get("claims", claimId));
  expect(claim!.state).toBe("sent"); // unverified: no state change
  await t.run(async (ctx) => {
    await routeClaimReply(ctx, "th1", {
      from: "Support <claims@maker.example>",
      preview: "We received your claim.",
    });
  });
  claim = await t.run(async (ctx) => await ctx.db.get("claims", claimId));
  expect(claim!.state).toBe("replied");
  const match = await t.run(async (ctx) => await ctx.db.get("matches", matchId));
  expect(match!.state).toBe("acknowledged");
  const events = await t.run(async (ctx) => await ctx.db.query("claimEvents").collect());
  const kinds = events.map((e) => e.kind).sort();
  expect(kinds).toContain("unverified_inbound");
  expect(kinds).toContain("inbound_reply");
});
