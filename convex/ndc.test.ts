import { expect, test } from "vitest";
import { extractNdcs, ndcKey, normalizeNdc } from "./ndc";

const NORMALIZED = /^\d{5}-\d{4}-\d{2}$/;

test("normalizeNdc: every print form seen in the corpus lands on 5-4-2", () => {
  // Fixture forms from the spec (real pharmacy receipt + openFDA rows).
  expect(normalizeNdc("NDC 72205-0003-99")).toBe("72205-0003-99"); // 5-4-2, 11-digit
  expect(normalizeNdc("60505-4379-3")).toBe("60505-4379-03"); // 5-4-1
  expect(normalizeNdc("16729-452-17")).toBe("16729-0452-17"); // 5-3-2
  expect(normalizeNdc("0264-7750-00")).toBe("00264-7750-00"); // 4-4-2
  expect(normalizeNdc("72205000399")).toBe("72205-0003-99"); // 11 bare digits
});

test("normalizeNdc: tolerates the receipt's 'NDC#' / 'NDC:' prefixes and whitespace", () => {
  expect(normalizeNdc("NDC#72205-0003-99")).toBe("72205-0003-99");
  expect(normalizeNdc("ndc: 72205-0003-99")).toBe("72205-0003-99");
  expect(normalizeNdc("  NDC # : 72205-0003-99  ")).toBe("72205-0003-99");
  expect(normalizeNdc("NDC 72205000399")).toBe("72205-0003-99");
});

test("normalizeNdc: output is always the 11-digit hyphenated form", () => {
  for (const raw of ["60505-4379-3", "16729-452-17", "0264-7750-00", "72205000399", "1234-123-1"]) {
    const out = normalizeNdc(raw);
    expect(out).not.toBeNull();
    expect(out).toMatch(NORMALIZED);
  }
});

test("normalizeNdc: 10 bare digits are ambiguous and rejected", () => {
  // 4-4-2 / 5-3-2 / 5-4-1 all pack to ten digits — guessing would create
  // false matches on a safety surface.
  expect(normalizeNdc("6050543793")).toBeNull();
  expect(normalizeNdc("0264775000")).toBeNull();
});

test("normalizeNdc: over-long segments, phone numbers, dates and junk are null", () => {
  expect(normalizeNdc("123456-1234-12")).toBeNull(); // labeler > 5
  expect(normalizeNdc("12345-12345-12")).toBeNull(); // product > 4
  expect(normalizeNdc("12345-1234-123")).toBeNull(); // package > 2
  expect(normalizeNdc("203-248-9631")).toBeNull(); // phone 3-3-4
  expect(normalizeNdc("")).toBeNull();
  expect(normalizeNdc("NDC")).toBeNull();
  expect(normalizeNdc("012345678905")).toBeNull(); // a 12-digit UPC
  expect(normalizeNdc("72205-0003")).toBeNull(); // two segments only
});

test("normalizeNdc is a field normalizer, not a text classifier — a 4-2-2 date-shaped string is out of range", () => {
  // "2026-09-11" is 4-2-2: the product segment must be 3-4 digits, so a date
  // the LLM misplaces into the ndc field is dropped, never stored as a code.
  expect(normalizeNdc("2026-09-11")).toBeNull();
  expect(normalizeNdc("1-1-1")).toBeNull();
});

test("extractNdcs: pulls every hyphenated NDC out of FDA-style text, normalized and deduped", () => {
  const productDesc =
    "Rosuvastatin Calcium Tablets, 10 mg, 90-count bottle, NDC 72205-0003-99; " +
    "also NDC 60505-4379-3 and 16729-452-17, 0264-7750-00, and again 72205-0003-99.";
  expect(extractNdcs(productDesc)).toEqual([
    "72205-0003-99",
    "60505-4379-03",
    "16729-0452-17",
    "00264-7750-00",
  ]);
});

test("extractNdcs: works without an NDC prefix and inside the description's Codes: part", () => {
  const description =
    "Failed dissolution. Distribution: Nationwide. Codes: Lot #: D2402443, D2402444; NDC: 60505-4379-3";
  expect(extractNdcs(description)).toEqual(["60505-4379-03"]);
});

test("extractNdcs: never matches phone numbers, dates, lots, UPCs or digit-adjacent runs", () => {
  const text =
    "Call 203-248-9631 or 1-800-555-1234 by 2026-09-11. Lot #: D2402443, D2402444. " +
    "UPC 0 12345 67890 5 and 012345678905. Order 172205-0003-99 (nine digits). Ref 72205-0003-991.";
  expect(extractNdcs(text)).toEqual([]);
});

test("extractNdcs: caps at 50 distinct codes", () => {
  const codes = Array.from({ length: 60 }, (_, i) => `NDC 12345-${String(1000 + i)}-01`);
  const out = extractNdcs(codes.join(", "));
  expect(out).toHaveLength(50);
  expect(new Set(out).size).toBe(50);
});

test("ndcKey: recallUpcs key form is 'ndc:' + normalized code", () => {
  expect(ndcKey("72205-0003-99")).toBe("ndc:72205-0003-99");
  expect(ndcKey(normalizeNdc("NDC 60505-4379-3")!)).toBe("ndc:60505-4379-03");
});
