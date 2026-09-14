import { expect, test } from "vitest";
import { CANDIDATE_MIN_SCORE, hasWholeToken, itemRecallScore } from "./matchScore";

const powerBankRecall = {
  title:
    "Truststone Group Recalls XO Poppy Power Trip Magnetic Wireless Power Banks Due to Fire and Burn Hazards; Sold Exclusively at TJX and Marshalls Stores",
  brandNames: ["Truststone Group"],
  productDesc: "XO Poppy Power Trip Magnetic Wireless Power Bank (model PY-PBK5M-TB2)",
  upcs: [],
  ndcs: [],
  codeText: "",
};

/** Shaped like a real openFDA drug row after mapFdaRecord: NDC in the
 * product text, lots in the description's "Codes:" tail. */
const rosuvastatinRecall = {
  title: "Rosuvastatin Calcium Tablets, 10 mg, 90 count bottle, Rx only, NDC 60505-4379-3",
  brandNames: ["Apotex Corp."],
  productDesc: "Rosuvastatin Calcium Tablets, 10 mg, 90 count bottle, Rx only, NDC 60505-4379-3",
  upcs: [],
  ndcs: ["60505-4379-03"],
  codeText:
    "Failed dissolution specifications. Distribution: Nationwide. Codes: Lot #: D2402443, D2402444, Exp 03/2027",
};

test("recalled power bank scores far above threshold via model + product", () => {
  const { score, reasons } = itemRecallScore({
    item: {
      product: "Poppy Power Trip Magnetic Wireless Power Bank, Teddy Bear Print",
      brand: "XO Poppy",
      model: "PY-PBK5M-TB2",
    },
    recall: powerBankRecall,
  });
  expect(score).toBeGreaterThan(CANDIDATE_MIN_SCORE * 2);
  expect(reasons.join(" ")).toContain("PY-PBK5M-TB2");
});

test("unrelated product stays below threshold", () => {
  const { score } = itemRecallScore({
    item: { product: "30W USB-C Charger", brand: "Anker", model: "A2337" },
    recall: powerBankRecall,
  });
  expect(score).toBeLessThan(CANDIDATE_MIN_SCORE);
});

test("UPC equality dominates", () => {
  const { score, reasons } = itemRecallScore({
    item: { product: "Mystery Widget", upc: "012345678905" },
    recall: { ...powerBankRecall, upcs: ["012345678905"] },
  });
  expect(score).toBeGreaterThanOrEqual(100);
  expect(reasons[0]).toContain("UPC");
});

test("NDC listed in the recall is a candidate on its own (+60), text overlap or not", () => {
  const { score, reasons } = itemRecallScore({
    item: { product: "Rx fill", ndc: "60505-4379-03" },
    recall: rosuvastatinRecall,
  });
  expect(score).toBeGreaterThanOrEqual(60);
  expect(score).toBeGreaterThan(CANDIDATE_MIN_SCORE);
  expect(reasons).toContain("NDC 60505-4379-03 listed in the recall");
});

test("same drug, different labeler/NDC gets no NDC credit", () => {
  const { score, reasons } = itemRecallScore({
    item: {
      product: "Rosuvastatin Calcium 10 mg tablets",
      brand: "Novadoz Pharmaceuticals",
      ndc: "72205-0003-99",
    },
    recall: rosuvastatinRecall,
  });
  expect(reasons.join(" ")).not.toContain("NDC");
  // Product words still overlap (rosuvastatin, calcium, tablets, ...) —
  // that's the prefilter's job; the adjudicator says no on the NDC mismatch.
  expect(score).toBeLessThan(60);
});

test("lot listed in the FDA Codes: tail scores +40, case-insensitive, whole token only", () => {
  const hit = itemRecallScore({
    item: { product: "Rx fill", lot: "d2402444" },
    recall: rosuvastatinRecall,
  });
  expect(hit.score).toBeGreaterThanOrEqual(40);
  expect(hit.reasons).toContain("lot d2402444 listed in the recall");

  // A digit-substring of a listed lot is not that lot.
  const substring = itemRecallScore({
    item: { product: "Rx fill", lot: "2402444" },
    recall: rosuvastatinRecall,
  });
  expect(substring.reasons.join(" ")).not.toContain("lot");
  expect(substring.score).toBe(0);
});

test("lots shorter than 4 characters are ignored", () => {
  const { score, reasons } = itemRecallScore({
    item: { product: "Rx fill", lot: "D24" },
    recall: { ...rosuvastatinRecall, codeText: "Codes: Lot D24" },
  });
  expect(score).toBe(0);
  expect(reasons).toEqual([]);
});

test("lot is also found in title / productDesc, not only codeText", () => {
  const { score } = itemRecallScore({
    item: { product: "Rx fill", lot: "AB12345" },
    recall: { ...powerBankRecall, productDesc: "Widget, lot AB12345 only", codeText: "" },
  });
  expect(score).toBeGreaterThanOrEqual(40);
});

test("NDC + lot together outrank a bare product-word match", () => {
  const exact = itemRecallScore({
    item: {
      product: "Rosuvastatin Calcium 10 mg tablets",
      brand: "Apotex",
      ndc: "60505-4379-03",
      lot: "D2402443",
    },
    recall: rosuvastatinRecall,
  });
  const wordsOnly = itemRecallScore({
    item: { product: "Rosuvastatin Calcium 10 mg tablets", brand: "Apotex" },
    recall: rosuvastatinRecall,
  });
  expect(exact.score - wordsOnly.score).toBe(100);
  expect(exact.reasons.slice(0, 2)).toEqual([
    "NDC 60505-4379-03 listed in the recall",
    "lot D2402443 listed in the recall",
  ]);
});

test("hasWholeToken: alphanumeric boundaries, regex metacharacters escaped", () => {
  expect(hasWholeToken("Lot #: D2402443, D2402444", "D2402443")).toBe(true);
  expect(hasWholeToken("Lot #: D2402443, D2402444", "d2402444")).toBe(true);
  expect(hasWholeToken("Lot #: D2402443", "2402443")).toBe(false);
  expect(hasWholeToken("Lot #: D24024431", "D2402443")).toBe(false);
  expect(hasWholeToken("lots A-12 and A-13 (batch 7)", "A-12")).toBe(true);
  expect(hasWholeToken("lots A-12 and A-13", "A.12")).toBe(false); // dot is literal, not wildcard
  expect(hasWholeToken("batch (7)", "(7)")).toBe(true);
});
