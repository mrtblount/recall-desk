import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Data-driven: the action reads feedSources and runs whatever is enabled and
// due, so adding FDA/FSIS (M4) is a registry row + a handler, not a new cron.
// interval() also fires once at deploy, which doubles as a smoke test.
crons.interval("crawl recall feeds", { hours: 2 }, internal.crawl.feeds.runDueFeeds, {});

// Budget-halted receipt extractions recover after the daily reset instead of
// silently vanishing (review finding). Terminal errors are excluded.
crons.interval(
  "retry stalled extractions",
  { hours: 6 },
  internal.email.retryStalledExtractions,
  {},
);

// Re-drive stranded matching work: unsent alerts, budget-halted
// adjudications, sweep-capped recalls.
crons.interval(
  "retry stalled matching",
  { minutes: 30 },
  internal.match.retryStalledMatching,
  {},
);

// Claims stuck by a died scheduler action recover (approved->draft after
// 10 min); ambiguous 'sending' states get a warning note, never a silent
// duplicate-send path.
crons.interval("recover stuck claims", { minutes: 15 }, internal.claims.recoverStuckClaims, {});

export default crons;
