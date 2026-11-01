import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AppSettings } from "../src/channel.js";
import { setPipesBotRuntime } from "../src/runtime.js";
import { createFrameRouter } from "../src/router.js";
import { loadFixture } from "./helpers/fixtures.js";
import { legacyFrame } from "./helpers/frames.js";
import { stubLogger } from "./helpers/logger.js";
import { createRuntimeStub } from "./helpers/runtime-stub.js";

let stub: ReturnType<typeof createRuntimeStub>;
let logger: ReturnType<typeof stubLogger>;

beforeEach(() => {
  stub = createRuntimeStub();
  setPipesBotRuntime(stub.core);
  logger = stubLogger();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const appRouter = (settings: AppSettings, sent: object[] = [], connected = true) =>
  createFrameRouter({
    mode: "app",
    apiKey: "ak_x",
    send: (f) => (sent.push(f), connected),
    logger,
    loadAppSettings: () => settings,
    newRequestId: () => "req_1",
  });

const warnings = () => logger.lines.filter((l) => l.level === "warn").map((l) => l.message);

test("trusted v2 sender is dispatched with CommandAuthorized and replies with send", async () => {
  const sent: object[] = [];
  await appRouter({ allowFrom: ["16505551234"] }, sent)({ type: "event", data: loadFixture("message-text") });
  expect(stub.contexts[0]).toMatchObject({
    CommandAuthorized: true,
    SessionKey: "default:pn_abc123:US.13491208655302741918",
  });
  expect(sent[0]).toMatchObject({
    type: "send",
    requestId: "req_1",
    poolNumberId: "pn_abc123",
    message: { to: "16505551234", text: { body: "agent reply" } },
  });
});

test("untrusted sender: not dispatched, no fetch, nothing sent, log names ids", async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const sent: object[] = [];
  await appRouter({ allowFrom: ["15559998888"] }, sent)({ type: "event", data: loadFixture("message-image") });
  expect(stub.contexts).toHaveLength(0);
  expect(stub.dispatches).toBe(0);
  expect(stub.fetchRemoteMedia).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(sent).toHaveLength(0);
  expect(logger.lines).toContainEqual({
    level: "info",
    message:
      "pipes-bot-channel: dropping message from untrusted sender phone=16505551234 user_id=US.13491208655302741918 -- add one of these to allowFrom to trust them",
  });
});

test("untrusted log uses - for absent ids", async () => {
  await appRouter({ allowFrom: ["15559998888"] })({ type: "event", data: loadFixture("message-text-bsuid-only") });
  const line = logger.lines.find((l) => l.message.includes("untrusted sender"))!;
  expect(line.message).toMatch(/phone=- user_id=\S+ --/);
});

test("other poolNumberId is ignored", async () => {
  await appRouter({ allowFrom: ["16505551234"], poolNumberId: "pn_other" })({
    type: "event",
    data: loadFixture("message-text"),
  });
  expect(stub.contexts).toHaveLength(0);
  expect(logger.lines).toContainEqual({
    level: "debug",
    message: "pipes-bot-channel: ignoring message for pn_abc123 (poolNumberId filter is pn_other)",
  });
  expect(logger.lines.some((l) => l.message.includes("untrusted"))).toBe(false);
});

test("matching poolNumberId filter lets trusted senders through", async () => {
  await appRouter({ allowFrom: ["16505551234"], poolNumberId: "pn_abc123" })({
    type: "event",
    data: loadFixture("message-text"),
  });
  expect(stub.contexts).toHaveLength(1);
});

test("empty allowFrom drops and warns once", async () => {
  const route = appRouter({ allowFrom: [] });
  await route({ type: "event", data: loadFixture("message-text") });
  await route({ type: "event", data: loadFixture("message-image") });
  expect(stub.contexts).toHaveLength(0);
  expect(warnings()).toEqual([
    "pipes-bot-channel: App mode has no trusted senders (allowFrom is empty) -- dropping all inbound messages",
  ]);
});

test("mixed envelope dispatches only the trusted sender", async () => {
  await appRouter({ allowFrom: ["15559998888"] })({ type: "event", data: loadFixture("message-two-senders") });
  expect(stub.contexts).toHaveLength(1);
  expect(stub.contexts[0]).toMatchObject({ CommandAuthorized: true });
  expect(String(stub.contexts[0].From)).toContain("15559998888");
});

test("one failing message does not drop the others in the envelope", async () => {
  const core = stub.core as unknown as {
    channel: { reply: { finalizeInboundContext: (ctx: Record<string, unknown>) => unknown } };
  };
  const original = core.channel.reply.finalizeInboundContext;
  let calls = 0;
  core.channel.reply.finalizeInboundContext = (ctx) => {
    calls += 1;
    if (calls === 1) throw new Error("boom");
    return original(ctx);
  };
  await appRouter({ allowFrom: ["16505551234", "15559998888"] })({
    type: "event",
    data: loadFixture("message-two-senders"),
  });
  expect(stub.contexts).toHaveLength(1);
  expect(logger.lines).toContainEqual({
    level: "error",
    message: "pipes-bot-channel: frame handling error: Error: boom",
  });
});

test("allowFrom changes apply on the next frame", async () => {
  const settings: AppSettings = { allowFrom: [] };
  const route = appRouter(settings);
  await route({ type: "event", data: loadFixture("message-text") });
  expect(stub.contexts).toHaveLength(0);
  settings.allowFrom = ["16505551234"];
  await route({ type: "event", data: loadFixture("message-image") });
  expect(stub.contexts).toHaveLength(1);
});

test("duplicate envelope and duplicate wamid are dropped", async () => {
  const route = appRouter({ allowFrom: ["16505551234"] });
  await route({ type: "event", data: loadFixture("message-text") });
  await route({ type: "event", data: loadFixture("message-text") });
  await route({ type: "event", data: loadFixture("message-text-username-with-phone") });
  expect(stub.contexts).toHaveLength(1);
});

test("duplicate legacy messageId is dropped", async () => {
  const route = createFrameRouter({
    mode: "sandbox",
    apiKey: "pk_x",
    send: () => true,
    logger,
    loadAppSettings: () => ({ allowFrom: [] }),
  });
  await route(legacyFrame());
  await route(legacyFrame());
  expect(stub.contexts).toHaveLength(1);
});

test("dedupe happens before the gate: an untrusted duplicate logs once", async () => {
  const route = appRouter({ allowFrom: ["15559998888"] });
  await route({ type: "event", data: loadFixture("message-text") });
  await route({ type: "event", data: loadFixture("message-text") });
  expect(logger.lines.filter((l) => l.message.includes("untrusted sender"))).toHaveLength(1);
});

test("send_result failure becomes a system event", async () => {
  const route = appRouter({ allowFrom: ["16505551234"] });
  await route({ type: "event", data: loadFixture("message-text") });
  await route({ type: "send_result", requestId: "req_1", success: false, error: { code: 131047 } });
  expect(stub.systemEvents).toEqual([
    {
      text: "Unable to send reply: the 24-hour WhatsApp messaging window has expired. The contact must send a new message to reopen the conversation.",
      sessionKey: "default:pn_abc123:US.13491208655302741918",
    },
  ]);
});

test("failed status for a sent wamid becomes a system event, once", async () => {
  const route = appRouter({ allowFrom: ["16505551234"] });
  await route({ type: "event", data: loadFixture("message-text") });
  const failed = loadFixture("status-failed") as {
    whatsapp: { statuses: { id: string }[] };
  };
  await route({ type: "send_result", requestId: "req_1", success: true, messageId: failed.whatsapp.statuses[0].id });
  await route({ type: "event", data: failed });
  await route({ type: "event", data: failed });
  expect(stub.systemEvents).toHaveLength(1);
  expect(stub.systemEvents[0].sessionKey).toBe("default:pn_abc123:US.13491208655302741918");
});

test("sandbox frame bypasses the gate and replies with whatsapp_reply", async () => {
  const sent: Record<string, unknown>[] = [];
  const route = createFrameRouter({
    mode: "sandbox",
    apiKey: "pk_x",
    send: (f) => (sent.push(f as Record<string, unknown>), true),
    logger,
    loadAppSettings: () => {
      throw new Error("sandbox must not load app settings");
    },
  });
  await route(legacyFrame());
  expect(stub.contexts).toHaveLength(1);
  expect("CommandAuthorized" in stub.contexts[0]).toBe(false);
  expect(sent[0]).toEqual({
    type: "whatsapp_reply",
    data: { conversationId: "conv_1", poolNumberId: "pool_1", toNumber: "+5511999990000", text: "agent reply" },
  });
});

test("sandbox mode ignores v2 event frames instead of skipping the gate", async () => {
  const route = createFrameRouter({
    mode: "sandbox",
    apiKey: "pk_x",
    send: () => true,
    logger,
    loadAppSettings: () => ({ allowFrom: [] }),
  });
  await route({ type: "event", data: loadFixture("message-text") });
  expect(stub.contexts).toHaveLength(0);
});

test("legacy frame in app mode goes through the gate", async () => {
  const sent: Record<string, unknown>[] = [];
  const route = appRouter({ allowFrom: ["+55 11 99999-0000"] }, sent);
  await route(legacyFrame());
  await route(legacyFrame({ messageId: "msg_2", fromNumber: "+5511888880000" }));
  expect(stub.contexts).toHaveLength(1);
  expect(stub.contexts[0]).toMatchObject({ CommandAuthorized: true });
  expect(sent[0]).toMatchObject({ type: "whatsapp_reply" });
});

test("sandbox skip diagnostics are logged for skipped legacy frames", async () => {
  const route = createFrameRouter({
    mode: "sandbox",
    apiKey: "pk_x",
    send: () => true,
    logger,
    loadAppSettings: () => ({ allowFrom: [] }),
  });
  await route(legacyFrame({ type: "unsupported" }));
  expect(stub.contexts).toHaveLength(0);
  expect(logger.lines).toContainEqual({
    level: "info",
    message: "pipes-bot-channel: skipping message [id=msg_1] [type=unsupported]",
  });
});

test("reply_status frames reach the legacy outbound handler", async () => {
  await appRouter({ allowFrom: [] })({
    type: "reply_status",
    data: { conversationId: "c1", success: true, messageId: "m1" },
  });
  expect(logger.lines.some((l) => l.message.includes("reply delivered to c1"))).toBe(true);
});

test("connected frame logs scope, authType and appId", async () => {
  await appRouter({ allowFrom: [] })({
    type: "connected",
    data: { scope: "app", authType: "app_key", appId: "app_abc123" },
  });
  const line = logger.lines.find((l) => l.message.includes("connected"))!;
  expect(line.level).toBe("info");
  expect(line.message).toContain("scope=app");
  expect(line.message).toContain("authType=app_key");
  expect(line.message).toContain("appId=app_abc123");
});

test("reply while disconnected warns and tracks nothing", async () => {
  const route = appRouter({ allowFrom: ["16505551234"] }, [], false);
  await route({ type: "event", data: loadFixture("message-text") });
  expect(warnings().length).toBeGreaterThan(0);
  await route({ type: "send_result", requestId: "req_1", success: false, error: { code: 131047 } });
  expect(stub.systemEvents).toHaveLength(0);
});

test("malformed frames never throw or dispatch", async () => {
  const route = appRouter({ allowFrom: ["16505551234"] });
  for (const f of [null, "x", {}, { type: "event" }, { type: "event", data: {} }, { type: "send_result" }, { type: "whatsapp_message" }, { type: "nope" }]) {
    await expect(route(f)).resolves.toBeUndefined();
  }
  expect(stub.contexts).toHaveLength(0);
});

test("a throwing settings loader is logged, not thrown", async () => {
  const route = createFrameRouter({
    mode: "app",
    apiKey: "ak_x",
    send: () => true,
    logger,
    loadAppSettings: () => {
      throw new Error("no config");
    },
  });
  await expect(route({ type: "event", data: loadFixture("message-text") })).resolves.toBeUndefined();
  expect(stub.contexts).toHaveLength(0);
  expect(logger.lines).toContainEqual({
    level: "error",
    message: "pipes-bot-channel: frame handling error: Error: no config",
  });
});

test("App mode fails closed when settings are unavailable", async () => {
  const sent: object[] = [];
  const route = createFrameRouter({
    mode: "app",
    apiKey: "ak_x",
    send: (f) => (sent.push(f), true),
    logger,
    loadAppSettings: (() => undefined) as unknown as () => AppSettings,
    newRequestId: () => "req_1",
  });
  await route({ type: "event", data: loadFixture("message-text") });
  await route(legacyFrame());
  expect(stub.contexts).toHaveLength(0);
  expect(stub.dispatches).toBe(0);
  expect(sent).toHaveLength(0);
});
