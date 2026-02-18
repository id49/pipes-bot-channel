import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { getConnectionStatus } from "./status-store.js";

export const pipesBotChannelPlugin: ChannelPlugin = {
  id: "pipes-bot-channel",

  meta: {
    id: "pipes-bot-channel",
    label: "PipesBot (WhatsApp)",
    selectionLabel: "PipesBot (WhatsApp)",
    docsPath: "/docs/channels/pipes-bot",
    blurb: "WhatsApp via PipesBot managed proxy",
  },

  capabilities: {
    chatTypes: ["direct"],
    media: true,
  },

  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({ apiKey: "configured" }),
    isConfigured: () => true,
  },

  status: {
    defaultRuntime: { accountId: "default", connected: false, lastError: null },

    buildAccountSnapshot: ({ runtime }) => {
      const status = getConnectionStatus();
      return {
        accountId: "default",
        connected: status.connected,
        running: !status.authFailed,
        lastConnectedAt: status.lastConnectedAt,
        lastError: status.authFailed
          ? "Authentication failed -- check your pk_ API key"
          : (status.lastError ?? runtime?.lastError ?? null),
      };
    },
  },
};
