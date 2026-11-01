import { vi, type Mock } from "vitest";
import type { PluginRuntime } from "openclaw/plugin-sdk";

export function createRuntimeStub(cfg: object = {}): {
  core: PluginRuntime;
  contexts: Record<string, unknown>[];
  readonly dispatches: number;
  systemEvents: Array<{ text: string; sessionKey: string }>;
  fetchRemoteMedia: Mock;
} {
  const contexts: Record<string, unknown>[] = [];
  const systemEvents: Array<{ text: string; sessionKey: string }> = [];
  let dispatches = 0;
  const fetchRemoteMedia = vi.fn(async () => ({
    buffer: Buffer.from("x"),
    contentType: "image/jpeg",
  }));

  const core = {
    config: { loadConfig: () => cfg },
    system: {
      enqueueSystemEvent: (text: string, opts: { sessionKey: string }) => {
        systemEvents.push({ text, sessionKey: opts.sessionKey });
      },
    },
    channel: {
      routing: { resolveAgentRoute: () => ({ agentId: "main" }) },
      session: {
        resolveStorePath: () => "/tmp/store",
        recordInboundSession: async () => {},
      },
      media: {
        fetchRemoteMedia,
        saveMediaBuffer: async (_buffer: Buffer, contentType?: string) => ({
          path: "/tmp/saved",
          contentType,
        }),
      },
      reply: {
        finalizeInboundContext: (ctx: Record<string, unknown>) => {
          contexts.push(ctx);
          return ctx;
        },
        dispatchReplyWithBufferedBlockDispatcher: async (params: {
          dispatcherOptions: { deliver: (payload: { text?: string }) => Promise<void> };
        }) => {
          dispatches += 1;
          await params.dispatcherOptions.deliver({ text: "agent reply" });
        },
      },
    },
  };

  return {
    core: core as unknown as PluginRuntime,
    contexts,
    get dispatches() {
      return dispatches;
    },
    systemEvents,
    fetchRemoteMedia,
  };
}
