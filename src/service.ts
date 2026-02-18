import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { PipesBotConnection } from "./connection.js";
import { handleInbound } from "./inbound.js";
import { isPipesBotReplyStatus } from "./types.js";
import { handleReplyStatus, trackOutboundReply } from "./outbound.js";
import { getPipesBotRuntime } from "./runtime.js";

export function createPipesBotService(): OpenClawPluginService {
  let connection: PipesBotConnection | null = null;

  return {
    id: "pipes-bot-channel",

    start(ctx: OpenClawPluginServiceContext): void {
      const pluginConfig = ctx.config.plugins?.entries?.["pipes-bot-channel"]
        ?.config as { apiKey?: string } | undefined;

      const apiKey = pluginConfig?.apiKey;

      if (!apiKey || !apiKey.startsWith("pk_")) {
        ctx.logger.error(
          "pipes-bot-channel: invalid or missing pk_ API key -- not starting"
        );
        return;
      }

      connection = new PipesBotConnection(apiKey, ctx.logger);

      connection.on("error", (err: Error) => {
        ctx.logger.error(`pipes-bot-channel: fatal connection error: ${err.message}`);
      });

      connection.on("message", (msg: object) => {
        // Route reply_status events to outbound handler
        if (isPipesBotReplyStatus(msg)) {
          handleReplyStatus(msg, { logger: ctx.logger, core: getPipesBotRuntime() });
          return;
        }

        // Route whatsapp_message events to inbound handler
        void handleInbound(msg, {
          apiKey,
          accountId: "default",
          send: (payload: object) => {
            const sent = connection!.send(payload);
            if (sent) {
              // Track outbound for reply_status correlation
              const replyData = (payload as { data?: { conversationId?: string } }).data;
              if (replyData?.conversationId) {
                trackOutboundReply(replyData.conversationId);
              }
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
      ctx.logger.info("pipes-bot-channel: service stopped");
    },
  };
}
