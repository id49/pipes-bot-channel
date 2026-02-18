import type { ChannelPlugin, ChannelSetupInput, OpenClawConfig } from "openclaw/plugin-sdk";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { getConnectionStatus } from "./status-store.js";
import { PipesBotConfigSchema } from "./config-schema.js";

type PipesBotSetupInput = ChannelSetupInput & {
  apiKey?: string;
};

const CHANNEL_KEY = "pipes-bot";

function getChannelConfig(cfg: OpenClawConfig): Record<string, unknown> {
  return ((cfg.channels as Record<string, unknown>)?.[CHANNEL_KEY] ?? {}) as Record<string, unknown>;
}

export function resolveApiKey(cfg: OpenClawConfig): string | undefined {
  const channelCfg = getChannelConfig(cfg);
  const key = channelCfg.apiKey as string | undefined;
  return key && key.startsWith("pk_") ? key : undefined;
}

export const pipesBotChannelPlugin: ChannelPlugin = {
  id: CHANNEL_KEY,
  configSchema: {
    ...buildChannelConfigSchema(PipesBotConfigSchema),
    uiHints: {
      apiKey: {
        label: "PipesBot API Key",
        sensitive: true,
        placeholder: "pk_...",
        help: "Your PipesBot API key (starts with pk_)",
      },
    },
  },

  meta: {
    id: CHANNEL_KEY,
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
    resolveAccount: (cfg) => {
      const channelCfg = getChannelConfig(cfg);
      const apiKey = resolveApiKey(cfg);
      return {
        apiKey,
        enabled: channelCfg.enabled !== false,
        configured: Boolean(apiKey),
      };
    },
    isConfigured: (account) => account.configured,
  },

  setup: {
    resolveAccountId: () => "default",
    applyAccountConfig: ({ cfg, input }) => {
      const setupInput = input as PipesBotSetupInput;
      const base = getChannelConfig(cfg);
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [CHANNEL_KEY]: {
            ...base,
            enabled: true,
            ...(setupInput.apiKey ? { apiKey: setupInput.apiKey } : {}),
          },
        },
      } as OpenClawConfig;
    },
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
