/** Pure inbound-mail parsing helpers — unit-tested, no Convex imports. */

/**
 * Extract the addr-spec from a formatted address. Uses the LAST angle-bracket
 * group: RFC5322 puts the real address there, and an attacker can plant a
 * fake "<victim@x.com>" inside the quoted display name (review finding —
 * first-group extraction was exploitable even by DMARC-passing mail).
 */
export function bareAddress(formatted: string): string {
  const matches = [...formatted.matchAll(/<([^<>]*)>/g)];
  const raw = matches.length > 0 ? matches[matches.length - 1][1] : formatted;
  return raw.trim().toLowerCase();
}

const ALIAS_TAG_RE = /^recalldesk\+([a-z0-9]+)@agentmail\.to$/i;

/** The routing tag from a recipient address, or null. Matches the WHOLE
 * addr-spec so junk around the alias can't smuggle a tag. */
export function aliasTag(recipient: string): string | null {
  const m = ALIAS_TAG_RE.exec(bareAddress(recipient));
  return m ? m[1].toLowerCase() : null;
}

export const RECEIPT_HINT_RE =
  /receipt|order|invoice|purchase|confirmation|shipped|delivery|your (order|package)/i;

/** Strip bidi/format control characters that can visually spoof strings
 * rendered in the UI (U+202A–U+202E, U+2066–U+2069, zero-widths). */
export function stripControl(s: string): string {
  return s.replace(/[‪-‮⁦-⁩​-‏﻿]/g, "");
}
