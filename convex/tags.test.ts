import { expect, test } from "vitest";
import { userTagFromSeed } from "./tags";

test("tags are deterministic, 6 chars, safe alphabet", () => {
  const a = userTagFromSeed("users:abc123:0");
  expect(a).toBe(userTagFromSeed("users:abc123:0"));
  expect(a).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/);
  expect(userTagFromSeed("users:abc123:1")).not.toBe(a);
  expect(userTagFromSeed("users:other:0")).not.toBe(a);
});

test("tag distribution has no quick collisions", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) seen.add(userTagFromSeed(`seed:${i}`));
  expect(seen.size).toBeGreaterThan(4990);
});
