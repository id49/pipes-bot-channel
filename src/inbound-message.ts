import type { SenderIds } from "./trust.js";
import type { PipesBotContact, PipesBotLocation } from "./types.js";

export type InboundType =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "sticker"
  | "location"
  | "contacts"
  | "reaction";

export type ReplyTarget =
  | { kind: "legacy"; conversationId: string; poolNumberId: string; toNumber: string }
  | { kind: "v2"; poolNumberId: string; to?: string; recipient?: string };

// Protocol-agnostic inbound message: both the legacy and API v2 adapters produce this shape.
export type InboundMessage = {
  messageId: string;
  poolNumberId: string;
  sender: SenderIds & { name?: string };
  senderId: string; // legacy: fromNumber; v2: userId ?? phone
  toId: string; // legacy: poolNumberPhoneNumber; v2: display_phone_number ?? poolNumberId
  peerId: string; // legacy: conversationId; v2: `${poolNumberId}:${senderId}`
  sessionKey: string; // `default:${peerId}`
  timestamp: number; // ms
  type: InboundType;
  body: string;
  media?: { downloadUrl: string; mimeType: string; fileName?: string };
  mediaUnavailable?: boolean;
  location?: PipesBotLocation;
  contacts?: PipesBotContact[];
  replyToId?: string;
  replyTarget: ReplyTarget;
};
