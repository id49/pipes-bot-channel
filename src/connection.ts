import WebSocket from "ws";
import { EventEmitter } from "node:events";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "wss://api.pipes.bot/ws";
// The server closes WebSockets with this code when the App is upgraded to API v2.
const CLOSE_API_VERSION_CHANGED = 4000;
// A second 4000 inside this window is treated as a loop and backs off normally.
const IMMEDIATE_RECONNECT_WINDOW_MS = 30_000;
const BASE_MS = 1_000;
const MAX_MS = 120_000; // 2 min cap (user decision)
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 50_000; // 75s total with ping interval = WS-03

// ── Types ────────────────────────────────────────────────────────────────────

export type ConnectionState = "connected" | "disconnected" | "reconnecting";

type PluginLogger = OpenClawPluginServiceContext["logger"];

// ── Module-level helpers ─────────────────────────────────────────────────────

function computeBackoffDelay(attempt: number): number {
  return Math.floor(Math.random() * Math.min(MAX_MS, BASE_MS * Math.pow(2, attempt)));
}

function buildWsUrl(baseUrl: string, apiKey: string): string {
  return `${baseUrl}?apiKey=${encodeURIComponent(apiKey)}`;
}

// ── PipesBotConnection ───────────────────────────────────────────────────────

export class PipesBotConnection extends EventEmitter {
  private readonly apiKey: string;
  private readonly logger: PluginLogger;
  private readonly baseUrl: string;

  private state: ConnectionState = "disconnected";
  private ws: WebSocket | null = null;
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private lastImmediateReconnectAt: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(apiKey: string, logger: PluginLogger, opts?: { baseUrl?: string }) {
    super();
    this.apiKey = apiKey;
    this.logger = logger;
    this.baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  connect(): void {
    this.shouldReconnect = true;
    this.doConnect();
  }

  disconnect(): void {
    // Ordered teardown -- shouldReconnect must be false before ws.close()
    // so the close handler does not schedule a reconnect.
    this.shouldReconnect = false;
    this.stopHeartbeat();

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws !== null) {
      this.ws.close(1000);
      this.ws = null;
    }

    this.setState("disconnected");
  }

  send(message: object): boolean {
    if (this.state !== "connected" || this.ws === null) {
      return false;
    }
    this.ws.send(JSON.stringify(message));
    return true;
  }

  getState(): ConnectionState {
    return this.state;
  }

  // ── Private methods ────────────────────────────────────────────────────────

  private doConnect(): void {
    const ws = new WebSocket(buildWsUrl(this.baseUrl, this.apiKey), {
      handshakeTimeout: 10_000,
    });
    this.ws = ws;

    ws.on("unexpected-response", (_req, response) => {
      const { statusCode } = response;

      if (statusCode === 401 || statusCode === 403) {
        // Permanent auth failure -- stop reconnecting
        this.shouldReconnect = false;
        this.logger.error(
          `pipes-bot-channel: WebSocket authentication failed (HTTP ${statusCode}) -- stopping`
        );
        this.emit("error", new Error(`WebSocket auth failed: HTTP ${statusCode}`));
      } else {
        // Transient failure -- let close handler schedule reconnect
        this.logger.warn(
          `pipes-bot-channel: WebSocket upgrade failed (HTTP ${statusCode}) -- will reconnect`
        );
      }
    });

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.setState("connected");
      this.startHeartbeat(ws);
      this.logger.info("pipes-bot-channel: WebSocket connected");
    });

    ws.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString()) as object;
        this.emit("message", parsed);
      } catch {
        this.logger.warn("pipes-bot-channel: received non-JSON WebSocket message -- ignoring");
      }
    });

    ws.on("error", (err) => {
      // Log only -- the close event fires next and handles reconnect scheduling
      this.logger.error(`pipes-bot-channel: WebSocket error: ${err.message}`);
    });

    ws.on("close", (code) => {
      this.stopHeartbeat();
      this.ws = null;

      if (this.shouldReconnect) {
        if (code === CLOSE_API_VERSION_CHANGED && this.mayReconnectNow()) {
          this.reconnectNow();
        } else {
          this.scheduleReconnect();
        }
      } else {
        this.setState("disconnected");
      }
    });
  }

  // Only the first 4000 in a window reconnects at once; a repeat falls back to backoff.
  private mayReconnectNow(): boolean {
    const now = Date.now();
    const last = this.lastImmediateReconnectAt;
    if (last !== null && now - last < IMMEDIATE_RECONNECT_WINDOW_MS) return false;
    this.lastImmediateReconnectAt = now;
    return true;
  }

  // API version changed server-side: reconnect without backoff and leave
  // reconnectAttempts at 0 so a later failure starts backoff from attempt 1.
  private reconnectNow(): void {
    this.logger.info("pipes-bot-channel: API version changed -- reconnecting now");
    this.setState("reconnecting");
    this.reconnectAttempts = 0;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, 0);
  }

  private scheduleReconnect(): void {
    this.setState("reconnecting");
    this.reconnectAttempts += 1;
    const delay = computeBackoffDelay(this.reconnectAttempts);
    this.logger.info(
      `pipes-bot-channel: reconnect attempt ${this.reconnectAttempts} in ${delay}ms`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit("state", next);

    if (next === "connected" || next === "disconnected") {
      this.logger.info(`pipes-bot-channel: state -> ${next}`);
    }
    // reconnecting state is logged in scheduleReconnect with attempt details
  }

  private startHeartbeat(ws: WebSocket): void {
    this.pingTimer = setInterval(() => {
      ws.ping();

      if (this.pongTimer !== null) {
        clearTimeout(this.pongTimer);
      }
      this.pongTimer = setTimeout(() => {
        this.logger.error(
          "pipes-bot-channel: pong timeout -- terminating dead connection"
        );
        // ws.terminate() forces close code 1006 (abnormal closure)
        ws.terminate();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);

    ws.on("pong", () => {
      if (this.pongTimer !== null) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
    });
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }
}
