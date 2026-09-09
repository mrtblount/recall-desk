import { v } from "convex/values";
import { env, internalAction } from "./_generated/server";

const API_BASE = "https://api.agentmail.to/v0";

/**
 * HARD CONSTRAINT (#6, hackathon brief): every outbound send checks the
 * ALLOWED_RECIPIENTS env allowlist — comma-separated exact addresses plus
 * `@domain` suffix entries — which contains only Tony-controlled addresses.
 * Only Tony widens it, by changing the env var himself. Never bypass or
 * weaken this to make a test pass.
 */
export function assertAllowedRecipient(email: string): void {
  const raw = env.ALLOWED_RECIPIENTS ?? "";
  const normalized = email.trim().toLowerCase();
  // A plus-alias of an allowed address is the same mailbox — canonicalize so
  // recalldesk+test@… matches an exact recalldesk@… entry.
  const canonical = normalized.replace(/\+[^@]*@/, "@");
  const entries: string[] = raw
    .split(",")
    .map((e: string) => e.trim().toLowerCase())
    .filter((e: string) => e.length > 0);
  const allowed = entries.some((entry: string) =>
    entry.startsWith("@")
      ? normalized.endsWith(entry)
      : normalized === entry || canonical === entry,
  );
  if (!allowed) {
    throw new Error(
      `recipient not on ALLOWED_RECIPIENTS allowlist: sends are restricted during the hackathon`,
    );
  }
}

function authHeaders(): Record<string, string> {
  const apiKey = env.AGENTMAIL_API_KEY;
  if (!apiKey) throw new Error("AGENTMAIL_API_KEY is not set");
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * Create (idempotently, via client_id) the ONE shared receipts inbox that
 * serves every user through plus-address aliases. Run once per AgentMail
 * account; both deployments then reference the same inbox via env.
 */
export const provisionSharedInbox = internalAction({
  args: { username: v.string() },
  returns: v.object({ inboxId: v.string(), email: v.string() }),
  handler: async (_ctx, args) => {
    const res = await fetch(`${API_BASE}/inboxes`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        username: args.username,
        display_name: "Recall Desk",
        client_id: "recall-desk-receipts-v1",
      }),
    });
    if (!res.ok) {
      throw new Error(`AgentMail create inbox failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { inbox_id: string; email: string };
    console.log(`provisioned inbox ${json.inbox_id}`);
    return { inboxId: json.inbox_id, email: json.email };
  },
});

/** Allowlist-guarded test send (smoke tests only). */
export const sendTest = internalAction({
  args: {
    inboxId: v.string(),
    to: v.string(),
    subject: v.string(),
    text: v.string(),
  },
  returns: v.object({ messageId: v.string(), threadId: v.string() }),
  handler: async (_ctx, args) => {
    assertAllowedRecipient(args.to);
    const res = await fetch(
      `${API_BASE}/inboxes/${encodeURIComponent(args.inboxId)}/messages/send`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ to: [args.to], subject: args.subject, text: args.text }),
      },
    );
    if (!res.ok) {
      throw new Error(`AgentMail send failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { message_id: string; thread_id: string };
    return { messageId: json.message_id, threadId: json.thread_id };
  },
});

/** Peek at recent inbox messages (metadata only) for smoke verification. */
export const peekMessages = internalAction({
  args: {
    inboxId: v.string(),
    toFilter: v.optional(v.string()),
    subjectFilter: v.optional(v.string()),
  },
  returns: v.array(
    v.object({
      from: v.string(),
      to: v.array(v.string()),
      subject: v.union(v.string(), v.null()),
      preview: v.union(v.string(), v.null()),
      timestamp: v.string(),
    }),
  ),
  handler: async (_ctx, args) => {
    const params = new URLSearchParams({ limit: "10" });
    if (args.toFilter) params.append("to", args.toFilter);
    if (args.subjectFilter) params.append("subject", args.subjectFilter);
    const res = await fetch(
      `${API_BASE}/inboxes/${encodeURIComponent(args.inboxId)}/messages?${params}`,
      { headers: authHeaders() },
    );
    if (!res.ok) {
      throw new Error(`AgentMail list failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as {
      messages?: Array<{
        from: string;
        to: string[];
        subject?: string;
        preview?: string;
        timestamp: string;
      }>;
    };
    return (json.messages ?? []).map((m) => ({
      from: m.from,
      to: m.to,
      subject: m.subject ?? null,
      preview: m.preview ?? null,
      timestamp: m.timestamp,
    }));
  },
});
