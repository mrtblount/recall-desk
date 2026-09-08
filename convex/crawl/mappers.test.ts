import { expect, test } from "vitest";
import { extractUpcsFromText, mapFdaRecord } from "./fda";
import { extractFsisRemedy, mapFsisRecord, stripHtml } from "./fsis";

const fdaRecord = {
  recall_number: "H-1258-2026",
  product_description: "Glutinous Rice Balls NET WT. 14.1 OZ UPC: 6908791000053",
  reason_for_recall: "Potential contamination with Burkholderia cepacia.",
  recalling_firm: "H & U Inc. dba Sun Noodle",
  classification: "Class II",
  status: "Ongoing",
  distribution_pattern: "FL, MI, MS, and OH.",
  report_date: "20260902",
  code_info: "UPC No. 632687615989; Lot No. 30661601.",
  product_quantity: "1,990 bottles",
  voluntary_mandated: "Voluntary: Firm initiated",
  initial_firm_notification: "Letter",
};

test("FDA mapper: full record", () => {
  const doc = mapFdaRecord(fdaRecord)!;
  expect(doc.source).toBe("fda");
  expect(doc.sourceId).toBe("H-1258-2026");
  expect(doc.publishedAt).toBe(Date.parse("2026-09-02T00:00:00Z"));
  expect(doc.hazard).toContain("Class II");
  expect(doc.upcs).toContain("632687615989");
  expect(doc.upcs).toContain("6908791000053");
  expect(doc.statusOverride).toBe("active");
  expect(doc.brandNames).toEqual(["H & U Inc. dba Sun Noodle"]);
});

test("FDA mapper: Terminated maps to closed; degenerate ids skipped", () => {
  expect(mapFdaRecord({ ...fdaRecord, status: "Terminated" })!.statusOverride).toBe("closed");
  expect(mapFdaRecord({ ...fdaRecord, status: "Completed" })!.statusOverride).toBe("closed");
  expect(mapFdaRecord({ ...fdaRecord, recall_number: "N/A" })).toBeNull();
  expect(mapFdaRecord({ ...fdaRecord, recall_number: "" })).toBeNull();
  expect(mapFdaRecord({ ...fdaRecord, report_date: "not-a-date" })).toBeNull();
});

test("FDA mapper: missing more_code_info key is fine (skeptic-verified shape)", () => {
  const doc = mapFdaRecord({ ...fdaRecord, more_code_info: undefined })!;
  expect(doc.upcs.length).toBeGreaterThan(0);
});

test("UPC extraction handles GTIN and separators", () => {
  expect(extractUpcsFromText("GTIN: 20884521128009 and UPC No. 6 32687-61598 9")).toEqual([
    "20884521128009",
    "632687615989",
  ]);
});

const fsisRecord = {
  langcode: "English",
  field_recall_number: "007-2020-EXP ",
  field_title: "Ferrarini USA &amp; Co. Recalls Imported Meat &#039;Products&#039;",
  field_recall_date: "2026-09-06",
  field_recall_type: "Active Recall",
  field_risk_level: "High - Class I",
  field_recall_reason: ["Product Contamination"],
  field_summary:
    "<p><strong>WASHINGTON,&nbsp;</strong>Sept. 06, 2026 – Prime Line is recalling ham. Consumers who have purchased these products are urged not to consume them. These products should be thrown away or returned to the place of purchase.</p>",
  field_product_items: ["•\tCardboard cases containing two pieces of ham"],
  field_states: ["Texas", "Idaho", "Texas"],
  field_recall_url: "http://www.fsis.usda.gov/recalls-alerts/example",
};

test("FSIS mapper: Active Recall asserts active (reopen path)", () => {
  const doc = mapFsisRecord({ ...fsisRecord, field_recall_number: "019-2026" })!;
  expect(doc.statusOverride).toBe("active");
  expect(doc.hazard).toBe("Product Contamination (High - Class I)");
});

test("FSIS mapper: trims id, detects -EXP expansion despite trailing space", () => {
  const doc = mapFsisRecord(fsisRecord)!;
  expect(doc.sourceId).toBe("007-2020-EXP");
  expect(doc.statusOverride).toBe("expanded");
  expect(doc.title).toBe("Ferrarini USA & Co. Recalls Imported Meat 'Products'");
  expect(doc.url).toBe("https://www.fsis.usda.gov/recalls-alerts/example");
  expect(doc.productDesc).toBe("Cardboard cases containing two pieces of ham");
  expect(doc.unitsText).toBe("Distributed in 2 states");
  expect(doc.remedySummary).toContain("urged not to consume");
  expect(doc.remedySummary).toContain("thrown away or returned");
});

test("FSIS mapper: Closed Recall -> closed; Spanish rows skipped", () => {
  expect(
    mapFsisRecord({ ...fsisRecord, field_recall_number: "019-2026", field_recall_type: "Closed Recall" })!
      .statusOverride,
  ).toBe("closed");
  expect(mapFsisRecord({ ...fsisRecord, langcode: "Spanish" })).toBeNull();
});

test("FSIS helpers: entity decoding and remedy extraction stay verbatim", () => {
  expect(stripHtml("<p>a&nbsp;&amp;&nbsp;b</p>")).toBe("a & b");
  expect(extractFsisRemedy("Intro. Nothing relevant here.")).toBe("");
});
