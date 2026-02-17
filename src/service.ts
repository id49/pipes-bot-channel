import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";

export function createPipesBotService(): OpenClawPluginService {
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

      ctx.logger.info("pipes-bot-channel: service started");
    },

    stop(ctx: OpenClawPluginServiceContext): void {
      ctx.logger.info("pipes-bot-channel: service stopped");
    },
  };
}
