/** GTIN (UPC-A / EAN-13 / EAN-8 / GTIN-14) validity — pure, unit-tested.
 * The extractor is told "digits only", but a phone number or a date of birth
 * it misplaces into the upc field would otherwise become an exact-match
 * lookup key; the mod-10 check digit rejects almost all of those. */
export function isValidGtin(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  let sum = 0;
  // Weights alternate 3,1,3,1… starting from the digit LEFT of the check digit.
  for (let i = digits.length - 2, w = 3; i >= 0; i--, w = 4 - w) {
    sum += Number(digits[i]) * w;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits[digits.length - 1]);
}
