import { Workpool } from "@convex-dev/workpool";
import { components } from "./_generated/api";

/** Firecrawl scrapes: free tier allows 2 concurrent browsers, so parallelism
 * stays at 2 and retries back off far enough to ride out 429s. Scrapes are
 * idempotent, so retries are safe. */
export const crawlPool = new Workpool(components.crawlPool, {
  maxParallelism: 2,
  retryActionsByDefault: true,
  defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 2_000, base: 3 },
});

/** OpenAI calls: modest parallelism, retries safe (ledger-idempotent). */
export const llmPool = new Workpool(components.llmPool, {
  maxParallelism: 3,
  retryActionsByDefault: true,
  defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 2_000, base: 3 },
});
