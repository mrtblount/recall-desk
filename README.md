# Recall Desk

**Forward your receipts once.** Recall Desk watches every federal recall feed (CPSC, FDA, FSIS, NHTSA) against what you actually own, tells you the day something you have is recalled, and files the claim for you.

Built solo for the [Convex All Gas Hackathon](https://www.convex.dev/hackathons/all-gas), Aug 25 – Sep 22, 2026. Every line of code in this repo was written for this hackathon, starting Aug 30, 2026.

- **Live:** https://tremendous-bullfrog-311.convex.site
- **Build log:** [hackathon.md](./hackathon.md)
- **Demo video:** _coming Sep 17_

## Stack

- [Convex](https://convex.dev) — database, reactive queries, actions, crons, workpool, static hosting (the whole backend)
- [Firecrawl](https://firecrawl.dev) — crawls the recall feeds and the manufacturers' remedy portals
- [AgentMail](https://agentmail.to) — the product's interface: receipts in, claims out, replies back
- [OpenAI](https://openai.com) — receipt extraction, remedy-procedure extraction, match adjudication, claim drafting
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

Session 0 (Aug 30, 2026): repo initialized, Convex project provisioned, hello-world shell live on convex.site. Next: the public recall board.
