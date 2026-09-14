/**
 * Magic-byte sniffing for uploaded receipt / product photos. Pure module: no
 * Convex imports, unit-tested in imageSniff.test.ts.
 *
 * WHY: the browser's blob.type is client-supplied and frequently wrong or
 * empty (an AirDropped .HEIC opened in desktop Chrome arrives as "" or
 * "image/heic"), and OpenAI's vision input rejects anything that is not a real
 * JPEG / PNG / WebP / GIF. Sniffing the container lets the server (a) label
 * the data URL with the TRUE type and (b) tell the user exactly why an iPhone
 * photo could not be read instead of a generic "couldn't read that receipt".
 */

export type RasterMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export type ImageSniff =
  | { kind: "raster"; mime: RasterMime }
  | { kind: "heic"; brand: string }
  | { kind: "unknown" };

/** ISO-BMFF major brands that mean HEIC/HEIF — the iPhone camera default
 * ("heic"), HEVC image sequences / Live Photos ("hevc", "msf1"), and the
 * generic HEIF brands. MP4/MOV brands (isom, mp42, qt) are deliberately NOT
 * here: a video is "unknown", not an iPhone photo. */
export const HEIC_BRANDS: ReadonlySet<string> = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heif",
  "mif1",
  "msf1",
]);

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let s = "";
  for (let i = start; i < start + length && i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

/** Identify an image container from its leading bytes. */
export function sniffImage(bytes: Uint8Array): ImageSniff {
  // JPEG: SOI marker ff d8 followed by another marker byte ff.
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: "raster", mime: "image/jpeg" };
  }
  // PNG: 89 'P' 'N' 'G' (the full signature continues 0d 0a 1a 0a).
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { kind: "raster", mime: "image/png" };
  }
  // WebP: RIFF container whose form type (bytes 8..12) is "WEBP".
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return { kind: "raster", mime: "image/webp" };
  }
  // GIF: "GIF87a" / "GIF89a".
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "GIF8") {
    return { kind: "raster", mime: "image/gif" };
  }
  // ISO-BMFF: box size (4 bytes) then "ftyp" then the 4-char major brand.
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (HEIC_BRANDS.has(brand)) return { kind: "heic", brand };
  }
  return { kind: "unknown" };
}
