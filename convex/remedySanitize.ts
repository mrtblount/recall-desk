/** Pure validation of LLM-extracted remedy procedures against the scraped
 * source. The extracted claim_url becomes a primary CTA in a safety flow —
 * a parked domain or injected page text must never survive into it. */

function baseDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split(".");
  return parts.slice(-2).join(".");
}

/** claim_url survives only if it parses, is http(s), appears VERBATIM in
 * the scraped markdown (grounding — the model cannot mint it), and shares
 * the portal's registrable domain (a page cannot exfiltrate to another
 * host through us). Everything else becomes "". */
export function sanitizeClaimUrl(
  claimUrl: string,
  pageUrl: string,
  markdown: string,
): string {
  if (claimUrl.trim() === "") return "";
  let parsed: URL;
  let page: URL;
  try {
    parsed = new URL(claimUrl);
    page = new URL(pageUrl);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
  if (!markdown.includes(claimUrl)) return "";
  if (baseDomain(parsed.hostname) !== baseDomain(page.hostname)) return "";
  return claimUrl;
}

/** claim_email survives only if it appears verbatim in the page. */
export function sanitizeClaimEmail(claimEmail: string, markdown: string): string {
  const trimmed = claimEmail.trim();
  if (trimmed === "" || !markdown.toLowerCase().includes(trimmed.toLowerCase())) {
    return "";
  }
  return trimmed;
}

const BOT_WALL_RE =
  /just a moment|enable javascript and cookies|checking your browser|cloudflare|access denied|are you a human|verify you are|captcha|attention required/i;

/** A rendered bot-wall/challenge page must not be saved as the remedy page —
 * it would be permanently misread as "portal unreadable". */
export function looksLikeBotWall(markdown: string): boolean {
  const t = markdown.trim();
  return t.length < 600 && BOT_WALL_RE.test(t);
}
