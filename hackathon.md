# Hackathon log

- **Project:** Recall Desk
- **Event:** Convex All Gas Hackathon
- **What it does:** Watches the federal recall feeds (CPSC, FDA, FSIS, NHTSA) against the retailer receipts you forward by email, alerts you the day something you own is recalled, and files the claim with the manufacturer for you.
- **Live app:** https://tremendous-bullfrog-311.convex.site
- **Repo:** https://github.com/mrtblount/recall-desk
- **Frontend:** Convex static hosting
- **Convex deployment:** https://tremendous-bullfrog-311.convex.cloud
- **Components:** @convex-dev/static-hosting, @firecrawl/firecrawl-convex, @convex-dev/workpool (crawlPool)
- **Convex features:** schema, tables, indexes, full-text search index, queries, mutations, actions, internal functions, paginated queries, realtime queries, HTTP actions, crons, scheduled functions (workpool), components, tests (convex-test)
- **Auth:** none
- **AI models:** none
- **Started:** 2026-08-30T06:30:40Z
- **Last updated:** 2026-09-07T00:30:03Z

## What this is

Recall Desk is a single-purpose everyday app: **forward your receipts once, and never miss a recall on something you own.** Two lanes share one corpus. The public lane crawls CPSC, FDA, FSIS and NHTSA recall feeds on Convex crons, tracks changes, and renders a live board anyone can open with no account — today's recalls, an "expanded" badge when a recall grows, a stats ticker. The personal lane gives each user a dedicated AgentMail ingest address; forwarded retailer receipts are parsed by OpenAI into inventory items, a matcher watches that inventory against the corpus, and a match triggers an alert, a Firecrawl scrape of the manufacturer's remedy page, extraction of the actual claim procedure, a prefilled claim draft, and — on approval — a real outbound claim email whose replies thread back onto the claim timeline. All state, scheduling and reactivity live in Convex; there is no other server or database.

- **Demo video:** not recorded yet (placeholder until the final week)
- **Stack:** Convex (database, queries, actions, crons, workpool, static hosting) · Firecrawl (recall feeds + remedy portals) · AgentMail (receipts in, claims out, replies back) · OpenAI (receipt extraction, remedy-procedure extraction, match adjudication, claim drafting) · Vite + React + TypeScript
- **Built by:** Tony Blount, solo, with Claude Code as the coding agent. Every line in this repo was written for this hackathon, starting 2026-08-30.

## How to run

```bash
git clone https://github.com/mrtblount/recall-desk && cd recall-desk
npm install
npx convex dev          # provisions/attaches a dev deployment, writes .env.local
npm run dev             # Vite dev server against that deployment
npm run deploy          # build + push backend + upload static files to <deployment>.convex.site
```

Secrets live in `.env.local` (gitignored) and in Convex environment variables (`npx convex env set`). `.env.example` lists the variable names.

## Why the sponsor stack is load-bearing

- **Firecrawl.** No crawl, no corpus and no remedy procedures. Two measurements taken while planning (2026-08-30) drove the design: (a) the Louisville Ladder remedy portal at atticstairwayrecall.expertinquiry.com returns only "You need to enable JavaScript to run this app" to plain HTTP but renders fully under Firecrawl, including the registration form's required fields; (b) the Casely recall page measures 108,913 characters raw vs 22,388 with `onlyMainContent`, a 5x strip of storefront chrome with zero loss of claim-critical fields (model E33A, JotForm claim link, photo instructions, gift card option, the recall contact inbox).
- **AgentMail.** Email is the product's interface. Ingestion is inbound mail. Claims are outbound mail. Manufacturer replies are inbound mail that advances state. Remove it and nothing enters or leaves.
- **OpenAI.** Four generation jobs: receipt-to-items extraction, remedy-page-to-procedure extraction, match adjudication, claim drafting. Remove it and nothing parses.

## Log

### 2026-08-30 - 8e52a04
Session 0 (milestone M1): repo, scaffold, Convex project, and a live URL. Shipped a public repo with MIT license and a hello-world shell that subscribes to a real Convex query (`convex/health.ts`, `src/App.tsx`), so the deploy proves the reactive stack end to end rather than just a static upload. Provisioned the Convex project non-interactively (`npx convex dev --once --configure new --team … --project recall-desk --dev-deployment cloud`), registered `@convex-dev/static-hosting` 0.2.1, and deployed to production on the first try. Convex features: queries, realtime queries (`useQuery`), HTTP actions (`convex/http.ts`), registered component (`convex/convex.config.ts`).

Decisions: (1) switched static hosting from the setup command's default component-owned mode (`httpPrefix: "/api"`) to app-owned root routing — `registerStaticRoutes` is the last call in `convex/http.ts` — because Convex validates JWTs by fetching `/.well-known/openid-configuration` at the deployment root, and Convex Auth serves that route from the app's router; prefixing it under `/api` would have broken auth in a later session and moved the AgentMail webhook URL. (2) Removed a `Date.now()` read from the health query after reading Convex's generated guidelines (queries are cached and never re-run because time passes). (3) Ran `npx convex ai-files install`, which added Convex's agent guidelines and skills to the repo; the hackathon build-log skill lives in `.claude/skills`.

Measured: production bundle 261.6 kB JS (79.9 kB gzip) + 1.4 kB CSS; `npx convex dev --once` pushes in ~1.3–1.5 s; static upload is 4 files; `/`, an SPA-fallback path, and hashed assets all return 200 on both the dev and prod `.convex.site` hosts, assets with `cache-control: public, max-age=31536000`. Broke: (1) `npm run deploy` as written by the setup command failed in this non-interactive shell — the wrapper runs `convex deploy` without `-y`, and the CLI refuses to prompt ("Cannot prompt for input in non-interactive terminals") whenever `CONVEX_DEPLOYMENT` points at a dev deployment. Fixed by splitting the script into the two documented halves, `npx convex deploy -y && npx @convex-dev/static-hosting upload --build --prod`, plus a `deploy:dev` script for hosted smoke tests. (2) A probe of `/favicon.svg` on the prod host *before* the first publish returned a 404 that the component stamps with `cache-control: public, max-age=14400`, so the edge cached the miss for four hours; the same path with a query string served 200 immediately. Lesson for demo week: never request a prod path before it is published, and version unhashed `public/` assets (`/favicon.svg?v=1`). Minor: npm 11 blocked esbuild's optional postinstall script (build unaffected); the global `convex` binary was stale (1.32) so the project pins `convex@1.45` locally.

Docs verification: before trusting any API note in the planning brief, a 13-agent research pass re-read the live docs for the hackathon rules, Convex CLI, static hosting, Convex Auth v1, the Firecrawl and AgentMail components, workpool/crons, and OpenAI structured outputs, with an adversarial second pass on the four decision-critical topics (227 claims confirmed, 2 refuted, 5 unverifiable). The consolidated note is `docs/api-verification-2026-08-30.md`. Headline corrections to the plan: the AgentMail free plan allows three inboxes total, so receipts will route through one shared inbox by sender address instead of one inbox per user; Firecrawl's `maxAge` defaults to two days and cached hits still cost credits, so change detection must set `maxAge: 0` or use `changeTracking`; CPSC exposes a JSON recall API alongside the HTML pages.

Next: M2 — schema for the recall corpus, one manual CPSC crawl seeding `recalls`, and the public board rendering from a live query.

### 2026-09-06 - e16a6a8
Session M2: the public board is real. Shipped the corpus schema (`convex/schema.ts`: feedSources, recalls with idempotency/board/search indexes, recallRevisions, remedyPages, publicStats, llmUsage), a CPSC seed pipeline (`convex/crawl/cpsc.ts` fetches the SaferProducts JSON API — response shape verified live first — maps defensively with unknown-narrowing and UTC-pinned dates, sha-256 contentHash, batches of 40), an idempotent upsert (`convex/recalls.ts`: insert / touch / archive-then-replace keyed on [source, sourceId], ticker counters maintained in the same mutation), public paginated `recentRecalls` + `stats` queries, and the live board UI (stats ticker, recall cards with real product photos, load-more, dark scheme). Production seeded with **193 real CPSC recalls**; a convex-test suite (4 tests: idempotent re-crawl, change-archives-revision, optional-field clearing, pagination order) runs green in ~0.3 s. Lane B tables (users/items/matches/claims) land with auth since they need `Id<"users">`.

Before deploying, a 33-agent adversarial review (3 find lenses → 2 skeptics per finding) confirmed 9 findings and refuted 6. The catch of the day: the content-change branch used `ctx.db.patch`, and Convex strips `undefined` args — so an optional field the source removed (a withdrawn product photo, a changed contact) could never be cleared while the stored contentHash claimed sync, permanently and silently. Fixed with archive-then-`ctx.db.replace`, plus: revision rows now archive the superseded version's full snapshot (diff source data for the change-tracking showcase), the crawl window now uses `LastPublishDateStart` after a live probe showed 15 of 46 recently republished records carry RecallDates outside a `RecallDateStart` window (one from 1998 — updates to old recalls would never re-enter), a "units units" label bug on real corpus strings, a freezing "updated N min ago" ticker (30 s tick), and a meta description that overclaimed unshipped features. The wider window alone grew the corpus 165 → 193.

Next: M3 — the Firecrawl component, the CPSC cron on `feedSources`, and recall-detail scrapes.

### 2026-09-06 - effc709
Session M3: the corpus updates itself. Registered the Firecrawl component (webhook route mounted at `/firecrawl/` — verified it coexists with the static site's GET catch-all) and a `crawlPool` workpool capped at 2 parallel scrapes to match Firecrawl's free-tier concurrency. A single cron ("crawl recall feeds", every 2 h) drives a data-driven `feedSources` registry, so FDA/FSIS in the next session are a registry row plus a handler, not new crons. Each feed run fetches the CPSC listing window, upserts idempotently, and — inside the same mutation transaction as the hash writes — enqueues a fresh (`maxAge: 0`) Firecrawl detail scrape for every changed recall. The detail scrape extracts the manufacturer's remedy-portal URL, which the JSON listing does not carry and the claim flow later depends on; extraction is a pure, unit-tested module (10 tests) that requires positive remedy evidence and returns null honestly. Verified on production: the deploy-time cron tick self-seeded the registry and ran the feed with no manual action (registry row created and `lastCrawledAt` stamped 19 ms apart), which is this milestone's done-means.

Live data QA caught the first extraction heuristic red-handed: on pre-2010 press-release pages (pulled in by the publish-date window) it returned CPSC page chrome — first AddToAny share links whose URLs embed the recall title, then the Threads profile. The fix was structural, not a longer blocklist: a minimum-evidence score, plus scrapes that always report so a null CLEARS a previously stored bogus or withdrawn link. Re-verified: three modern recalls extract their real portals (a recallrtr.com claim page, a dedicated skiphoprecall.com site, a retailer recall list); ten old press releases correctly cleared to none. A 22-agent adversarial review then confirmed four more defects before deploy: an unseeded registry that would have made every prod cron tick a silent no-op, change-triggered re-scrapes served from Firecrawl's 2-day cache (the exact rows flagged as changed), non-atomic hash-write/enqueue, and a non-converging backfill — all fixed, with `detailScrapedAt` now marking scraped rows. Measured: cron pipeline on dev ran fetched=35 → inserted=11 → 11 scrapes → 10 remedy URLs; free-tier rate limit observed at 429 with 26 req/min consumed, which is why the pool paces at 2.

Next: M4 — FDA + FSIS feeds in the registry, hash-diff revisions surfaced, and the "expanded" badge.
