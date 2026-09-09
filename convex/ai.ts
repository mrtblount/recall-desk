import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  env,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";

/**
 * HARD CONSTRAINT (#7): OpenAI spend ceiling $75 total. The guard halts LLM
 * calls at $70 total (buffer) or $5/day and logs loudly. Every call goes
 * through callStructured, which checks the budget first and records usage
 * after. Never remove or raise these caps to make a test pass.
 */
export const DAILY_BUDGET_USD = 5;
export const TOTAL_BUDGET_USD = 70;

/** USD per 1M tokens, standard tier — verified live 2026-09-09 at
 * platform.openai.com/docs/pricing. Unknown models use the strong price. */
const PRICES: Record<string, { input: number; output: number }> = {
  "gpt-5.6-luna": { input: 0.1, output: 0.6 },
  "gpt-5.6-terra": { input: 1.0, output: 6.0 },
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES[model] ?? PRICES["gpt-5.6-terra"];
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export const budgetStatus = internalQuery({
  args: {},
  returns: v.object({
    allowed: v.boolean(),
    reason: v.union(v.string(), v.null()),
    dayUsd: v.number(),
    totalUsd: v.number(),
  }),
  handler: async (ctx) => {
    const budget = await ctx.db.query("llmBudget").unique();
    const day = todayUtc();
    const dayUsd = budget !== null && budget.day === day ? budget.dayUsd : 0;
    const totalUsd = budget?.totalUsd ?? 0;
    if (totalUsd >= TOTAL_BUDGET_USD) {
      return { allowed: false, reason: `TOTAL LLM budget exhausted ($${totalUsd.toFixed(2)} >= $${TOTAL_BUDGET_USD})`, dayUsd, totalUsd };
    }
    if (dayUsd >= DAILY_BUDGET_USD) {
      return { allowed: false, reason: `daily LLM budget exhausted ($${dayUsd.toFixed(2)} >= $${DAILY_BUDGET_USD})`, dayUsd, totalUsd };
    }
    return { allowed: true, reason: null, dayUsd, totalUsd };
  },
});

export const recordUsage = internalMutation({
  args: {
    model: v.string(),
    purpose: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const usd = costUsd(args.model, args.inputTokens, args.outputTokens);
    const day = todayUtc();
    await ctx.db.insert("llmUsage", {
      day,
      model: args.model,
      purpose: args.purpose,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      costUsd: usd,
    });
    const budget = await ctx.db.query("llmBudget").unique();
    if (budget === null) {
      await ctx.db.insert("llmBudget", { day, dayUsd: usd, totalUsd: usd });
    } else {
      await ctx.db.patch("llmBudget", budget._id, {
        day,
        dayUsd: (budget.day === day ? budget.dayUsd : 0) + usd,
        totalUsd: budget.totalUsd + usd,
      });
    }
    return null;
  },
});

type StructuredCall = {
  purpose: string;
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
};

/** Error classes so callers can decide retryability. */
export class BudgetHaltError extends Error {}
export class TerminalExtractionError extends Error {}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** One OpenAI Responses API call with strict structured output.
 * - invalid JSON on a COMPLETED response: one retry (budget re-checked)
 * - truncated (incomplete) response: one retry with doubled output budget,
 *   then TerminalExtractionError (identical input would truncate forever —
 *   review finding: blind retries were 6x-billing deterministic failures)
 * - refusal: TerminalExtractionError
 * - budget guard: BudgetHaltError (recoverable after the daily reset)
 * Concurrency note: the guard is check-then-spend across <=3 parallel pool
 * actions; worst-case overshoot is ~3 small calls, which the $5 gap between
 * TOTAL_BUDGET_USD and the hard $75 ceiling absorbs many times over. */
export async function callStructured(
  ctx: { runQuery: Function; runMutation: Function },
  call: StructuredCall,
): Promise<Record<string, unknown>> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  let maxOutputTokens = call.maxOutputTokens;

  for (let attempt = 0; attempt < 2; attempt++) {
    const budget = (await ctx.runQuery(internal.ai.budgetStatus, {})) as {
      allowed: boolean;
      reason: string | null;
    };
    if (!budget.allowed) {
      console.error(`!!! LLM BUDGET GUARD HALTED CALL (${call.purpose}): ${budget.reason}`);
      throw new BudgetHaltError(`LLM budget guard: ${budget.reason}`);
    }
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: call.model,
        input: [
          { role: "system", content: call.system },
          {
            role: "user",
            content:
              attempt === 0
                ? call.user
                : `${call.user}\n\nIMPORTANT: your previous answer was not valid JSON for the schema. Return ONLY valid JSON.`,
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: call.schemaName,
            strict: true,
            schema: call.schema,
          },
        },
        max_output_tokens: maxOutputTokens,
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      if (isTransientStatus(res.status)) {
        throw new Error(`OpenAI transient ${res.status}: ${detail}`);
      }
      throw new TerminalExtractionError(`OpenAI ${res.status}: ${detail}`);
    }
    const json = (await res.json()) as {
      status?: string;
      output?: Array<{ type: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    // Record usage with conservative estimates when the field is absent —
    // booking $0 on a real charge would under-count the hard ceiling.
    await ctx.runMutation(internal.ai.recordUsage, {
      model: call.model,
      purpose: call.purpose,
      inputTokens:
        json.usage?.input_tokens ?? Math.ceil((call.system.length + call.user.length) / 4),
      outputTokens: json.usage?.output_tokens ?? maxOutputTokens,
    });
    const message = (json.output ?? []).find((o) => o.type === "message");
    const content = message?.content?.find((c) => c.type === "output_text");
    const refusal = message?.content?.find((c) => c.type === "refusal");
    if (refusal) {
      throw new TerminalExtractionError(`OpenAI refusal: ${refusal.refusal?.slice(0, 200)}`);
    }
    if (json.status === "incomplete") {
      if (attempt === 1) {
        throw new TerminalExtractionError(
          `output truncated twice at ${maxOutputTokens} tokens (${call.purpose})`,
        );
      }
      console.warn(`OpenAI incomplete for ${call.purpose}; retrying with 2x output budget`);
      maxOutputTokens = maxOutputTokens * 2;
      continue;
    }
    try {
      return JSON.parse(content?.text ?? "") as Record<string, unknown>;
    } catch {
      if (attempt === 1) {
        throw new TerminalExtractionError(`invalid JSON twice (${call.purpose})`);
      }
    }
  }
  throw new Error("unreachable");
}

const RECEIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_receipt", "retailer", "order_date", "confidence", "items"],
  properties: {
    is_receipt: { type: "boolean" },
    retailer: { type: "string", description: "Retailer name, or empty string if unknown" },
    order_date: { type: "string", description: "YYYY-MM-DD if present, else empty string" },
    confidence: { type: "number", description: "0-1 confidence this is a purchase receipt parsed correctly" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["product", "brand", "model", "upc", "category", "quantity"],
        properties: {
          product: { type: "string" },
          brand: { type: "string", description: "empty string if unknown" },
          model: { type: "string", description: "model number, empty string if unknown" },
          upc: { type: "string", description: "UPC/EAN digits only, empty string if unknown" },
          category: { type: "string", description: "short category like electronics, baby, home; empty string if unknown" },
          quantity: { type: "number" },
        },
      },
    },
  },
} as const;

/** Receipt email -> inventory items. Idempotent: skips if the ledger row
 * already has items. Runs on llmPool. */
export const extractReceipt = internalAction({
  args: {
    messageId: v.string(),
    inboxId: v.string(),
    userId: v.id("users"),
  },
  returns: v.object({ itemsCreated: v.number() }),
  handler: async (ctx, args) => {
    const already = await ctx.runQuery(internal.email.ledgerByMessageId, {
      messageId: args.messageId,
    });
    if (already === null) return { itemsCreated: 0 };
    if (already.itemIdsCreated.length > 0) return { itemsCreated: 0 };

    const apiKey = env.AGENTMAIL_API_KEY;
    if (!apiKey) throw new Error("AGENTMAIL_API_KEY is not set");
    const res = await fetch(
      `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(args.inboxId)}/messages/${encodeURIComponent(args.messageId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!res.ok) throw new Error(`AgentMail get message failed (${res.status})`);
    const msg = (await res.json()) as {
      subject?: string;
      text?: string;
      extracted_text?: string;
      html?: string;
    };
    const body =
      msg.extracted_text ??
      msg.text ??
      (msg.html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const capped = body.slice(0, 15_000);

    let result: Record<string, unknown>;
    try {
      result = await callStructured(ctx, {
      purpose: "receipt-extraction",
      model: env.OPENAI_MODEL_CHEAP ?? "gpt-5.6-luna",
      system:
        "You extract purchased items from retailer receipt/order-confirmation emails. " +
        "Only list physical products actually purchased in THIS email — never invent, never include suggestions, ads, or subscriptions. " +
        "If the email is not a purchase receipt or order confirmation, set is_receipt to false and items to an empty array. " +
        "Use empty strings for unknown fields, digits only for UPC.",
      user: `Subject: ${msg.subject ?? ""}\n\n${capped}`,
      schemaName: "receipt_extraction",
      schema: RECEIPT_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 2_000,
      });
    } catch (error) {
      if (error instanceof BudgetHaltError) {
        // Recoverable: keep classification "receipt" + note, so the stalled
        // cron re-enqueues after the daily reset. Return normally — a pool
        // retry seconds later would hit the same guard.
        await ctx.runMutation(internal.email.markLedgerError, {
          messageId: args.messageId,
          error: String(error).slice(0, 300),
          keepReceiptClassification: true,
        });
        return { itemsCreated: 0 };
      }
      if (error instanceof TerminalExtractionError) {
        // Deterministic failure: mark and stop — retries would re-bill for
        // the same outcome (review finding: 6x amplification).
        await ctx.runMutation(internal.email.markLedgerError, {
          messageId: args.messageId,
          error: String(error).slice(0, 300),
          keepReceiptClassification: false,
        });
        return { itemsCreated: 0 };
      }
      throw error; // transient — let the pool retry
    }

    const created: { itemsCreated: number } = await ctx.runMutation(
      internal.items.createFromExtraction,
      {
        messageId: args.messageId,
        userId: args.userId,
        extraction: result,
      },
    );
    return created;
  },
});
