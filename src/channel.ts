import type { ChannelPlugin, ChannelSetupInput, OpenClawConfig } from "openclaw/plugin-sdk";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { getConnectionStatus } from "./status-store.js";
import { PipesBotConfigSchema } from "./config-schema.js";
import { parseAllowFrom } from "./trust.js";

type PipesBotSetupInput = ChannelSetupInput & {
  apiKey?: string;
};

const CHANNEL_KEY = "pipes-bot-channel";

export type PipesBotMode = "sandbox" | "app";

function getChannelConfig(cfg: OpenClawConfig): Record<string, unknown> {
  return ((cfg.channels as Record<string, unknown>)?.[CHANNEL_KEY] ?? {}) as Record<string, unknown>;
}

export function resolveApiKey(cfg: OpenClawConfig): string | undefined {
  const channelCfg = getChannelConfig(cfg);
  const key = channelCfg.apiKey as string | undefined;
  return key && (key.startsWith("pk_") || key.startsWith("ak_")) ? key : undefined;
}

// The key prefix is the only mode selector: ak_ keys run in BYON App mode, pk_ keys in sandbox.
export function resolveMode(apiKey: string): PipesBotMode {
  return apiKey.startsWith("ak_") ? "app" : "sandbox";
}

export type AppSettings = { allowFrom: string[]; poolNumberId?: string };

export function resolveAppSettings(cfg: OpenClawConfig): AppSettings {
  const channelCfg = getChannelConfig(cfg);
  const poolNumberId = typeof channelCfg.poolNumberId === "string" ? channelCfg.poolNumberId.trim() : "";
  return {
    allowFrom: parseAllowFrom(channelCfg.allowFrom),
    poolNumberId: poolNumberId || undefined,
  };
}

export const pipesBotChannelPlugin: ChannelPlugin = {
  id: CHANNEL_KEY,
  configSchema: {
    ...buildChannelConfigSchema(PipesBotConfigSchema),
    uiHints: {
      apiKey: {
        label: "PipesBot API Key",
        sensitive: true,
        placeholder: "pk_... or ak_...",
        help: "PipesBot account key (pk_, sandbox numbers) or BYON App key (ak_, API v2)",
      },
      allowFrom: {
        label: "Trusted senders",
        help: "Phone numbers (any format) or WhatsApp user IDs (CC.…) allowed to talk to the agent in App mode",
      },
      poolNumberId: {
        label: "BYON number ID",
        help: "Only answer on this BYON number (pn_…). Leave empty for all numbers in the App",
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

    buildAccountSnapshot: ({ cfg, runtime }) => {
      const status = getConnectionStatus();
      const apiKey = resolveApiKey(cfg);
      const mode = apiKey ? resolveMode(apiKey) : undefined;
      const noTrustedSenders = mode === "app" && resolveAppSettings(cfg).allowFrom.length === 0;
      return {
        accountId: "default",
        connected: status.connected,
        running: !status.authFailed,
        lastConnectedAt: status.lastConnectedAt,
        ...(mode ? { mode } : {}),
        lastError: status.authFailed
          ? "Authentication failed -- check your API key (pk_ for sandbox, ak_ for a BYON App)"
          : (status.lastError ??
            (noTrustedSenders ? "No trusted senders configured (allowFrom)" : null) ??
            runtime?.lastError ??
            null),
      };
    },
  },
};
