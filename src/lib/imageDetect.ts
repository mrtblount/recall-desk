/**
 * Pure image-container sniffing and sizing math for the upload path.
 * No DOM here so it unit-tests under vitest's edge runtime; the DOM work
 * (decode, canvas, HEIC conversion) lives in imagePrep.ts.
 */

export type ImageKind = "jpeg" | "png" | "webp" | "gif" | "heic" | "unknown";

/** ISO-BMFF brands that mean "HEIF family" — what iPhones write. */
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heif", "mif1", "msf1", "heim", "heis", "avif"]);

function ascii(bytes: Uint8Array, start: number, len: number): string {
  let s = "";
  for (let i = start; i < start + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** Identify the container from the first bytes (≥ 12 needed for HEIC/WebP). */
export function sniffImageKind(bytes: Uint8Array): ImageKind {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && ascii(bytes, 1, 3) === "PNG" && bytes[0] === 0x89) return "png";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (bytes.length >= 6 && ascii(bytes, 0, 4) === "GIF8") return "gif";
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (HEIF_BRANDS.has(brand)) return "heic";
    // Compatible-brands list follows the major brand; iPhone files sometimes
    // lead with "mif1" and list "heic" later — scan the first 64 bytes.
    const head = ascii(bytes, 12, Math.min(52, bytes.length - 12)).toLowerCase();
    for (const b of HEIF_BRANDS) if (head.includes(b)) return "heic";
  }
  return "unknown";
}

/** A file "looks like" HEIC by name or declared type — used before the bytes
 * are read so the UI can label the conversion step honestly. */
export function looksLikeHeic(file: { name: string; type: string }): boolean {
  return /\.hei[cf]$/i.test(file.name) || /^image\/hei[cf]/i.test(file.type);
}

/** Scale (w, h) down so the long edge is at most `max`; never upscales. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max || long === 0) return { width, height };
  const scale = max / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** MIME type for a sniffed kind (what the server will be told). */
export function mimeForKind(kind: ImageKind): string | null {
  switch (kind) {
    case "jpeg": return "image/jpeg";
    case "png": return "image/png";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "heic": return "image/heic";
    default: return null;
  }
}
