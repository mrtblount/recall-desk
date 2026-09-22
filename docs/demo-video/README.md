# Demo video recorder

`record.js` drives a fresh Chromium (Playwright, video recording on) against the production site and produces the 2:45 demo: intro card, board + search, recall detail, a brand-new account signing in live (the AgentMail code is read back over the API mid-recording), a HEIC receipt upload, the seeded receipt emailed to the new alias while the desk is on screen, the remedy checklist, the claim draft, outro card. It writes `marks.json` (the second each narration segment should start) so the ten narration clips can be mixed on afterwards with ffmpeg (`adelay` per clip, `amix`, `loudnorm`).

Run: `AGENTMAIL_API_KEY=… node docs/demo-video/record.js` with `durations.json` (seconds per narration clip), `seeded.json` (subject/text/html of the seeded retailer receipt) and an `audio/` folder of `s01.wav … s10.wav` beside it. Edit the two constants at the top for the Playwright package path and the Chromium binary.

Narration (Higgsfield Seed Audio, voice "Reid"):

1. Every day, products get recalled. Almost nobody checks them against what they actually own. Recall Desk does.
2. This is the live site, on convex dot site. No account needed. Sixteen hundred federal recalls from the CPSC, the FDA, and the USDA, crawled on Convex crons and served from realtime queries.
3. Search is a Convex full-text index. Every card is a real notice, with the official link, and the manufacturer's remedy page, which Firecrawl found for us.
4. Sign-in is Convex Auth with an email code, delivered by AgentMail. Watch it arrive.
5. Here's my desk. I'll drop in a real iPhone photo of a Home Depot receipt. It's converted in the browser, read by OpenAI's vision model into items with model numbers and UPCs, and the photo is deleted the moment it's been read.
6. Or forward a receipt to the address Recall Desk gave me. AgentMail's webhook hands it to Convex, OpenAI extracts the items, and the matcher runs. No refresh. That's a Convex subscription.
7. Two of these are real recalls. A deterministic prefilter picks the candidates, one OpenAI call adjudicates, and it writes down why. It also emailed me.
8. This is the manufacturer's remedy page, rendered by Firecrawl, turned into steps, and prefilled from my receipt. Some of these portals answer plain HTTP with fifty-seven characters that say enable JavaScript. Firecrawl gets the whole form.
9. And the claim is drafted from the official notice. I review it, I approve it, it sends through AgentMail, and the manufacturer's reply threads back onto this timeline.
10. Convex runs all of it. Firecrawl feeds it. AgentMail is how it talks. OpenAI reads. Built solo in three weeks with Claude Code, with the repo and the build log public. Recall Desk. You bought it. We watch it.
