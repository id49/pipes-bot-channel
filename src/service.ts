import type {
  OpenClawConfig,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk";
import { PipesBotConnection } from "./connection.js";
import { createFrameRouter } from "./router.js";
import { getPipesBotRuntime } from "./runtime.js";
import { updateConnectionStatus } from "./status-store.js";
import { resolveApiKey, resolveAppSettings, resolveMode } from "./channel.js";
import type { ConnectionState } from "./connection.js";

export function createPipesBotService(): OpenClawPluginService {
  let connection: PipesBotConnection | null = null;

  return {
    id: "pipes-bot-channel",

    start(ctx: OpenClawPluginServiceContext): void {
      const apiKey = resolveApiKey(ctx.config);

      if (!apiKey) {
        ctx.logger.error(
          "pipes-bot-channel: invalid or missing API key (pk_ or ak_) -- not starting"
        );
        return;
      }

      connection = new PipesBotConnection(apiKey, ctx.logger);

      const route = createFrameRouter({
        mode: resolveMode(apiKey),
        apiKey,
        send: (frame) => connection!.send(frame),
        logger: ctx.logger,
        loadAppSettings: () =>
          resolveAppSettings(getPipesBotRuntime().config.loadConfig() as OpenClawConfig),
      });

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

        void route(msg);
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
