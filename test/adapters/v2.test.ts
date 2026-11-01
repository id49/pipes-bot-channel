import { expect, test } from "vitest";
import { parseV2Envelope } from "../../src/adapters/v2.js";
import { isV2EventFrame, isV2SendResult } from "../../src/types.js";
import { loadFixture } from "../helpers/fixtures.js";

const BSUID = "US.13491208655302741918";

test("message-text: phone and BSUID sender", () => {
  const r = parseV2Envelope(loadFixture("message-text"));
  expect(r.envelopeId).toBe("evt_0f1e2d3c4b5a69788796a5b4c3d2e1f0");
  expect(r.poolNumberId).toBe("pn_abc123");
  expect(r.messages).toHaveLength(1);
  expect(r.messages[0]).toEqual({
    messageId: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
    poolNumberId: "pn_abc123",
    type: "text",
    body: "Does it come in another color?",
    sender: { phone: "16505551234", userId: BSUID, name: "Sheena Nelson" },
    senderId: BSUID,
    toId: "15550001111",
    peerId: `pn_abc123:${BSUID}`,
    sessionKey: `default:pn_abc123:${BSUID}`,
    timestamp: 1749416383000,
    replyTarget: { kind: "v2", poolNumberId: "pn_abc123", to: "16505551234" },
  });
});

test("message-text-username-with-phone: still replies to the phone", () => {
  const [m] = parseV2Envelope(loadFixture("message-text-username-with-phone")).messages;
  expect(m.sender).toEqual({ phone: "16505551234", userId: BSUID, name: "Sheena Nelson" });
  expect(m.replyTarget).toEqual({ kind: "v2", poolNumberId: "pn_abc123", to: "16505551234" });
});

test("message-text-bsuid-only: replies with recipient", () => {
  const [m] = parseV2Envelope(loadFixture("message-text-bsuid-only")).messages;
  expect(m.sender).toEqual({ userId: BSUID, name: "Sheena Nelson" });
  expect(m.senderId).toBe(BSUID);
  expect(m.replyTarget).toEqual({ kind: "v2", poolNumberId: "pn_abc123", recipient: BSUID });
  expect(m.replyTarget).not.toHaveProperty("to");
});

test("message-text-parent-bsuid: carries parentUserId", () => {
  const [m] = parseV2Envelope(loadFixture("message-text-parent-bsuid")).messages;
  expect(m.sender.parentUserId).toBe("US.ENT.11815799212886844830");
});

test("message-image: media from pipes.media with caption", () => {
  const [m] = parseV2Envelope(loadFixture("message-image")).messages;
  expect(m.type).toBe("image");
  expect(m.body).toBe("Do you have this one in blue?");
  expect(m.media).toEqual({ downloadUrl: "/v1/media/download/aBcDeFgHiJkLmNoPqRs1t", mimeType: "image/jpeg" });
  expect(m).not.toHaveProperty("mediaUnavailable");
});

test("message-image-unavailable: mediaUnavailable, no media", () => {
  const [m] = parseV2Envelope(loadFixture("message-image-unavailable")).messages;
  expect(m.type).toBe("image");
  expect(m.mediaUnavailable).toBe(true);
  expect(m).not.toHaveProperty("media");
});

test("media without a pipes.media entry is unavailable", () => {
  const env = loadFixture("message-image") as { pipes: { media: Record<string, unknown> } };
  env.pipes.media = {};
  const [m] = parseV2Envelope(env).messages;
  expect(m.mediaUnavailable).toBe(true);
  expect(m).not.toHaveProperty("media");
});

test("document media: mimeType and fileName fall back to the Meta object", () => {
  const env = loadFixture("message-image") as any;
  env.pipes.media = { doc1: { downloadUrl: "/v1/media/download/doc1" } };
  env.whatsapp.messages[0] = {
    ...env.whatsapp.messages[0],
    type: "document",
    image: undefined,
    document: { id: "doc1", mime_type: "application/pdf", filename: "invoice.pdf" },
  };
  const [m] = parseV2Envelope(env).messages;
  expect(m.type).toBe("document");
  expect(m.body).toBe("");
  expect(m.media).toEqual({
    downloadUrl: "/v1/media/download/doc1",
    mimeType: "application/pdf",
    fileName: "invoice.pdf",
  });
});

test("pipes.media fileName and mimeType win over the Meta object", () => {
  const env = loadFixture("message-image") as any;
  env.pipes.media["1003383421387256"].fileName = "photo.jpg";
  env.pipes.media["1003383421387256"].mimeType = "image/png";
  const [m] = parseV2Envelope(env).messages;
  expect(m.media).toEqual({
    downloadUrl: "/v1/media/download/aBcDeFgHiJkLmNoPqRs1t",
    mimeType: "image/png",
    fileName: "photo.jpg",
  });
});

test("message-contact-request: contacts mapped", () => {
  const [m] = parseV2Envelope(loadFixture("message-contact-request")).messages;
  expect(m.type).toBe("contacts");
  expect(m.body).toBe("");
  expect(m.contacts).toEqual([
    { name: { formatted_name: "Sheena Nelson" }, phones: [{ phone: "+1 650-555-1234", type: "CELL" }] },
  ]);
});

test("message-location: coordinates with name and address", () => {
  const [m] = parseV2Envelope(loadFixture("message-location")).messages;
  expect(m.type).toBe("location");
  expect(m.body).toBe("");
  expect(m.location).toEqual({
    latitude: -23.5505,
    longitude: -46.6333,
    name: "Praca da Se",
    address: "Sao Paulo, SP",
  });
});

test("location omits name and address when absent", () => {
  const env = loadFixture("message-location") as any;
  env.whatsapp.messages[0].location = { latitude: 1, longitude: 2 };
  const [m] = parseV2Envelope(env).messages;
  expect(m.location).toEqual({ latitude: 1, longitude: 2 });
});

test("message-reaction: emoji body and replyToId", () => {
  const [m] = parseV2Envelope(loadFixture("message-reaction")).messages;
  expect(m.type).toBe("reaction");
  expect(m.body).toBe("\u{1F44D}");
  expect(m.replyToId).toBe("wamid.HAND_reaction_target");
});

test("message-reaction-removed yields no message", () => {
  expect(parseV2Envelope(loadFixture("message-reaction-removed")).messages).toEqual([]);
});

test("message-interactive: button reply title becomes text", () => {
  const [m] = parseV2Envelope(loadFixture("message-interactive")).messages;
  expect(m.type).toBe("text");
  expect(m.body).toBe("Yes");
});

test("interactive list reply title becomes text; no title skips", () => {
  const env = loadFixture("message-interactive") as any;
  env.whatsapp.messages[0].interactive = { type: "list_reply", list_reply: { id: "r1", title: "Option A" } };
  expect(parseV2Envelope(env).messages[0].body).toBe("Option A");
  env.whatsapp.messages[0].interactive = { type: "nfm_reply" };
  expect(parseV2Envelope(env).messages).toEqual([]);
});

test("message-button: text becomes text", () => {
  const [m] = parseV2Envelope(loadFixture("message-button")).messages;
  expect(m.type).toBe("text");
  expect(m.body).toBe("Stop");
});

test("button without text is skipped", () => {
  const env = loadFixture("message-button") as any;
  env.whatsapp.messages[0].button = { payload: "p" };
  expect(parseV2Envelope(env).messages).toEqual([]);
});

test("system messages are skipped", () => {
  for (const name of ["system-user-changed-number", "system-user-changed-user-id"]) {
    expect(parseV2Envelope(loadFixture(name)).messages).toEqual([]);
  }
});

test("echoes and template updates yield nothing", () => {
  for (const name of ["message-echo", "template-status-update"]) {
    const r = parseV2Envelope(loadFixture(name));
    expect(r.messages).toEqual([]);
    expect(r.failedStatuses).toEqual([]);
  }
});

test("ignored fields still report envelopeId and poolNumberId", () => {
  const r = parseV2Envelope(loadFixture("message-echo"));
  expect(r.envelopeId).toBe("evt_hand_echo");
  expect(r.poolNumberId).toBe("pn_abc123");
});

test("status-failed surfaces a failed status; delivered does not", () => {
  const failed = parseV2Envelope(loadFixture("status-failed"));
  expect(failed.messages).toEqual([]);
  expect(failed.failedStatuses).toHaveLength(1);
  expect(failed.failedStatuses[0].wamid).toBe("wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=");
  expect(failed.failedStatuses[0].error?.code).toBe(131049);
  const delivered = parseV2Envelope(loadFixture("status-delivered-bsuid"));
  expect(delivered.failedStatuses).toEqual([]);
});

test("failed status without errors has no error key", () => {
  const env = loadFixture("status-failed") as any;
  delete env.whatsapp.statuses[0].errors;
  const r = parseV2Envelope(env);
  expect(r.failedStatuses).toEqual([{ wamid: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=" }]);
});

test("two senders in one envelope yield two messages", () => {
  const r = parseV2Envelope(loadFixture("message-two-senders"));
  expect(r.messages).toHaveLength(2);
  expect(r.messages[0].sender.name).toBe("Sheena Nelson");
  expect(r.messages[1]).toMatchObject({
    senderId: "15559998888",
    sender: { phone: "15559998888", name: "Bruno" },
    peerId: "pn_abc123:15559998888",
    replyTarget: { kind: "v2", poolNumberId: "pn_abc123", to: "15559998888" },
  });
});

test("sender name falls back to the first contact, then profile.username, then absent", () => {
  const env = loadFixture("message-text") as any;
  env.whatsapp.contacts = [{ wa_id: "000", user_id: "US.OTHER", profile: { username: "@someone" } }];
  expect(parseV2Envelope(env).messages[0].sender.name).toBe("@someone");
  env.whatsapp.contacts = [];
  expect(parseV2Envelope(env).messages[0].sender).not.toHaveProperty("name");
  delete env.whatsapp.contacts;
  expect(parseV2Envelope(env).messages[0].sender).not.toHaveProperty("name");
});

test("toId falls back to poolNumberId without display_phone_number", () => {
  const env = loadFixture("message-text") as any;
  delete env.whatsapp.metadata;
  expect(parseV2Envelope(env).messages[0].toId).toBe("pn_abc123");
});

test("messages with neither from nor from_user_id are skipped", () => {
  const env = loadFixture("message-text") as any;
  delete env.whatsapp.messages[0].from;
  delete env.whatsapp.messages[0].from_user_id;
  expect(parseV2Envelope(env).messages).toEqual([]);
});

test("malformed envelopes never throw", () => {
  for (const bad of [
    null,
    undefined,
    "x",
    {},
    { field: "messages" },
    { field: "messages", whatsapp: { messages: "x" } },
    { field: "messages", whatsapp: { messages: [{ type: "text" }] } },
    { field: "messages", whatsapp: { messages: [null, 5] } },
    { field: "messages", whatsapp: { statuses: "x" } },
  ]) {
    expect(parseV2Envelope(bad)).toMatchObject({ messages: [], failedStatuses: [] });
  }
});

test("a text message missing its text object does not throw and has an empty body", () => {
  const env = loadFixture("message-text") as any;
  delete env.whatsapp.messages[0].text;
  expect(parseV2Envelope(env).messages[0].body).toBe("");
});

test("isV2EventFrame and isV2SendResult", () => {
  expect(isV2EventFrame({ type: "event", data: {} })).toBe(true);
  expect(isV2EventFrame({ type: "event" })).toBe(false);
  expect(isV2EventFrame({ type: "whatsapp_message", data: {} })).toBe(false);
  expect(isV2EventFrame(null)).toBe(false);
  expect(isV2SendResult({ type: "send_result", success: true })).toBe(true);
  expect(isV2SendResult({ type: "send_result", success: false, error: { code: 1 } })).toBe(true);
  expect(isV2SendResult({ type: "send_result" })).toBe(false);
  expect(isV2SendResult({ type: "send_result", success: "yes" })).toBe(false);
  expect(isV2SendResult("send_result")).toBe(false);
});
