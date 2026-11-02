import type { InboundMessage, InboundType } from "../inbound-message.js";
import type { PipesBotContact, PipesBotLocation } from "../types.js";

export type V2FailedStatus = {
  wamid: string;
  error?: { code?: string | number; message?: string; title?: string };
};

export type V2ParseResult = {
  envelopeId?: string;
  poolNumberId?: string;
  messages: InboundMessage[];
  failedStatuses: V2FailedStatus[];
};

type Obj = Record<string, unknown>;

const MEDIA_TYPES = ["image", "audio", "video", "document", "sticker"];

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const objects = (value: unknown): Obj[] => (Array.isArray(value) ? value.filter(isObj) : []);

// Normalize one API v2 event envelope (`event.data`) into inbound messages and failed send statuses.
// Never throws: anything malformed or ignored yields empty arrays.
export function parseV2Envelope(envelope: unknown): V2ParseResult {
  const result: V2ParseResult = { messages: [], failedStatuses: [] };
  if (!isObj(envelope)) return result;

  const envelopeId = str(envelope.id);
  if (envelopeId) result.envelopeId = envelopeId;
  const pipes = isObj(envelope.pipes) ? envelope.pipes : {};
  const poolNumberId = str(pipes.poolNumberId);
  if (poolNumberId) result.poolNumberId = poolNumberId;

  // Only `messages` carries inbound traffic; echoes, template updates and the rest are ignored.
  if (envelope.field !== "messages" || !poolNumberId || !isObj(envelope.whatsapp)) return result;
  const whatsapp = envelope.whatsapp;
  const media = isObj(pipes.media) ? pipes.media : {};
  const contacts = objects(whatsapp.contacts);
  const displayPhone = isObj(whatsapp.metadata) ? str(whatsapp.metadata.display_phone_number) : undefined;

  for (const raw of objects(whatsapp.messages)) {
    const message = toInboundMessage(raw, { poolNumberId, toId: displayPhone ?? poolNumberId, media, contacts });
    if (message) result.messages.push(message);
  }

  for (const status of objects(whatsapp.statuses)) {
    const wamid = str(status.id);
    if (status.status !== "failed" || !wamid) continue;
    const failed: V2FailedStatus = { wamid };
    const error = objects(status.errors)[0];
    if (error) failed.error = pickError(error);
    result.failedStatuses.push(failed);
  }

  return result;
}

type MessageContext = { poolNumberId: string; toId: string; media: Obj; contacts: Obj[] };

function toInboundMessage(raw: Obj, ctx: MessageContext): InboundMessage | null {
  const messageId = str(raw.id);
  const from = str(raw.from);
  const fromUserId = str(raw.from_user_id);
  const senderId = fromUserId ?? from;
  if (!messageId || !senderId) return null;

  const content = resolveContent(raw, ctx.media);
  if (!content) return null;

  const sender: InboundMessage["sender"] = {};
  if (from) sender.phone = from;
  if (fromUserId) sender.userId = fromUserId;
  const parentUserId = str(raw.from_parent_user_id);
  if (parentUserId) sender.parentUserId = parentUserId;
  const name = resolveSenderName(ctx.contacts, from, fromUserId);
  if (name) sender.name = name;

  const peerId = `${ctx.poolNumberId}:${senderId}`;
  return {
    messageId,
    poolNumberId: ctx.poolNumberId,
    sender,
    senderId,
    toId: ctx.toId,
    peerId,
    sessionKey: `default:${peerId}`,
    timestamp: Number(raw.timestamp) * 1000,
    ...content,
    replyTarget: from
      ? { kind: "v2", poolNumberId: ctx.poolNumberId, to: from }
      : { kind: "v2", poolNumberId: ctx.poolNumberId, recipient: senderId },
  };
}

type Content = Pick<
  InboundMessage,
  "type" | "body" | "media" | "mediaUnavailable" | "location" | "contacts" | "replyToId"
>;

// Map a Meta message to the type-specific part of InboundMessage; null means the message is skipped.
function resolveContent(raw: Obj, mediaMap: Obj): Content | null {
  const type = str(raw.type);
  if (!type) return null;

  if (type === "text") {
    return { type: "text", body: isObj(raw.text) ? (str(raw.text.body) ?? "") : "" };
  }

  if (MEDIA_TYPES.includes(type)) {
    const object = isObj(raw[type]) ? raw[type] : {};
    const content: Content = { type: type as InboundType, body: str(object.caption) ?? "" };
    const id = str(object.id);
    const entry = id !== undefined && isObj(mediaMap[id]) ? mediaMap[id] : undefined;
    const downloadUrl = entry ? str(entry.downloadUrl) : undefined;
    const mimeType = (entry && str(entry.mimeType)) ?? str(object.mime_type);
    if (entry && downloadUrl && entry.unavailable !== true && mimeType) {
      const fileName = str(entry.fileName) ?? str(object.filename);
      content.media = { downloadUrl, mimeType, ...(fileName ? { fileName } : {}) };
    } else {
      content.mediaUnavailable = true;
    }
    return content;
  }

  if (type === "location") {
    const loc = raw.location;
    if (!isObj(loc) || typeof loc.latitude !== "number" || typeof loc.longitude !== "number") return null;
    const location: PipesBotLocation = { latitude: loc.latitude, longitude: loc.longitude };
    const name = str(loc.name);
    const address = str(loc.address);
    if (name) location.name = name;
    if (address) location.address = address;
    return { type: "location", body: "", location };
  }

  if (type === "contacts") {
    const contacts = objects(raw.contacts).flatMap((c) => toContact(c) ?? []);
    return { type: "contacts", body: "", ...(contacts.length > 0 ? { contacts } : {}) };
  }

  if (type === "reaction") {
    const reaction = isObj(raw.reaction) ? raw.reaction : {};
    const emoji = str(reaction.emoji);
    if (!emoji) return null;
    const replyToId = str(reaction.message_id);
    return { type: "reaction", body: emoji, ...(replyToId ? { replyToId } : {}) };
  }

  if (type === "interactive") {
    const interactive = isObj(raw.interactive) ? raw.interactive : {};
    const reply = [interactive.button_reply, interactive.list_reply]
      .map((r) => (isObj(r) ? str(r.title) : undefined))
      .find((title) => title);
    return reply ? { type: "text", body: reply } : null;
  }

  if (type === "button") {
    const text = isObj(raw.button) ? str(raw.button.text) : undefined;
    return text ? { type: "text", body: text } : null;
  }

  return null; // system, unsupported and everything else
}

function toContact(raw: Obj): PipesBotContact | null {
  const formatted = isObj(raw.name) ? str(raw.name.formatted_name) : undefined;
  if (!formatted) return null;
  const contact: PipesBotContact = { name: { formatted_name: formatted } };
  const phones = objects(raw.phones).flatMap((p) => {
    const phone = str(p.phone);
    const type = str(p.type);
    return phone ? [{ phone, ...(type ? { type } : {}) }] : [];
  });
  const emails = objects(raw.emails).flatMap((e) => {
    const email = str(e.email);
    const type = str(e.type);
    return email ? [{ email, ...(type ? { type } : {}) }] : [];
  });
  if (phones.length > 0) contact.phones = phones;
  if (emails.length > 0) contact.emails = emails;
  return contact;
}

function resolveSenderName(contacts: Obj[], from?: string, fromUserId?: string): string | undefined {
  const match =
    contacts.find((c) => (fromUserId && c.user_id === fromUserId) || (from && c.wa_id === from)) ?? contacts[0];
  if (!match || !isObj(match.profile)) return undefined;
  return str(match.profile.name) ?? str(match.profile.username);
}

function pickError(error: Obj): NonNullable<V2FailedStatus["error"]> {
  const picked: NonNullable<V2FailedStatus["error"]> = {};
  if (typeof error.code === "string" || typeof error.code === "number") picked.code = error.code;
  const message = str(error.message);
  const title = str(error.title);
  if (message) picked.message = message;
  if (title) picked.title = title;
  return picked;
}
