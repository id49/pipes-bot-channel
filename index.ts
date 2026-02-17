import { createPipesBotService } from "./src/service.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const plugin = {
  id: "pipes-bot-channel",
  name: "PipesBot Channel",
  description: "WhatsApp channel via PipesBot managed proxy",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi): void {
    api.registerService(createPipesBotService());
    api.logger.info("pipes-bot-channel: registered");
  },
};

export default plugin;
