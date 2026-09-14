import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import heroCollage from "./assets/hero-collage.webp";
import { ImagePrepError, prepareReceiptImage } from "./lib/imagePrep";
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

/** The URL fragment is the router: "#desk" is the desk page, anything else the home board. */
type Route = "home" | "desk";
const routeFromHash = (): Route => (location.hash === "#desk" ? "desk" : "home");
/** Setting the fragment is the navigation: it fires hashchange, which drives `route`. */
const navigateHash = (hash: string) => {
  window.location.hash = hash;
};

type DeskInfo = NonNullable<FunctionReturnType<typeof api.users.myDesk>>;

/**
 * Backend errors reach the client wrapped ("[Request ID: …] Server Error\nUncaught Error: …\n at …");
 * the text inside is written for the user, so unwrap it rather than showing plumbing.
 */
function userMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const data = (error as { data?: unknown }).data;
  if (typeof data === "string" && data.trim() !== "") return data.trim();
  const text = error.message
    .replace(/^\[CONVEX [^\]]*\]\s*/i, "")
    .replace(/^\[Request ID: [^\]]*\]\s*/i, "")
    .replace(/^Server Error:?\s*/i, "")
    .replace(/^Uncaught (?:Convex)?Error:\s*/i, "")
    .split("\n")[0]
    ?.trim();
  // Production redacts non-ConvexError messages to plumbing; never show that.
  if (!text || /^(server error|uncaught|\[)/i.test(text) || /called by client/i.test(text)) return fallback;
  return text;
}

/** How an item reached the desk, from the ledger-id prefix its ingestion path stamped. */
function entryLabel(sourceMessageId: string): string {
  if (sourceMessageId.startsWith("manual:")) return "typed in";
  if (sourceMessageId.startsWith("photo:")) return "photo";
  if (sourceMessageId.startsWith("paste:")) return "pasted";
  return "email";
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Email → 8-digit code, both through Convex Auth. Shown on the desk page when signed out. */
function SignInForms() {
  const { signIn } = useAuthActions();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

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
  return step === "email" ? (
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
  );
}

type IntakeTab = "photo" | "paste" | "manual";
const INTAKE_TABS: ReadonlyArray<{ id: IntakeTab; label: string }> = [
  { id: "photo", label: "Photo" },
  { id: "paste", label: "Paste text" },
  { id: "manual", label: "Type it in" },
];
const MAX_PHOTOS = 4;
const EMPTY_MANUAL = { product: "", brand: "", model: "", purchaseDate: "", retailer: "" };

/** The "add to your desk" card: photo upload, pasted text, or a typed-in item. */
function IntakePanel({ ingestAddress, autoFocusPhoto }: { ingestAddress: string | null; autoFocusPhoto: boolean }) {
  const ingestPasted = useAction(api.receipts.ingestPastedReceipt);
  const ingestUploaded = useAction(api.receipts.ingestUploadedReceipt);
  const uploadUrl = useMutation(api.receipts.generateReceiptUploadUrl);
  const addManual = useMutation(api.items.addManualItem);
  const [tab, setTab] = useState<IntakeTab>("photo");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [paste, setPaste] = useState("");
  const [manual, setManual] = useState(EMPTY_MANUAL);
  const [copied, setCopied] = useState(false);
  const tabRefs = useRef<Record<IntakeTab, HTMLButtonElement | null>>({ photo: null, paste: null, manual: null });
  const fileRef = useRef<HTMLInputElement>(null);
  const copyTimer = useRef<number | null>(null);

  // "Add a receipt" on the home page lands here with the Photo tab focused.
  useEffect(() => {
    if (autoFocusPhoto) tabRefs.current.photo?.focus();
  }, [autoFocusPhoto]);
  useEffect(() => () => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
  }, []);

  const working = busy !== "";
  const selectTab = (next: IntakeTab) => {
    setTab(next);
    setMsg("");
    setErr("");
  };
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = INTAKE_TABS.findIndex((t) => t.id === tab);
    const next = INTAKE_TABS[(i + (e.key === "ArrowRight" ? 1 : INTAKE_TABS.length - 1)) % INTAKE_TABS.length];
    selectTab(next.id);
    tabRefs.current[next.id]?.focus();
  };

  const handleFiles = async (list: ArrayLike<File> | null) => {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    if (working) {
      setErr("Still working on the last upload — one moment.");
      return;
    }
    setErr("");
    setMsg("");
    if (files.length > MAX_PHOTOS) {
      setErr("Choose up to 4 photos at a time.");
      return;
    }
    try {
      // Prepare everything first (HEIC → JPEG, downscale, strip metadata) so
      // nothing the server would reject is ever uploaded.
      const prepared: Blob[] = [];
      for (const file of files) {
        setBusy("Preparing photo…");
        const image = await prepareReceiptImage(file, (stage) =>
          setBusy(stage === "converting" ? "Converting iPhone photo…" : "Preparing photo…"),
        );
        prepared.push(image.blob);
      }
      const storageIds: Id<"_storage">[] = [];
      for (const [i, blob] of prepared.entries()) {
        setBusy(`Uploading photo ${i + 1} of ${prepared.length}…`);
        const url = await uploadUrl({});
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": blob.type || "application/octet-stream" },
          body: blob,
        });
        if (!res.ok) throw new Error("Upload failed — check your connection and try again.");
        const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
        storageIds.push(storageId);
      }
      setBusy("Reading your photos…");
      const out = await ingestUploaded({ storageIds });
      setMsg(
        out.itemsCreated > 0
          ? `Added ${plural(out.itemsCreated, "item")} from your photos.`
          : "No products found in those photos — try a flatter, brighter shot.",
      );
    } catch (error) {
      setErr(error instanceof ImagePrepError ? error.userMessage : userMessage(error, "Upload failed."));
    } finally {
      setBusy("");
    }
  };

  const submitPaste = async () => {
    setErr("");
    setMsg("");
    setBusy("Reading…");
    try {
      const out = await ingestPasted({ text: paste });
      setMsg(
        out.itemsCreated > 0
          ? `Added ${plural(out.itemsCreated, "item")}.`
          : "No purchased items found in that text.",
      );
      setPaste("");
    } catch (error) {
      setErr(userMessage(error, "Couldn't read that."));
    } finally {
      setBusy("");
    }
  };

  const submitManual = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErr("");
    setMsg("");
    const opt = (s: string) => (s.trim() === "" ? undefined : s.trim());
    const product = manual.product.trim();
    setBusy("Adding…");
    try {
      await addManual({
        product,
        brand: opt(manual.brand),
        model: opt(manual.model),
        purchaseDate: opt(manual.purchaseDate),
        retailer: opt(manual.retailer),
      });
      setMsg(`Watching ${product}.`);
      setManual(EMPTY_MANUAL);
    } catch (error) {
      setErr(userMessage(error, "Couldn't add that item."));
    } finally {
      setBusy("");
    }
  };

  const copyAlias = async () => {
    if (ingestAddress === null) return;
    try {
      await navigator.clipboard.writeText(ingestAddress);
      setCopied(true);
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("Couldn't copy — select the address and copy it by hand.");
    }
  };

  const field = (key: keyof typeof EMPTY_MANUAL) => ({
    value: manual[key],
    onChange: (e: ChangeEvent<HTMLInputElement>) => setManual((m) => ({ ...m, [key]: e.target.value })),
    disabled: working,
  });

  return (
    <section className="desk-card" aria-labelledby="intake-label">
      <span className="detail-label" id="intake-label">Add to your desk</span>
      <div className="intake-tabs" role="tablist" aria-label="How to add an item" onKeyDown={onTabKey}>
        {INTAKE_TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => { tabRefs.current[t.id] = el; }}
            className="intake-tab"
            role="tab"
            id={`intake-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`intake-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => selectTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`intake-panel-${tab}`} aria-labelledby={`intake-tab-${tab}`}>
        {tab === "photo" && (
          <>
            <p className="intake-hint">Snap the receipt, the prescription label, or the product itself — we read the products off it.</p>
            <label
              className="dropzone"
              role="button"
              tabIndex={working ? -1 : 0}
              aria-busy={working}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileRef.current?.click();
                }
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void handleFiles(e.dataTransfer.files);
              }}
            >
              <input
                ref={fileRef}
                type="file"
                accept="image/*,.heic,.heif"
                multiple
                hidden
                disabled={working}
                onChange={(e) => {
                  // Copy the list before resetting the input (resetting clears it).
                  const picked = e.target.files ? Array.from(e.target.files) : [];
                  e.target.value = "";
                  void handleFiles(picked);
                }}
              />
              <strong>{working ? busy : "Take a photo or choose from your camera roll"}</strong>
              <small>Up to 4 photos at a time. iPhone HEIC photos are fine.</small>
            </label>
            <ul className="intake-guide">
              <li>Store receipts — flat, good light, the whole receipt in frame. Long receipt? Take 2–3 overlapping shots.</li>
              <li>Pharmacy receipts and prescription labels — we keep the drug, strength, manufacturer and NDC; never your name, prescriber or plan.</li>
              <li>Pill bottles, boxes and labels — front and back as separate photos.</li>
              <li>Screenshots count — an Amazon Your Orders page works as a photo.</li>
            </ul>
          </>
        )}
        {tab === "paste" && (
          <>
            <p className="intake-hint">Copy the order confirmation email or the order page (select all → copy) and paste it here.</p>
            <textarea
              className="intake-textarea"
              aria-label="Paste your receipt text"
              placeholder="Paste an order confirmation or receipt here…"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={7}
              maxLength={15000}
              disabled={working}
            />
            <div className="dialog-actions">
              <button
                className="button button--orange"
                disabled={working || paste.trim().length < 20}
                onClick={() => void submitPaste()}
              >
                {working ? busy : "Add these items"} <Arrow />
              </button>
            </div>
          </>
        )}
        {tab === "manual" && (
          <form onSubmit={submitManual}>
            <p className="intake-hint">No receipt? Tell us what you have.</p>
            <div className="field">
              <label htmlFor="manual-product">Product</label>
              <input id="manual-product" required minLength={2} maxLength={200} placeholder="e.g. Stanley 16 oz rubber mallet" autoComplete="off" {...field("product")} />
            </div>
            <div className="field">
              <label htmlFor="manual-brand">Brand (optional)</label>
              <input id="manual-brand" maxLength={120} placeholder="e.g. Stanley" autoComplete="off" {...field("brand")} />
            </div>
            <div className="field">
              <label htmlFor="manual-model">Model or code (optional)</label>
              <input id="manual-model" maxLength={120} placeholder="e.g. 57-527" autoComplete="off" {...field("model")} />
              <small>from the box or label — sharpens matching a lot</small>
            </div>
            <div className="field">
              <label htmlFor="manual-date">Bought around (optional)</label>
              <input id="manual-date" type="month" placeholder="YYYY-MM" pattern="\d{4}-\d{2}(-\d{2})?" {...field("purchaseDate")} />
            </div>
            <div className="field">
              <label htmlFor="manual-store">Store (optional)</label>
              <input id="manual-store" maxLength={120} placeholder="e.g. Home Depot" autoComplete="off" {...field("retailer")} />
            </div>
            <p className="dialog-muted">Less precise than a receipt: we match on the words you give us, so include the brand and any model number you can find.</p>
            <div className="dialog-actions">
              <button className="button button--orange" type="submit" disabled={working}>
                {working ? busy : "Watch this item"} <Arrow />
              </button>
            </div>
          </form>
        )}
      </div>
      {msg && <p className="intake-status" role="status">{msg}</p>}
      {err && <p className="intake-status intake-status--error" role="alert">{err}</p>}
      <p className="intake-email">
        Prefer email? Forward receipts to{" "}
        {ingestAddress ? (
          <>
            <strong>{ingestAddress}</strong>
            <button type="button" className="copy-button" onClick={() => void copyAlias()}>
              {copied ? "Copied" : "Copy"}
            </button>
          </>
        ) : (
          <em>your address (activating)</em>
        )}
        {" "}— anything you send there lands here automatically.
      </p>
    </section>
  );
}

function DeskSignedIn({ desk, autoFocusPhoto, onOpenRemedy, onOpenClaim, onSampleClaim, onSignOut }: {
  desk: DeskInfo;
  autoFocusPhoto: boolean;
  onOpenRemedy: (matchId: Id<"matches">) => void;
  onOpenClaim: (matchId: Id<"matches">) => void;
  onSampleClaim: () => void;
  onSignOut: () => void;
}) {
  const items = useQuery(api.items.myItems);
  const dismissItem = useMutation(api.items.dismissItem);
  const matches = useQuery(api.match.myMatches);
  const dismissMatch = useMutation(api.match.dismissMatch);
  const claims = useQuery(api.claims.myClaims);
  const matchCount = matches?.length ?? desk.matchesCount;
  const itemCount = desk.itemsCount > 100 ? "100+" : String(items?.length ?? desk.itemsCount);

  return (
    <>
      <div className="desk-head">
        <p className="eyebrow"><span className="orange-square" aria-hidden="true" />My desk</p>
        <h1>One place.<br />One less thing.</h1>
        <p className="desk-identity">
          <span>Signed in as <strong>{desk.email ?? "your account"}</strong></span>
          <button className="text-link" onClick={onSignOut}>Sign out</button>
        </p>
      </div>
      <div className="desk-grid">
        <IntakePanel ingestAddress={desk.ingestAddress} autoFocusPhoto={autoFocusPhoto} />
        <div className="desk-main">
          <section className="desk-section" aria-labelledby="matches-label">
            <span className="detail-label" id="matches-label" style={{ color: "var(--orange)" }} aria-live="polite">
              Recall matches · {matchCount}
            </span>
            {matches === undefined ? (
              <p className="dialog-muted">Checking your desk…</p>
            ) : matches.length === 0 ? (
              <p className="desk-empty">
                No recalls match your items yet. Every new recall is checked
                against your desk automatically — you'll get an email the day
                one matches.{" "}
                <button className="text-link" onClick={onSampleClaim}>See a sample claim</button>
              </p>
            ) : (
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
                        {match.matchScore < 0.7
                          ? `Possible match (${Math.round(match.matchScore * 100)}%) — confirm before acting: `
                          : `AI assessment (${Math.round(match.matchScore * 100)}%): `}
                        {match.matchRationale}
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
            )}
          </section>
          {claims !== undefined && claims.length > 0 && (
            <section className="desk-section" aria-labelledby="claims-label">
              <span className="detail-label" id="claims-label">Your claims · {claims.length}</span>
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
            </section>
          )}
          <section className="desk-section" aria-labelledby="items-label">
            <span className="detail-label" id="items-label">Watched items · {itemCount}</span>
            {items === undefined ? (
              <p className="dialog-muted">Loading…</p>
            ) : items.length === 0 ? (
              <p className="desk-empty">Nothing watched yet — add a receipt on the left.</p>
            ) : (
              <>
                <ul className="sample-timeline">
                  {items.slice(0, 12).map((item) => (
                    <li key={item._id}>
                      <span aria-hidden="true">▤</span>
                      <div>
                        <strong>
                          {item.product}
                          <span className="entry-badge">{entryLabel(item.sourceMessageId)}</span>
                        </strong>
                        <small>
                          {[
                            item.brand,
                            item.retailer,
                            item.purchaseDate,
                            item.ndc ? `NDC ${item.ndc}` : "",
                            item.lot ? `lot ${item.lot}` : "",
                          ]
                            .filter(Boolean)
                            .join(" · ") || "no further details in the receipt"}
                          {item.sourceMessageId.startsWith("manual:")
                            ? " · matched on your words — add a model number to sharpen it"
                            : item.confidence < 0.8
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
          </section>
          <p className="dialog-muted">Your items are matched against every new recall automatically — you'll be emailed the day something you own is recalled.</p>
        </div>
      </div>
    </>
  );
}

/** The full-page desk: loading → sign-in → the desk itself. */
function DeskPage({ desk, autoFocusPhoto, onOpenRemedy, onOpenClaim, onSampleClaim, onSignOut }: {
  desk: DeskInfo | null | undefined;
  autoFocusPhoto: boolean;
  onOpenRemedy: (matchId: Id<"matches">) => void;
  onOpenClaim: (matchId: Id<"matches">) => void;
  onSampleClaim: () => void;
  onSignOut: () => void;
}) {
  if (desk === undefined) {
    return <p className="dialog-muted">Loading your desk…</p>;
  }
  if (desk === null) {
    return (
      <>
        <div className="desk-head">
          <p className="eyebrow"><span className="orange-square" aria-hidden="true" />My desk</p>
          <h1>Your desk.<br />One sign-in away.</h1>
        </div>
        <div className="desk-signin">
          <SignInForms />
          <ol className="sample-timeline">
            <li><span>01</span><div><strong>Add what you own</strong><small>A photo, pasted text, a forwarded receipt — or just type it in.</small></div></li>
            <li><span>02</span><div><strong>We watch every recall</strong><small>CPSC, FDA and USDA-FSIS, checked against your desk around the clock.</small></div></li>
            <li><span>03</span><div><strong>Approve the prepared claim</strong><small>We draft it from the official notice. Nothing sends without you.</small></div></li>
          </ol>
        </div>
      </>
    );
  }
  return (
    <DeskSignedIn
      desk={desk}
      autoFocusPhoto={autoFocusPhoto}
      onOpenRemedy={onOpenRemedy}
      onOpenClaim={onOpenClaim}
      onSampleClaim={onSampleClaim}
      onSignOut={onSignOut}
    />
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
  | { kind: "welcome" } | { kind: "claim" } | { kind: "approve" }
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

function SiteFooter({ open }: { open: (kind: "about" | "privacy" | "sources") => () => void }) {
  return (
    <footer className="site-footer">
      <Brand />
      <div className="footer-links">
        <button onClick={open("about")}>About</button>
        <button onClick={open("privacy")}>Privacy</button>
        <button onClick={open("sources")}>Official sources</button>
        <a href={REPO} target="_blank" rel="noopener noreferrer">GitHub</a>
      </div>
    </footer>
  );
}

export default function App() {
  const stats = useQuery(api.recalls.stats);
  const desk = useQuery(api.users.myDesk);
  const { signOut } = useAuthActions();
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

  // Hash routing: "#desk" is the desk page; every other fragment is the home board.
  const [route, setRoute] = useState<Route>(routeFromHash);
  // A signed-in visitor must not see the marketing hero flash before myDesk
  // resolves; remember the last known state per browser (per-viewer
  // convenience only — the query is the source of truth).
  const [assumeSignedIn] = useState<boolean>(() => {
    try { return localStorage.getItem("rd:signedIn") === "1"; } catch { return false; }
  });
  useEffect(() => {
    if (desk === undefined) return;
    try {
      if (desk !== null) localStorage.setItem("rd:signedIn", "1");
      else localStorage.removeItem("rd:signedIn");
    } catch { /* storage unavailable: fall back to the query alone */ }
  }, [desk]);
  const [focusIntake, setFocusIntake] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const onHash = () => {
      setRoute(routeFromHash());
      setScreen(null); // Back/Forward must not leave a dialog floating over the other route
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    // Coming back from the desk with a section fragment: the section did not
    // exist when the hash changed, so the browser could not scroll to it.
    if (route !== "home") return;
    const id = location.hash.slice(1);
    if (id === "recalls" || id === "how-it-works") {
      document.getElementById(id)?.scrollIntoView();
    }
  }, [route]);

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

  const goDesk = (focusPhoto = false) => {
    setFocusIntake(focusPhoto);
    setNavOpen(false);
    if (location.hash !== "#desk") navigateHash("#desk");
    window.scrollTo({ top: 0 });
  };
  const goHome = (anchor?: string) => {
    const target = anchor ?? "#top";
    setNavOpen(false);
    if (location.hash === target) {
      // Same fragment twice fires no hashchange, so scroll ourselves.
      document.getElementById(target.slice(1))?.scrollIntoView();
      return;
    }
    navigateHash(target);
  };
  /** Dialog buttons that lead to the desk: close the dialog, then route. */
  const openDesk = (focusPhoto = false) => () => {
    close();
    goDesk(focusPhoto);
  };
  const signOutToHome = async () => {
    goHome();
    await signOut();
  };
  const signedIn = desk !== undefined && desk !== null;
  const email = desk?.email ?? "your account";

  const noticeKind = (r: Recall) =>
    r.source === "fsis" && /^Public health alert/i.test(r.hazard)
      ? "public health alert"
      : "recall";
  const dialogLabel =
    screen?.kind === "recall"
      ? `Official ${SOURCE_LABEL[screen.recall.source]} ${noticeKind(screen.recall)} · ${fmtDate(screen.recall.publishedAt)}${screen.recall.status === "closed" ? " · CLOSED" : screen.recall.status === "expanded" ? " · EXPANDED" : ""}`
      : screen?.kind === "remedy" ? "Remedy checklist"
      : screen?.kind === "claimReal" ? "Your claim · approval required"
      : screen?.kind === "welcome" ? "The personal desk"
      : screen?.kind === "claim" ? "Your approval comes first · Sample preview"
      : screen?.kind === "approve" ? "Sample workflow"
      : screen?.kind === "about" ? "About Recall Desk"
      : screen?.kind === "privacy" ? "Privacy"
      : "Official sources";

  let dialogBody: ReactNode = null;
  if (screen?.kind === "recall") {
    dialogBody = <RecallDetail recall={screen.recall} onWelcome={open("welcome")} />;
  } else if (screen?.kind === "remedy") {
    dialogBody = <RemedyScreen matchId={screen.matchId} userEmail={desk?.email ?? null} />;
  } else if (screen?.kind === "claimReal") {
    dialogBody = <ClaimScreen matchId={screen.matchId} />;
  } else if (screen?.kind === "welcome") {
    dialogBody = (
      <>
        <h2 id="dialog-title">A little less<br />on your list.</h2>
        <p>Keep track of the things you buy, get an alert when a recall matches, and review a prepared claim in one place.</p>
        <ol className="sample-timeline">
          <li><span>01</span><div><strong>Add what you own</strong><small>A photo, pasted text or a forwarded receipt becomes the items on your desk.</small></div></li>
          <li><span>02</span><div><strong>We watch for a match</strong><small>A relevant recall becomes an actionable alert.</small></div></li>
          <li><span>03</span><div><strong>Review and approve your claim</strong><small>You stay in control of what gets sent.</small></div></li>
        </ol>
        <div className="dialog-actions">
          <button className="button button--orange" onClick={openDesk()}>{signedIn ? "Open my desk" : "Create my desk"} <Arrow /></button>
          <button className="button button--outline" onClick={open("claim")}>Explore a sample claim</button>
        </div>
        <p className="dialog-muted">Desks are open — email sign-in, no password. Add what you own by photo, pasted text, or by forwarding receipts.</p>
      </>
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
        <p className="dialog-muted">On your own desk, you confirm the matching model and provide the evidence the manufacturer requires before approving your claim.</p>
        <div className="dialog-actions">
          <button className="button button--orange" onClick={open("approve")}>Preview approval <Arrow /></button>
          <button className="button button--outline" onClick={openDesk()}>Open my desk</button>
        </div>
      </>
    );
  } else if (screen?.kind === "approve") {
    dialogBody = (
      <div className="approved-state">
        <svg className="approved-icon" aria-hidden="true"><use href="#i-check" /></svg>
        <h2 id="dialog-title">You're in control.</h2>
        <p>Approval previewed. No claim was sent.</p>
        <p className="dialog-muted">On your desk, an approved claim and the manufacturer's replies appear on your claim timeline.</p>
        <div className="dialog-actions" style={{ justifyContent: "center" }}>
          <button className="button button--orange" onClick={close}>Back to recalls <Arrow /></button>
        </div>
      </div>
    );
  } else if (screen?.kind === "about") {
    dialogBody = (
      <>
        <h2 id="dialog-title">You bought it.<br />We watch it.</h2>
        <p>Recall Desk watches the U.S. federal recall feeds around the clock and matches them against what you own — receipts by photo, pasted text or forwarded email — then prepares the claim for your approval.</p>
        <p>Built solo for the Convex All Gas Hackathon on Convex and Firecrawl, with AgentMail and OpenAI powering the receipt lane: photo, paste or email in; recall matches, remedy checklists and claims out. Every recall shown is a real official notice; nothing is invented.</p>
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
        <p>The public board requires no account and collects nothing. Receipts you upload, paste or forward are used only to match your purchases against official recalls and to prepare claims you explicitly approve. Photos are deleted as soon as they're read. Medication receipts keep only the drug, strength, manufacturer and NDC — never patient or prescriber details. No data is sold, ever.</p>
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

  const heroArt = (slip: ReactNode) => (
    <div className="hero-art">
      <img src={heroCollage} width={1254} height={1254} alt="A sculptural paper receipt arches over an espresso machine, sage speaker, and travel mug." fetchPriority="high" decoding="async" />
      <div className="scan-zone" aria-hidden="true"><span className="scan-bracket scan-bracket--top" /><span className="scan-bracket scan-bracket--bottom" /><span className="scan-line" /></div>
      {slip}
    </div>
  );
  const motionToggle = (
    <button className="motion-toggle" aria-pressed={motionPaused} onClick={() => setMotionPaused((v) => !v)}>
      <svg aria-hidden="true"><use href="#i-pause" /></svg><span>{motionPaused ? "Play motion" : "Pause motion"}</span>
    </button>
  );

  return (
    <>
      {route === "desk" ? (
        <a
          className="skip-link"
          href="#desk"
          onClick={(e) => {
            // A fragment link would re-route; focus the desk directly instead.
            e.preventDefault();
            mainRef.current?.focus();
          }}
        >
          Skip to your desk
        </a>
      ) : (
        <a className="skip-link" href="#recalls">Skip to recalls</a>
      )}
      <IconDefs />
      <div className="wrap">
        <header className="site-header">
          <Brand />
          <nav className={`main-nav${navOpen ? " is-open" : ""}`} id="main-nav" aria-label="Main navigation">
            <a className="nav-link" href="#recalls" onClick={(e) => { e.preventDefault(); goHome("#recalls"); }}>Latest recalls</a>
            <a className="nav-link" href="#how-it-works" onClick={(e) => { e.preventDefault(); goHome("#how-it-works"); }}>How it works</a>
            <button
              className={`nav-link${route === "desk" ? " nav-link--current" : ""}`}
              aria-current={route === "desk" ? "page" : undefined}
              onClick={() => goDesk()}
            >
              My desk
            </button>
          </nav>
          <div className="header-actions">
            {desk === undefined ? null : desk === null ? (
              <button className="button" onClick={open("welcome")}>Get started <Arrow /></button>
            ) : (
              <>
                <span className="signed-pill">
                  <span className="status-dot" aria-hidden="true" />
                  Signed in<span className="signed-email"> · {email}</span>
                </span>
                {route === "desk" ? (
                  <button className="button button--outline" onClick={() => goHome("#recalls")}>Latest recalls <Arrow /></button>
                ) : (
                  <button className="button button--orange" onClick={() => goDesk()}>My desk <Arrow /></button>
                )}
              </>
            )}
            <button className="menu-toggle" aria-expanded={navOpen} aria-controls="main-nav" aria-label="Open navigation" onClick={() => setNavOpen((v) => !v)}>
              <svg className="icon" aria-hidden="true"><use href="#i-menu" /></svg>
            </button>
          </div>
        </header>

        {route === "desk" ? (
          <main id="top" className="desk-page" ref={mainRef} tabIndex={-1}>
            <DeskPage
              desk={desk}
              autoFocusPhoto={focusIntake}
              onOpenRemedy={(matchId) => setScreen({ kind: "remedy", matchId })}
              onOpenClaim={(matchId) => setScreen({ kind: "claimReal", matchId })}
              onSampleClaim={open("claim")}
              onSignOut={() => void signOutToHome()}
            />
          </main>
        ) : (
          <main id="top">
            {desk || (desk === undefined && assumeSignedIn) ? (
              <section className="hero hero--desk" aria-labelledby="hero-heading">
                <div className="hero-copy">
                  <p className="eyebrow"><span className="status-dot" aria-hidden="true" />{desk ? <>Signed in as <span className="eyebrow-email">{email}</span></> : "Signed in"}</p>
                  <h1 id="hero-heading"><span>Your desk</span><span>is watching.</span></h1>
                  <div className="desk-stats">
                    <div className="stat"><span className="stat-number">{desk ? (desk.itemsCount > 100 ? "100+" : desk.itemsCount) : "…"}</span><span className="stat-label">items watched</span></div>
                    <div className="stat"><span className="stat-number">{desk ? desk.matchesCount : "…"}</span><span className="stat-label">recall matches</span></div>
                    <div className="stat"><span className="stat-number">{desk ? desk.claimsCount : "…"}</span><span className="stat-label">claims</span></div>
                  </div>
                  <div className="hero-ctas">
                    <button className="button button--orange" onClick={() => goDesk()}>Open my desk <Arrow /></button>
                    <button className="button button--outline" onClick={() => goDesk(true)}>Add a receipt</button>
                    <button className="text-link" onClick={() => void signOut()}>Sign out</button>
                  </div>
                  <p className="hero-note">Every new recall is checked against your desk automatically.</p>
                </div>
                {heroArt(
                  !desk ? null : desk.matchesCount > 0 ? (
                    <button className="match-slip" onClick={() => goDesk()} aria-label={`${desk.matchesCount} recall ${desk.matchesCount === 1 ? "match" : "matches"} on your desk — open my desk`}>
                      <small>YOUR DESK</small>
                      <span className="match-content">
                        <svg className="match-alert" aria-hidden="true"><use href="#i-alert" /></svg>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span className="match-title">{desk.matchesCount} recall match{desk.matchesCount === 1 ? "" : "es"}.</span>
                          <span className="match-bottom"><span>Review what to do.</span><span className="match-action">Open my desk <svg aria-hidden="true"><use href="#i-ne" /></svg></span></span>
                        </span>
                      </span>
                    </button>
                  ) : (
                    <button className="match-slip" onClick={() => goDesk(true)} aria-label="No recalls match your items — add a receipt">
                      <small>YOUR DESK</small>
                      <span className="match-content">
                        <svg className="match-alert match-alert--calm" aria-hidden="true"><use href="#i-check" /></svg>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span className="match-title">No recalls match your items.</span>
                          <span className="match-bottom"><span>Checked against every new recall automatically.</span><span className="match-action">Add a receipt <svg aria-hidden="true"><use href="#i-ne" /></svg></span></span>
                        </span>
                      </span>
                    </button>
                  ),
                )}
                {motionToggle}
              </section>
            ) : (
              <section className="hero" aria-labelledby="hero-heading">
                <div className="hero-copy">
                  <p className="eyebrow"><span className="orange-square" aria-hidden="true" />A little less to worry about</p>
                  <h1 id="hero-heading"><span>You bought it.</span><span>We watch it.</span></h1>
                  <p className="hero-description">Recall alerts for the things you own. Add a receipt — photo, paste or email. We watch for recalls and prepare your claim for approval.</p>
                  <div className="hero-ctas">
                    <button className="button button--orange" onClick={open("welcome")}>Watch my purchases <Arrow /></button>
                    <a className="text-link" href="#recalls">Browse recalls <svg className="arrow" aria-hidden="true"><use href="#i-down" /></svg></a>
                  </div>
                  <p className="hero-note">Your receipts in. One less thing on your mind.</p>
                </div>
                {heroArt(
                  <button className="match-slip" onClick={open("claim")} aria-label="Review an illustrative recall claim">
                    <small>ILLUSTRATIVE PREVIEW</small>
                    <span className="match-content">
                      <svg className="match-alert" aria-hidden="true"><use href="#i-alert" /></svg>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="match-title">Recall matched.</span>
                        <span className="match-bottom"><span>Your claim is ready for review.</span><span className="match-action">Review claim <svg aria-hidden="true"><use href="#i-ne" /></svg></span></span>
                      </span>
                    </span>
                  </button>,
                )}
                {motionToggle}
              </section>
            )}

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
        )}
      </div>

      {route === "desk" ? (
        <section className="how-section how-section--slim" aria-label="Site footer">
          <div className="wrap" style={{ position: "relative" }}>
            <SiteFooter open={open} />
          </div>
        </section>
      ) : (
        <section className="how-section" id="how-it-works" aria-labelledby="how-heading">
          <div className="wrap" style={{ position: "relative" }}>
            <p className="eyebrow"><span className="orange-square" aria-hidden="true" />Less admin. More peace of mind.</p>
            <h2 id="how-heading">From receipt to resolution.</h2>
            <ol className="steps">
              <li className="step"><span className="step-number">01</span><svg className="step-icon" aria-hidden="true"><use href="#i-receipt" /></svg><div><h3 className="step-title">Add a receipt</h3><p className="step-description">Photo, pasted text or a forwarded email — the purchases you want us to watch.</p></div></li>
              <li className="step"><span className="step-number">02</span><svg className="step-icon" aria-hidden="true"><use href="#i-bell" /></svg><div><h3 className="step-title">We watch for recalls</h3><p className="step-description">Get alerted when a recall matches.</p></div></li>
              <li className="step"><span className="step-number">03</span><svg className="step-icon" aria-hidden="true"><use href="#i-send" /></svg><div><h3 className="step-title">Approve your claim</h3><p className="step-description">We prepare it. You review. We send.</p></div></li>
            </ol>
            <div className="how-cta">
              {signedIn ? (
                <button className="button button--orange" onClick={() => goDesk()}>Open my desk <Arrow /></button>
              ) : (
                <button className="button button--orange" onClick={open("welcome")}>Get started <Arrow /></button>
              )}
            </div>
            <SiteFooter open={open} />
          </div>
        </section>
      )}

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
