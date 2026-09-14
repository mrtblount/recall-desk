import { expect, test } from "vitest";
import { HEIC_BRANDS, sniffImage } from "./imageSniff";

/** Build a byte array from raw byte lists and ASCII strings. */
function bytes(...parts: Array<number[] | string>): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      for (const ch of part) out.push(ch.charCodeAt(0));
    } else {
      out.push(...part);
    }
  }
  return new Uint8Array(out);
}

/** An ISO-BMFF header: 4-byte box size, "ftyp", major brand, minor version. */
function bmff(majorBrand: string, compatible: string[] = []): Uint8Array {
  const size = 16 + compatible.length * 4;
  return bytes(
    [0, 0, 0, size],
    "ftyp",
    majorBrand,
    [0, 0, 0, 0],
    ...compatible,
    // A little payload so the sample is not just a header.
    [0, 0, 0, 8],
    "meta",
  );
}

test("JPEG: ff d8 ff regardless of what follows (JFIF or EXIF)", () => {
  expect(sniffImage(bytes([0xff, 0xd8, 0xff, 0xe0], "JFIF"))).toEqual({
    kind: "raster",
    mime: "image/jpeg",
  });
  expect(sniffImage(bytes([0xff, 0xd8, 0xff, 0xe1], "Exif"))).toEqual({
    kind: "raster",
    mime: "image/jpeg",
  });
});

test("PNG: 89 50 4e 47 signature", () => {
  expect(sniffImage(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({
    kind: "raster",
    mime: "image/png",
  });
});

test("WebP: RIFF....WEBP", () => {
  expect(sniffImage(bytes("RIFF", [0x10, 0x00, 0x00, 0x00], "WEBP", "VP8 "))).toEqual({
    kind: "raster",
    mime: "image/webp",
  });
  // RIFF that is not WebP (a WAV file) is not an image.
  expect(sniffImage(bytes("RIFF", [0x10, 0x00, 0x00, 0x00], "WAVE", "fmt "))).toEqual({
    kind: "unknown",
  });
});

test("GIF: GIF87a and GIF89a", () => {
  expect(sniffImage(bytes("GIF87a", [0x01, 0x00]))).toEqual({ kind: "raster", mime: "image/gif" });
  expect(sniffImage(bytes("GIF89a", [0x01, 0x00]))).toEqual({ kind: "raster", mime: "image/gif" });
});

test("HEIC/HEIF: every ISO-BMFF brand in the family is reported as heic", () => {
  expect([...HEIC_BRANDS].sort()).toEqual(["heic", "heif", "heix", "hevc", "hevx", "mif1", "msf1"]);
  for (const brand of HEIC_BRANDS) {
    expect(sniffImage(bmff(brand, ["mif1", "heic"]))).toEqual({ kind: "heic", brand });
  }
});

test("ISO-BMFF video brands are unknown, not heic", () => {
  for (const brand of ["isom", "mp42", "qt  ", "avif", "M4V "]) {
    expect(sniffImage(bmff(brand))).toEqual({ kind: "unknown" });
  }
});

test("truncated, empty and non-image bytes are unknown", () => {
  expect(sniffImage(new Uint8Array(0))).toEqual({ kind: "unknown" });
  expect(sniffImage(bytes([0xff, 0xd8]))).toEqual({ kind: "unknown" }); // JPEG SOI cut short
  expect(sniffImage(bytes([0x00, 0x00, 0x00, 0x18], "ftyp"))).toEqual({ kind: "unknown" }); // brand missing
  expect(sniffImage(bytes("%PDF-1.7\n"))).toEqual({ kind: "unknown" });
  expect(sniffImage(bytes("<!doctype html>"))).toEqual({ kind: "unknown" });
});

test("the client-declared type plays no part: bytes decide", () => {
  // A .jpg that is secretly a HEIC (AirDrop rename) still sniffs as heic.
  expect(sniffImage(bmff("heic")).kind).toBe("heic");
});
