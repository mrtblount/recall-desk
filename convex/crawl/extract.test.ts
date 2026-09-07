import { expect, test } from "vitest";
import { extractRemedyUrl, remedyCandidates } from "./extract";

test("picks the manufacturer recall portal over gov and social links", () => {
  const md = `
Consumers should stop using the product.
[CPSC.gov](https://www.cpsc.gov/Recalls) [Facebook](https://www.facebook.com/USCPSC)
Contact Louisville Ladder online at [www.atticstairwayrecall.expertinquiry.com](https://atticstairwayrecall.expertinquiry.com/) and click on "Recall Registration".
[Health Canada notice](https://recalls-rappels.canada.ca/en/alert-recall/example)
`;
  expect(extractRemedyUrl(md)).toBe("https://atticstairwayrecall.expertinquiry.com/");
});

test("prefers remedy-texted links over generic company homepages", () => {
  const md = `
Visit [acme.com](https://www.acme.com/) for products.
Consumers can [register for the recall remedy](https://www.acme.com/support/recall-registration) online.
`;
  expect(extractRemedyUrl(md)).toBe("https://www.acme.com/support/recall-registration");
});

test("returns null when only excluded/gov/media links exist", () => {
  const md = `
[CPSC](https://www.cpsc.gov/x) [photo](https://www.cpsc.gov/s3fs-public/img.jpg)
[FDA](https://www.fda.gov/safety) [tweet](https://x.com/USCPSC/status/1)
`;
  expect(extractRemedyUrl(md)).toBeNull();
});

test("scores recall-flavored hostnames above plain ones and dedupes", () => {
  const md = `
[form](https://portal.example.com/start) [form again](https://portal.example.com/start)
[info](https://productrecall.brandsite.com/)
`;
  const c = remedyCandidates(md);
  expect(c[0].url).toBe("https://productrecall.brandsite.com/");
  expect(c).toHaveLength(2);
});
