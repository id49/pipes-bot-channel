import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setPipesBotRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getPipesBotRuntime(): PluginRuntime {
  if (!runtime) throw new Error("pipes-bot-channel: runtime not initialized");
  return runtime;
}
