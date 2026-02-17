import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { PipesBotConnection } from "./connection.js";

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
        void msg; // Phase 3 stub
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
