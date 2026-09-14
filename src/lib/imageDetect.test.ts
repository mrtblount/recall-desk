import { expect, test } from "vitest";
import { fitWithin, looksLikeHeic, mimeForKind, sniffImageKind } from "./imageDetect";

const bytes = (...parts: Array<number | string>): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === "number") out.push(p);
    else for (const ch of p) out.push(ch.charCodeAt(0));
  }
  return new Uint8Array(out);
};

test("sniffs JPEG, PNG, WebP, GIF", () => {
  expect(sniffImageKind(bytes(0xff, 0xd8, 0xff, 0xe1, 0, 0, 0, 0, 0, 0, 0, 0))).toBe("jpeg");
  expect(sniffImageKind(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0))).toBe("png");
  expect(sniffImageKind(bytes("RIFF", 0, 0, 0, 0, "WEBP", "VP8 "))).toBe("webp");
  expect(sniffImageKind(bytes("GIF89a", 0, 0, 0, 0, 0, 0))).toBe("gif");
});

test("sniffs HEIC by major brand and by compatible brand", () => {
  // iPhone: size(4) 'ftyp' 'heic' minor(4) compat...
  expect(sniffImageKind(bytes(0, 0, 0, 0x18, "ftyp", "heic", 0, 0, 0, 0, "mif1heic"))).toBe("heic");
  expect(sniffImageKind(bytes(0, 0, 0, 0x18, "ftyp", "mif1", 0, 0, 0, 0, "mif1heic"))).toBe("heic");
  expect(sniffImageKind(bytes(0, 0, 0, 0x18, "ftyp", "heix", 0, 0, 0, 0, "mif1heix"))).toBe("heic");
  // an MP4 is ISO-BMFF too but not HEIF
  expect(sniffImageKind(bytes(0, 0, 0, 0x18, "ftyp", "isom", 0, 0, 0, 0, "isomiso2mp41"))).toBe("unknown");
});

test("short or foreign bytes are unknown", () => {
  expect(sniffImageKind(new Uint8Array(0))).toBe("unknown");
  expect(sniffImageKind(bytes(0xff, 0xd8))).toBe("unknown");
  expect(sniffImageKind(bytes("%PDF-1.7", 0, 0, 0, 0))).toBe("unknown");
});

test("looksLikeHeic by name or type", () => {
  expect(looksLikeHeic({ name: "IMG_7178.HEIC", type: "" })).toBe(true);
  expect(looksLikeHeic({ name: "photo.heif", type: "" })).toBe(true);
  expect(looksLikeHeic({ name: "blob", type: "image/heic" })).toBe(true);
  expect(looksLikeHeic({ name: "IMG_7178.jpeg", type: "image/jpeg" })).toBe(false);
});

test("fitWithin only downscales and keeps aspect", () => {
  expect(fitWithin(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 });
  expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 });
  expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
  expect(fitWithin(0, 0, 2048)).toEqual({ width: 0, height: 0 });
});

test("mimeForKind", () => {
  expect(mimeForKind("jpeg")).toBe("image/jpeg");
  expect(mimeForKind("heic")).toBe("image/heic");
  expect(mimeForKind("unknown")).toBeNull();
});
