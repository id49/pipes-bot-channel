import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { buildAgentMediaPayload, toLocationContext, type NormalizedLocation } from "openclaw/plugin-sdk";
import { getPipesBotRuntime } from "./runtime.js";
import { downloadPipesBotMedia } from "./media.js";
import {
  isPipesBotMessage,
  type PluginLogger,
  type PipesBotContact,
  type PipesBotMessageData,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

export async function handleInbound(
  msg: unknown,
  opts: {
    apiKey: string;
    accountId: string;
    send: (payload: object) => boolean;
    logger: PluginLogger;
  },
): Promise<void> {
  // 1. Type guard — reject anything that isn't a whatsapp_message envelope
  if (!isPipesBotMessage(msg)) return;
  const data = msg.data;

  const core = getPipesBotRuntime();
  const cfg = core.config.loadConfig() as OpenClawConfig;
  const { apiKey, accountId, send, logger } = opts;

  logger.info(
    `pipes-bot-channel: inbound message [id=${data.messageId}] [type=${data.type}] from=${data.fromNumber} conversation=${data.conversationId}`,
  );

  // 2. Skip unsupported message types
  if (data.type === "unsupported") {
    logger.info(`pipes-bot-channel: skipping unsupported message type [id=${data.messageId}]`);
    return;
  }

  // 3. Skip reaction removals (no emoji present)
  if (data.type === "reaction" && !data.reaction?.emoji) {
    logger.info(`pipes-bot-channel: skipping reaction removal [id=${data.messageId}]`);
    return;
  }

  // 4. Resolve body text
  const rawBody = resolveRawBody(data);
  const body = rawBody;

  // 5. Download media for media message types
  const mediaPayload = await resolveMediaPayload(data, apiKey, logger, core);

  // 6. Save contacts as VCF if this is a contacts message
  const contactsPayload =
    data.type === "contacts" && data.contacts && data.contacts.length > 0
      ? await resolveContactsPayload(data.contacts, core)
      : {};

  // 7. Location context
  const locationCtx = resolveLocationCtx(data);

  // 8. ReplyToId (reactions only)
  const replyToId =
    data.type === "reaction" ? data.reaction?.messageId : undefined;

  // 9. SessionKey — prefixed with accountId for multi-account safety
  const sessionKey = `${accountId}:${data.conversationId}`;

  // 10. Resolve agent route
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "pipes-bot-channel",
    accountId,
    peer: { kind: "direct", id: data.conversationId },
  });

  logger.info(
    `pipes-bot-channel: routed [id=${data.messageId}] -> agent=${route.agentId} session=${sessionKey}`,
  );

  // 11. Resolve session store path
  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  // 12. Finalize inbound context — normalizes Body, sets BodyForAgent, etc.
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `pipes-bot-channel:${data.fromNumber}`,
    To: `pipes-bot-channel:${data.poolNumberPhoneNumber}`,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: "direct" as const,
    SenderName: data.fromName ?? undefined,
    SenderId: data.fromNumber,
    Provider: "pipes-bot-channel",
    Surface: "pipes-bot-channel",
    MessageSid: data.messageId,
    Timestamp: new Date(data.timestamp).getTime(),
    ConversationLabel: data.fromName ?? data.fromNumber,
    ReplyToId: replyToId,
    OriginatingChannel: "pipes-bot-channel",
    OriginatingTo: `pipes-bot-channel:${data.conversationId}`,
    ...mediaPayload,
    ...contactsPayload,
    ...locationCtx,
  });

  // 13. Record inbound session for multi-turn context
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      logger.error(`pipes-bot-channel: session record failed: ${String(err)}`);
    },
  });

  // 14. Dispatch to agent pipeline
  //     Uses dispatchReplyWithBufferedBlockDispatcher — simpler than the
  //     createReplyDispatcherWithTyping pattern because PipesBot has no
  //     typing indicator API (typing callbacks are no-ops).
  logger.info(`pipes-bot-channel: dispatching to agent pipeline [id=${data.messageId}]`);
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        logger.info(
          `pipes-bot-channel: delivering reply to conversation=${data.conversationId} [${(payload.text ?? "").length} chars]`,
        );
        const sent = send({
          type: "whatsapp_reply",
          data: {
            conversationId: data.conversationId,
            poolNumberId: data.poolNumberId,
            toNumber: data.fromNumber,
            text: payload.text ?? "",
          },
        });
        if (!sent) {
          logger.warn(
            `pipes-bot-channel: send returned false (disconnected?) for conversation ${data.conversationId}`,
          );
        }
      },
      onError: (err, info) => {
        logger.error(
          `pipes-bot-channel: ${info.kind} reply failed: ${String(err)}`,
        );
      },
    },
    replyOptions: {},
  });
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Resolve the text body for each message type. */
function resolveRawBody(data: PipesBotMessageData): string {
  switch (data.type) {
    case "text":
      return data.body;
    case "reaction":
      // Emoji is guaranteed non-null here (removals are skipped upstream)
      return data.reaction?.emoji ?? "";
    case "location":
    case "contacts":
      // Body stays empty — structured data is in locationCtx / contactsPayload
      return "";
    default:
      // image, audio, video, document, sticker — caption or empty
      return data.body ?? "";
  }
}

/** Download media for image/audio/video/document/sticker message types. */
async function resolveMediaPayload(
  data: PipesBotMessageData,
  apiKey: string,
  logger: PluginLogger,
  _core: ReturnType<typeof getPipesBotRuntime>,
): Promise<ReturnType<typeof buildAgentMediaPayload>> {
  const mediaTypes: Array<
    "image" | "audio" | "video" | "document" | "sticker"
  > = ["image", "audio", "video", "document", "sticker"];
  if (!mediaTypes.includes(data.type as never)) return {};

  if (!data.media || data.media.unavailable || !data.media.downloadUrl) {
    if (data.media?.unavailable) {
      logger.warn(
        `pipes-bot-channel: media unavailable for message ${data.messageId} — proceeding as text-only`,
      );
    }
    return {};
  }

  const result = await downloadPipesBotMedia({
    downloadUrl: data.media.downloadUrl,
    mimeType: data.media.mimeType,
    fileName: data.media.fileName,
    apiKey,
    logger,
  });

  if (!result) return {};

  return buildAgentMediaPayload([
    { path: result.path, contentType: result.contentType },
  ]);
}

/** Save contacts array as a VCF file and return an agent media payload. */
async function resolveContactsPayload(
  contacts: PipesBotContact[],
  core: ReturnType<typeof getPipesBotRuntime>,
): Promise<ReturnType<typeof buildAgentMediaPayload>> {
  const vcard = contacts.map(formatVCard).join("\n");
  const saved = await core.channel.media.saveMediaBuffer(
    Buffer.from(vcard, "utf-8"),
    "text/vcard",
    "inbound",
  );
  return buildAgentMediaPayload([
    { path: saved.path, contentType: "text/vcard" },
  ]);
}

/**
 * Convert a location message to OpenClaw's structured location context fields.
 * Returns an empty object for non-location types.
 */
function resolveLocationCtx(
  data: PipesBotMessageData,
): ReturnType<typeof toLocationContext> | Record<string, never> {
  if (data.type !== "location" || !data.location) return {};
  const loc: NormalizedLocation = {
    latitude: data.location.latitude,
    longitude: data.location.longitude,
    name: data.location.name,
    address: data.location.address,
  };
  return toLocationContext(loc);
}

/** Format a single contact as a vCard 3.0 string. */
function formatVCard(contact: PipesBotContact): string {
  const name = contact.name?.formatted_name ?? "Unknown";
  const phones = (contact.phones ?? [])
    .map((p) => `TEL;TYPE=${p.type ?? "CELL"}:${p.phone}`)
    .join("\n");
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${name}`];
  if (phones) lines.push(phones);
  lines.push("END:VCARD");
  return lines.join("\n");
}
