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

/** USD per 1M tokens, standard tier, uncached input — re-verified live
 * 2026-09-14 at developers.openai.com/api/docs/pricing (luna $0.20/$1.20,
 * terra $2.00/$12.00). The 2026-09-09 table carried half these numbers, so
 * the ledger under-counted early spend 2x; the guard must never round down.
 * Unknown models use the strong price. */
const PRICES: Record<string, { input: number; output: number }> = {
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-5.6-terra": { input: 2.0, output: 12.0 },
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
  /** data: URLs of receipt / product photos for the upload path (1..4).
   * Several photos = one product from several sides, or one long receipt in
   * overlapping parts; the prompt tells the model to merge them. */
  imageDataUrls?: string[];
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
    const userText =
      attempt === 0
        ? call.user
        : `${call.user}\n\nIMPORTANT: your previous answer was not valid JSON for the schema. Return ONLY valid JSON.`;
    // Bounded wait: the action has a hard execution limit, and a hung fetch
    // that hits it skips every caller's `finally` (uploaded photos would
    // outlive the request). 3 minutes is far beyond any observed call.
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: AbortSignal.timeout(180_000),
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
              call.imageDataUrls !== undefined
                ? [
                    { type: "input_text", text: userText },
                    // "original": the vision guide's own OCR recommendation —
                    // receipt digits are small, and the client already capped
                    // the long edge at 2048 px, so this is ~3.7k tokens/photo.
                    ...call.imageDataUrls.map((imageUrl) => ({
                      type: "input_image",
                      image_url: imageUrl,
                      detail: "original",
                    })),
                  ]
                : userText,
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

/** Shared by the paste, photo and forwarded-email paths — one set of rules so
 * a pharmacy label reads the same whichever door it came through. The privacy
 * rule is load-bearing: pharmacy receipts print the patient's name, DOB,
 * address, phone, prescriber, plan and Rx number next to the drug facts, and
 * none of that may ever reach the items table. */
export const RECEIPT_SYSTEM_PROMPT = [
  "You extract products from evidence that someone bought or owns them. The evidence may be a store or " +
    "online receipt, an order confirmation, an order-page screenshot, a PHARMACY receipt or prescription " +
    "label, a pill bottle, an over-the-counter medicine box, product packaging or labels (front or back), " +
    "or an appliance rating plate. It arrives as pasted text, a forwarded email, or one or more photos.",
  "is_receipt means 'this content is evidence of a purchased or owned product'. Set it true for ALL of the " +
    "kinds above. Set it false, with an empty items array, only when no identifiable product was bought or " +
    "owned (a restaurant menu, a random photo, a bank statement, a newsletter).",
  "Only list physical products actually purchased or owned — never suggestions, ads, related items, " +
    "subscriptions, services, fees, taxes or gift cards.",
  "Medications: product = drug name + strength + form (e.g. 'Rosuvastatin Calcium 10 mg tablets'); " +
    "brand = the manufacturer or labeler (e.g. 'Novadoz Pharmaceuticals'); model = '' unless a product code " +
    "is printed; ndc = the NDC exactly as printed (e.g. '72205-0003-99'); lot = the lot or batch number if " +
    "printed; category = 'medication'; order_date = the fill date.",
  "HARD PRIVACY RULE: never output a patient name, date of birth, address, phone number, prescriber name, " +
    "Rx or prescription number, insurance or plan details, or payment card digits — not in any field, not " +
    "even partially. Keep only product facts.",
  "Several photos may show one product from different sides, one long receipt in overlapping parts, OR " +
    "several unrelated receipts: merge duplicates, never duplicate an item, and when the photos come from " +
    "different receipts give each item its own retailer and purchase_date (a pharmacy fill and a hardware " +
    "receipt must not share a date). Photos may be rotated or upside down — read the text in whatever " +
    "orientation it appears.",
  "Never invent. Use an empty string for anything not present. UPC is digits only. Quantity is 1 when not " +
    "stated.",
].join(" ");

/** The forwarded-email door adds one scoping rule on top of the shared prompt. */
export const RECEIPT_EMAIL_SYSTEM_PROMPT =
  RECEIPT_SYSTEM_PROMPT +
  " This content is a forwarded email: list only products purchased in THIS email, never products from " +
  "quoted earlier messages, recommendations or marketing blocks.";

export const RECEIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_receipt", "retailer", "order_date", "confidence", "items"],
  properties: {
    is_receipt: {
      type: "boolean",
      description:
        "true when the content is evidence of a purchased or owned product (receipt, order, pharmacy label, packaging, rating plate); false only when no product is identifiable",
    },
    retailer: { type: "string", description: "Retailer of the receipt (or of the first receipt when several), or empty string if unknown" },
    order_date: { type: "string", description: "Purchase/fill date of the receipt (or of the first receipt when several) as YYYY-MM-DD, else empty string" },
    confidence: { type: "number", description: "0-1 confidence the products were read correctly" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["product", "brand", "model", "upc", "ndc", "lot", "category", "quantity", "retailer", "purchase_date"],
        properties: {
          product: { type: "string", description: "product name; for medications drug name + strength + form" },
          brand: { type: "string", description: "brand, or manufacturer/labeler for medications; empty string if unknown" },
          model: { type: "string", description: "model number or product code, empty string if unknown" },
          upc: { type: "string", description: "UPC/EAN digits only, empty string if unknown" },
          ndc: { type: "string", description: "National Drug Code exactly as printed (e.g. 72205-0003-99), empty string if none" },
          lot: { type: "string", description: "lot or batch number as printed, empty string if none" },
          category: { type: "string", description: "short category like electronics, baby, home, medication; empty string if unknown" },
          quantity: { type: "number" },
          retailer: { type: "string", description: "retailer this item was bought from when it differs from the receipt-level retailer (several receipts in one upload), else empty string" },
          purchase_date: { type: "string", description: "YYYY-MM-DD purchase or fill date for THIS item when it differs from the receipt-level order_date, else empty string" },
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
      system: RECEIPT_EMAIL_SYSTEM_PROMPT,
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
