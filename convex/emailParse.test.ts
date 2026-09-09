import { expect, test } from "vitest";
import { aliasTag, bareAddress, stripControl } from "./emailParse";

test("bareAddress takes the LAST angle group (display-name spoof defeated)", () => {
  expect(bareAddress('"<victim@x.com>" <attacker@evil.com>')).toBe("attacker@evil.com");
  expect(bareAddress("Plain Name <user@x.com>")).toBe("user@x.com");
  expect(bareAddress("user@x.com")).toBe("user@x.com");
  expect(bareAddress("  MiXeD@X.CoM  ")).toBe("mixed@x.com");
});

test("aliasTag matches only a whole recalldesk alias addr-spec", () => {
  expect(aliasTag("recalldesk+abc123@agentmail.to")).toBe("abc123");
  expect(aliasTag("Recall Desk <recalldesk+RNA88K@agentmail.to>")).toBe("rna88k");
  expect(aliasTag("evil-recalldesk+x@agentmail.to")).toBeNull();
  expect(aliasTag("recalldesk+x@agentmail.to.evil.com")).toBeNull();
  expect(aliasTag("recalldesk@agentmail.to")).toBeNull();
});

test("stripControl removes bidi and zero-width characters", () => {
  expect(stripControl("Rock ‮n Play‬​")).toBe("Rock n Play");
});
