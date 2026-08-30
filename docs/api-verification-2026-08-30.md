# Recall Desk — API & Rules Verification Note (2026-08-30)

Consolidated from eight research reports plus skeptic verdicts (where available), reconciled against what was actually observed in today's provisioning session. Public-repo document: no secrets, no addresses. Deployment names/URLs below are public and safe.

## Executive summary

1. **Hackathon rules are settled and verified**: new apps only (from Aug 25, 12 PM PT), submit on vibeapps by **Sep 22 12:00 PM PT**, public repo + `hackathon.md` + live `convex.site` URL + video under 3:00; auth is optional but scored; only Firecrawl gives credits ($20k after Luma registration); no OpenAI/Convex credits.
2. **Provisioning is done and reproducible non-interactively**: `npx convex dev --once --configure new --team tony-blount --project recall-desk --dev-deployment cloud` created dev `spotted-lobster-736`; prod is `tremendous-bullfrog-311` (`https://tremendous-bullfrog-311.convex.site`). A bare non-TTY `npx convex dev --once` would instead have created an anonymous local backend with no public URL.
3. **Routing decision: app-owned root routing** (`defineApp()` + `app.use(staticHosting)`, `registerStaticRoutes` registered last in `convex/http.ts`) — verified live: `/` and an SPA-fallback path return 200, hashed assets get `cache-control: public, max-age=31536000`. This is the only mode compatible with Convex Auth's hard-coded root `/.well-known/*` routes and keeps `/agentmail/webhook` stable.
4. **The generated `npx @convex-dev/static-hosting deploy` script is unusable from a non-interactive shell** (it spawns `convex deploy` without `-y` and crashes on the prod-confirmation prompt); the working scripts are `npx convex deploy -y && npx @convex-dev/static-hosting upload --build --prod` (prod) and `npx convex dev --once && npx @convex-dev/static-hosting upload --build` (dev). Also learned: never GET an unpublished prod path (404s are cached 4h at the edge) and version unhashed `public/` assets.
5. **Sponsor stack and auth**: Firecrawl (`@firecrawl/firecrawl-convex` 0.1.1), AgentMail (`@agentmail/convex` 0.1.0, one shared inbox, 3-inbox free cap, send path reportedly broken on convex 1.45 — smoke test day one), workpool 0.4.10 for concurrency; auth = Convex Auth v1 `@convex-dev/auth@0.0.95` with Email OTP over AgentMail REST (v2 alpha has no OTP; Clerk is the fallback). All OpenAI model names/prices are **re-verify at first use (M6)**.

---

## 1. Hackathon rules (Convex "All Gas", Aug 25 – Sep 22)

Skeptic verdict exists: every fact below was confirmed unless listed under "Contested / unverified".

### (a) Confirmed facts

- Fresh-code rule: "Only new apps started on or after August 25 at 12 PM PT will qualify." Luma restates without the time; neither page prints the year. — https://www.convex.dev/hackathons/all-gas ; https://luma.com/convex-allgas-hackathon
- Deadline Sep 22, 12:00 PM PT via the exact vibeapps link; the submit page requires a vibeapps account; judging group is access-code gated; winners Sep 25. — https://vibeapps.dev/judging/convex-all-gas-hackathon-openai/submit
- Submission checklist: public repo, `hackathon.md` at root, live app URL on `convex.site` or `chatgpt.site` openable without invite, video no longer than three minutes ("Under 3 minutes" in the criteria — keep it strictly under 3:00). — convex.dev page + embedded setup prompt
- Judging criteria (7): everyday apps not dev tools; creativity/usefulness ("Copycats ... score low"); Convex depth ("queries, mutations, live updates, auth, and components"); sponsor stack does real work ("generate, crawl, or send, not just sit in the README"); live URL, no localhost; social proof on X or LinkedIn tagging @convex @OpenAI @firecrawl @agentmail ("Engagement counts"); video demo. — convex.dev page
- Sponsors are exactly Convex, OpenAI, Firecrawl, AgentMail. Credits: "No OpenAI API credits or Convex credits are provided"; "$20k Firecrawl credits for every participant ... after you register on Luma"; Convex AI Gateway is paid-plan only (and beta). — convex.dev ; Luma ; https://docs.convex.dev/ai-gateway/overview
- Auth: "Convex Auth v1 alpha is not a requirement. Apps with no auth are still a valid submission." (Luma's "v1" is a typo; link targets Auth v2, which says "Do not use Convex Auth v2 in production projects yet", stable targeted Q3 2026, providers Password/Passkey/OAuth/Anonymous). — Luma ; https://auth-v2.previews.convex.dev/
- Hosting: Codex is required only for `chatgpt.site`; the setup prompt tells Claude Code to "Recommend and default to `convex.site`" and standalone agents "must not claim they published a `chatgpt.site` Site". — embedded setup prompt
- Skill: install by curl (not npm/marketplace) into `.claude/skills/convex-hackathon-skill/`; run `/hackathon start` then `/hackathon` after each session; `hackathon.md` Event field must be exactly `Convex All Gas Hackathon`, Frontend `Convex static hosting`; the skill redacts address-shaped text to `[redacted inbox]` (commit 2026-08-29) and only credits components registered via `app.use(` in `convex.config.ts`. — https://github.com/get-convex/convex-hackathon-skill
- Plugin: `claude plugin install convex@claude-plugins-official --scope user` then `/reload-plugins`. — https://www.convex.dev/agent-setup.md (**done today: 1.10.0 installed at user scope**)
- Eligibility: 18+; employees of Convex, OpenAI, Firecrawl, AgentMail and immediate family ineligible; OFAC/Quebec etc. excluded; teams up to four, one registers; multiple submissions allowed. — convex.dev ; Luma
- Prizes: 1st $10,000 + $5,000 Codex credits + 3 mo Firecrawl Growth + 6 mo AgentMail Startup; 2nd $5,000 + $2,500 Codex; 3rd $1,500 + $1,000 Codex. — convex.dev
- Prior art already listed: **Recourse** (`hearty-lobster-443.convex.site`) — Firecrawl maps the counterparty domain, OpenAI writes the letter, AgentMail sends from its own inbox, replies arrive by signed webhook, hourly escalation crons — i.e. the "file a claim by email" half of Recall Desk is already occupied; TableForAll ships a privacy-first demo mode. — https://vibeapps.dev/vibeapps.md ; https://vibeapps.dev/md/recourse.md
- npm versions today: `@convex-dev/static-hosting` 0.2.1, `@firecrawl/firecrawl-convex` 0.1.1, `@agentmail/convex` 0.1.0, `@convex-dev/auth` latest 0.0.95 / alpha 2.0.0-alpha.1, `convex` 1.45.0. — npm registry

#### Contested / unverified

- **Unverifiable**: whether the Aug 25 cutoff is enforced via Git history or declaration. The skill sets `Started:` to "the first meaningful commit time", so treat Git history as the evidence.
- **Refuted as "unresolved"**: who counts as a cohost — Luma's Terms name the four employers explicitly, so it is not open.
- **Skeptic-flagged, not reproduced**: a current entrant reports `@agentmail/convex` 0.1.0 on convex 1.45 fails to resolve every component `internalAction` ("Couldn't resolve agentmail.lib.listInboxes"), taking out `createInbox`/`performSend`; queries/mutations resolve. Repo last commit 2026-05-11, zero issues filed. Must smoke test on day one.
- **Skeptic-flagged**: the skill's `Components:` rule reads "List only registered `@convex-dev/*` components"; sponsor packages are not `@convex-dev/*`, so check that they appear in `hackathon.md` (add by hand if not).

### (b) Snippets worth copying

```bash
# Skill install (project-local, no npm)
mkdir -p .claude/skills/convex-hackathon-skill/references
curl -fsSL https://raw.githubusercontent.com/get-convex/convex-hackathon-skill/main/SKILL.md \
  -o .claude/skills/convex-hackathon-skill/SKILL.md
curl -fsSL https://raw.githubusercontent.com/get-convex/convex-hackathon-skill/main/references/log-format.md \
  -o .claude/skills/convex-hackathon-skill/references/log-format.md
```

```markdown
# Hackathon log
- **Project:** Recall Desk
- **Event:** Convex All Gas Hackathon
- **Live app:** https://tremendous-bullfrog-311.convex.site
- **Frontend:** Convex static hosting
- **Convex deployment:** https://tremendous-bullfrog-311.convex.cloud
```

### (c) Discrepancies vs the handoff brief

- "Live URL" is restricted to `convex.site`/`chatgpt.site` — Vercel/Netlify/custom domains do not satisfy it (an AllGasHackathon-tagged Vercel entry exists in the catalog, which shows tagging is self-service, not that the rule is relaxed).
- The social post is participation step 05 and a scored criterion, not on the formal checklist; still do it (X or LinkedIn).
- No OpenAI or Convex credits exist; Codex credits are prizes only; bring your own `OPENAI_API_KEY`.
- Auth is not required (it is scored); the skill README's "Use `private` for the Repo field" is overridden by the rules ("All GitHub repos must be public").
- The skill's log-format example uses a different Event name; the setup prompt's exact string wins.

### (d) Session-0 decisions

- **Register on Luma first** — it is step 01 and gates the $20k Firecrawl credits.
- **convex.site via `@convex-dev/static-hosting`** (done) — the prescribed cross-agent path; expected URL `https://<deployment>.convex.site`.
- **Public repo from the first commit; first meaningful commit after Aug 25 12 PM PT** — Git history is the likely evidence.
- **All three sponsor packages registered via `app.use(...)` in `convex/convex.config.ts`** — the skill only credits `app.use(` and the judges score "real work".
- **Position against Recourse**: lead with recall-feed crawling + receipt-to-recall matching; treat claim-by-email as the second act, not the pitch.
- **Ship a seeded demo path** so judges can exercise the loop without forwarding a receipt (TableForAll pattern).
- **Never put inbox addresses or env values in `hackathon.md`** — judges read it; the skill redacts anyway.

### (e) Open questions

- How the Firecrawl credits are delivered (Luma confirmation or Discord `#hackathon`).
- Exact vibeapps submission form fields (sign-in required).
- Whether the skill lists non-`@convex-dev` sponsor components automatically.

---

## 2. Convex CLI 1.45.0 — non-interactive provisioning and deploy

Skeptic verdict exists. Firsthand session results are marked **[observed]**.

### (a) Confirmed facts

- **[observed]** `npx convex dev --once --configure new --team tony-blount --project recall-desk --dev-deployment cloud` provisioned the project and cloud dev deployment `spotted-lobster-736` from a non-TTY shell. The team slug was read from other repos' `.env.local` comments; `npx convex login status` also lists teams as `Name (slug)`.
- `convex` 1.45.0 (published 2026-08-21) requires Node >= 20; the global 1.32.0 binary on this machine has stale help — always use project-local `npx convex`. — npm registry; `src/cli/*`
- `--team/--project/--dev-deployment` are hidden options valid only with `--configure`; with `--configure=new`, `--project` is the project **name** (server derives the slug); every prompt hard-crashes in non-TTY ("Cannot prompt for input in non-interactive terminals"). — `src/cli/dev.ts`, `configure.ts`, `lib/utils/prompts.ts`
- **Critical 1.35+ default**: in a non-TTY shell with no `CONVEX_DEPLOYMENT`/`CONVEX_DEPLOY_KEY`, a bare `npx convex dev --once` provisions an **anonymous local** deployment (`anonymous-<dirname>`) even when logged in, unless `--configure` is passed or `CONVEX_ALLOW_ANONYMOUS=false`; local deployments have no public URL and `npx convex deploy` refuses them. — `lib/deploymentSelection.ts` ; https://docs.convex.dev/cli/agent-mode.md ; CHANGELOG 1.35.0
- `.env.local` receives three things: `CONVEX_DEPLOYMENT=dev:<name> # team: ..., project: ...`, plus framework-prefixed `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL` (site URL from `/get_canonical_urls`); `.gitignore` gets `.env.local`; `convex.json` is user-owned and never written. — `lib/deployment.ts`, `lib/envvars.ts`, `lib/config.ts`
- `npx convex deploy` targets the project's default prod when `CONVEX_DEPLOYMENT` is set; `-y/--yes` exists but is hidden since 1.34.1 and is **required** in non-TTY (otherwise `askToConfirmPush` crashes). No deploy key needed when logged in. — `src/cli/deploy.ts`, `lib/command.ts` ; https://docs.convex.dev/cli/deploy-key-types.md
- `npx convex env set NAME 'value' [--prod]`; `--from-file`; declared env vars in `defineApp({ env })` must be set on every deployment or deploy fails (1.39.0). — 1.45.0 help ; CHANGELOG
- 1.40 removed `--local/--cloud` (use `npx convex deployment select local|dev`); 1.38 removed `disable-local-deployments`; 1.42 added `npx convex project create` and `deployment create --type prod --default`. — CHANGELOG
- `CONVEX_SITE_URL`/`CONVEX_CLOUD_URL` are system env vars inside functions and on the typed `env` export since 1.44.0; HTTP actions live on `.convex.site`. — https://docs.convex.dev/production/environment-variables.md
- `deploy --cmd` exports both the cloud URL var and the site URL var to the build env. — `lib/deploy2.ts`
- A deployment-scoped `CONVEX_DEPLOY_KEY` in `.env.local` beats `CONVEX_DEPLOYMENT` and redirects `deploy`/`env set --prod` to that deployment — do not mix the per-agent key recipe with prod deploys.
- **[observed]** `npx convex ai-files install` added `CLAUDE.md`, `AGENTS.md`, `.agents/skills` (it never auto-installs in non-TTY, so it was run explicitly).

#### Contested / unverified

- **Refuted**: "login is the one unavoidable interactive step". `npx convex login --device-name <name> --no-open` runs from a non-TTY shell, prints the verification URL + code and polls; only a new ToS opt-in could still prompt (hidden `--accept-opt-ins`).
- **Unverifiable from source**: whether a new project automatically gets a prod deployment (docs conflict). **[observed]** the project ended today with prod `tremendous-bullfrog-311` reachable by `npx convex deploy -y`; no `deployment create --type prod` step was recorded, so in practice no manual step was needed.
- Not captured: exact first-run `deploy -y` console output; region selection when the team has no default.

### (b) Snippets worth copying

```bash
# Team discovery + login state (non-interactive)
npx convex login status

# One-shot new project + cloud dev deployment (what worked today)
npx convex dev --once --configure new --team tony-blount --project recall-desk --dev-deployment cloud

# Guard against the non-TTY anonymous-local default
export CONVEX_ALLOW_ANONYMOUS=false

# Secrets
npx convex env set OPENAI_API_KEY '...'           # dev
npx convex env set OPENAI_API_KEY '...' --prod    # prod
```

```json
{
  "scripts": {
    "deploy": "npx convex deploy -y && npx @convex-dev/static-hosting upload --build --prod",
    "deploy:dev": "npx convex dev --once && npx @convex-dev/static-hosting upload --build"
  }
}
```

```env
# .env.local shape written for a Vite project
# Deployment used by `npx convex dev`
CONVEX_DEPLOYMENT=dev:spotted-lobster-736 # team: tony-blount, project: recall-desk
VITE_CONVEX_URL=https://spotted-lobster-736.convex.cloud
VITE_CONVEX_SITE_URL=https://spotted-lobster-736.convex.site
```

### (c) Discrepancies vs the handoff brief

- `-y` is real but hidden from `--help`; `.env.local` holds three vars, not two; `convex.json` is not written.
- A bare non-TTY `npx convex dev --once` does **not** create a cloud project — it goes anonymous/local.
- `--project` is a name, not a slug, under `--configure=new` (help text says `<project_slug>`).
- Login can be started headlessly (see refuted claim).

### (d) Session-0 decisions

- **Provisioning command**: `npx convex dev --once --configure new --team tony-blount --project recall-desk --dev-deployment cloud` (done; keep in the runbook). Rationale: only flag-driven `--configure` bypasses the anonymous default and every prompt.
- **`export CONVEX_ALLOW_ANONYMOUS=false` in the agent shell** — makes any later bare `dev --once` fail loudly instead of silently going local.
- **Pin `convex` ^1.45.0 and install before any `npx convex` call**; never use the global 1.32 binary.
- **Prod deploys with `npx convex deploy -y`** (no deploy key; no CI); dev pushes with `npx convex dev --once`.
- **Health query guideline applied**: no `Date.now()` in queries (determinism); pass timestamps in as args or compute in mutations/actions.

### (e) Open questions

- Whether `deployment/authorize_prod` lazily provisioned prod on first `deploy -y` or it existed at creation (moot for this project).
- Server-side slug derivation rules for project names.

---

## 3. `@convex-dev/static-hosting` 0.2.1

Skeptic verdict exists (all claims confirmed). Firsthand marked **[observed]**.

### (a) Confirmed facts

- `setup` writes `convex/convex.config.ts` only if absent, choosing **component-owned** (`defineApp({ httpPrefix: "/api" })` + `app.use(staticHosting, { httpPrefix: "/" })`) when no `convex/http.ts` exists, else **app-owned** (`defineApp()` + `app.use(staticHosting)`); it adds `"deploy": "npx @convex-dev/static-hosting deploy"` only if absent and rewrites `package.json` (2-space JSON); it never touches `http.ts`. — `src/cli/setup.ts` **[observed: setup wrote component-owned mode because `http.ts` did not exist yet; we switched to app-owned]**
- App-owned mode: `registerStaticRoutes(http, components.staticHosting, { pathPrefix?, spaFallback?, cdnBaseUrl? })` registers a **GET-only** `pathPrefix: "/"` catch-all; exact routes and longer prefixes win (router checks exact first, then longest prefix, per method); SPA fallback and caching are identical to component-owned mode (`lib.resolveAssetForHttp`, ETag/304, nosniff); cost is one extra internal query + storage fetch on uncached requests. — `src/client/index.ts` ; convex `src/server/router.ts`
- **[observed]** After switching: `/` → 200, an SPA-fallback path → 200, hashed assets `cache-control: public, max-age=31536000` (source string is `public, max-age=31536000, immutable`; HTML always `public, max-age=0, must-revalidate`).
- Component-owned mode moves every `convex/http.ts` route under `/api` (Convex Auth's `/.well-known/*` → `/api/.well-known/*`, `/api/auth/callback/*` → `/api/api/auth/callback/*`), while the root app's `CONVEX_SITE_URL` is **not** prefixed (only non-root components get a prefixed value), so Convex Auth's issuer/jwks/callback URLs would point at the static site (SPA fallback returns `index.html` for `/.well-known/openid-configuration`). — `crates/isolate/.../phase.rs` ; convex-auth `tokens.ts`, `implementation/index.ts` ; MIGRATION.md
- Upload limits: 1,800 files and 2 MiB serialized manifest per deployment; batches of 100 upload URLs; concurrency 5; refuses empty dist or dist without `/index.html`; atomic publish (`lib:stageAssets` → `lib:publishDeployment`); old files GC'd on every deploy; abandoned uploads recovered after 24h. — `src/cli/upload.ts` ; INTEGRATION.md
- Build injection: the CLI runs `convex run --component staticHosting lib:getUrls` (with `--prod` for deploy) and spawns `npm run build` with `VITE_CONVEX_URL=<cloudUrl>` and `STATIC_HOSTING_BASE_PATH`; it executes the project-local `convex` binary (must be a dependency). Frontend: `new ConvexReactClient(import.meta.env.VITE_CONVEX_URL)`. — `src/cli/deploy.ts`, `commands.ts`
- `deploy` always targets prod (`getUrls --prod`, `convex deploy`, `upload --prod`); `upload --build` without `--prod` targets the dev deployment (the documented smoke test). — `src/cli/deploy.ts`, `args.ts`
- **[observed] The generated `deploy` script fails non-interactively**: the wrapper spawns `convex deploy` without `-y`; the CLI printed "Cannot prompt for input in non-interactive terminals" at the prompt "Do you want to push your code to your prod deployment … now?". The skeptic had flagged exactly this from source. Working replacements are in section 2(b).
- **[observed] Edge-cached 404 footgun**: a GET of `/favicon.svg` on the prod `.convex.site` host **before the first publish** returned 404 with `cache-control: public, max-age=14400`, and stayed 404 after publish; `/favicon.svg?v=2` returned 200. The favicon URL is now versioned in `index.html`.
- Before the first upload `/` returns a 503 setup page with `Retry-After: 5` and `Cache-Control: no-store`; malformed percent-encoding → 400; unknown MIME → `application/octet-stream`; nested `route/index.html` directory indexes are not served (PR #19 open). — `src/component/http.ts`
- HEAD: static-hosting docs say GET only; convex router and backend ingress normalize HEAD→GET. Sources conflict; use GET for monitors.
- Issue #38 (open): `deploy` fails at upload with a project-level **preview** deploy key; prod/dev only. `UpdateBanner`/`useDeploymentUpdates` need `convex/staticHosting.ts` exporting `exposeDeploymentQuery` and convex >= 1.37.
- Never `npm run build && upload --prod` by hand: a manual build bakes the dev `VITE_CONVEX_URL` from `.env.local` (INTEGRATION.md "Wrong" example; Recourse shipped a prod site pointed at dev for hours).

### (b) Snippets worth copying

```ts
// convex/convex.config.ts  (app-owned root routing — what we run)
import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";
const app = defineApp();
app.use(staticHosting); // no httpPrefix
export default app;
```

```ts
// convex/http.ts — exact app routes first, static catch-all LAST
import { httpRouter } from "convex/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";
const http = httpRouter();
// auth.addHttpRoutes(http);           // Convex Auth well-known + /api/auth/*
// http.route({ path: "/agentmail/webhook", method: "POST", handler: ... });
registerStaticRoutes(http, components.staticHosting);
export default http;
```

```html
<!-- index.html: version unhashed public/ assets -->
<link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml" />
```

```ts
// vite.config.ts (harmless at root)
export default defineConfig({ base: process.env.STATIC_HOSTING_BASE_PATH ?? "/" });
```

### (c) Discrepancies vs the handoff brief

- Setup output depends on whether `convex/http.ts` exists — not fixed.
- App-owned mode keeps SPA fallback and caching (the handoff feared it might not).
- The one-shot `deploy` wrapper is not usable from an agent shell (prompt crash); the handoff assumed it was.
- Component-owned mode is worse than "routes move to /api" for Convex Auth because `CONVEX_SITE_URL` is not prefixed for the root app.
- No per-file cap in static-hosting; effective ceiling is Convex's 20 MiB HTTP action response limit.

### (d) Session-0 decisions

- **Routing mode: app-owned root routing** (done) — required by Convex Auth's root `/.well-known/*` and keeps `/agentmail/webhook` at root; Firecrawl's component mount (`httpPrefix: "/firecrawl/"`) is a POST route and cannot be shadowed by the GET catch-all.
- **`deploy` script = `npx convex deploy -y && npx @convex-dev/static-hosting upload --build --prod`; `deploy:dev` = `npx convex dev --once && npx @convex-dev/static-hosting upload --build`** — do not use the wrapper `deploy` command non-interactively.
- **Never probe unpublished prod paths; version every unhashed `public/` asset** (`?v=N`) — edge 404s are cached for 4 hours.
- **Only build through `deploy`/`upload --build`** so `VITE_CONVEX_URL` points at the target deployment.
- **Pure client-rendered Vite SPA** (no prerender/SSG plugins) — nested `index.html` routes are not served.
- **Uptime/health checks use GET `/`**, expecting 503 until first publish.

### (e) Open questions

- Whether HEAD works end-to-end on `.convex.site` (not tested).
- Whether the 4h edge cache on 404s also applies to 200 responses of unhashed assets (assume yes; versioning covers it).
- Fix timeline for issue #38 / PR #19.

---

## 4. Auth — Convex Auth v1 (0.0.95), v2 alpha, Clerk fallback

Skeptic verdict exists.

### (a) Confirmed facts

- `@convex-dev/auth` latest 0.0.95 (2026-08-11); `2.0.0-alpha.1` on the `alpha` tag (2026-08-24, on the public npm registry despite the "preview registry" docs wording). v1 is "beta". Install: `npm install @convex-dev/auth @auth/core@0.41.1`; peers react 18/19, convex ^1.17. — npm ; https://labs.convex.dev/auth/setup
- **0.0.95 patches GHSA-c3rg-jwq9-3233** (High, CVSS 7.4, published 2026-08-22, `< 0.0.95`): failed OTP sign-ins consumed the code, bypassing rate limiting; codes under 8 digits are brute-forceable within lifetime. Pin >= 0.0.95, use 8-digit codes and a short `maxAge`. — CHANGELOG ; GitHub advisory
- `npx @convex-dev/auth` does six things: sets `SITE_URL`, generates and sets `JWT_PRIVATE_KEY` + `JWKS`, edits `convex/tsconfig.json`, writes `auth.config.ts`, `auth.ts`, `http.ts`; requires `CONVEX_DEPLOYMENT`; flags `--web-server-url`, `--skip-git-check`, `--prod`. It does not touch `schema.ts`. — `src/cli/index.ts`
- `auth.addHttpRoutes(http)` takes only the router and hard-codes GET `/.well-known/openid-configuration` and `/.well-known/jwks.json` (plus `/api/auth/signin/*`, `/api/auth/callback/*` for OAuth); issuer, jwks_uri, authorization_endpoint and JWT `iss` are all built from unprefixed `CONVEX_SITE_URL`; Convex requires `domain === iss` exactly. Therefore **incompatible with `defineApp({ httpPrefix: "/api" })`**. — `implementation/index.ts`, `tokens.ts` ; https://docs.convex.dev/auth/advanced/custom-auth.md
- Email OTP: use `Email` from `@convex-dev/auth/providers/Email` (adds an `authorize` email-match check; default `maxAge` 1h); `sendVerificationRequest({ identifier, url, expires, provider, token, theme, request }, ctx)` is a free-form async function; `@auth/core`'s `setEnvDefaults` auto-populates `provider.apiKey` from `AUTH_<ID>_KEY` (e.g. `AUTH_AGENTMAIL_OTP_KEY` for id `agentmail-otp`). Failed attempts rate-limited 10/hour per identifier. `SITE_URL` is required even for OTP. — `src/providers/Email.ts`, `signIn.ts` ; `@auth/core` `lib/utils/env.js`
- `convex/auth.ts` exports a query and an internalMutation, so it cannot be `"use node"`; the OTP sender runs in the default V8 runtime — use raw `fetch` against AgentMail's REST API (the `agentmail` SDK drags in `ws`).
- Schema: spread `...authTables` (7 tables), redefine `users` with the seven optional defaults + custom **optional** fields, keep both `email` and `phone` indexes. In the OTP flow the user row is created at **code-send** time (`type: "email"`) and upserted again at **verification** (`type: "verification"`), so `afterUserCreatedOrUpdated` fires twice; provision per-user resources only on `"verification"`, idempotently, via `ctx.scheduler.runAfter`. — `mutations/createVerificationCode.ts`, `verifyCodeAndSignIn.ts`
- Client: `useAuthActions().signIn("agentmail-otp", formData)` twice (email, then code + hidden email); `ConvexAuthProvider` wraps `ConvexReactClient`; `getAuthUserId(ctx)` server-side. Sessions 30 days, JWT 1h. Debug with `AUTH_LOG_LEVEL=DEBUG`.
- Prod: `npx @convex-dev/auth --prod` generates a separate key pair; set `SITE_URL` to `https://tremendous-bullfrog-311.convex.site`.
- Auth v2 alpha: Components-based rewrite (`AUTH_PRIVATE_KEY`/`AUTH_JWKS`, own `convex.config.ts`, peer convex ^1.43, pulls in rate-limiter + batch-worker); documented providers Password/Passkey/OAuth/Anonymous only; the alpha's `email` component is a lookup registry, not OTP; migration guide is "WIP". The hackathon skill credits either version by the presence of `@convex-dev/auth` + `convex/auth.ts`.
- Official scaffold shortcut exists: `npm create convex@latest -- -t react-vite-convexauth` (Password provider, `...authTables`, `ConvexAuthProvider`, `predev` runs the auth CLI).
- Clerk fallback: `@clerk/react` + `ConvexProviderWithClerk` from `convex/react-clerk`, `auth.config.ts` with `domain: process.env.CLERK_JWT_ISSUER_DOMAIN`, no deployment-root routes needed.

#### Contested / unverified

- **Refuted**: "GitHub Security Advisories API returned no entry" — the repo-published advisory GHSA-c3rg-jwq9-3233 exists.
- **Unverifiable**: the `customJwt` escape hatch for prefixed routes; which convex version introduced app-level `httpPrefix`.
- Not verified: `agentmail` SDK inside Convex's V8 runtime (avoid; use `fetch`).

### (b) Snippets worth copying

```bash
npm install @convex-dev/auth @auth/core@0.41.1
npx @convex-dev/auth --web-server-url http://localhost:5173 --skip-git-check
npx @convex-dev/auth --prod   # later; then npx convex env set SITE_URL https://tremendous-bullfrog-311.convex.site --prod
```

```ts
// convex/AgentMailOTP.ts (ResendOTP pattern with the send swapped for fetch)
import { Email } from "@convex-dev/auth/providers/Email";
import { RandomReader, generateRandomString } from "@oslojs/crypto/random";

export const AgentMailOTP = Email({
  id: "agentmail-otp",
  apiKey: process.env.AUTH_AGENTMAIL_OTP_KEY,
  maxAge: 60 * 15,
  async generateVerificationToken() {
    const random: RandomReader = { read(bytes) { crypto.getRandomValues(bytes); } };
    return generateRandomString(random, "0123456789", 8);
  },
  async sendVerificationRequest({ identifier: email, provider, token }) {
    const res = await fetch(
      `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(process.env.AUTH_INBOX_ID!)}/messages/send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ to: [email], subject: "Your Recall Desk code", text: `Your code is ${token}` }),
      },
    );
    if (!res.ok) throw new Error(`AgentMail send failed: ${res.status}`);
  },
});
```

```ts
// convex/auth.ts
import { convexAuth } from "@convex-dev/auth/server";
import { AgentMailOTP } from "./AgentMailOTP";
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [AgentMailOTP],
  callbacks: {
    async afterUserCreatedOrUpdated(ctx, { userId, type }) {
      if (type === "verification") {
        await ctx.scheduler.runAfter(0, internal.users.onVerified, { userId });
      }
    },
  },
});
```

### (c) Discrepancies vs the handoff brief

- Pin `@auth/core@0.41.1` (docs pin), not bare `@auth/core`.
- Init sets deployment env vars and edits tsconfig, not just three files; it needs `CONVEX_DEPLOYMENT` first.
- Mounting under `/api` breaks auth — yes, definitively (issuer/jwks hard-coded to root).
- `sendVerificationRequest` takes one object (+ untyped `ctx`), not positional args; `Email` comes from `@convex-dev/auth/providers/Email`, not `@auth/core`.
- The user row exists before the code is verified — do not provision on `existingUserId === null`.
- v2 alpha is a real published package but unsuitable (no OTP, unstable).

### (d) Session-0 decisions

- **Auth choice: Convex Auth v1 `@convex-dev/auth@0.0.95` + `@auth/core@0.41.1`, Email OTP sent via raw `fetch` to AgentMail REST** — only documented OTP path; compatible with app-owned root routing already in place; scored under "Convex depth".
- **Sequence it after the AgentMail send smoke test** (if AgentMail REST sends fail, the OTP path is dead — fall back to Clerk or ship without auth, which is still valid).
- **8-digit numeric codes, `maxAge` 15 min, `AUTH_AGENTMAIL_OTP_KEY` env name** — security floors per the advisory; env name auto-read by `@auth/core`.
- **Do not use Auth v2 alpha** — no OTP, "APIs expected to change".
- **`SITE_URL` prod = `https://tremendous-bullfrog-311.convex.site`; run `npx @convex-dev/auth --prod` before the first judged deploy.**

### (e) Open questions

- Whether AgentMail's send endpoint accepts a bare `to` array + `text` as assumed (verify the request shape in the smoke test).
- Better Auth component as an alternative (not evaluated).

---

## 5. Firecrawl component (`@firecrawl/firecrawl-convex` 0.1.1)

No skeptic verdict; facts are single-report, source-backed.

### (a) Confirmed facts (per report)

- Package `@firecrawl/firecrawl-convex` 0.1.1 (2026-08-13), repo `github.com/firecrawl/firecrawl-convex`, peer `convex ^1.43.0`; unscoped/other names 404. — npm ; gh
- Env: `FIRECRAWL_API_KEY` (required), `FIRECRAWL_WEBHOOK_SECRET`, `FIRECRAWL_API_URL` (optional); registered with `defineApp({ env })` + `app.use(firecrawl, { httpPrefix: "/firecrawl/", env })`; `httpPrefix` is needed only for webhook-mode crawls (route `POST /firecrawl/webhook`). — README ; `src/component/convex.config.ts`
- Surface: `scrape`, `map`, `search` (one-shot component actions hitting `/v2/*`, results returned as `v.any()` and **not persisted**), `startCrawl`/`getCrawl`/`listPages`/`getPage`/`cancelCrawl`/`deleteCrawl`/`resumeCrawl` (durable; pages land in component `crawls`/`pages` tables). No `batchScrape`/`extract`. The client's `ActionCtx` needs only `runQuery/runMutation/runAction`, so `internalAction` works. — `src/client/index.ts`
- Crawled pages are budgeted to 900,000 bytes/doc and 400,000 bytes/field with `truncated: true`; overflow counted as `unstored`; ingest 10 docs per mutation. Poll mode for local dev (`mode: "poll"`); webhook watchdog 30s→300s; 250 status checks max. — `src/component/crawl.ts`
- Errors are `ConvexError { code, status, path, message }`; 408/425/429/5xx retried 3× (500 ms base, 8 s cap, honors `Retry-After`); branch on `error.data.status === 402 | 429`. No workpool/rate limiter inside the component. — `src/component/api.ts`
- Firecrawl API: `onlyMainContent` defaults true; `waitFor` ms; **`maxAge` defaults to 172,800,000 ms (2 days) — caching is on by default and cached hits still cost 1 credit**; `timeout` 60,000 default / 300,000 max; `changeTracking` requires `markdown`, bypasses cache, returns `changeStatus` new/same/changed/removed, `git-diff` mode free, `json` mode +5 credits. — https://docs.firecrawl.dev/api-reference/endpoint/scrape.md ; features/change-tracking.md
- Credits: scrape/crawl 1/page, map 1/call, search 2 per 10 results; +4/page json; charged even on 403/404; crawl pre-flight requires balance ≥ `limit` (default 10,000 → 402). Free tier: /scrape 10/min, /crawl 2/min, 2 concurrent browsers; this environment's key showed 20,991 credits and 429'd at ~14 req/min. — billing.md ; rate-limits.md ; `firecrawl --status`
- CPSC: `https://www.cpsc.gov/Recalls` is Drupal 10, 200 text/html (~282 KB); `https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=...` returns **200 application/json on GET** (HEAD returns a 503 Akamai page). — curl headers only

### (b) Snippets worth copying

```ts
// convex/convex.config.ts (add to the existing app)
import { v } from "convex/values";
import firecrawl from "@firecrawl/firecrawl-convex/convex.config";
const app = defineApp({
  env: { FIRECRAWL_API_KEY: v.string(), FIRECRAWL_WEBHOOK_SECRET: v.optional(v.string()) },
});
app.use(firecrawl, {
  httpPrefix: "/firecrawl/",
  env: { FIRECRAWL_API_KEY: app.env.FIRECRAWL_API_KEY, FIRECRAWL_WEBHOOK_SECRET: app.env.FIRECRAWL_WEBHOOK_SECRET },
});
```

```ts
// convex/recalls.ts — feed scrape with change tracking from a cron-driven internalAction
import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import { internalAction } from "./_generated/server";
import { components } from "./_generated/api";
const firecrawl = new FirecrawlClient(components.firecrawl);

export const scrapeFeed = internalAction({
  args: { url: v.string() },
  handler: async (ctx, { url }) =>
    firecrawl.scrape(ctx, url, {
      formats: ["markdown", { type: "changeTracking", modes: ["git-diff"] }],
      onlyMainContent: true,
      timeout: 60_000,
    }),
});
```

### (c) Discrepancies vs the handoff brief

- Repo/package names guessed in the brief do not exist; no batch scrape; one-shot results are not stored; markdown is a plain string field (no file storage) with truncation.
- Caching is on by default (2 days) and cached hits are not free.
- No concurrency control in the component — app-level workpool/scheduler required.
- CPSC has a working JSON API (HEAD misleads).

### (d) Session-0 decisions

- **Register Firecrawl with `httpPrefix: "/firecrawl/"` under app-owned root routing** — component mounts are relative to `/` regardless of app prefix; the webhook is POST so the GET catch-all cannot shadow it. Verify `/firecrawl/webhook` in the first deploy if crawls are used.
- **Recall-feed monitoring = one-shot `scrape` with `changeTracking` (git-diff) from an `internalAction`**, skipping OpenAI when `changeStatus === "same"`; keep `onlyMainContent`/tag settings identical across runs.
- **Set `maxAge` explicitly whenever `changeTracking` is off**; persist markdown + diff in our own tables (file storage for >~200 KB).
- **Use CPSC's JSON endpoint (GET) for the index; reserve Firecrawl for detail pages and agencies without feeds** — zero credits, still keeps Firecrawl central.
- **Space scrapes via the workpool (≤ 2–3 parallel) and catch 429/402** — Free-tier limits apply regardless of credit balance.
- **Always pass an explicit crawl `limit`.**

### (e) Open questions

- Whether omitting `httpPrefix` makes `startCrawl` fall back to poll automatically (inferred from source).
- Content of the SaferProducts JSON for recent dates (only headers captured).
- Whether `metadata.creditsUsed` appears per scrape document.

---

## 6. AgentMail component (`@agentmail/convex` 0.1.0)

No skeptic verdict; single-report, source-backed. The hackathon skeptic's independent warning (send path broken on convex 1.45) is folded in.

### (a) Confirmed facts (per report)

- Package `@agentmail/convex` 0.1.0 (only version; repo `agentmail-to/convex`, last commit 2026-05-11); deps `svix`, `@convex-dev/workpool`; peers `convex ^1.24.8`, `convex-helpers ^0.1.106` (install it). Component named `agentmail`, mounts `sendPool` + `callbackPool` (maxParallelism 8). — npm ; `src/component/convex.config.ts`
- Env: `AGENTMAIL_API_KEY`, `AGENTMAIL_WEBHOOK_SECRET` (`whsec_...`), optional `AGENTMAIL_BASE_URL` (default `https://api.agentmail.to/v0`). Constructor `new AgentMail(components.agentmail, { webhookSecret?, retryAttempts? (5), initialBackoffMs? (30000), onEvent?, onMessageReceived? })`. — README
- Inbound: no route helper — mount `http.route({ path: "/agentmail/webhook", method: "POST", handler: httpAction(async (ctx, req) => agentmail.handleWebhook(ctx, req)) })`; Svix verification (401 on failure), dedupe by `event_id`, insert `inboundMessages`, then enqueue `onMessageReceived` on `callbackPool` (runs **after** the 204). The instance that calls `handleWebhook` must carry the callback. — `src/client/index.ts`, `src/component/lib.ts`
- `onMessageReceived` args: `{ message: v.any(), thread: v.any(), eventId: v.string() }`; `message` is raw snake_case (`inbox_id`, `message_id`, `thread_id`, `from` string, `to` string[], `text?`, `html?`, `extracted_text?`, `attachments?` metadata only). Attachment bytes come from `GET /v0/inboxes/{inbox_id}/messages/{message_id}/attachments/{attachment_id}` → presigned `download_url`; no component wrapper. Payloads capped at 1 MB (text/html dropped → `getMessage`). — docs.agentmail.to
- Component validator accepts only 7 event types (`message.received/sent/delivered/bounced/complained/rejected`, `domain.verified`); subscribing to `.spam/.blocked/.unauthenticated` or `message.opened` would break the `events` insert. Pass `event_types` explicitly on webhook create.
- Outbound: `sendMessage(ctx, inboxId, { to, subject, text?, html?, ... })`, `replyToMessage(ctx, inboxId, parentMessageId, args)`, `forwardMessage`, `cancel`, `status` — durable via `sendPool` (`performSend` is an `internalAction`); statuses `pending | sent | failed | delivered | bounced | complained | rejected`; permanent HTTP errors (400/401/404/405/410/413/414/415/422) → `failed`. `cleanupFinalizedOutbound` must be scheduled by the app.
- `createInbox(ctx, { username?, domain?, displayName?, clientId? })` needs an action ctx; `clientId` is the idempotency key; returns snake_case `inbox_id`, `email`, ...; no `metadata` support; no rename endpoint.
- Plan quotas: **Free = 3 inboxes, 3,000 emails/month, no custom domain, "Sent via AgentMail" footer**; 50 recipients max; 6 MB inline attachments per request. — https://docs.agentmail.to/knowledge-base/rate-limits.md

#### Contested / unverified

- **Not reproduced**: Recourse's report that every component `internalAction` fails to resolve on convex 1.45 (`createInbox`, `listInboxes`, `performSend`), leaving `enqueueSend` queuing mail nothing can send; they kept the component for webhook ingest + `listInboundMessages` and sent via a small REST client. Also expect one type cast in the webhook handler (`runMutation` gained an options arg after 1.24).

### (b) Snippets worth copying

```ts
// convex/http.ts route (instance MUST carry the callback)
const agentmail = new AgentMail(components.agentmail, {
  onMessageReceived: internal.email.onMessageReceived,
});
http.route({
  path: "/agentmail/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => agentmail.handleWebhook(ctx, req)),
});
```

```ts
// convex/email.ts
export const onMessageReceived = internalMutation({
  args: { message: v.any(), thread: v.any(), eventId: v.string() },
  handler: async (ctx, { message }) => {
    await ctx.scheduler.runAfter(0, internal.receipts.process, {
      inboxId: message.inbox_id,
      messageId: message.message_id,
      threadId: message.thread_id,
      from: message.from,
      body: message.extracted_text ?? message.text ?? message.html ?? "",
      attachments: message.attachments ?? [],
    });
  },
});
```

```bash
npx convex env set AGENTMAIL_API_KEY '...'
npx convex env set AGENTMAIL_WEBHOOK_SECRET 'whsec_...'
# register per deployment: https://tremendous-bullfrog-311.convex.site/agentmail/webhook (prod)
#                          https://spotted-lobster-736.convex.site/agentmail/webhook (dev)
# event_types: message.received, message.sent, message.delivered, message.bounced, message.complained, message.rejected
```

### (c) Discrepancies vs the handoff brief

- Package is `@agentmail/convex`, not `@convex-dev/agentmail`.
- "Inbox per user" is impossible on Free (3 inboxes) — one shared receipts inbox, route by sender/thread.
- No route helper; `createInbox` returns snake_case; attachments are metadata only; status enum is wider than assumed; callback runs asynchronously after the webhook returns.
- The component's outbound path may not work on convex 1.45 (unverified entrant report).

### (d) Session-0 decisions

- **Day-one smoke test of `agentmail.sendMessage` end-to-end on the cloud dev deployment**, before building on it; budget for a small REST send client if the component's actions fail to resolve, keeping the component registered via `app.use` for signed webhook ingest and reactive reads.
- **One shared receipts inbox** created idempotently (`clientId`) from an `internalAction`; pick the username once (no rename); store `inbox_id` + `email` in our own table; map senders to users by parsing `from`.
- **Webhook at root `/agentmail/webhook`, one webhook + secret per deployment (dev and prod), explicit 7-type `event_types` list.**
- **Receipts as attachments**: fetch the presigned `download_url` in an action and `ctx.storage.store` the blob before OpenAI.
- **Correlate claims to threads**: store the returned `OutboundId`, expose `status()` via an app query, and match manufacturer replies by `thread_id` via `listInboundMessages({ threadId })`.
- **Daily cron for `cleanupFinalizedOutbound`.**

### (e) Open questions

- Whether `inbox_id` always equals the address (treat as opaque; store both).
- Plus-addressing support (undocumented; route by sender instead).
- Exact numeric API rate limits and webhook retry schedule.

---

## 7. Workpool 0.4.10, crons, scheduler, schema, file storage

No skeptic verdict; facts verified against the published tarball and live docs by the reporter.

### (a) Confirmed facts (per report)

- `@convex-dev/workpool` 0.4.10 (2026-08-21); peers `convex ^1.36.1`, `convex-helpers ^0.1.94`; uses `batch-worker` internally (do not register it yourself). Separate pools require separate `app.use(workpool, { name })` registrations. — npm ; `dist/component/convex.config.js`
- Options: `{ maxParallelism? (default 10, soft 100, hard 200), logLevel?, defaultRetryBehavior?, retryActionsByDefault? (false) }`; `DEFAULT_RETRY_BEHAVIOR = { maxAttempts: 5, initialBackoffMs: 250, base: 2 }`. **No `statusTtl` option exists** despite the README. — `dist/client/index.d.ts`
- `enqueueAction(ctx, fn, args, { retry?, onComplete?, context?, name?, runAt? | runAfter? })`, `enqueueActionBatch`, `enqueueMutation` (never retried by the pool). `onComplete` gets `{ workId, context, result }` with `result.kind` ∈ success/failed/canceled, in a separate transaction, always called. `pool.status(ctx, id)` (ctx required) returns `{ state: "pending" | "running" | "finished" }` — `finished` for any unknown id because work docs are deleted on completion. `NonRetryableError` skips retries. Runtime reconfig via `components.<pool>.config.update`. — `src/client/index.ts`, `src/component/shared.ts`
- Crons: `convex/crons.ts` with `cronJobs()`; `interval` (first run at deploy), `cron("m h dom mon dow")` UTC, `hourly/daily/weekly/monthly` with **optional** `minuteUTC` (omit to let Convex spread; top-of-hour discouraged, ESLint rule exists); only mutations/actions; identifiers unique ASCII; at most one run at a time, overlapping runs skipped. — https://docs.convex.dev/scheduling/cron-jobs
- Scheduler: `ctx.scheduler.runAfter(ms, fn, args)` / `runAt`, returns `Id<"_scheduled_functions">`; `cancel(id)`; mutations exactly-once, actions at-most-once (never retried); auth not propagated; results kept 7 days. Limits: 1000 scheduled per mutation; S16 (Free) = 8 concurrent scheduled jobs, 64 concurrent actions; actions 30 min (V8) / 10 min (Node). — scheduled-functions docs ; limits.md
- Data: documents ≤ 1 MiB; 16 MiB read/written per transaction; 32 indexes/table, 16 fields/index, `_creationTime` auto-appended, `by_creation_time` automatic, `by_id` reserved; search index = exactly one `searchField`, up to 16 `filterFields`, 4 per table; removed indexes are deleted on deploy. — schemas/indexes/text-search docs
- File storage: `ctx.storage.store(blob)` in actions → `Id<"_storage">`; `storage.get` actions-only; `getUrl` anywhere (bearer URLs); metadata via `ctx.db.system.get("_storage", id)`; no per-file cap; Free plan 1 GB. — file-storage docs
- Best practice: crons and scheduler target `internal.*`; always `await` scheduler calls.

### (b) Snippets worth copying

```ts
// convex/convex.config.ts additions
import workpool from "@convex-dev/workpool/convex.config.js";
app.use(workpool, { name: "crawlPool" });
app.use(workpool, { name: "llmPool" });
app.use(workpool, { name: "emailPool" });
```

```ts
const crawlPool = new Workpool(components.crawlPool, {
  maxParallelism: 2,
  retryActionsByDefault: true,
  defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 1000, base: 2 },
});
export const onScrapeDone = crawlPool.defineOnComplete<DataModel>({
  context: v.object({ feedId: v.id("feeds") }),
  handler: async (ctx, { context, result }) => {
    await ctx.db.patch(context.feedId, {
      lastRunStatus: result.kind,
      lastError: result.kind === "failed" ? result.error : undefined,
    });
  },
});
```

```ts
// convex/crons.ts
const crons = cronJobs();
crons.interval("crawl recall feeds", { hours: 2 }, internal.crawl.enqueueFeeds);
crons.daily("cleanup agentmail outbound", { hourUTC: 9 }, internal.email.cleanup);
export default crons;
```

```ts
// Large text → file storage from an action
const storageId = await ctx.storage.store(new Blob([markdown], { type: "text/markdown" }));
await ctx.runMutation(internal.recalls.saveRaw, { recallId, rawStorageId: storageId });
```

### (c) Discrepancies vs the handoff brief

- `status(ctx, id)` needs ctx; discriminant is `state`, not `kind`; `statusTtl` does not exist; `vOnCompleteValidator` is deprecated (`vOnCompleteArgs`).
- Free-plan concurrency guidance conflicts (README "20" vs limits page "8 scheduled jobs") — size pools conservatively.
- Cron `interval` fires immediately on deploy; queries cannot be cron targets; `convex-helpers` is a required peer.

### (d) Session-0 decisions

- **Three pools (`crawlPool` 2–3, `llmPool` 3–4, `emailPool` 1–2)**, total well under 20 on Free; retries on for idempotent crawl/LLM actions, `retry: false` for claim emails.
- **Own `jobs`/`crawlRuns` status rows written from `onComplete`** — the pool keeps no history.
- **Tiny cron mutations that fan out via `enqueueActionBatch`**; `interval` every 2h for feeds; omit `minuteUTC` on daily crons.
- **Inline text under ~200 KB; otherwise file storage with `rawStorageId: v.id("_storage")`.**
- **Index naming `by_<field>[_<field>]`; enums as `v.union(v.literal(...))`; `searchIndex("search_title", ...)` for recall search.**
- **No `Date.now()` in queries** (applied today per the Convex health guideline).

### (e) Open questions

- Authoritative scheduled-function arg limit (8 MB vs 4 MiB/16 MiB pages disagree).
- Interaction of the Free-plan 8-concurrent-scheduled-jobs cap with workpool's batch-worker.

---

## 8. OpenAI models, pricing, strict structured outputs — **re-verify at first use (M6)**

No skeptic verdict. **Every model name, price, and limit in this section is labeled "re-verify at first use (M6)" and must not be treated as settled**; the catalog moved fast (docs now at `developers.openai.com/api/docs/*.md`).

### (a) Reported facts — re-verify at first use (M6)

- Current line reported as GPT-5.6 Sol/Terra/Luna (`gpt-5.6-sol` = alias `gpt-5.6`, `gpt-5.6-terra`, `gpt-5.6-luna`), Standard per 1M in/out: sol $4/$20 (promo), terra $2/$12, luna $0.20/$1.20; Batch/Flex 0.5×; Fast mode 2×. — https://developers.openai.com/api/docs/pricing.md — re-verify at first use (M6)
- Legacy cheap tiers still billable: `gpt-5-nano` $0.05/$0.40 (shutdown Dec 11, 2026 → luna), `gpt-4.1-nano` $0.10/$0.40 (shutdown Oct 23, 2026), `gpt-4o-mini` $0.15/$0.60, `gpt-5-mini` $0.25/$2.00 (shutdown Dec 11 → terra). — deprecations.md — re-verify at first use (M6)
- GPT-5.6 defaults to `reasoning.effort: medium`; reasoning tokens bill as output; set `effort: "none"|"low"` for extraction. Prompt caching on by default, 1,024-token minimum, cache writes 1.25× input, reads 0.1×. — reasoning.md ; prompt-caching.md — re-verify at first use (M6)
- Tier 1 (after $5 paid): luna 500 RPM / 500K TPM; Free tier $100/mo cap with unpublished per-model limits. — rate-limits.md — re-verify at first use (M6)
- Strict structured outputs: `text.format = { type: "json_schema", name, schema, strict: true }`; only `client.responses.parse()` fills `output_parsed`; root must be an object (no root `anyOf`/discriminated union), all fields required (`.nullable()` not `.optional()`), `additionalProperties: false`, ≤ 10 nesting levels, no `allOf/if/then`; check `status === "incomplete"` and `refusal` items. `openai` npm 7.8.0 (2026-08-27), zod ^3.25 || ^4 optional peer. — structured-outputs.md ; openai-node `docs/helpers.md` — re-verify at first use (M6)
- Budget estimate for 2,000 calls × (3k in + 500 out), uncached, no reasoning tokens: luna $2.40, gpt-5-nano $0.70, gpt-4o-mini $1.50, terra $24, sol $44. — arithmetic on the pricing table — re-verify at first use (M6)

### (b) Snippet worth copying (API shape only; model id is an env var)

```ts
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

const Match = z.object({
  recallId: z.string().nullable(),
  confidence: z.number(),
  reason: z.string(),
});

const response = await openai.responses.parse({
  model: process.env.OPENAI_MODEL_CHEAP!, // re-verify at first use (M6)
  reasoning: { effort: "none" },          // re-verify at first use (M6)
  input: [{ role: "system", content: SYSTEM }, { role: "user", content: receiptText }],
  text: { format: zodTextFormat(Match, "match") },
});
if (response.status === "incomplete") throw new Error(response.incomplete_details?.reason);
const match = response.output_parsed; // null on refusal/parse failure
```

### (c) Discrepancies vs the handoff brief

- Model naming has moved on from the gpt-4o-mini / gpt-4.1 / gpt-5-mini assumptions; several are scheduled for shutdown before year end — re-verify at first use (M6).
- "Cheapest strict-output model" is ambiguous (gpt-5-nano by price vs luna as current-gen) — re-verify at first use (M6).
- GPT-5.6 adds cache-write charges and defaults to medium reasoning — cost assumptions change — re-verify at first use (M6).
- SDK is on major 7; the `zodTextFormat` + `responses.parse` snippet is still correct — re-verify at first use (M6).

### (d) Session-0 decisions

- **Model ids live in env vars (`OPENAI_MODEL_CHEAP`, `OPENAI_MODEL_STRONG`) with a cost table in Convex; no model name is hard-coded** — everything here is re-verify at first use (M6).
- **Responses API + `zodTextFormat` + `responses.parse`; log `usage` fields (`input_tokens`, `cached_tokens`, `cache_write_tokens`, `output_tokens`, `reasoning_tokens`) per call.**
- **Put $5 on the account to reach Tier 1 before M6** (Free-tier limits for current models are unpublished) — re-verify at first use (M6).
- **Stable instructions+schema prefix ≥ 1,024 tokens first, variable receipt text last; `reasoning.effort` low/none** — re-verify at first use (M6).

### (e) Open questions (all re-verify at first use (M6))

- Free-tier RPM/TPM for current models; `gpt-5-nano` supported reasoning efforts; whether sub-minimum prompts incur cache-write charges; first-call schema-compilation latency.

---

## Decisions taken today (checklist for the coding agent)

- [x] Convex project provisioned non-interactively: `npx convex dev --once --configure new --team tony-blount --project recall-desk --dev-deployment cloud` (dev `spotted-lobster-736`, prod `tremendous-bullfrog-311`, site `https://tremendous-bullfrog-311.convex.site`).
- [x] Team slug sourced from other repos' `.env.local` comments; `npx convex login status` confirmed as the non-interactive team listing.
- [x] Static hosting switched from setup's component-owned `/api` mode to **app-owned root routing**: `defineApp()` + `app.use(staticHosting)`; `convex/http.ts` calls `registerStaticRoutes(http, components.staticHosting)` **last**.
- [x] Verified on prod: `/` 200, SPA-fallback path 200, hashed assets `cache-control: public, max-age=31536000`.
- [x] Generated `"deploy": "npx @convex-dev/static-hosting deploy"` rejected (non-TTY prompt crash: "Cannot prompt for input in non-interactive terminals"); replaced with `"deploy": "npx convex deploy -y && npx @convex-dev/static-hosting upload --build --prod"` and `"deploy:dev": "npx convex dev --once && npx @convex-dev/static-hosting upload --build"`.
- [x] Favicon URL versioned (`/favicon.svg?v=1`) after an unpublished-path 404 was edge-cached (`public, max-age=14400`); rule adopted: never probe unpublished prod paths, version unhashed `public/` assets.
- [x] Convex health guideline applied: no `Date.now()` in queries.
- [x] `npx convex ai-files install` run (CLAUDE.md, AGENTS.md, `.agents/skills`); Convex Claude Code plugin `convex@claude-plugins-official` 1.10.0 installed at user scope.
- [x] OpenAI model names/prices carried as **re-verify at first use (M6)** only; model ids to live in env vars.
- [ ] Register on Luma (gates Firecrawl credits); create the vibeapps account; note the Sep 22 12:00 PM PT deadline.
- [x] Hackathon skill curled into `.claude/skills/convex-hackathon-skill/`; `hackathon.md` initialized with Event `Convex All Gas Hackathon`, Frontend `Convex static hosting`, and the live app URL above.
- [ ] `export CONVEX_ALLOW_ANONYMOUS=false` in the agent shell profile.
- [ ] Register `firecrawl` (`httpPrefix: "/firecrawl/"`), `agentmail`, and three workpools via `app.use(...)`; run `npx convex dev --once` for codegen.
- [ ] Set `FIRECRAWL_API_KEY`, `AGENTMAIL_API_KEY`, `AGENTMAIL_WEBHOOK_SECRET`, `OPENAI_API_KEY` on dev and (with `--prod`) prod.
- [ ] Day-one AgentMail smoke test: create the single shared receipts inbox (idempotent `clientId`) and send one message end-to-end on the cloud dev deployment; if component actions fail to resolve, add a REST send client and keep the component for webhook ingest.
- [ ] Register one AgentMail webhook per deployment at `/agentmail/webhook` with the explicit 7-type `event_types` list; construct the `AgentMail` instance in `http.ts` with `onMessageReceived`.
- [ ] Verify `POST /firecrawl/webhook` coexists with the static catch-all on the first deploy (only if crawls are used); default to one-shot `scrape` + `changeTracking` for feeds; use CPSC's JSON endpoint (GET) for the index.
- [ ] Auth after the sponsor loop works: `@convex-dev/auth@0.0.95` + `@auth/core@0.41.1`, Email OTP via `fetch` to AgentMail REST (`AUTH_AGENTMAIL_OTP_KEY`, 8-digit code, 15-min `maxAge`), `auth.addHttpRoutes(http)` before `registerStaticRoutes`, `npx @convex-dev/auth --prod` + prod `SITE_URL` before the judged deploy; Clerk is the fallback; Auth v2 alpha rejected.
- [ ] Position Recall Desk against "Recourse" (recall-feed crawling + receipt matching first); ship a seeded demo path; post on X/LinkedIn tagging the four sponsors early; keep the video strictly under 3:00.
