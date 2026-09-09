/** Map a remedy form's required-field label to a value we already hold.
 * Conservative: null means "the user provides this" — never guess. */

export type PrefillSource = {
  email?: string | null;
  product?: string;
  brand?: string;
  model?: string;
  upc?: string;
  purchaseDate?: string;
  retailer?: string;
  quantity?: number;
};

export function prefillFor(fieldName: string, src: PrefillSource): string | null {
  const f = fieldName.toLowerCase();
  // Evidence the user must produce themselves — checked FIRST so "photo of
  // the product label" never matches the product rule.
  if (/photo|picture|image|upload|receipt|proof/.test(f)) return null;
  if (/e-?mail/.test(f)) return src.email ?? null;
  if (/\b(model|sku)\b/.test(f)) return src.model ?? null;
  if (/upc|barcode|gtin|ean/.test(f)) return src.upc ?? null;
  if (/serial/.test(f)) return null; // on the product, not the receipt
  if (/(date.*(purchase|order|bought))|((purchase|order).*date)/.test(f)) {
    return src.purchaseDate ?? null;
  }
  if (/retailer|store|where.*(purchas|bought)|place of purchase/.test(f)) {
    return src.retailer ?? null;
  }
  if (/quantity|number of (units|items)/.test(f)) {
    return src.quantity !== undefined ? String(src.quantity) : null;
  }
  if (/brand|manufacturer/.test(f)) return src.brand ?? null;
  if (/product|item|description/.test(f)) {
    return [src.brand, src.product].filter(Boolean).join(" ") || null;
  }
  return null; // names, addresses, phones, photos: always the user's to give
}
