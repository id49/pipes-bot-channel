import { randomUUID } from "node:crypto";
import type { AppSettings, PipesBotMode } from "./channel.js";
import { Dedupe } from "./dedupe.js";
import { fromLegacyFrame } from "./adapters/legacy.js";
import { parseV2Envelope } from "./adapters/v2.js";
import { handleInbound } from "./inbound.js";
import type { InboundMessage } from "./inbound-message.js";
import { handleReplyStatus, trackOutboundReply } from "./outbound.js";
import { buildSendFrame, V2Outbound, type V2Deps } from "./outbound-v2.js";
import { getPipesBotRuntime } from "./runtime.js";
import { isTrustedSender } from "./trust.js";
import { isPipesBotReplyStatus, isV2EventFrame, isV2SendResult, type PluginLogger } from "./types.js";

export type RouterDeps = {
  mode: PipesBotMode;
  apiKey: string;
  send: (frame: object) => boolean;
  logger: PluginLogger;
  loadAppSettings: () => AppSettings;
  newRequestId?: () => string;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const show = (value: unknown): string => (typeof value === "string" && value !== "" ? value : "-");

// Routes every WebSocket frame by `type`. App mode puts the trusted-sender gate in front of the agent.
// The returned function never rejects: failures are logged so one bad frame cannot stop the connection.
export function createFrameRouter(deps: RouterDeps): (frame: unknown) => Promise<void> {
  const { mode, apiKey, send, logger } = deps;
  const newRequestId = deps.newRequestId ?? (() => randomUUID());
  const dedupe = new Dedupe();
  const v2Outbound = new V2Outbound();
  const v2Deps: V2Deps = {
    logger,
    enqueueSystemEvent: (text, opts) => getPipesBotRuntime().system.enqueueSystemEvent(text, opts),
  };
  let warnedEmptyAllowFrom = false;

  const isDuplicate = (key: string): boolean => {
    if (!dedupe.seen(key)) return false;
    logger.debug?.(`pipes-bot-channel: dropping duplicate ${key}`);
    return true;
  };

  // Runs one step of a frame so a failure does not drop its siblings.
  const isolated = async (step: () => void | Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (err) {
      logger.error(`pipes-bot-channel: frame handling error: ${String(err)}`);
    }
  };

  // App mode's trust decision: everything not allowlisted is dropped, and only "trusted" earns CommandAuthorized.
  const gate = (message: InboundMessage, settings: AppSettings): "trusted" | "drop" => {
    if (settings.poolNumberId && settings.poolNumberId !== message.poolNumberId) {
      logger.debug?.(
        `pipes-bot-channel: ignoring message for ${message.poolNumberId} (poolNumberId filter is ${settings.poolNumberId})`,
      );
      return "drop";
    }
    if (settings.allowFrom.length === 0) {
      if (!warnedEmptyAllowFrom) {
        warnedEmptyAllowFrom = true;
        logger.warn(
          "pipes-bot-channel: App mode has no trusted senders (allowFrom is empty) -- dropping all inbound messages",
        );
      }
      return "drop";
    }
    if (!isTrustedSender(message.sender, settings.allowFrom)) {
      logger.info(
        `pipes-bot-channel: dropping message from untrusted sender phone=${show(message.sender.phone)} user_id=${show(message.sender.userId)} -- add one of these to allowFrom to trust them`,
      );
      return "drop";
    }
    return "trusted";
  };

  const replyFor = (message: InboundMessage): ((text: string) => boolean) => {
    const target = message.replyTarget;
    if (target.kind === "legacy") {
      const { conversationId, poolNumberId, toNumber } = target;
      return (text) => {
        const sent = send({ type: "whatsapp_reply", data: { conversationId, poolNumberId, toNumber, text } });
        if (sent) trackOutboundReply(conversationId);
        return sent;
      };
    }
    return (text) => {
      const requestId = newRequestId();
      const sent = send(buildSendFrame(target, text, requestId));
      if (sent) v2Outbound.trackSend(requestId, message.sessionKey);
      return sent;
    };
  };

  // Sandbox has no gate and never sets CommandAuthorized.
  const deliverSandbox = (message: InboundMessage): Promise<void> =>
    isolated(async () => {
      await handleInbound(message, { apiKey, accountId: "default", reply: replyFor(message), logger });
    });

  const deliverApp = (message: InboundMessage, settings: AppSettings): Promise<void> =>
    isolated(async () => {
      if (gate(message, settings) !== "trusted") return;
      await handleInbound(message, {
        apiKey,
        accountId: "default",
        commandAuthorized: true,
        reply: replyFor(message),
        logger,
      });
    });

  const routeLegacyMessage = async (frame: Record<string, unknown>): Promise<void> => {
    const data = asRecord(frame.data);
    if (typeof data.messageId === "string" && isDuplicate(data.messageId)) return;

    const message = fromLegacyFrame(frame);
    if (!message) {
      logger.info(`pipes-bot-channel: skipping message [id=${show(data.messageId)}] [type=${show(data.type)}]`);
      return;
    }
    if (mode === "app") await deliverApp(message, deps.loadAppSettings());
    else await deliverSandbox(message);
  };

  const routeV2Event = async (frame: Record<string, unknown>): Promise<void> => {
    // v2 events carry no sender allowlist of their own; only App mode has a gate to protect them.
    if (mode !== "app") {
      logger.debug?.("pipes-bot-channel: ignoring v2 event outside App mode");
      return;
    }
    const { envelopeId, messages, failedStatuses } = parseV2Envelope(frame.data);
    if (envelopeId !== undefined && isDuplicate(envelopeId)) return;

    for (const status of failedStatuses) {
      if (isDuplicate(`${status.wamid}:failed`)) continue;
      await isolated(() => v2Outbound.handleFailedStatus(status, v2Deps));
    }

    const fresh = messages.filter((message) => !isDuplicate(message.messageId));
    if (fresh.length === 0) return;
    const settings = deps.loadAppSettings();
    for (const message of fresh) await deliverApp(message, settings);
  };

  return async (frame) => {
    await isolated(async () => {
      const record = asRecord(frame);
      switch (record.type) {
        case "connected": {
          // Auth details may sit at the top level or under `data`.
          const info = { ...record, ...asRecord(record.data) };
          logger.info(
            `pipes-bot-channel: connected scope=${show(info.scope)} authType=${show(info.authType)} appId=${show(info.appId)}`,
          );
          return;
        }
        case "reply_status":
          if (isPipesBotReplyStatus(frame)) handleReplyStatus(frame, { logger, core: getPipesBotRuntime() });
          return;
        case "send_result":
          if (isV2SendResult(frame)) v2Outbound.handleSendResult(frame, v2Deps);
          return;
        case "whatsapp_message":
          await routeLegacyMessage(record);
          return;
        case "event":
          if (isV2EventFrame(frame)) await routeV2Event(record);
          return;
        default:
          logger.debug?.(`pipes-bot-channel: ignoring frame [type=${show(record.type)}]`);
      }
    });
  };
}
