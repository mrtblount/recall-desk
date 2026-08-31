<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Repo workflow (Tony's standing instruction, 2026-08-30)

- **Commit straight to `main`.** No feature branches or PRs for this repo (explicit exception to the global branch→PR rule, decided by Tony on 2026-08-30). Commit early and often with honest messages — the public commit history is the hackathon's fresh-code compliance evidence, so never squash or rewrite it.
- Session discipline: start by reading `hackathon.md`'s last entry and the milestone table in `.claude/handoff-prompt.md` (gitignored private brief); end by updating `hackathon.md` (via the `/convex-hackathon-skill` in `.claude/skills/`), committing, pushing, and running `npm run deploy` if anything user-visible changed.
- `npm run deploy` = production (convex deploy -y + static upload); `npm run deploy:dev` = hosted smoke test on the dev deployment.
- Never re-run `npx @convex-dev/static-hosting setup` (it would rewrite `convex/convex.config.ts`); exact HTTP routes (auth, webhooks) go ABOVE `registerStaticRoutes` in `convex/http.ts`.
- Docs ground truth: `docs/api-verification-2026-08-30.md` and `convex/_generated/ai/guidelines.md` before writing Convex code.
