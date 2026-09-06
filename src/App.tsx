import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";

const REPO = "https://github.com/mrtblount/recall-desk";

const SOURCE_LABEL: Record<Doc<"recalls">["source"], string> = {
  cpsc: "CPSC",
  fda: "FDA",
  fsis: "FSIS",
  nhtsa: "NHTSA",
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** CPSC NumberOfUnits strings can carry long parentheticals ("About 22,660
 * (In addition, about 3,177 were sold in Canada)") — trim for the card label;
 * the stored value stays source-faithful. */
function unitsLabel(unitsText: string): string {
  const trimmed = unitsText.replace(/\s*\(.*$/, "").trim();
  return trimmed.length > 0 ? `${trimmed} units` : "";
}

function timeAgo(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function RecallCard({ recall }: { recall: Doc<"recalls"> }) {
  return (
    <article className="card">
      <div className="card-body">
        <p className="meta">
          <time dateTime={new Date(recall.publishedAt).toISOString()}>
            {formatDate(recall.publishedAt)}
          </time>
          <span className={`chip chip-${recall.source}`}>
            {SOURCE_LABEL[recall.source]}
          </span>
          {recall.status === "expanded" && (
            <span className="chip chip-expanded">Expanded</span>
          )}
          {recall.unitsText && unitsLabel(recall.unitsText) && (
            <span className="units">{unitsLabel(recall.unitsText)}</span>
          )}
        </p>
        <h2 className="card-title">
          <a href={recall.url} target="_blank" rel="noopener noreferrer">
            {recall.title}
          </a>
        </h2>
        {recall.hazard && <p className="hazard">{recall.hazard}</p>}
        <p className="card-foot">
          {recall.remedyOptions.map((option) => (
            <span key={option} className="remedy">
              {option}
            </span>
          ))}
          <a
            className="official"
            href={recall.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Official notice ↗
          </a>
        </p>
      </div>
      {recall.imageUrl && (
        <img
          className="thumb"
          src={recall.imageUrl}
          alt={recall.imageCaption ?? "Recalled product"}
          loading="lazy"
        />
      )}
    </article>
  );
}

export default function App() {
  const stats = useQuery(api.recalls.stats);
  const { results, status, loadMore } = usePaginatedQuery(
    api.recalls.recentRecalls,
    {},
    { initialNumItems: 20 },
  );

  return (
    <div className="page">
      <header className="masthead">
        <p className="eyebrow">Live federal recall monitor · Convex All Gas Hackathon</p>
        <h1>Recall Desk</h1>
        <p className="lede">
          Every federal product recall, watched around the clock. Soon: forward
          your receipts once and get told the day something you own is recalled
          — claim filed for you.
        </p>
      </header>

      <div className="ticker" role="status">
        <span>
          <strong>{stats ? stats.recallsTracked.toLocaleString() : "—"}</strong> recalls tracked
        </span>
        <span className="tick-sep" aria-hidden="true" />
        <span>
          corpus updated{" "}
          <strong>{stats?.lastCrawlAt ? timeAgo(stats.lastCrawlAt) : "—"}</strong>
        </span>
        <span className="tick-sep" aria-hidden="true" />
        <span>
          sources <strong>CPSC</strong> live · FDA, FSIS, NHTSA next
        </span>
      </div>

      <main className="board" aria-busy={status === "LoadingFirstPage"}>
        {status === "LoadingFirstPage" ? (
          <p className="empty">Loading the recall corpus…</p>
        ) : results.length === 0 ? (
          <p className="empty">
            Corpus is seeding — real recalls appear here the moment the first
            crawl lands.
          </p>
        ) : (
          results.map((recall) => <RecallCard key={recall._id} recall={recall} />)
        )}
        {status === "CanLoadMore" && (
          <button className="more" onClick={() => loadMore(20)}>
            Load more recalls
          </button>
        )}
        {status === "LoadingMore" && <p className="empty">Loading…</p>}
      </main>

      <footer className="foot">
        <a href={REPO}>Source</a>
        <span aria-hidden="true"> · </span>
        <a href={`${REPO}/blob/main/hackathon.md`}>Build log</a>
        <span aria-hidden="true"> · </span>
        <span>
          Data: U.S. CPSC via SaferProducts.gov — always real, never invented.
        </span>
      </footer>
    </div>
  );
}
