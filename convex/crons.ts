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

export default crons;
