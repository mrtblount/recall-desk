import { expect, test } from "vitest";
import { CANDIDATE_MIN_SCORE, itemRecallScore } from "./matchScore";

const powerBankRecall = {
  title:
    "Truststone Group Recalls XO Poppy Power Trip Magnetic Wireless Power Banks Due to Fire and Burn Hazards; Sold Exclusively at TJX and Marshalls Stores",
  brandNames: ["Truststone Group"],
  productDesc: "XO Poppy Power Trip Magnetic Wireless Power Bank (model PY-PBK5M-TB2)",
  upcs: [],
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
