import { expect, test } from "vitest";
import { isValidGtin } from "./gtin";

test("accepts real UPC-A / EAN-13 / EAN-8 / GTIN-14 codes", () => {
  expect(isValidGtin("036000291452")).toBe(true); // classic UPC-A example
  expect(isValidGtin("012345678905")).toBe(true);
  expect(isValidGtin("4006381333931")).toBe(true); // EAN-13
  expect(isValidGtin("96385074")).toBe(true); // EAN-8
  expect(isValidGtin("10614141000415")).toBe(true); // GTIN-14
  expect(isValidGtin("039645111352")).toBe(true); // Quikrete play sand, from the Home Depot receipt
});

test("rejects wrong check digits, phone numbers, dates, and odd lengths", () => {
  expect(isValidGtin("036000291453")).toBe(false);
  expect(isValidGtin("2032489631")).toBe(false); // 10-digit phone
  expect(isValidGtin("10141975")).toBe(false); // a DOB that happens to be 8 digits
  expect(isValidGtin("12345")).toBe(false);
  expect(isValidGtin("")).toBe(false);
  expect(isValidGtin("abc")).toBe(false);
});
