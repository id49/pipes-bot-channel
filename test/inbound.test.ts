import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { handleInbound } from "../src/inbound.js";
import { fromLegacyFrame } from "../src/adapters/legacy.js";
import { setPipesBotRuntime } from "../src/runtime.js";
import { legacyFrame } from "./helpers/frames.js";
import { stubLogger } from "./helpers/logger.js";
import { createRuntimeStub } from "./helpers/runtime-stub.js";

let stub: ReturnType<typeof createRuntimeStub>;

beforeEach(() => {
  stub = createRuntimeStub();
  setPipesBotRuntime(stub.core);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("sandbox context is identical to the pre-refactor fields", async () => {
  const msg = fromLegacyFrame(legacyFrame())!;
  const replies: string[] = [];
  await handleInbound(msg, {
    apiKey: "pk_x",
    accountId: "default",
    reply: (t) => (replies.push(t), true),
    logger: stubLogger(),
  });
  expect(stub.contexts[0]).toEqual({
    Body: "oi",
    RawBody: "oi",
    CommandBody: "oi",
    From: "pipes-bot-channel:+5511999990000",
    To: "pipes-bot-channel:+15550001111",
    SessionKey: "default:conv_1",
    AccountId: "default",
    ChatType: "direct",
    SenderName: "Ana",
    SenderId: "+5511999990000",
    Provider: "pipes-bot-channel",
    Surface: "pipes-bot-channel",
    MessageSid: "msg_1",
    Timestamp: Date.parse("2026-11-01T10:00:00.000Z"),
    ConversationLabel: "Ana",
    ReplyToId: undefined,
    OriginatingChannel: "pipes-bot-channel",
    OriginatingTo: "pipes-bot-channel:conv_1",
  });
  expect("CommandAuthorized" in stub.contexts[0]!).toBe(false);
  expect(replies).toEqual(["agent reply"]);
  expect(stub.dispatches).toBe(1);
});

test("sandbox keeps an empty fromName exact", async () => {
  const msg = fromLegacyFrame(legacyFrame({ fromName: "" }))!;
  await handleInbound(msg, {
    apiKey: "pk_x",
    accountId: "default",
    reply: () => true,
    logger: stubLogger(),
  });
  expect(stub.contexts[0]).toMatchObject({ SenderName: "", ConversationLabel: "" });
});

test("commandAuthorized sets CommandAuthorized: true", async () => {
  const msg = fromLegacyFrame(legacyFrame())!;
  await handleInbound(msg, {
    apiKey: "ak_x",
    accountId: "default",
    commandAuthorized: true,
    reply: () => true,
    logger: stubLogger(),
  });
  expect(stub.contexts[0]).toMatchObject({ CommandAuthorized: true });
});

test("media message downloads via downloadUrl", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://r2.example/signed" } }),
    ),
  );
  const msg = fromLegacyFrame(
    legacyFrame({
      type: "image",
      body: "caption",
      media: { downloadUrl: "/v1/media/abc", mimeType: "image/jpeg", byteSize: 1 },
    }),
  )!;
  await handleInbound(msg, {
    apiKey: "pk_x",
    accountId: "default",
    reply: () => true,
    logger: stubLogger(),
  });
  expect(stub.fetchRemoteMedia).toHaveBeenCalledWith(
    expect.objectContaining({ url: "https://r2.example/signed" }),
  );
  expect(stub.contexts[0]).toMatchObject({ MediaPath: "/tmp/saved" });
});

test("mediaUnavailable dispatches text-only without fetching", async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const logger = stubLogger();
  const msg = fromLegacyFrame(
    legacyFrame({
      type: "image",
      body: "caption",
      media: { downloadUrl: "", mimeType: "image/jpeg", byteSize: 0, unavailable: true },
    }),
  )!;
  await handleInbound(msg, {
    apiKey: "pk_x",
    accountId: "default",
    reply: () => true,
    logger,
  });
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(stub.fetchRemoteMedia).not.toHaveBeenCalled();
  expect(stub.dispatches).toBe(1);
  expect(stub.contexts[0]).toMatchObject({ Body: "caption" });
  expect(stub.contexts[0]).not.toHaveProperty("MediaPath");
  expect(
    logger.lines.some((l) => l.level === "warn" && l.message.includes("media unavailable")),
  ).toBe(true);
});
