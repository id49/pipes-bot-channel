import { test, expect, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { PipesBotConnection } from "../src/connection.js";
import { stubLogger } from "./helpers/logger.js";

async function listen(onConnection: (ws: import("ws").WebSocket, n: number) => void) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  let connections = 0;
  const urls: string[] = [];
  wss.on("connection", (ws, req) => {
    connections++;
    urls.push(req.url ?? "");
    onConnection(ws, connections);
  });
  const port = (wss.address() as AddressInfo).port;
  return { wss, port, urls, count: () => connections };
}

test("close 4000 reconnects immediately", async () => {
  const server = await listen((ws, n) => {
    if (n === 1) ws.close(4000, "api_version_changed");
  });
  const logger = stubLogger();
  const conn = new PipesBotConnection("ak_x", logger, { baseUrl: `ws://127.0.0.1:${server.port}/ws` });
  try {
    conn.connect();
    // Normal backoff would wait up to 2s for attempt 1; 4000 must not.
    await vi.waitFor(() => expect(server.count()).toBe(2), { timeout: 500 });
    expect(logger.lines.map((l) => l.message)).toContain(
      "pipes-bot-channel: API version changed -- reconnecting now"
    );
    expect(server.urls[0]).toBe("/ws?apiKey=ak_x");
    expect(logger.lines.some((l) => l.message.includes("reconnect attempt"))).toBe(false);
  } finally {
    conn.disconnect();
    await new Promise<void>((resolve) => server.wss.close(() => resolve()));
  }
});

test("disconnect cancels a pending close-4000 reconnect timer", async () => {
  const server = await listen((ws) => ws.close(4000, "api_version_changed"));
  const conn = new PipesBotConnection("ak_x", stubLogger(), { baseUrl: `ws://127.0.0.1:${server.port}/ws` });
  try {
    conn.connect();
    await vi.waitFor(() => expect(server.count()).toBeGreaterThanOrEqual(1), { timeout: 500 });
    conn.disconnect();
    const seen = server.count();
    await new Promise((r) => setTimeout(r, 100));
    expect(server.count()).toBe(seen);
    expect(conn.getState()).toBe("disconnected");
  } finally {
    conn.disconnect();
    await new Promise<void>((resolve) => server.wss.close(() => resolve()));
  }
});

test("a repeated close 4000 within 30s goes through backoff", async () => {
  const server = await listen((ws) => ws.close(4000, "api_version_changed"));
  const logger = stubLogger();
  const conn = new PipesBotConnection("ak_x", logger, { baseUrl: `ws://127.0.0.1:${server.port}/ws` });
  try {
    conn.connect();
    // First 4000 reconnects immediately; the second one must back off instead of looping at 0 ms.
    await vi.waitFor(() => expect(logger.lines.some((l) => l.message.includes("reconnect attempt"))).toBe(true), {
      timeout: 1_000,
    });
    const immediate = logger.lines.filter(
      (l) => l.message === "pipes-bot-channel: API version changed -- reconnecting now"
    );
    expect(immediate).toHaveLength(1);
    expect(server.count()).toBe(2);
  } finally {
    conn.disconnect();
    await new Promise<void>((resolve) => server.wss.close(() => resolve()));
  }
});
