import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { PipesBotConnection } from "./connection.js";
import { handleInbound } from "./inbound.js";
import { fromLegacyFrame } from "./adapters/legacy.js";
import { isPipesBotReplyStatus } from "./types.js";
import { handleReplyStatus, trackOutboundReply } from "./outbound.js";
import { getPipesBotRuntime } from "./runtime.js";
import { updateConnectionStatus } from "./status-store.js";
import { resolveApiKey } from "./channel.js";
import type { ConnectionState } from "./connection.js";

export function createPipesBotService(): OpenClawPluginService {
  let connection: PipesBotConnection | null = null;

  return {
    id: "pipes-bot-channel",

    start(ctx: OpenClawPluginServiceContext): void {
      const apiKey = resolveApiKey(ctx.config);

      if (!apiKey || !apiKey.startsWith("pk_")) {
        ctx.logger.error(
          "pipes-bot-channel: invalid or missing pk_ API key -- not starting"
        );
        return;
      }

      connection = new PipesBotConnection(apiKey, ctx.logger);

      connection.on("state", (state: ConnectionState) => {
        updateConnectionStatus({
          connected: state === "connected",
          ...(state === "connected"
            ? { lastConnectedAt: Date.now(), lastError: null }
            : {}),
        });
      });

      connection.on("error", (err: Error) => {
        const isAuthFailure = err.message.includes("auth failed");
        updateConnectionStatus({
          connected: false,
          authFailed: isAuthFailure,
          lastError: err.message,
        });
        ctx.logger.error(`pipes-bot-channel: fatal connection error: ${err.message}`);
      });

      connection.on("message", (msg: object) => {
        const msgType = (msg as { type?: string }).type ?? "unknown";
        ctx.logger.info(`pipes-bot-channel: ws message received [type=${msgType}]`);
        ctx.logger.info(`pipes-bot-channel: raw message: ${JSON.stringify(msg)}`);

        // Route reply_status events to outbound handler
        if (isPipesBotReplyStatus(msg)) {
          handleReplyStatus(msg, { logger: ctx.logger, core: getPipesBotRuntime() });
          return;
        }

        // Route whatsapp_message events to inbound handler
        const inbound = fromLegacyFrame(msg);
        if (!inbound || inbound.replyTarget.kind !== "legacy") return;
        const { conversationId, poolNumberId, toNumber } = inbound.replyTarget;
        void handleInbound(inbound, {
          apiKey,
          accountId: "default",
          reply: (text: string) => {
            const sent = connection!.send({
              type: "whatsapp_reply",
              data: { conversationId, poolNumberId, toNumber, text },
            });
            if (sent) {
              // Track outbound for reply_status correlation
              trackOutboundReply(conversationId);
            }
            return sent;
          },
          logger: ctx.logger,
        }).catch((err: unknown) => {
          ctx.logger.error(`pipes-bot-channel: inbound error: ${String(err)}`);
        });
      });

      connection.connect();
    },

    stop(ctx: OpenClawPluginServiceContext): void {
      connection?.disconnect();
      connection = null;
      updateConnectionStatus({ connected: false, authFailed: false, lastError: null });
      ctx.logger.info("pipes-bot-channel: service stopped");
    },
  };
}
