import { test, expect, afterEach } from "vitest";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk";
import { pipesBotChannelPlugin, resolveApiKey, resolveAppSettings, resolveMode } from "../src/channel.js";
import { updateConnectionStatus } from "../src/status-store.js";
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

test("resolveAppSettings reads allowFrom and poolNumberId", () => {
  expect(resolveAppSettings(cfg({ allowFrom: ["a, b"], poolNumberId: " pn_1 " }))).toEqual({ allowFrom: ["a", "b"], poolNumberId: "pn_1" });
  expect(resolveAppSettings(cfg({ poolNumberId: "" }))).toEqual({ allowFrom: [], poolNumberId: undefined });
});

test("config schema accepts allowFrom and poolNumberId", () => {
  const parsed = PipesBotConfigSchema.parse({ apiKey: "ak_x", allowFrom: ["+5511999990000"], poolNumberId: "pn_1" });
  expect(parsed.allowFrom).toEqual(["+5511999990000"]);
  expect(parsed.poolNumberId).toBe("pn_1");
});

afterEach(() => {
  updateConnectionStatus({ connected: false, authFailed: false, lastError: null });
});

const snapshot = (c: object) =>
  pipesBotChannelPlugin.status!.buildAccountSnapshot!({ account: {} as never, cfg: cfg(c) }) as ChannelAccountSnapshot;

test("snapshot reports app mode and the empty-allowlist error", () => {
  expect(snapshot({ apiKey: "ak_x" })).toMatchObject({ mode: "app", lastError: "No trusted senders configured (allowFrom)" });
});

test("snapshot reports app mode with no error once senders are trusted", () => {
  expect(snapshot({ apiKey: "ak_x", allowFrom: ["+5511999990000"] })).toMatchObject({ mode: "app", lastError: null });
});

test("snapshot reports sandbox mode with no allowlist error", () => {
  expect(snapshot({ apiKey: "pk_x" })).toMatchObject({ mode: "sandbox", lastError: null });
});

test("snapshot omits mode when no valid key is configured", () => {
  const snap = snapshot({});
  expect(snap).not.toHaveProperty("mode");
  expect(snap.lastError).toBeNull();
});

test("auth failure copy mentions both key types", () => {
  updateConnectionStatus({ authFailed: true });
  expect(snapshot({ apiKey: "ak_x" })).toMatchObject({
    running: false,
    lastError: "Authentication failed -- check your API key (pk_ for sandbox, ak_ for a BYON App)",
  });
});

test("connection error outranks the allowlist error", () => {
  updateConnectionStatus({ lastError: "boom" });
  expect(snapshot({ apiKey: "ak_x" }).lastError).toBe("boom");
});
