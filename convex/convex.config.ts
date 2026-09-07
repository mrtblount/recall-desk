import { defineApp } from "convex/server";
import { v } from "convex/values";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import firecrawl from "@firecrawl/firecrawl-convex/convex.config";
import workpool from "@convex-dev/workpool/convex.config.js";

// App-owned root routing: static hosting is mounted without an httpPrefix and
// the static catch-all is registered LAST in convex/http.ts, so exact app
// routes (auth .well-known, webhooks) keep their canonical root paths.
// Component mounts (like /firecrawl/) are relative to / and are POST routes,
// so the GET static catch-all cannot shadow them.
const app = defineApp({
  env: {
    FIRECRAWL_API_KEY: v.string(),
    FIRECRAWL_WEBHOOK_SECRET: v.optional(v.string()),
  },
});

app.use(staticHosting);

app.use(firecrawl, {
  httpPrefix: "/firecrawl/",
  env: {
    FIRECRAWL_API_KEY: app.env.FIRECRAWL_API_KEY,
    FIRECRAWL_WEBHOOK_SECRET: app.env.FIRECRAWL_WEBHOOK_SECRET,
  },
});

// Bounded-parallelism pool for Firecrawl scrapes (free tier: 2 concurrent
// browsers, ~10 scrapes/min). llmPool and emailPool arrive with M5/M6.
app.use(workpool, { name: "crawlPool" });

export default app;
