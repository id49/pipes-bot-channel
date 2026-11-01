import type { InboundMessage } from "../inbound-message.js";
import { isPipesBotMessage, type PipesBotMessageData } from "../types.js";

const MEDIA_TYPES = ["image", "audio", "video", "document", "sticker"];

// Normalize a legacy `whatsapp_message` frame. Returns null for frames the dispatcher must skip
// (other frame types, unsupported messages, reaction removals).
export function fromLegacyFrame(frame: unknown): InboundMessage | null {
  if (!isPipesBotMessage(frame)) return null;
  const data = frame.data;
  if (data.type === "unsupported") return null;
  if (data.type === "reaction" && !data.reaction?.emoji) return null;

  const sender: InboundMessage["sender"] = {};
  // A "." in fromNumber marks a BSUID rather than a phone number.
  if (data.fromNumber.includes(".")) sender.userId = data.fromNumber;
  else sender.phone = data.fromNumber;
  if (data.userId) sender.userId = data.userId;
  if (data.parentUserId) sender.parentUserId = data.parentUserId;
  if (typeof data.fromName === "string") sender.name = data.fromName;

  const message: InboundMessage = {
    messageId: data.messageId,
    poolNumberId: data.poolNumberId,
    sender,
    senderId: data.fromNumber,
    toId: data.poolNumberPhoneNumber,
    peerId: data.conversationId,
    sessionKey: `default:${data.conversationId}`,
    timestamp: new Date(data.timestamp).getTime(),
    type: data.type,
    body: resolveBody(data),
    replyTarget: {
      kind: "legacy",
      conversationId: data.conversationId,
      poolNumberId: data.poolNumberId,
      toNumber: data.fromNumber,
    },
  };

  if (MEDIA_TYPES.includes(data.type) && data.media) {
    if (data.media.unavailable) {
      message.mediaUnavailable = true;
    } else if (data.media.downloadUrl) {
      message.media = {
        downloadUrl: data.media.downloadUrl,
        mimeType: data.media.mimeType,
        ...(data.media.fileName ? { fileName: data.media.fileName } : {}),
      };
    }
  }
  if (data.type === "location" && data.location) message.location = data.location;
  if (data.type === "contacts" && data.contacts && data.contacts.length > 0) {
    message.contacts = data.contacts;
  }
  if (data.type === "reaction") message.replyToId = data.reaction?.messageId;

  return message;
}

function resolveBody(data: PipesBotMessageData): string {
  switch (data.type) {
    case "reaction":
      return data.reaction?.emoji ?? "";
    case "location":
    case "contacts":
      return "";
    default:
      // text and media types: body or caption
      return data.body ?? "";
  }
}
