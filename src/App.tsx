import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

const REPO = "https://github.com/mrtblount/recall-desk";

export default function App() {
  const health = useQuery(api.health.ping);

  return (
    <main className="shell">
      <p className="eyebrow">Convex All Gas Hackathon · build in progress</p>
      <h1>Recall Desk</h1>
      <p className="lede">
        Forward your receipts once. Recall Desk watches every federal recall feed
        against what you actually own, tells you the day something you have is
        recalled, and files the claim for you.
      </p>

      <div className="status" role="status" aria-live="polite">
        <span className={health ? "dot dot-live" : "dot"} aria-hidden="true" />
        {health === undefined ? (
          <span>Connecting to Convex…</span>
        ) : (
          <span>
            Backend live · reactive query answered · build <code>{health.build}</code>
          </span>
        )}
      </div>

      <p className="links">
        <a href={REPO}>Source</a>
        <span aria-hidden="true"> · </span>
        <a href={`${REPO}/blob/main/hackathon.md`}>Build log</a>
      </p>
      <p className="note">Session 0 of 21. The public recall board lands next.</p>
    </main>
  );
}
