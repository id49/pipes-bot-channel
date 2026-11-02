import { test, expect } from "vitest";
import { isTrustedSender, parseAllowFrom } from "../src/trust.js";

test("phone entries match regardless of formatting", () => {
  expect(isTrustedSender({ phone: "5511999990000" }, ["+55 (11) 99999-0000"])).toBe(true);
  expect(isTrustedSender({ phone: "+5511999990000" }, ["5511999990000"])).toBe(true);
  expect(isTrustedSender({ phone: "5511999990001" }, ["5511999990000"])).toBe(false);
});

test("BSUID entries match userId or parentUserId exactly", () => {
  expect(isTrustedSender({ userId: "US.13491208655302741918" }, ["US.13491208655302741918"])).toBe(true);
  expect(isTrustedSender({ parentUserId: "US.ENT.11815799212886844830" }, [" US.ENT.11815799212886844830 "])).toBe(true);
  expect(isTrustedSender({ userId: "US.13491208655302741918" }, ["US.1349120865530274191"])).toBe(false);
});

test("a BSUID entry never matches a phone by digits", () => {
  expect(isTrustedSender({ phone: "13491208655302741918" }, ["US.13491208655302741918"])).toBe(false);
});

test("a phone written with dots still matches by digits", () => {
  expect(isTrustedSender({ phone: "5511999990000" }, ["55.11.99999-0000"])).toBe(true);
  expect(isTrustedSender({ phone: "5511999990000" }, ["+55 11 99999.0000"])).toBe(true);
});

test("Brazilian mobiles match with or without the ninth digit", () => {
  expect(isTrustedSender({ phone: "551187654321" }, ["+55 11 98765-4321"])).toBe(true);
  expect(isTrustedSender({ phone: "5511987654321" }, ["+55 11 8765-4321"])).toBe(true);
  expect(isTrustedSender({ phone: "5511987654321" }, ["5511987654321"])).toBe(true);
  expect(isTrustedSender({ phone: "552197654321" }, ["5511987654321"])).toBe(false);
});

test("Brazilian landlines never match a mobile with the ninth digit", () => {
  expect(isTrustedSender({ phone: "551133334444" }, ["5511933334444"])).toBe(false);
  expect(isTrustedSender({ phone: "5511933334444" }, ["551133334444"])).toBe(false);
});

test("the ninth-digit rule applies to Brazil only", () => {
  expect(isTrustedSender({ phone: "541187654321" }, ["5411987654321"])).toBe(false);
});

test("empty list and digitless entries never match", () => {
  expect(isTrustedSender({ phone: "5511999990000" }, [])).toBe(false);
  expect(isTrustedSender({ phone: "" }, ["abc"])).toBe(false);
  expect(isTrustedSender({ phone: "" }, [""])).toBe(false);
  expect(isTrustedSender({}, ["5511999990000"])).toBe(false);
});

test("parseAllowFrom splits comma-separated entries", () => {
  expect(parseAllowFrom(["+55 11 99999-0000, US.123", " ", "15550001111;16505551234"]))
    .toEqual(["+55 11 99999-0000", "US.123", "15550001111", "16505551234"]);
  expect(parseAllowFrom("5511999990000")).toEqual(["5511999990000"]);
  expect(parseAllowFrom(undefined)).toEqual([]);
  expect(parseAllowFrom(42)).toEqual([]);
});

test("parseAllowFrom ignores non-string elements inside an array", () => {
  expect(parseAllowFrom(["5511999990000", 42, null, { phone: "x" }])).toEqual(["5511999990000"]);
});
