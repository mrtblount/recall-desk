/** Deterministic short tags for ingest aliases. Pure — unit-tested. */

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o/1/l/i

/** FNV-1a 32-bit over the seed, rendered as 6 chars of a safe alphabet.
 * Deterministic (mutations must not use randomness); collisions are handled
 * by the caller re-deriving with a bumped seed. */
export function userTagFromSeed(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[hash % ALPHABET.length];
    hash = Math.floor(hash / ALPHABET.length);
  }
  return out;
}
