import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import heroCollage from "./assets/hero-collage.webp";
import { prefillFor } from "./lib/prefill";

const REPO = "https://github.com/mrtblount/recall-desk";

const SOURCE_LABEL: Record<Doc<"recalls">["source"], string> = {
  cpsc: "CPSC",
  fda: "FDA",
  fsis: "FSIS",
  nhtsa: "NHTSA",
};

type Recall = Doc<"recalls">;

function fmtDate(ts: number): string {
  return new Date(ts)
    .toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric", timeZone: "UTC" })
    .toUpperCase();
}

function timeAgo(ts: number, now: number): string {
  const mins = Math.max(0, Math.round((now - ts) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** First clause of the (often long) official hazard text, for the card line. */
function hazardShort(hazard: string): string {
  const first = hazard.split(/(?<=[.!?])\s/)[0] ?? hazard;
  return first.length > 110 ? `${first.slice(0, 109)}…` : first;
}

function remedyLabel(recall: Recall): string {
  return recall.remedyOptions.length > 0
    ? `${recall.remedyOptions[0]} available`
    : "See official notice";
}

function unitsLabel(unitsText: string): string {
  const trimmed = unitsText.replace(/\s*\(.*$/, "").trim();
  if (trimmed.length === 0) return "";
  return /^(about|approximately)?[\s\d.,]*\d\s*(million|billion)?$/i.test(trimmed)
    ? `${trimmed} units`
    : trimmed;
}

const Arrow = () => (
  <svg className="arrow" aria-hidden="true"><use href="#i-ne" /></svg>
);

function IconDefs() {
  return (
    <svg aria-hidden="true" style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <symbol id="i-ne" viewBox="0 0 24 24"><path d="M6 18 18 6M6 6h12v12" /></symbol>
        <symbol id="i-right" viewBox="0 0 24 24"><path d="M4 12h15m-6-6 6 6-6 6" /></symbol>
        <symbol id="i-down" viewBox="0 0 24 24"><path d="M12 4v15m-6-6 6 6 6-6" /></symbol>
        <symbol id="i-search" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.8" /><path d="m16 16 5 5" /></symbol>
        <symbol id="i-close" viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6" /></symbol>
        <symbol id="i-menu" viewBox="0 0 24 24"><path d="M5 8h14M5 16h14" /></symbol>
        <symbol id="i-alert" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" /><path d="M16 8v10m0 5v.1" strokeWidth="2.4" /></symbol>
        <symbol id="i-check" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="m7 12 3.5 3.5L17 9" /></symbol>
        <symbol id="i-receipt" viewBox="0 0 32 40"><path d="M6 2h20v36l-4-3-3 3-3-3-3 3-3-3-4 3Zm6 8h8m-8 7h8m-8 7h5" /></symbol>
        <symbol id="i-bell" viewBox="0 0 38 42"><path d="M7 28V16a12 12 0 0 1 24 0v12l3 5H4Zm8 9a4 4 0 0 0 8 0M19 1v3" /></symbol>
        <symbol id="i-send" viewBox="0 0 42 42"><path d="M3 15 38 3 26 38l-9-16Zm14 7L38 3M3 15l14 7 9 16" /></symbol>
        <symbol id="i-pause" viewBox="0 0 16 16"><path d="M5 3v10M11 3v10" /></symbol>
        <symbol id="brand-symbol" viewBox="0 0 32 42"><path d="M5 10 26 2v30L5 40Z" /><path className="fold" d="m9 31 12-4V13" /></symbol>
      </defs>
    </svg>
  );
}

const Brand = () => (
  <a className="brand" href="#top" aria-label="Recall Desk home">
    <svg className="brand-mark" aria-hidden="true"><use href="#brand-symbol" /></svg>Recall Desk.
  </a>
);

function DeskScreen({ onSampleClaim, onOpenRemedy, onOpenClaim }: { onSampleClaim: () => void; onOpenRemedy: (matchId: Id<"matches">) => void; onOpenClaim: (matchId: Id<"matches">) => void }) {
  const { signIn, signOut } = useAuthActions();
  const desk = useQuery(api.users.myDesk);
  const items = useQuery(api.items.myItems, desk ? {} : "skip");
  const dismissItem = useMutation(api.items.dismissItem);
  const matches = useQuery(api.match.myMatches, desk ? {} : "skip");
  const dismissMatch = useMutation(api.match.dismissMatch);
  const claims = useQuery(api.claims.myClaims, desk ? {} : "skip");
  const ingestPasted = useAction(api.receipts.ingestPastedReceipt);
  const ingestUploaded = useAction(api.receipts.ingestUploadedReceipt);
  const uploadUrl = useMutation(api.receipts.generateReceiptUploadUrl);
  const [paste, setPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [intakeBusy, setIntakeBusy] = useState("");
  const [intakeMsg, setIntakeMsg] = useState("");
  const [intakeErr, setIntakeErr] = useState("");

  const handleUpload = async (file: File) => {
    setIntakeErr("");
    setIntakeMsg("");
    setIntakeBusy("Reading your receipt…");
    try {
      const url = await uploadUrl({});
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      const out = await ingestUploaded({ storageId });
      setIntakeMsg(
        out.itemsCreated > 0
          ? `Added ${out.itemsCreated} item${out.itemsCreated === 1 ? "" : "s"} from your photo.`
          : "No purchased items found in that photo — try a clearer shot.",
      );
    } catch (error) {
      setIntakeErr(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setIntakeBusy("");
    }
  };
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  if (desk === undefined) {
    return <p className="dialog-muted">Loading your desk…</p>;
  }

  if (desk === null) {
    // Signed out: email -> code, both through Convex Auth.
    const sendCode = async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError("");
      setBusy(true);
      try {
        // Convex Auth does NOT normalize case — do it here, identically on
        // both steps, or Foo@x.com and foo@x.com become different accounts.
        const normalized = email.trim().toLowerCase();
        setEmail(normalized);
        await signIn("recall-otp", { email: normalized });
        setStep("code");
      } catch {
        setError("We couldn't send a code right now — email delivery may still be connecting. Check the address and try again soon.");
      } finally {
        setBusy(false);
      }
    };
    const verifyCode = async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const form = e.currentTarget;
      const code = new FormData(form).get("code");
      setError("");
      setBusy(true);
      try {
        await signIn("recall-otp", { email, code: String(code ?? "").trim() });
        // success re-renders via myDesk
      } catch {
        setError("That code didn't match (or expired). Resend a fresh one below.");
      } finally {
        setBusy(false);
      }
    };
    return (
      <>
        <h2 id="dialog-title">Your desk.<br />One sign-in away.</h2>
        {step === "email" ? (
          <form onSubmit={sendCode}>
            <p>Enter your email and we'll send an 8-digit sign-in code. No passwords.</p>
            <div className="search-row" style={{ marginTop: 14 }}>
              <div className="search-box">
                <label htmlFor="desk-email" className="sr-only">Email address</label>
                <input id="desk-email" name="email" type="email" required placeholder="you@example.com" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
            </div>
            <div className="dialog-actions">
              <button className="button button--orange" type="submit" disabled={busy}>
                {busy ? "Sending…" : "Email me a code"} <Arrow />
              </button>
            </div>
            {error && <p className="dialog-muted" role="alert">{error}</p>}
        <p className="dialog-muted">Sign-in codes are delivered by email; your address is used for sign-in and recall alerts, nothing else.</p>
          </form>
        ) : (
          <form onSubmit={verifyCode}>
            <p>We sent an 8-digit code to <strong>{email}</strong>. Enter it below.</p>
            <div className="search-row" style={{ marginTop: 14 }}>
              <div className="search-box">
                <label htmlFor="desk-code" className="sr-only">Sign-in code</label>
                <input id="desk-code" name="code" inputMode="numeric" pattern="[0-9]*" required placeholder="12345678" autoComplete="one-time-code" />
              </div>
            </div>
            <div className="dialog-actions">
              <button className="button button--orange" type="submit" disabled={busy}>
                {busy ? "Checking…" : "Sign in"} <Arrow />
              </button>
              <button
                className="button button--outline"
                type="button"
                disabled={busy}
                onClick={async () => {
                  setError("");
                  setNotice("");
                  setBusy(true);
                  try {
                    await signIn("recall-otp", { email });
                    setNotice("Code re-sent — check your inbox.");
                  } catch {
                    setError("Couldn't resend right now. Wait a moment and try again.");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Resend code
              </button>
              <button className="button button--outline" type="button" onClick={() => { setStep("email"); setError(""); setNotice(""); }}>
                Different email
              </button>
            </div>
            {notice && <p className="dialog-muted" role="status">{notice}</p>}
            {error && <p className="dialog-muted" role="alert">{error}</p>}
          </form>
        )}
      </>
    );
  }

  // Signed in: the real desk.
  return (
    <>
      <h2 id="dialog-title">One place.<br />One less thing.</h2>
      <p>Signed in as <strong>{desk.email ?? "your account"}</strong>.</p>
      <div className="detail-block">
        <span className="detail-label">Add a receipt</span>
        <div className="dialog-actions" style={{ marginTop: 4 }}>
          <label className="button button--orange" style={{ cursor: "pointer" }}>
            {intakeBusy !== "" ? intakeBusy : "Upload a photo"} <Arrow />
            <input
              type="file"
              accept="image/*"
              hidden
              disabled={intakeBusy !== ""}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void handleUpload(file);
              }}
            />
          </label>
          <button
            className="button button--outline"
            onClick={() => setShowPaste((v) => !v)}
            aria-expanded={showPaste}
          >
            {showPaste ? "Hide paste box" : "Paste receipt text"}
          </button>
        </div>
        {showPaste && (
          <>
            <textarea
              aria-label="Paste your receipt text"
              placeholder="Paste an order confirmation or receipt here…"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={6}
              maxLength={15000}
              style={{ width: "100%", marginTop: 10, font: "inherit", fontSize: 14, padding: 10, border: "1px solid var(--line)", borderRadius: 5, background: "var(--paper)", color: "inherit", resize: "vertical" }}
            />
            <div className="dialog-actions">
              <button
                className="button button--orange"
                disabled={intakeBusy !== "" || paste.trim().length < 20}
                onClick={async () => {
                  setIntakeErr("");
                  setIntakeMsg("");
                  setIntakeBusy("Reading…");
                  try {
                    const out = await ingestPasted({ text: paste });
                    setIntakeMsg(
                      out.itemsCreated > 0
                        ? `Added ${out.itemsCreated} item${out.itemsCreated === 1 ? "" : "s"}.`
                        : "No purchased items found in that text.",
                    );
                    setPaste("");
                    setShowPaste(false);
                  } catch (error) {
                    setIntakeErr(error instanceof Error ? error.message : "Couldn't read that.");
                  } finally {
                    setIntakeBusy("");
                  }
                }}
              >
                {intakeBusy !== "" ? "Reading…" : "Add these items"} <Arrow />
              </button>
            </div>
          </>
        )}
        {intakeMsg && <p className="dialog-muted" role="status">{intakeMsg}</p>}
        {intakeErr && <p className="dialog-muted" role="alert">{intakeErr}</p>}
        <p className="dialog-muted" style={{ marginTop: 8 }}>
          Prefer email? Forward receipts to{" "}
          {desk.ingestAddress ? (
            <strong>{desk.ingestAddress}</strong>
          ) : (
            <em>your address (activating)</em>
          )}{" "}
          — anything you send there lands here automatically.
        </p>
      </div>
      {matches !== undefined && matches.length > 0 && (
        <div className="detail-block">
          <span className="detail-label" style={{ color: "var(--orange)" }} aria-live="polite">
            ⚠ Recall matches · {matches.length}
          </span>
          <ul className="sample-timeline">
            {matches.map(({ match, item, recall }) => (
              <li key={match._id}>
                <span aria-hidden="true" style={{ color: "var(--orange)" }}>!</span>
                <div>
                  <strong>{item?.product ?? "(item removed)"}</strong>
                  <small>
                    {recall?.title ?? "(recall unavailable)"}
                    {recall?.status === "closed" ? " · recall now closed" : ""}
                    <br />
                    {match.prefilterReasons && match.prefilterReasons.length > 0 && (
                      <>Why: {match.prefilterReasons.join("; ")}<br /></>
                    )}
                    AI assessment ({Math.round(match.matchScore * 100)}%): {match.matchRationale}
                    {" · "}
                    {recall && (
                      <a href={recall.url} target="_blank" rel="noopener noreferrer">
                        official notice ↗
                      </a>
                    )}
                    {recall?.remedyUrl && (
                      <>
                        {" · "}
                        <button className="text-link" style={{ font: "inherit", padding: 0, border: 0, background: "none", cursor: "pointer" }} onClick={() => onOpenRemedy(match._id)}>
                          remedy checklist →
                        </button>
                      </>
                    )}
                    {" · "}
                    <button className="text-link" style={{ font: "inherit", padding: 0, border: 0, background: "none", cursor: "pointer" }} onClick={() => onOpenClaim(match._id)}>
                      {match.state === "claim_sent" || match.state === "acknowledged"
                        ? "claim timeline →"
                        : recall?.remedyUrl
                          ? "email a claim instead →"
                          : "file the claim by email →"}
                    </button>
                    {!recall?.remedyUrl && recall?.consumerContact && !/[\w.+-]+@/.test(recall.consumerContact) && (
                      <> · contact: {recall.consumerContact}</>
                    )}
                    {match.state === "notified" ? " · alerted by email" : ""}
                  </small>
                </div>
                <button
                  className="clear-search"
                  aria-label={`Dismiss match for ${item?.product ?? "this item"}`}
                  title="Dismiss"
                  onClick={() => void dismissMatch({ matchId: match._id })}
                >
                  <svg className="icon" aria-hidden="true"><use href="#i-close" /></svg>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {claims !== undefined && claims.length > 0 && (
        <div className="detail-block">
          <span className="detail-label">Your claims · {claims.length}</span>
          <ul className="sample-timeline">
            {claims.map((row) => (
              <li key={row.claim._id}>
                <span aria-hidden="true">{CLAIM_ICON[row.claim.state] ?? "•"}</span>
                <div>
                  <strong>{row.product ?? "(item removed)"}</strong>
                  <small>
                    {CLAIM_STATE_LABEL[row.claim.state] ?? row.claim.state}
                    {row.lastEventAt
                      ? ` · ${new Date(row.lastEventAt).toLocaleDateString()}`
                      : ""}
                    {" · to "}
                    {row.claim.recipient || "(no recipient)"}
                    {" · "}
                    <button
                      className="text-link"
                      style={{ font: "inherit", padding: 0, border: 0, background: "none", cursor: "pointer" }}
                      onClick={() => onOpenClaim(row.matchId)}
                    >
                      open →
                    </button>
                  </small>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="detail-block">
        <span className="detail-label">Watched items{desk.itemsCount > 100 ? " · 100+" : desk.itemsCount > 0 ? ` · ${desk.itemsCount}` : ""}</span>
        {items === undefined || items.length === 0 ? (
          <p>
            None yet — forward a retailer receipt to your address above and
            the items appear here within a minute.
          </p>
        ) : (
          <>
            <ul className="sample-timeline">
              {items.slice(0, 12).map((item) => (
                <li key={item._id}>
                  <span aria-hidden="true">▤</span>
                  <div>
                    <strong>{item.product}</strong>
                    <small>
                      {[item.brand, item.retailer, item.purchaseDate]
                        .filter(Boolean)
                        .join(" · ") || "no further details in the receipt"}
                      {item.confidence < 0.8
                        ? ` · extraction confidence ${Math.round(item.confidence * 100)}%`
                        : ""}
                    </small>
                  </div>
                  <button
                    className="clear-search"
                    aria-label={`Stop watching ${item.product}`}
                    title="Stop watching"
                    onClick={() => void dismissItem({ itemId: item._id })}
                  >
                    <svg className="icon" aria-hidden="true"><use href="#i-close" /></svg>
                  </button>
                </li>
              ))}
            </ul>
            {items.length > 12 && (
              <p className="dialog-muted">+{items.length - 12} more items on your desk.</p>
            )}
          </>
        )}
      </div>
      <div className="dialog-actions">
        <button className="button button--orange" onClick={onSampleClaim}>See a sample claim <Arrow /></button>
        <button className="button button--outline" onClick={() => { setStep("email"); setError(""); setNotice(""); void signOut(); }}>Sign out</button>
      </div>
      <p className="dialog-muted">Your items are matched against every new recall automatically — you'll be emailed the day something you own is recalled.</p>
    </>
  );
}

function RemedyScreen({ matchId, userEmail }: { matchId: Id<"matches">; userEmail: string | null }) {
  const data = useQuery(api.remedy.remedyForMatch, { matchId });
  if (data === undefined) return <p className="dialog-muted">Loading…</p>;
  if (data === null) return <p className="dialog-muted">This match isn't on your desk.</p>;
  const { item, recall, remedyPage } = data;
  const procedure = remedyPage?.extractedProcedure as
    | {
        is_remedy_page?: boolean;
        summary?: string;
        steps?: string[];
        required_fields?: Array<{ name: string; description: string }>;
        claim_url?: string;
        claim_email?: string;
        deadline?: string;
        options?: string[];
      }
    | undefined;
  const prefillSrc = {
    email: userEmail,
    product: item?.product,
    brand: item?.brand,
    model: item?.model,
    upc: item?.upc,
    purchaseDate: item?.purchaseDate,
    retailer: item?.retailer,
    quantity: item?.quantity,
  };
  const recallClosed = data.recall?.status === "closed";
  return (
    <>
      <h2 id="dialog-title">Your remedy,<br />step by step.</h2>
      {recallClosed && (
        <p className="dialog-muted">
          This recall is closed — everything below is historical reference.
          The remedy may no longer be available.
        </p>
      )}
      <div className="detail-block">
        <span className="detail-label">Your item</span>
        <p><strong>{item?.product ?? "(item removed)"}</strong></p>
      </div>
      <div className="detail-block">
        <span className="detail-label">The recall</span>
        <p>{recall?.title ?? "(unavailable)"}{recall?.status === "closed" ? " · now closed" : ""}</p>
      </div>
      {recall?.remedyUrl === undefined ? (
        <div className="detail-block">
          <span className="detail-label">No self-serve portal</span>
          <p>
            The official notice doesn't publish a self-serve remedy portal.
            {recall?.consumerContact ? ` Contact from the notice: ${recall.consumerContact}` : " Use the official notice for contact instructions."}
          </p>
        </div>
      ) : procedure === undefined ? (
        <div className="detail-block">
          <span className="detail-label">Reading the manufacturer's page…</span>
          <p>We're fetching and reading the remedy page right now — this view updates by itself, usually within a minute.</p>
        </div>
      ) : procedure.is_remedy_page !== true ? (
        <div className="detail-block">
          <span className="detail-label">Portal unreadable</span>
          <p>The linked page didn't read as a remedy portal — use the official notice below.</p>
        </div>
      ) : (
        <>
          {procedure.summary && (
            <div className="detail-block">
              <span className="detail-label">The remedy</span>
              <p>
                {procedure.summary}
                {procedure.options && procedure.options.length > 0 ? ` Options: ${procedure.options.join(", ")}.` : ""}
                {procedure.deadline ? ` Deadline: ${procedure.deadline}.` : ""}
              </p>
            </div>
          )}
          {procedure.steps && procedure.steps.length > 0 && (
            <div className="detail-block">
              <span className="detail-label">Steps</span>
              <ol className="sample-timeline">
                {procedure.steps.slice(0, 8).map((step, i) => (
                  <li key={i}><span>{String(i + 1).padStart(2, "0")}</span><div><small>{step}</small></div></li>
                ))}
              </ol>
            </div>
          )}
          {procedure.required_fields && procedure.required_fields.length > 0 && (
            <div className="detail-block">
              <span className="detail-label">What the form asks for — prefilled from your receipt</span>
              <ul className="sample-timeline">
                {procedure.required_fields.slice(0, 12).map((field, i) => {
                  const value = prefillFor(field.name, prefillSrc);
                  return (
                    <li key={i}>
                      <span aria-hidden="true">{value ? "✓" : "▢"}</span>
                      <div>
                        <strong>{field.name}</strong>
                        <small>
                          {value
                            ? `${value} — ${/e-?mail/i.test(field.name) ? "your sign-in email" : "from your receipt"}`
                            : field.description || "you provide this"}
                        </small>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
      <div className="dialog-actions">
        {procedure?.claim_url && !recallClosed ? (
          <a className="button button--orange" href={procedure.claim_url} target="_blank" rel="noopener noreferrer">
            Open the claim form <Arrow />
          </a>
        ) : recall?.remedyUrl && recall.status !== "closed" ? (
          <a className="button button--orange" href={recall.remedyUrl} target="_blank" rel="noopener noreferrer">
            Open the remedy page <Arrow />
          </a>
        ) : null}
        {recall && (
          <a className="button button--outline" href={recall.url} target="_blank" rel="noopener noreferrer">
            Official notice
          </a>
        )}
      </div>
      {procedure?.claim_email && (
        <p className="dialog-muted">Claims contact on the page: {procedure.claim_email}</p>
      )}
      <p className="dialog-muted">
        Extracted automatically by AI from the manufacturer's remedy page —
        verify each detail against the page itself before submitting anything.
      </p>
    </>
  );
}

const CLAIM_STATE_LABEL: Record<string, string> = {
  draft: "Draft — needs your approval",
  approved: "Approved, queued to send",
  sending: "Sending…",
  sent: "Sent — awaiting a reply",
  delivered: "Delivered — awaiting a reply",
  replied: "Manufacturer replied",
  completed: "Resolved",
};

const CLAIM_ICON: Record<string, string> = {
  draft: "✎", approved: "→", sending: "→", sent: "✉",
  delivered: "✉", replied: "↩", completed: "✓",
};

const EVENT_LABEL: Record<string, string> = {
  drafted: "Draft written",
  edited: "Draft edited",
  approved: "Approved by you",
  sent: "Claim sent",
  send_failed: "Send failed — back to draft",
  delivered: "Delivered to the recipient",
  bounced: "Bounced — check the recipient address",
  inbound_reply: "Reply received",
  unverified_inbound: "⚠ Unverified message on this thread (sender doesn't match the recipient)",
  completed: "Marked resolved by you",
  note: "Note",
};

function ClaimScreen({ matchId }: { matchId: Id<"matches"> }) {
  const data = useQuery(api.claims.claimForMatch, { matchId });
  const remedy = useQuery(api.remedy.remedyForMatch, { matchId });
  const draftClaim = useAction(api.claims.draftClaim);
  const editDraft = useMutation(api.claims.editClaimDraft);
  const approve = useMutation(api.claims.approveClaim);
  const markCompleted = useMutation(api.claims.markClaimCompleted);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recipient, setRecipient] = useState<string | null>(null);
  const [subject, setSubject] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);

  if (data === undefined) return <p className="dialog-muted">Loading…</p>;
  const portalUrl = remedy?.recall?.remedyUrl ?? null;

  if (data === null) {
    return (
      <>
        <h2 id="dialog-title">Your claim,<br />ready to review.</h2>
        {portalUrl && (
          <p className="dialog-muted">
            This recall has a self-serve portal — the remedy checklist is
            usually the faster route. Email is the fallback when a form isn't
            an option.
          </p>
        )}
        <p>
          We'll draft the claim email from your receipt, the official recall
          notice's own instructions, and the manufacturer's remedy page —
          carrying out the stated steps, not just asking about them. Nothing
          is sent until you approve it.
        </p>
        <div className="dialog-actions">
          <button
            className="button button--orange"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await draftClaim({ matchId });
              } catch {
                setError("Couldn't draft right now — try again in a moment.");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Drafting…" : "Draft my claim"} <Arrow />
          </button>
        </div>
        {error && <p className="dialog-muted" role="alert">{error}</p>}
      </>
    );
  }

  const { claim, events } = data;
  const editable = claim.state === "draft";
  const recipientValue = recipient ?? claim.recipient;
  const subjectValue = subject ?? claim.draftSubject;
  const bodyValue = body ?? claim.draftBody;
  const dirty =
    recipientValue !== claim.recipient ||
    subjectValue !== claim.draftSubject ||
    bodyValue !== claim.draftBody;

  return (
    <>
      <h2 id="dialog-title">{editable ? <>Review it.<br />Then send it.</> : <>Your claim<br />timeline.</>}</h2>
      {editable ? (
        <>
          <div className="detail-block">
            <span className="detail-label">To</span>
            <div className="search-row"><div className="search-box">
              <label htmlFor="claim-to" className="sr-only">Recipient</label>
              <input id="claim-to" type="email" placeholder="claims contact email" value={recipientValue} onChange={(e) => setRecipient(e.target.value)} />
            </div></div>
          </div>
          <div className="detail-block">
            <span className="detail-label">Subject</span>
            <div className="search-row"><div className="search-box">
              <label htmlFor="claim-subject" className="sr-only">Subject</label>
              <input id="claim-subject" maxLength={200} value={subjectValue} onChange={(e) => setSubject(e.target.value)} />
            </div></div>
          </div>
          <div className="detail-block">
            <span className="detail-label">Message — drafted by AI from your data; edit anything ({bodyValue.length}/4000)</span>
            <textarea
              aria-label="Claim email body"
              value={bodyValue}
              onChange={(e) => setBody(e.target.value)}
              maxLength={4000}
              rows={10}
              style={{ width: "100%", font: "inherit", fontSize: 14, padding: 10, border: "1px solid var(--line)", borderRadius: 5, background: "var(--card, #fff)", color: "inherit", resize: "vertical" }}
            />
          </div>
          <div className="dialog-actions">
            <button
              className="button button--orange"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  if (dirty) {
                    await editDraft({ claimId: claim._id, recipient: recipientValue, draftSubject: subjectValue, draftBody: bodyValue });
                  }
                  await approve({ claimId: claim._id });
                } catch {
                  setError("Couldn't send — check the recipient address and try again.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Sending…" : "Approve & send"} <Arrow />
            </button>
            {dirty && (
              <button
                className="button button--outline"
                disabled={busy}
                onClick={() => void editDraft({ claimId: claim._id, recipient: recipientValue, draftSubject: subjectValue, draftBody: bodyValue })}
              >
                Save draft
              </button>
            )}
          </div>
          {error && <p className="dialog-muted" role="alert">{error}</p>}
          <p className="dialog-muted">
            Nothing sends without your approval. During the hackathon, sends
            are restricted to owner-controlled addresses.
          </p>
        </>
      ) : (
        <>
          {(claim.state === "approved" || claim.state === "sending") && (
            <p className="dialog-muted" role="status">
              {claim.state === "approved" ? "Queued to send…" : "Sending…"}
            </p>
          )}
          <div className="detail-block">
            <span className="detail-label">To</span>
            <p>{claim.recipient}</p>
          </div>
          <div className="detail-block">
            <span className="detail-label">Subject</span>
            <p>{claim.draftSubject}</p>
          </div>
          {claim.state === "replied" && (
            <div className="dialog-actions">
              <button
                className="button button--outline"
                onClick={() => void markCompleted({ claimId: claim._id })}
              >
                Mark resolved
              </button>
            </div>
          )}
        </>
      )}
      {events.length > 0 && (
        <div className="detail-block">
          <span className="detail-label">Timeline</span>
          <ul className="sample-timeline" aria-live="polite">
            {events.map((event) => (
              <li key={event._id}>
                <span aria-hidden="true">{event.kind === "inbound_reply" ? "↩" : "✓"}</span>
                <div>
                  <strong>{EVENT_LABEL[event.kind] ?? event.kind}</strong>
                  <small>
                    {new Date(event._creationTime).toLocaleString()}
                    {event.kind === "inbound_reply" && (event.payload as { preview?: string } | undefined)?.preview
                      ? ` — "${String((event.payload as { preview?: string }).preview).slice(0, 140)}"`
                      : ""}
                    {event.kind === "send_failed" && (event.payload as { error?: string } | undefined)?.error
                      ? ` — ${String((event.payload as { error?: string }).error).slice(0, 120)}`
                      : ""}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

type Screen =
  | { kind: "welcome" } | { kind: "desk" } | { kind: "claim" } | { kind: "approve" }
  | { kind: "about" } | { kind: "privacy" } | { kind: "sources" }
  | { kind: "recall"; recall: Recall }
  | { kind: "remedy"; matchId: Id<"matches"> }
  | { kind: "claimReal"; matchId: Id<"matches"> };

function RecallCard({ recall, onShow }: { recall: Recall; onShow: () => void }) {
  return (
    <article className="recall-card">
      <button className="product-frame" onClick={onShow} aria-label={`View recall details for ${recall.title}`}>
        {recall.imageUrl ? (
          <>
            <img src={recall.imageUrl} alt={recall.imageCaption ?? "Recalled product"} width={500} height={360} decoding="async" loading="lazy" />
            <span className="photo-label">OFFICIAL {SOURCE_LABEL[recall.source]} PHOTO</span>
          </>
        ) : (
          <span className="product-frame--empty">No photo in notice</span>
        )}
      </button>
      <p className="product-meta">
        {SOURCE_LABEL[recall.source]} · <time dateTime={new Date(recall.publishedAt).toISOString()}>{fmtDate(recall.publishedAt)}</time>
        {recall.status === "expanded" && <span className="flag-expanded"> · EXPANDED</span>}
        {recall.status === "closed" && <span className="flag-closed"> · CLOSED</span>}
      </p>
      <h3 className="product-title"><button onClick={onShow}>{recall.title}</button></h3>
      <p className="product-hazard">{hazardShort(recall.hazard)}</p>
      <button className="product-bottom" onClick={onShow} aria-label={`${remedyLabel(recall)}: view ${recall.title} recall`}>
        <span>{remedyLabel(recall)}</span>
        <svg className="icon" aria-hidden="true"><use href="#i-right" /></svg>
      </button>
    </article>
  );
}

function RecallDetail({ recall, onWelcome }: { recall: Recall; onWelcome: () => void }) {
  const units = recall.unitsText ? unitsLabel(recall.unitsText) : "";
  const closed = recall.status === "closed";
  return (
    <>
      <h2 id="dialog-title">{closed ? "This recall is closed." : "Know what to do next."}</h2>
      {closed && (
        <p className="dialog-muted">
          Listed for historical reference — the remedy below may no longer be
          available. Check the official source for current status.
        </p>
      )}
      <div className="dialog-product">
        {recall.imageUrl && <img src={recall.imageUrl} alt={recall.imageCaption ?? "Recalled product"} />}
        <div>
          <p className="product-meta">{remedyLabel(recall)}</p>
          <h3>{recall.title}</h3>
          <p className="product-hazard">{hazardShort(recall.hazard)}</p>
        </div>
      </div>
      {recall.productDesc && (
        <div className="detail-block">
          <span className="detail-label">The affected product</span>
          <p>{recall.productDesc}{units ? ` · ${units}` : ""}</p>
        </div>
      )}
      <div className="detail-block">
        <span className="detail-label">What happened</span>
        <p>{recall.description || recall.hazard}</p>
      </div>
      {recall.remedySummary && (
        <div className="detail-block">
          <span className="detail-label">{closed ? "What the notice said to do" : "What to do"}</span>
          <p>{recall.remedySummary}</p>
        </div>
      )}
      {recall.source === "fda" && (
        <div className="detail-block">
          <span className="detail-label">Look it up</span>
          <p>FDA recall number {recall.sourceId} — search it in FDA's enforcement database for the full record.</p>
        </div>
      )}
      <div className="dialog-actions">
        {recall.remedyUrl ? (
          <>
            <a className="button button--orange" href={recall.remedyUrl} target="_blank" rel="noopener noreferrer">
              Go to the remedy page <Arrow /><span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a className="button button--outline" href={recall.url} target="_blank" rel="noopener noreferrer">Official notice</a>
          </>
        ) : (
          <a className="button button--orange" href={recall.url} target="_blank" rel="noopener noreferrer">
            {recall.source === "fda" ? "FDA recalls & safety alerts" : "Read official notice"} <Arrow /><span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
        <button className="button button--outline" onClick={onWelcome}>Watch my purchases</button>
      </div>
      <p className="dialog-muted">
        Check the official notice for complete affected-model and remedy details.
        {recall.remedyUrl ? " The remedy link was extracted automatically from the official notice." : ""}
      </p>
    </>
  );
}

function RemedyScreenWrapper({ matchId }: { matchId: Id<"matches"> }) {
  const desk = useQuery(api.users.myDesk);
  return <RemedyScreen matchId={matchId} userEmail={desk?.email ?? null} />;
}

export default function App() {
  const stats = useQuery(api.recalls.stats);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const [query, setQuery] = useState("");
  const activeSearch = query.trim().length >= 2;
  const searchResults = useQuery(
    api.recalls.searchRecalls,
    activeSearch ? { query: query.trim() } : "skip",
  );
  const { results, status, loadMore } = usePaginatedQuery(
    api.recalls.recentRecalls,
    {},
    { initialNumItems: 12 },
  );

  const searching = activeSearch && searchResults === undefined;
  const shown: Recall[] = activeSearch ? (searchResults ?? []) : results;
  const active = results.filter((r) => r.status === "active");
  const sample = active.find((r) => r.imageUrl) ?? active[0];

  const [screen, setScreen] = useState<Screen | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [motionPaused, setMotionPaused] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (screen && !dialog.open) dialog.showModal();
    if (!screen && dialog.open) dialog.close();
  }, [screen]);
  useEffect(() => {
    document.body.classList.toggle("motion-paused", motionPaused);
  }, [motionPaused]);

  const open = (kind: Screen["kind"]) => () => setScreen({ kind } as Screen);
  const close = () => setScreen(null);

  const noticeKind = (r: Recall) =>
    r.source === "fsis" && /^Public health alert/i.test(r.hazard)
      ? "public health alert"
      : "recall";
  const dialogLabel =
    screen?.kind === "recall"
      ? `Official ${SOURCE_LABEL[screen.recall.source]} ${noticeKind(screen.recall)} · ${fmtDate(screen.recall.publishedAt)}${screen.recall.status === "closed" ? " · CLOSED" : screen.recall.status === "expanded" ? " · EXPANDED" : ""}`
      : screen?.kind === "remedy" ? "Remedy checklist"
      : screen?.kind === "claimReal" ? "Your claim · approval required"
      : screen?.kind === "welcome" ? "The personal desk · Preview"
      : screen?.kind === "desk" ? "My desk"
      : screen?.kind === "claim" ? "Your approval comes first · Sample preview"
      : screen?.kind === "approve" ? "Sample workflow"
      : screen?.kind === "about" ? "About Recall Desk"
      : screen?.kind === "privacy" ? "Privacy"
      : "Official sources";

  let dialogBody: ReactNode = null;
  if (screen?.kind === "recall") {
    dialogBody = <RecallDetail recall={screen.recall} onWelcome={open("welcome")} />;
  } else if (screen?.kind === "remedy") {
    dialogBody = <RemedyScreenWrapper matchId={screen.matchId} />;
  } else if (screen?.kind === "claimReal") {
    dialogBody = <ClaimScreen matchId={screen.matchId} />;
  } else if (screen?.kind === "welcome") {
    dialogBody = (
      <>
        <h2 id="dialog-title">A little less<br />on your list.</h2>
        <p>Keep track of the things you buy, get an alert when a recall matches, and review a prepared claim in one place.</p>
        <ol className="sample-timeline">
          <li><span>01</span><div><strong>Forward your retailer receipts</strong><small>Your purchases become the items on your desk.</small></div></li>
          <li><span>02</span><div><strong>We watch for a match</strong><small>A relevant recall becomes an actionable alert.</small></div></li>
          <li><span>03</span><div><strong>Review and approve your claim</strong><small>You stay in control of what gets sent.</small></div></li>
        </ol>
        <div className="dialog-actions">
          <button className="button button--orange" onClick={open("desk")}>Create my desk <Arrow /></button>
          <button className="button button--outline" onClick={open("claim")}>Explore a sample claim</button>
        </div>
        <p className="dialog-muted">Desks are open today (email sign-in, no password). Receipt ingestion is being connected — your forwarding address appears on your desk the moment it's live.</p>
      </>
    );
  } else if (screen?.kind === "desk") {
    dialogBody = (
      <DeskScreen
        onSampleClaim={open("claim")}
        onOpenRemedy={(matchId) => setScreen({ kind: "remedy", matchId })}
        onOpenClaim={(matchId) => setScreen({ kind: "claimReal", matchId })}
      />
    );
  } else if (screen?.kind === "claim") {
    const remedyWord = sample?.remedyOptions[0]?.toLowerCase() ?? "remedy";
    dialogBody = (
      <>
        <h2 id="dialog-title">Ready when you are.</h2>
        <p>A recall matched an item on this sample desk. Review the claim before it goes anywhere.</p>
        {sample && (
          <div className="dialog-product">
            {sample.imageUrl && <img src={sample.imageUrl} alt={sample.imageCaption ?? "Recalled product"} />}
            <div>
              <span className="preview-label">ILLUSTRATIVE CLAIM</span>
              <h3>{sample.title}</h3>
              <p style={{ fontSize: 14, color: "var(--muted)" }}>Remedy: {sample.remedyOptions[0] ?? "see official notice"}</p>
            </div>
          </div>
        )}
        <div className="preview-email">
          <span className="detail-label">Draft message · example only</span>
          <p><strong>Subject:</strong> Product recall — {remedyWord} request</p>
          <p>Hello,</p>
          <p>I am requesting assistance with this recall. Please confirm the next steps for verifying my unit and receiving the {remedyWord}.</p>
          <p>I can provide purchase and product-label photos for review.</p>
        </div>
        <p className="dialog-muted">In the finished product, you confirm the matching model and provide the evidence the manufacturer requires before approving your claim.</p>
        <div className="dialog-actions">
          <button className="button button--orange" onClick={open("approve")}>Preview approval <Arrow /></button>
          <button className="button button--outline" onClick={open("desk")}>Open my desk</button>
        </div>
      </>
    );
  } else if (screen?.kind === "approve") {
    dialogBody = (
      <div className="approved-state">
        <svg className="approved-icon" aria-hidden="true"><use href="#i-check" /></svg>
        <h2 id="dialog-title">You're in control.</h2>
        <p>Approval previewed. No claim was sent.</p>
        <p className="dialog-muted">Once receipts are flowing, an approved claim and the manufacturer's replies will appear on your claim timeline.</p>
        <div className="dialog-actions" style={{ justifyContent: "center" }}>
          <button className="button button--orange" onClick={close}>Back to recalls <Arrow /></button>
        </div>
      </div>
    );
  } else if (screen?.kind === "about") {
    dialogBody = (
      <>
        <h2 id="dialog-title">You bought it.<br />We watch it.</h2>
        <p>Recall Desk watches the U.S. federal recall feeds around the clock and — soon — matches them against the retailer receipts you forward, preparing the claim for your approval.</p>
        <p>Built solo for the Convex All Gas Hackathon on Convex and Firecrawl today, with AgentMail and OpenAI powering the receipt-matching lane that's next. Every recall shown is a real official notice; nothing is invented.</p>
        <div className="dialog-actions">
          <a className="button button--outline" href={REPO} target="_blank" rel="noopener noreferrer">Source on GitHub <Arrow /></a>
          <a className="button button--outline" href={`${REPO}/blob/main/hackathon.md`} target="_blank" rel="noopener noreferrer">Build log</a>
        </div>
      </>
    );
  } else if (screen?.kind === "privacy") {
    dialogBody = (
      <>
        <h2 id="dialog-title">Your receipts<br />stay yours.</h2>
        <p>Today the public board requires no account and collects nothing. When receipt monitoring opens, forwarded receipts are used only to match your purchases against official recalls and to prepare claims you explicitly approve. No data is sold, ever.</p>
        <div className="dialog-actions"><button className="button button--outline" onClick={close}>Close</button></div>
      </>
    );
  } else if (screen?.kind === "sources") {
    dialogBody = (
      <>
        <h2 id="dialog-title">Straight from<br />the source.</h2>
        <p>Recalls come directly from the U.S. CPSC (SaferProducts.gov), the FDA (openFDA enforcement reports), and USDA-FSIS, refreshed automatically on crons, with each card linking to official information. NHTSA vehicle recalls are next.</p>
        <div className="dialog-actions">
          <a className="button button--outline" href="https://www.cpsc.gov/Recalls" target="_blank" rel="noopener noreferrer">CPSC.gov <Arrow /></a>
        </div>
      </>
    );
  }

  return (
    <>
      <a className="skip-link" href="#recalls">Skip to recalls</a>
      <IconDefs />
      <div className="wrap">
        <header className="site-header">
          <Brand />
          <nav className={`main-nav${navOpen ? " is-open" : ""}`} id="main-nav" aria-label="Main navigation">
            <a className="nav-link" href="#recalls" onClick={() => setNavOpen(false)}>Latest recalls</a>
            <a className="nav-link" href="#how-it-works" onClick={() => setNavOpen(false)}>How it works</a>
            <button className="nav-link" onClick={open("desk")}>My desk</button>
          </nav>
          <div className="header-actions">
            <button className="button" onClick={open("welcome")}>Get started <Arrow /></button>
            <button className="menu-toggle" aria-expanded={navOpen} aria-controls="main-nav" aria-label="Open navigation" onClick={() => setNavOpen((v) => !v)}>
              <svg className="icon" aria-hidden="true"><use href="#i-menu" /></svg>
            </button>
          </div>
        </header>

        <main id="top">
          <section className="hero" aria-labelledby="hero-heading">
            <div className="hero-copy">
              <p className="eyebrow"><span className="orange-square" aria-hidden="true" />A little less to worry about</p>
              <h1 id="hero-heading"><span>You bought it.</span><span>We watch it.</span></h1>
              <p className="hero-description">Recall alerts for the things you own. Forward your receipts. We watch for recalls and prepare your claim for approval.</p>
              <div className="hero-ctas">
                <button className="button button--orange" onClick={open("welcome")}>Watch my purchases <Arrow /></button>
                <a className="text-link" href="#recalls">Browse recalls <svg className="arrow" aria-hidden="true"><use href="#i-down" /></svg></a>
              </div>
              <p className="hero-note">Your receipts in. One less thing on your mind.</p>
            </div>
            <div className="hero-art">
              <img src={heroCollage} width={1254} height={1254} alt="A sculptural paper receipt arches over an espresso machine, sage speaker, and travel mug." fetchPriority="high" decoding="async" />
              <div className="scan-zone" aria-hidden="true"><span className="scan-bracket scan-bracket--top" /><span className="scan-bracket scan-bracket--bottom" /><span className="scan-line" /></div>
              <button className="match-slip" onClick={open("claim")} aria-label="Review an illustrative recall claim">
                <small>ILLUSTRATIVE PREVIEW</small>
                <span className="match-content">
                  <svg className="match-alert" aria-hidden="true"><use href="#i-alert" /></svg>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="match-title">Recall matched.</span>
                    <span className="match-bottom"><span>Your claim is ready for review.</span><span className="match-action">Review claim <svg aria-hidden="true"><use href="#i-ne" /></svg></span></span>
                  </span>
                </span>
              </button>
            </div>
            <button className="motion-toggle" aria-pressed={motionPaused} onClick={() => setMotionPaused((v) => !v)}>
              <svg aria-hidden="true"><use href="#i-pause" /></svg><span>{motionPaused ? "Play motion" : "Pause motion"}</span>
            </button>
          </section>

          <div className="board-status">
            <span className="eyebrow"><span className="status-dot" aria-hidden="true" />Public recall board</span>
            <span className="source-status">CPSC · FDA · FSIS live</span>
            <span>No account needed</span>
          </div>

          <section className="board-section" id="recalls" aria-labelledby="recalls-heading">
            <div className="section-heading">
              <h2 id="recalls-heading">The latest. Worth a look.</h2>
              <span className="text-link" aria-live="polite">
                {stats ? `${stats.recallsTracked.toLocaleString()} tracked · updated ${stats.lastCrawlAt ? timeAgo(stats.lastCrawlAt, now) : "—"}` : "…"}
              </span>
            </div>
            <div className="search-row">
              <div className="search-box">
                <svg className="icon" aria-hidden="true"><use href="#i-search" /></svg>
                <label htmlFor="recall-search" className="sr-only">Search a product, brand, or model</label>
                <input id="recall-search" type="search" placeholder="Search a product, brand, or model…" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
                <button className="clear-search" aria-label="Clear search" hidden={query === ""} onClick={() => setQuery("")}>
                  <svg className="icon" aria-hidden="true"><use href="#i-close" /></svg>
                </button>
              </div>
            </div>
            <p className="sr-only" role="status" aria-live="polite">
              {activeSearch && !searching ? `${shown.length} ${shown.length === 1 ? "recall" : "recalls"} match your search.` : ""}
            </p>
            <div className="recall-grid" id="recall-grid">
              {shown.map((recall) => (
                <RecallCard key={recall._id} recall={recall} onShow={() => setScreen({ kind: "recall", recall })} />
              ))}
            </div>
            {shown.length === 0 && (
              <div className="empty-state">
                <h3>{searching ? "Searching…" : activeSearch ? "No matches." : status === "LoadingFirstPage" ? "Loading the corpus…" : "Corpus is seeding."}</h3>
                <p>{searching ? "Looking across the live corpus." : activeSearch ? "Try another product, brand, or model — or clear the search for the full live list." : "Real recalls appear here the moment the next crawl lands."}</p>
                {activeSearch && !searching && <button className="button button--outline" onClick={() => setQuery("")}>Clear search</button>}
              </div>
            )}
            {!activeSearch && status === "CanLoadMore" && (
              <div className="load-more-row">
                <button className="button button--outline" onClick={() => loadMore(12)}>Load more recalls</button>
              </div>
            )}
            <p className="board-note board-live-note">
              Every card is a real official notice — nothing is invented. See each notice for affected models and remedy details.<br />
              Live corpus from CPSC, FDA, and USDA-FSIS, refreshed automatically on crons.
            </p>
          </section>
        </main>
      </div>

      <section className="how-section" id="how-it-works" aria-labelledby="how-heading">
        <div className="wrap" style={{ position: "relative" }}>
          <p className="eyebrow"><span className="orange-square" aria-hidden="true" />Less admin. More peace of mind.</p>
          <h2 id="how-heading">From receipt to resolution.</h2>
          <ol className="steps">
            <li className="step"><span className="step-number">01</span><svg className="step-icon" aria-hidden="true"><use href="#i-receipt" /></svg><div><h3 className="step-title">Forward a receipt</h3><p className="step-description">Add the purchases you want us to watch.</p></div></li>
            <li className="step"><span className="step-number">02</span><svg className="step-icon" aria-hidden="true"><use href="#i-bell" /></svg><div><h3 className="step-title">We watch for recalls</h3><p className="step-description">Get alerted when a recall matches.</p></div></li>
            <li className="step"><span className="step-number">03</span><svg className="step-icon" aria-hidden="true"><use href="#i-send" /></svg><div><h3 className="step-title">Approve your claim</h3><p className="step-description">We prepare it. You review. We send.</p></div></li>
          </ol>
          <div className="how-cta">
            <button className="button button--orange" onClick={open("welcome")}>Get started <Arrow /></button>
          </div>
          <footer className="site-footer">
            <Brand />
            <div className="footer-links">
              <button onClick={open("about")}>About</button>
              <button onClick={open("privacy")}>Privacy</button>
              <button onClick={open("sources")}>Official sources</button>
              <a href={REPO} target="_blank" rel="noopener noreferrer">GitHub</a>
            </div>
          </footer>
        </div>
      </section>

      <dialog id="info-dialog" ref={dialogRef} aria-labelledby="dialog-title" onCancel={(e) => { e.preventDefault(); close(); }} onClick={(e) => { if (e.target === dialogRef.current) close(); }}>
        <div className="dialog-header">
          <span className="dialog-label">{dialogLabel}</span>
          <button className="close-dialog" aria-label="Close dialog" onClick={close}>
            <svg className="icon" aria-hidden="true"><use href="#i-close" /></svg>
          </button>
        </div>
        <div className="dialog-body">{dialogBody}</div>
      </dialog>
    </>
  );
}
