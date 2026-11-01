import { test, expect } from "vitest";
import { resolveApiKey, resolveMode } from "../src/channel.js";
import { PipesBotConfigSchema } from "../src/config-schema.js";

const cfg = (c: object) => ({ channels: { "pipes-bot-channel": c } }) as never;

test("resolveApiKey accepts pk_ and ak_ keys", () => {
  expect(resolveApiKey(cfg({ apiKey: "pk_abc" }))).toBe("pk_abc");
  expect(resolveApiKey(cfg({ apiKey: "ak_live_abc" }))).toBe("ak_live_abc");
  expect(resolveApiKey(cfg({ apiKey: "sk_abc" }))).toBeUndefined();
  expect(resolveApiKey(cfg({}))).toBeUndefined();
});

test("resolveMode derives the mode from the key prefix", () => {
  expect(resolveMode("pk_abc")).toBe("sandbox");
  expect(resolveMode("ak_live_abc")).toBe("app");
});

test("config schema accepts allowFrom and poolNumberId", () => {
  const parsed = PipesBotConfigSchema.parse({ apiKey: "ak_x", allowFrom: ["+5511999990000"], poolNumberId: "pn_1" });
  expect(parsed.allowFrom).toEqual(["+5511999990000"]);
  expect(parsed.poolNumberId).toBe("pn_1");
});
