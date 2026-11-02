import { expect, test } from "vitest";
import { fromLegacyFrame } from "../../src/adapters/legacy.js";
import { legacyFrame } from "../helpers/frames.js";

test("text frame maps to InboundMessage", () => {
  expect(fromLegacyFrame(legacyFrame())).toEqual({
    messageId: "msg_1",
    poolNumberId: "pool_1",
    sender: { phone: "+5511999990000", name: "Ana" },
    senderId: "+5511999990000",
    toId: "+15550001111",
    peerId: "conv_1",
    sessionKey: "default:conv_1",
    timestamp: Date.parse("2026-11-01T10:00:00.000Z"),
    type: "text",
    body: "oi",
    replyTarget: {
      kind: "legacy",
      conversationId: "conv_1",
      poolNumberId: "pool_1",
      toNumber: "+5511999990000",
    },
  });
});

test("BSUID in fromNumber goes to sender.userId", () => {
  const msg = fromLegacyFrame(legacyFrame({ fromNumber: "US.123", userId: "US.123" }));
  expect(msg?.sender).toEqual({ userId: "US.123", name: "Ana" });
  expect(msg?.sender).not.toHaveProperty("phone");
  expect(msg?.senderId).toBe("US.123");
  expect(msg?.replyTarget).toEqual({
    kind: "legacy",
    conversationId: "conv_1",
    poolNumberId: "pool_1",
    toNumber: "US.123",
  });
});

test("userId and parentUserId fill the sender when present", () => {
  const msg = fromLegacyFrame(legacyFrame({ userId: "US.1", parentUserId: "US.ENT.1" }));
  expect(msg?.sender).toEqual({
    phone: "+5511999990000",
    userId: "US.1",
    parentUserId: "US.ENT.1",
    name: "Ana",
  });
});

test("image with downloadUrl sets media", () => {
  const msg = fromLegacyFrame(
    legacyFrame({
      type: "image",
      body: "look",
      media: {
        downloadUrl: "https://example.com/m/1",
        mimeType: "image/jpeg",
        fileName: "pic.jpg",
        byteSize: 10,
      },
    }),
  );
  expect(msg?.type).toBe("image");
  expect(msg?.body).toBe("look");
  expect(msg?.media).toEqual({
    downloadUrl: "https://example.com/m/1",
    mimeType: "image/jpeg",
    fileName: "pic.jpg",
  });
  expect(msg).not.toHaveProperty("mediaUnavailable");
});

test("unavailable media sets mediaUnavailable and no media", () => {
  const msg = fromLegacyFrame(
    legacyFrame({
      type: "image",
      media: {
        downloadUrl: "https://example.com/m/1",
        mimeType: "image/jpeg",
        byteSize: 10,
        unavailable: true,
      },
    }),
  );
  expect(msg?.mediaUnavailable).toBe(true);
  expect(msg).not.toHaveProperty("media");
});

test("media without downloadUrl yields neither media nor mediaUnavailable", () => {
  const msg = fromLegacyFrame(
    legacyFrame({ type: "audio", body: "", media: { mimeType: "audio/ogg", byteSize: 10 } }),
  );
  expect(msg).not.toHaveProperty("media");
  expect(msg).not.toHaveProperty("mediaUnavailable");
});

test("reaction maps emoji and replyToId; removal returns null", () => {
  const msg = fromLegacyFrame(
    legacyFrame({ type: "reaction", body: "", reaction: { messageId: "msg_0", emoji: "👍" } }),
  );
  expect(msg?.type).toBe("reaction");
  expect(msg?.body).toBe("👍");
  expect(msg?.replyToId).toBe("msg_0");

  expect(
    fromLegacyFrame(legacyFrame({ type: "reaction", body: "", reaction: { messageId: "msg_0" } })),
  ).toBeNull();
  expect(fromLegacyFrame(legacyFrame({ type: "reaction", body: "" }))).toBeNull();
});

test("location and contacts carry structured data with empty body", () => {
  const location = { latitude: 1, longitude: 2, name: "Here" };
  const loc = fromLegacyFrame(legacyFrame({ type: "location", body: "ignored", location }));
  expect(loc?.body).toBe("");
  expect(loc?.location).toEqual(location);

  const contacts = [{ name: { formatted_name: "Bob" }, phones: [{ phone: "+1555" }] }];
  const con = fromLegacyFrame(legacyFrame({ type: "contacts", body: "ignored", contacts }));
  expect(con?.body).toBe("");
  expect(con?.contacts).toEqual(contacts);
});

test("unsupported and non-message frames return null", () => {
  expect(fromLegacyFrame(legacyFrame({ type: "unsupported" }))).toBeNull();
  expect(fromLegacyFrame({ type: "reply_status" })).toBeNull();
  expect(fromLegacyFrame(null)).toBeNull();
});
