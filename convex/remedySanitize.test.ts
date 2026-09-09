import { expect, test } from "vitest";
import { looksLikeBotWall, sanitizeClaimEmail, sanitizeClaimUrl } from "./remedySanitize";

const page = "https://www.recallrtr.com/xopowerbank";
const md = "Register at https://www.recallrtr.com/xopowerbank/form today. Contact recall@getcasely.com.";

test("grounded, same-domain claim URLs survive", () => {
  expect(sanitizeClaimUrl("https://www.recallrtr.com/xopowerbank/form", page, md)).toBe(
    "https://www.recallrtr.com/xopowerbank/form",
  );
});

test("hallucinated, cross-domain, and unsafe-scheme URLs are stripped", () => {
  expect(sanitizeClaimUrl("https://www.recallrtr.com/other", page, md)).toBe(""); // not in page
  expect(
    sanitizeClaimUrl("https://secure-recall-refunds.example/claim", page,
      md + " submit at https://secure-recall-refunds.example/claim"),
  ).toBe(""); // grounded but wrong domain
  expect(sanitizeClaimUrl("javascript:alert(1)", page, md + "javascript:alert(1)")).toBe("");
  expect(sanitizeClaimUrl("/relative/form", page, md + "/relative/form")).toBe("");
});

test("claim emails must appear verbatim on the page", () => {
  expect(sanitizeClaimEmail("recall@getcasely.com", md)).toBe("recall@getcasely.com");
  expect(sanitizeClaimEmail("phish@evil.example", md)).toBe("");
});

test("bot walls are detected; real content is not", () => {
  expect(looksLikeBotWall("Just a moment... Checking your browser before accessing.")).toBe(true);
  expect(looksLikeBotWall("Loading... You need to enable JavaScript and cookies to continue")).toBe(true);
  expect(looksLikeBotWall(md.repeat(20))).toBe(false);
});
