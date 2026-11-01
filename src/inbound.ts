import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { buildAgentMediaPayload, toLocationContext, type NormalizedLocation } from "openclaw/plugin-sdk";
import { getPipesBotRuntime } from "./runtime.js";
import { downloadPipesBotMedia } from "./media.js";
import type { InboundMessage } from "./inbound-message.js";
import type { PluginLogger, PipesBotContact } from "./types.js";

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

export async function handleInbound(
  message: InboundMessage,
  opts: {
    apiKey: string;
    accountId: string;
    commandAuthorized?: boolean;
    reply: (text: string) => boolean;
    logger: PluginLogger;
  },
): Promise<void> {
  const core = getPipesBotRuntime();
  const cfg = core.config.loadConfig() as OpenClawConfig;
  const { apiKey, accountId, reply, logger } = opts;

  logger.info(
    `pipes-bot-channel: inbound message [id=${message.messageId}] [type=${message.type}] from=${message.senderId} conversation=${message.peerId}`,
  );

  // 1. Download media (adapters set `media` only for downloadable media)
  if (message.mediaUnavailable) {
    logger.warn(
      `pipes-bot-channel: media unavailable for message ${message.messageId} — proceeding as text-only`,
    );
  }
  const mediaPayload = message.media
    ? await resolveMediaPayload(message.media, apiKey, logger)
    : {};

  // 2. Save contacts as VCF if this is a contacts message
  const contactsPayload =
    message.contacts && message.contacts.length > 0
      ? await resolveContactsPayload(message.contacts, core)
      : {};

  // 3. Location context
  const locationCtx = resolveLocationCtx(message);

  // 4. SessionKey — prefixed with accountId by the adapter for multi-account safety
  const sessionKey = message.sessionKey;

  // 5. Resolve agent route
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "pipes-bot-channel",
    accountId,
    peer: { kind: "direct", id: message.peerId },
  });

  logger.info(
    `pipes-bot-channel: routed [id=${message.messageId}] -> agent=${route.agentId} session=${sessionKey}`,
  );

  // 6. Resolve session store path
  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  // 7. Finalize inbound context — normalizes Body, sets BodyForAgent, etc.
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: message.body,
    RawBody: message.body,
    CommandBody: message.body,
    From: `pipes-bot-channel:${message.senderId}`,
    To: `pipes-bot-channel:${message.toId}`,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: "direct" as const,
    SenderName: message.sender.name,
    SenderId: message.senderId,
    Provider: "pipes-bot-channel",
    Surface: "pipes-bot-channel",
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    ConversationLabel: message.sender.name ?? message.senderId,
    ReplyToId: message.replyToId,
    OriginatingChannel: "pipes-bot-channel",
    OriginatingTo: `pipes-bot-channel:${message.peerId}`,
    ...(opts.commandAuthorized ? { CommandAuthorized: true } : {}),
    ...mediaPayload,
    ...contactsPayload,
    ...locationCtx,
  });

  // 8. Record inbound session for multi-turn context
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      logger.error(`pipes-bot-channel: session record failed: ${String(err)}`);
    },
  });

  // 9. Dispatch to agent pipeline
  //    Uses dispatchReplyWithBufferedBlockDispatcher — simpler than the
  //    createReplyDispatcherWithTyping pattern because PipesBot has no
  //    typing indicator API (typing callbacks are no-ops).
  logger.info(`pipes-bot-channel: dispatching to agent pipeline [id=${message.messageId}]`);
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        logger.info(
          `pipes-bot-channel: delivering reply to conversation=${message.peerId} [${(payload.text ?? "").length} chars]`,
        );
        const sent = reply(payload.text ?? "");
        if (!sent) {
          logger.warn(
            `pipes-bot-channel: send returned false (disconnected?) for conversation ${message.peerId}`,
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

/** Download media for a message and build the agent media payload. */
async function resolveMediaPayload(
  media: NonNullable<InboundMessage["media"]>,
  apiKey: string,
  logger: PluginLogger,
): Promise<ReturnType<typeof buildAgentMediaPayload>> {
  const result = await downloadPipesBotMedia({
    downloadUrl: media.downloadUrl,
    mimeType: media.mimeType,
    fileName: media.fileName,
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
  message: InboundMessage,
): ReturnType<typeof toLocationContext> | Record<string, never> {
  if (!message.location) return {};
  const loc: NormalizedLocation = {
    latitude: message.location.latitude,
    longitude: message.location.longitude,
    name: message.location.name,
    address: message.location.address,
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
