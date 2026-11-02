import { test, expect } from "vitest";
import { Dedupe } from "../src/dedupe.js";

test("second sighting is a duplicate", () => {
  const d = new Dedupe();
  expect(d.seen("evt_1")).toBe(false);
  expect(d.seen("evt_1")).toBe(true);
});

test("entries expire after ttl", () => {
  let t = 0;
  const d = new Dedupe({ ttlMs: 1000, now: () => t });
  d.seen("a");
  t = 1001;
  expect(d.seen("a")).toBe(false);
});

test("an expired entry is re-recorded and dedupes again", () => {
  let t = 0;
  const d = new Dedupe({ ttlMs: 1000, now: () => t });
  d.seen("a");
  t = 1001;
  expect(d.seen("a")).toBe(false);
  expect(d.seen("a")).toBe(true);
});

test("oldest entry is evicted past max", () => {
  const d = new Dedupe({ max: 2 });
  d.seen("a"); d.seen("b"); d.seen("c");
  expect(d.seen("a")).toBe(false);
  expect(d.seen("c")).toBe(true);
});
