import type { PluginLogger } from "../../src/types.js";

type LogLine = { level: "debug" | "info" | "warn" | "error"; message: string };

export function stubLogger(): PluginLogger & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const record = (level: LogLine["level"]) => (message: string) => {
    lines.push({ level, message });
  };
  return {
    lines,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}
