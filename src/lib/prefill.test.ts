import { expect, test } from "vitest";
import { prefillFor } from "./prefill";

const src = {
  email: "user@example.com",
  product: "Power Trip Magnetic Wireless Power Bank",
  brand: "XO Poppy",
  model: "PY-PBK5M-TB2",
  upc: "012345678905",
  purchaseDate: "2026-09-02",
  retailer: "Amazon.com",
  quantity: 1,
};

test("maps receipt data onto common remedy-form fields", () => {
  expect(prefillFor("Email address", src)).toBe("user@example.com");
  expect(prefillFor("Model number", src)).toBe("PY-PBK5M-TB2");
  expect(prefillFor("UPC code", src)).toBe("012345678905");
  expect(prefillFor("Date of purchase", src)).toBe("2026-09-02");
  expect(prefillFor("Purchase date", src)).toBe("2026-09-02");
  expect(prefillFor("Place of purchase", src)).toBe("Amazon.com");
  expect(prefillFor("Product description", src)).toContain("XO Poppy");
});

test("never guesses what only the user can provide", () => {
  expect(prefillFor("Full name", src)).toBeNull();
  expect(prefillFor("Serial number", src)).toBeNull();
  expect(prefillFor("Mailing address", src)).toBeNull();
  expect(prefillFor("Photo of the product label", src)).toBeNull();
});
