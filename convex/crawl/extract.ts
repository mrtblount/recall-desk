/**
 * Pure helpers for pulling a manufacturer remedy-portal URL out of a scraped
 * CPSC recall-detail page (markdown). No Convex imports — unit-testable.
 */

const LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

const EXCLUDED_HOSTS = [
  /(^|\.)cpsc\.gov$/i,
  /(^|\.)saferproducts\.gov$/i,
  /(^|\.)recalls-rappels\.canada\.ca$/i,
  /(^|\.)canada\.ca$/i,
  /\.gov$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)youtube\.com$/i,
  /(^|\.)linkedin\.com$/i,
  /(^|\.)tiktok\.com$/i,
  /(^|\.)threads\.net$/i,
  /(^|\.)bsky\.app$/i,
  /(^|\.)mastodon\.[a-z]+$/i,
  // Social-share widgets in CPSC page chrome — their share URLs embed the
  // recall title, which fooled the first version of this scorer.
  /(^|\.)addtoany\.com$/i,
  /(^|\.)addthis\.com$/i,
  /(^|\.)sharethis\.com$/i,
];

const REMEDY_TEXT_RE = /remedy|recall|register|registration|claim|refund|repair|replacement|reimburse/i;
const MEDIA_RE = /\.(jpe?g|png|gif|svg|webp|mp4|css|js)(\?|$)/i;

export type RemedyCandidate = { url: string; text: string; score: number };

/** All plausible off-site links with a relevance score, best first. */
export function remedyCandidates(markdown: string): RemedyCandidate[] {
  const seen = new Set<string>();
  const out: RemedyCandidate[] = [];
  for (const m of markdown.matchAll(LINK_RE)) {
    const text = m[1].trim();
    const url = m[2].trim();
    if (seen.has(url)) continue;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (EXCLUDED_HOSTS.some((re) => re.test(host))) continue;
    if (MEDIA_RE.test(url)) continue;
    // Share/redirect wrappers and anything that embeds a cpsc.gov URL in its
    // query or fragment is page chrome, never a manufacturer remedy page.
    if (/cpsc\.gov/i.test(url) || /[#?]url=/i.test(url)) continue;
    seen.add(url);
    let score = 0;
    if (/recall|remedy|claim/i.test(host)) score += 3;
    if (REMEDY_TEXT_RE.test(text)) score += 2;
    try {
      if (/recall|remedy|claim|register/i.test(new URL(url).pathname)) score += 1;
    } catch {
      /* unreachable: parsed above */
    }
    if (url.startsWith("https://")) score += 1;
    out.push({ url, text, score });
  }
  // Stable: higher score first, earlier occurrence wins ties.
  return out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.score - a.c.score || a.i - b.i)
    .map((x) => x.c);
}

/** A link must carry positive remedy evidence (recall-flavored host, or
 * remedy-flavored text plus another signal) — a bare off-site link is page
 * chrome or a company homepage, and a blocklist arms race never ends. */
export const MIN_REMEDY_SCORE = 3;

/** Best-evidenced manufacturer remedy page, or null. Never invents a URL and
 * never falls back to "some link" — null is the honest answer for notices
 * (e.g. pre-2010 press releases) with no manufacturer link at all. */
export function extractRemedyUrl(markdown: string): string | null {
  const candidates = remedyCandidates(markdown);
  if (candidates.length === 0 || candidates[0].score < MIN_REMEDY_SCORE) {
    return null;
  }
  return candidates[0].url;
}
