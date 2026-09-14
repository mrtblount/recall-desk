/**
 * Browser-side receipt image preparation: converts iPhone HEIC to JPEG,
 * fixes EXIF orientation, downscales to the vision model's useful maximum,
 * and strips metadata (EXIF/GPS) before upload.
 *
 * Why every photo goes through a canvas (not just HEIC):
 *  - Browsers apply EXIF orientation when drawing an <img> to a canvas
 *    (Chrome 81+, Safari 13.1+, Firefox 77+) and canvas.toBlob output carries
 *    no EXIF. The vision model ignores orientation metadata and misreads
 *    rotated text, so the re-encode is what makes the receipt readable — and
 *    it drops the GPS tag as a side effect.
 *  - The model caps high-detail input at 2048 px on the long edge; receipts
 *    need that small print, so we downscale to exactly that, never below.
 *
 * Pure sniffing/sizing helpers live in ./imageDetect (unit-tested, no DOM).
 */
import { fitWithin, looksLikeHeic, sniffImageKind, type ImageKind } from "./imageDetect";

export class ImagePrepError extends Error {
  userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = "ImagePrepError";
    this.userMessage = userMessage;
  }
}

export type PreparedImage = {
  blob: Blob;
  name: string;
  /** "heic" = converted from HEIC, "resized" = re-encoded/downscaled, "none" = passed through. */
  converted: "heic" | "resized" | "none";
  width: number;
  height: number;
};

type Stage = "converting" | "resizing";

const MB = 1024 * 1024;
const MAX_INPUT_BYTES = 50 * MB;
const MAX_LONG_EDGE = 2048;
const PNG_PASSTHROUGH_MAX_BYTES = 4 * MB;
const JPEG_QUALITY = 0.85;
const JPEG_RETRY_QUALITY = 0.7;
const JPEG_RETRY_OVER_BYTES = 6 * MB;
/** Real iPhone 16 Pro HEICs convert in ~1.3 s; 45 s is a dead-worker detector, not a budget. */
const HEIC_TIMEOUT_MS = 45_000;

const MSG = {
  tooLarge: "That photo is too large (50 MB max).",
  unreadable: "We couldn't read that file — use a photo (JPG, PNG, HEIC) or a screenshot.",
  heicFailed: "We couldn't convert that iPhone photo — try taking it again with the camera option, or share it as JPEG.",
  undecodable: "That image couldn't be opened — try another photo or a screenshot.",
} as const;

export async function prepareReceiptImage(
  file: File,
  onProgress?: (stage: Stage) => void,
): Promise<PreparedImage> {
  if (file.size > MAX_INPUT_BYTES) throw new ImagePrepError(MSG.tooLarge);

  // File.type is "" for .heic on Windows, so trust the bytes; the name/type
  // only break ties when the container is unrecognised.
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  let kind: ImageKind = sniffImageKind(head);
  if (kind === "unknown") {
    if (!looksLikeHeic(file)) throw new ImagePrepError(MSG.unreadable);
    kind = "heic";
  }

  const img = kind === "heic" ? await decodeHeic(file, onProgress) : await decodeOrThrow(file);
  const { naturalWidth: srcW, naturalHeight: srcH } = img;

  // Screenshots of order pages compress better lossless, and small PNGs carry
  // no EXIF, so leave them alone; anything bigger gets the JPEG treatment.
  if (kind === "png" && file.size <= PNG_PASSTHROUGH_MAX_BYTES && Math.max(srcW, srcH) <= MAX_LONG_EDGE) {
    return { blob: file, name: `${baseName(file.name)}.png`, converted: "none", width: srcW, height: srcH };
  }

  onProgress?.("resizing");
  const { width, height } = fitWithin(srcW, srcH, MAX_LONG_EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImagePrepError(MSG.undecodable);
  // JPEG has no alpha: fill first so transparent PNG regions become white, not black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  let blob = await toJpeg(canvas, JPEG_QUALITY);
  if (blob.size > JPEG_RETRY_OVER_BYTES) blob = await toJpeg(canvas, JPEG_RETRY_QUALITY);
  canvas.width = canvas.height = 0; // release the bitmap eagerly on memory-tight phones

  return {
    blob,
    name: `${baseName(file.name)}.jpg`,
    converted: kind === "heic" ? "heic" : "resized",
    width,
    height,
  };
}

async function decodeOrThrow(blob: Blob): Promise<HTMLImageElement> {
  try {
    return await loadImage(blob);
  } catch {
    throw new ImagePrepError(MSG.undecodable);
  }
}

/**
 * Safari 17+ decodes HEIC natively, so try <img> first and only pull the
 * ~3 MB libheif chunk when that fails (Chromium and Firefox always fail).
 */
async function decodeHeic(file: File, onProgress?: (stage: Stage) => void): Promise<HTMLImageElement> {
  try {
    return await loadImage(file);
  } catch {
    /* fall through to the library */
  }
  onProgress?.("converting");
  let jpeg: Blob;
  try {
    jpeg = await convertHeicToJpeg(file);
  } catch {
    // Covers: dynamic import failing (offline), libheif rejecting the file,
    // a dead worker (rejects with `undefined`), and the timeout.
    throw new ImagePrepError(MSG.heicFailed);
  }
  return decodeOrThrow(jpeg);
}

// heic-to runs libheif (wasm2js) in a worker it caches module-wide. If that
// worker fails to start, the first call rejects with `undefined` and every
// later call hangs forever — hence: one call at a time, a hard timeout, and a
// sticky "dead" flag so retries fail fast instead of waiting 45 s each.
let heicQueue: Promise<unknown> = Promise.resolve();
let heicWorkerDead = false;

function convertHeicToJpeg(file: File): Promise<Blob> {
  const task = async (): Promise<Blob> => {
    if (heicWorkerDead) throw new Error("heic worker is dead");
    // "heic-to/csp" is the eval-free build: same API, no 'unsafe-eval' needed.
    const { heicTo } = await import("heic-to/csp");
    try {
      // 0.92 is an intermediate; prepareReceiptImage re-encodes via canvas at 0.85.
      return await withTimeout(heicTo({ blob: file, type: "image/jpeg", quality: 0.92 }), HEIC_TIMEOUT_MS);
    } catch (err) {
      if (err === undefined || err instanceof TimeoutError) heicWorkerDead = true;
      throw err;
    }
  };
  const run = heicQueue.then(task, task);
  heicQueue = run.catch(() => undefined);
  return run;
}

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** Decode a blob into an <img>; rejects when the browser can't read the format. */
async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image failed to load"));
      img.src = url;
    });
    // decode() rasterises off the main thread; on a huge image it can reject
    // even though the load succeeded, in which case drawImage decodes lazily.
    await img.decode().catch(() => undefined);
    if (img.naturalWidth === 0 || img.naturalHeight === 0) throw new Error("image decoded to nothing");
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const fail = () => reject(new ImagePrepError(MSG.undecodable));
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : fail()), "image/jpeg", quality);
    } catch {
      fail(); // toBlob throws synchronously on a zero-sized or tainted canvas
    }
  });
}

function baseName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").trim();
  return base || "receipt";
}
