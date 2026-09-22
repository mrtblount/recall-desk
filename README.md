# Recall Desk

**Forward your receipts once.** Recall Desk watches the federal recall feeds (CPSC, FDA, USDA-FSIS) against what you actually own, tells you the day something you have is recalled, and files the claim for you.

Built solo for the [Convex All Gas Hackathon](https://www.convex.dev/hackathons/all-gas), Aug 25 – Sep 22, 2026. Every line of code in this repo was written for this hackathon, starting Aug 30, 2026.

- **Live:** https://tremendous-bullfrog-311.convex.site
- **Build log:** [hackathon.md](./hackathon.md)
- **Demo video:** _coming Sep 17_

## Stack

- [Convex](https://convex.dev) — database, reactive queries, actions, crons, workpool, static hosting (the whole backend)
- [Firecrawl](https://firecrawl.dev) — crawls the recall feeds and the manufacturers' remedy portals
- [AgentMail](https://agentmail.to) — the product's interface: receipts in, claims out, replies back
- [OpenAI](https://openai.com) — receipt extraction, remedy-procedure extraction, match adjudication, claim drafting
- [heic-to](https://github.com/hoppergee/heic-to) (LGPL-3.0) converts iPhone HEIC photos to JPEG in the browser, loaded unmodified as a separate lazy chunk
- Vite + React + TypeScript

## Run it

```bash
npm install
npx convex dev      # provisions/attaches a dev deployment and writes .env.local
npm run dev         # Vite dev server
npm run deploy      # build + deploy backend + upload static site to <deployment>.convex.site
```

Secrets live in `.env.local` (gitignored) and Convex environment variables. `.env.example` lists the names.

## Status

Live and end to end (Sep 14, 2026): a public recall board fed by CPSC, FDA and USDA-FSIS crons; email sign-in; receipts in by photo (iPhone HEIC included), pasted text, typed-in items, or forwarded email; pharmacy receipts read down to the NDC; matches against the corpus with alerts; Firecrawl-read remedy checklists; drafted claims that send on approval and thread the manufacturer's reply back. The dated build log with measurements and review findings is [hackathon.md](./hackathon.md).
