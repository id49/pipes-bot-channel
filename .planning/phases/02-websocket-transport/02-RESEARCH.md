# Phase 02: WebSocket Transport - Research

**Researched:** 2026-02-17
**Domain:** WebSocket client lifecycle, reconnection state machines, heartbeat monitoring
**Confidence:** HIGH

---

## Summary

Phase 02 implements the PipesBot WebSocket transport layer inside the existing OpenClaw `OpenClawPluginService`. The PipesBot API is fully documented in the local `pipes-bot-docs` repo. The `ws` v8 package is already installed. The `@pipes-bot/plugin` reference client (`ws-client.ts`) provides a working baseline, but it needs to be extended for this project: the user's locked decisions require 2-minute max backoff (not 30s), jitter, 75s heartbeat timeout, 3-state model, EventEmitter-based status exposure, and OpenClaw logger integration.

The PipesBot server authenticates via HTTP before the WebSocket upgrade completes. A 401 response (invalid/missing API key) never produces a WebSocket `close` event — it fires as a `ws` `unexpected-response` event. This distinction is critical for WS-04 permanent-failure handling: auth failures must be caught on the `unexpected-response` listener, not on `close`.

The most subtle architectural decision is the heartbeat: PipesBot docs say the **server does not send pings** — the client sends them. The 75s timeout requirement (WS-03) means the client must send a ping and detect if no `pong` arrives within a deadline. This requires a per-ping timeout/ack tracking pattern, not a passive "did the server ping me?" approach.

**Primary recommendation:** Implement a standalone `PipesBotConnection` class (not just a function) that owns the `ws` instance, all timers, and the state machine. The service's `start`/`stop` delegates to this class. Expose state via a typed EventEmitter and a synchronous `getState()` accessor.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ws` | `8.19.0` (installed) | WebSocket client | Already installed; Node.js standard WS library; no alternatives needed |
| `@types/ws` | `8.18.1` (installed) | TypeScript types for `ws` | Required for type safety |
| `node:events` | Node built-in | EventEmitter for status events | No external dep needed; built-in EventEmitter is sufficient for 3-state model |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| None needed | — | — | The `ws` library + Node built-ins cover all requirements |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom `PipesBotConnection` class | `reconnecting-websocket` npm package | Package adds ~6KB and assumptions about ping/pong that conflict with our 75s timeout model; hand-rolling is correct here given the specificity of requirements |
| `node:events` EventEmitter | Custom callback API | EventEmitter is more flexible and follows Node.js conventions; callbacks would require multiple registration calls |

**Installation:**

Already installed. No new packages needed.

```bash
# Nothing to install — ws@8.19.0 and @types/ws@8.18.1 already in package.json
```

---

## PipesBot WebSocket API

Source: `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-docs/content/docs/websocket/index.mdx` (HIGH confidence — local docs repo)

### Connection URL

```
wss://api.pipes.bot/ws?apiKey=YOUR_API_KEY
```

- API key is passed as a **query parameter** (not a header)
- No `Authorization` header needed
- User-scoped (no `conversationId`) receives all messages from all pool numbers

### Authentication Behavior

| Condition | HTTP Status | WS Event |
|-----------|-------------|----------|
| Valid `pk_` key | 101 Switching Protocols | `open` event |
| Invalid/missing key | `401 Unauthorized` | `unexpected-response` event (never fires `close`) |
| Invalid conversationId | `403 Forbidden` | `unexpected-response` event |

**Critical:** Auth failures in `ws` fire the `unexpected-response` event with the `IncomingMessage` (HTTP response). The HTTP status code is available at `response.statusCode`. These must be caught on the `unexpected-response` listener and classified as permanent failures (no reconnect).

### Server-Sent Events After Connection

| Event type | When sent | Payload |
|------------|-----------|---------|
| `connected` | Immediately after WS upgrade | `{ type: "connected", userId, connectionId, scope }` |
| `whatsapp_message` | On incoming WhatsApp message | Message envelope |
| `reply_status` | After client sends `whatsapp_reply` | `{ success, messageId?, error?, code? }` |

The `connected` event is the **handshake confirmation**. The CONTEXT.md decision "always re-handshake on new connection" means: wait for and process the `connected` event on every new connection, including reconnects.

### Keepalive

From PipesBot docs: "Send WebSocket `ping` frames at regular intervals (25 seconds recommended)."
- The **server does not send pings** — the client must send them
- `ws` auto-responds to server pings (autoPong: true by default), but since the server doesn't send pings, this is irrelevant
- The client sends pings; the server responds with pongs
- WS-03 requires: no pong received within 75s triggers reconnect

---

## Architecture Patterns

### Recommended Project Structure

```
src/
├── service.ts            # OpenClawPluginService (already exists — extend this)
└── connection.ts         # PipesBotConnection class (state machine + ws lifecycle)
```

The existing `service.ts` becomes a thin wrapper that creates `PipesBotConnection` in `start` and calls `disconnect()` in `stop`. All WS logic lives in `connection.ts`.

### Pattern 1: Connection State Machine

**What:** A 3-state machine (`connected`, `disconnected`, `reconnecting`) owned by `PipesBotConnection`. State transitions are the only place where events are emitted and logger calls are made.

**States and transitions:**

```
           connect()
               │
               ▼
         [disconnected]
               │  open event
               │
               ▼
         [connected]
               │  close/error/timeout
               │
               ▼
        [reconnecting]  ──── permanent failure (401)
               │                    │
               │  open event        ▼
               └──────────── [disconnected + stopped]
```

**State enum:**

```typescript
// src/connection.ts
type ConnectionState = "connected" | "disconnected" | "reconnecting";
```

**Events emitted (via EventEmitter):**

```typescript
interface PipesBotConnectionEvents {
  "state": (state: ConnectionState) => void;
  "message": (msg: unknown) => void;
  "error": (err: Error) => void;  // permanent failures surfaced to service
}
```

### Pattern 2: Exponential Backoff with Full Jitter

**What:** Full jitter algorithm — the recommended AWS approach for preventing thundering herds. Delay is `random(0, min(cap, base * 2^attempt))`.

**Why full jitter (not "equal jitter"):** Full jitter produces lower average delays and better desynchronization. For a persistent background service that is the only client for this API key, thundering herd is not a concern, but jitter still prevents deterministic retry storms after server restarts.

**Locked constraints from CONTEXT.md:**
- Max delay: 2 minutes (120,000ms) — **user decision, not PipesBot recommendation**
- PipesBot docs recommend max 30s — overridden by user decision
- Backoff resets immediately on successful reconnect

**Algorithm:**

```typescript
// Source: derived from AWS Architecture Blog pattern + user decisions
function computeBackoffDelay(attempt: number): number {
  const BASE_MS = 1_000;    // 1 second base
  const MAX_MS = 120_000;   // 2 minutes cap (user decision)
  const cap = Math.min(MAX_MS, BASE_MS * Math.pow(2, attempt));
  return Math.floor(Math.random() * cap);  // Full jitter: random(0, cap)
}
```

**Behavior at each attempt:**

| Attempt | Cap | Range |
|---------|-----|-------|
| 1 | 2s | 0–2s |
| 2 | 4s | 0–4s |
| 3 | 8s | 0–8s |
| 4 | 16s | 0–16s |
| 5 | 32s | 0–32s |
| 6 | 64s | 0–64s |
| 7+ | 120s | 0–120s |

**Retry strategy (Claude's discretion):** Retry **forever** until stopped or a permanent failure occurs. Rationale: this is a transport layer for a persistent bot. The service should self-heal indefinitely. Bounded retries would require human intervention for transient network outages. The PipesBot reference client also retries indefinitely.

### Pattern 3: Heartbeat / Ping-Pong Monitoring

**What:** Client sends `ws.ping()` every 25 seconds. If no `pong` event arrives within a deadline (50 seconds after sending the ping), the connection is treated as silently dead and `ws.terminate()` is called.

**Why 25s ping + 50s pong timeout:**
- PipesBot docs recommend 25s ping interval
- WS-03 specifies: "no ping within 75s triggers reconnect" — this means if the full cycle (send ping + wait for pong) takes more than 75s total, reconnect
- Choosing 25s interval + 50s pong deadline = 75s max round-trip before reconnect
- This satisfies WS-03 exactly

**Implementation sketch:**

```typescript
// In PipesBotConnection
private pingIntervalMs = 25_000;
private pongTimeoutMs = 50_000;
private pingTimer: NodeJS.Timeout | null = null;
private pongTimer: NodeJS.Timeout | null = null;

private startHeartbeat(ws: WebSocket): void {
  this.pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.ping();
    // Start pong deadline
    this.pongTimer = setTimeout(() => {
      this.logger.error("pipes-bot-channel: pong timeout — terminating connection");
      ws.terminate();  // Triggers close event → reconnect
    }, this.pongTimeoutMs);
  }, this.pingIntervalMs);

  ws.on("pong", () => {
    // Pong received — clear the deadline
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  });
}

private stopHeartbeat(): void {
  if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
}
```

**Note:** `ws.terminate()` forcibly closes the TCP socket without a WebSocket close frame. This produces close code `1006` (abnormal closure) on the `close` event, which is classified as transient — triggering reconnection correctly.

### Pattern 4: Close Code Classification (WS-04)

**Source:** Standard WebSocket close codes (websocket.org) + PipesBot docs behavior

| Code | Classification | Action |
|------|---------------|--------|
| 1000 | Clean — depends on context | If `shouldReconnect = false` (stop called): stop. Otherwise: reconnect |
| 1001 | Server going away | Transient — reconnect |
| 1006 | Abnormal closure (network/timeout) | Transient — reconnect |
| 1008 | Policy violation (could be auth) | Treat as transient per CONTEXT.md decision |
| 1011 | Server internal error | Transient — reconnect |
| 1012 | Service restart | Transient — reconnect |
| 1013 | Try again later | Transient — reconnect |
| Any other | Unknown | Transient per CONTEXT.md decision — reconnect |

**Permanent failures (stop reconnecting):**
- `unexpected-response` with HTTP 401 → auth failure (invalid/revoked key)
- `unexpected-response` with HTTP 403 → auth/scope failure
- Explicit `stop()` call (sets `shouldReconnect = false`)

**No permanent WS close codes exist in PipesBot's documented API.** All close codes are treated as transient. Permanent failures only come from the HTTP authentication layer before WS upgrade.

```typescript
function isTransientClose(code: number): boolean {
  // Auth failures are caught via unexpected-response, not close codes.
  // All close codes are transient — reconnect on any.
  // Exception: clean close initiated by our own stop() — checked via shouldReconnect flag.
  return true;
}
```

### Pattern 5: Stop/Teardown Order

**Critical ordering to avoid reconnection race during stop:**

```typescript
disconnect(): void {
  // 1. Set flag FIRST — prevents reconnection scheduling in close handler
  this.shouldReconnect = false;
  // 2. Stop heartbeat timers
  this.stopHeartbeat();
  // 3. Cancel any pending reconnect timer
  if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  // 4. Close WS gracefully (code 1000)
  if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
    this.ws.close(1000, "service stopping");
  }
  this.ws = null;
}
```

**Why this order matters:** The `close` event fires asynchronously. If `shouldReconnect` is not set to `false` before calling `ws.close()`, the close handler will schedule a reconnect before `disconnect()` returns, causing a leaked reconnection attempt during gateway shutdown.

### Pattern 6: `ws` Constructor for PipesBot

```typescript
// API key via query param (not header) — PipesBot docs confirmed
import WebSocket from "ws";

function buildUrl(apiKey: string): string {
  // NEVER log apiKey — not even in this URL construction
  return `wss://api.pipes.bot/ws?apiKey=${encodeURIComponent(apiKey)}`;
}

const ws = new WebSocket(buildUrl(apiKey), {
  handshakeTimeout: 10_000,  // 10s to complete HTTP upgrade
});
```

**Note on `autoPong`:** The `ws` library automatically responds to server pings with pong frames by default (`autoPong: true`). Since PipesBot doesn't send pings (client sends them), this is harmless but irrelevant.

### Pattern 7: Event Listener Cleanup on Each `ws` Instance

`ws` instances cannot be reused after close. Each reconnect creates a new `WebSocket` instance. All event listeners attached to the old instance are garbage collected with it — no need to manually `removeAllListeners()` between reconnects. However, the `pong` listener attached inside `startHeartbeat` is per-instance, so calling `stopHeartbeat()` before creating a new instance is sufficient.

### Anti-Patterns to Avoid

- **Reusing a closed `ws` instance:** Once closed, a `ws.WebSocket` cannot be reopened. Each reconnect must `new WebSocket(url)`.
- **Starting heartbeat before `open` event:** `ws.ping()` throws if called when `readyState !== OPEN`. Only start heartbeat in the `open` handler.
- **Listening for `unexpected-response` after `open`:** Register the `unexpected-response` listener immediately after construction, before the handshake completes. It fires during the HTTP upgrade phase.
- **Setting `shouldReconnect = true` in reconnect loop:** The flag is only set in `disconnect()`. Always initialized to `true` at construction time.
- **Logging the URL:** The API key is in the query string. Never log the constructed URL.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON parsing of WS messages | Manual Buffer handling | `data.toString()` + `JSON.parse()` | `ws` delivers `Buffer` for binary frames and `string` for text frames; `toString()` handles both |
| WS close frame detection | Parsing raw frames | `ws.on("close", (code, reason) => ...)` | `ws` handles all frame parsing; close code and reason are decoded automatically |
| Pong auto-response | Custom pong sender | `ws` default `autoPong: true` | Already built in; don't override unless you need to add latency measurement |
| State machine enforcement | Custom mutex/lock | Simple `state` field + `shouldReconnect` flag | The event-driven WS lifecycle is inherently single-threaded in Node.js; no locking needed |

**Key insight:** The `ws` library handles all the low-level WebSocket protocol details (frame parsing, masking, close handshake, pong responses). Our code only needs to manage connection lifecycle state and retries.

---

## Common Pitfalls

### Pitfall 1: Auth Failure Not Caught

**What goes wrong:** HTTP 401 (invalid API key) fires `unexpected-response`, NOT `close`. Code that only listens on `close` for errors will silently loop: `connect → 401 → open not fired → error not fired → nothing happens`. The reconnect loop never fires, WS appears stuck.

**Why it happens:** `ws` fires `unexpected-response` when the HTTP upgrade gets a non-101 response. This is separate from the `error` event.

**How to avoid:** Always register an `unexpected-response` listener:

```typescript
ws.on("unexpected-response", (_req, response) => {
  const status = response.statusCode;
  if (status === 401 || status === 403) {
    this.logger.error(
      `pipes-bot-channel: authentication failed (HTTP ${status}) — stopping reconnection`
    );
    this.shouldReconnect = false;
    this.emit("error", new Error(`Auth failed: HTTP ${status}`));
  } else {
    this.logger.error(`pipes-bot-channel: unexpected HTTP ${status} during WS upgrade — will retry`);
    this.scheduleReconnect();
  }
});
```

**Warning signs:** Service stuck in "connecting" state; no `open`, `close`, or `error` events firing; log shows "connecting" but nothing after.

### Pitfall 2: Reconnect Scheduled After Stop

**What goes wrong:** `service.stop()` calls `ws.close()`. The `close` event fires asynchronously after `stop()` returns. If `shouldReconnect` is still `true`, the close handler schedules a reconnect.

**Why it happens:** `ws.close()` is asynchronous — the close event fires later.

**How to avoid:** Set `shouldReconnect = false` **before** calling `ws.close()`. See Pattern 5 above.

**Warning signs:** Gateway appears to stop but reconnection logs appear after `stop()`; process hangs because of open WS connection.

### Pitfall 3: Ping Timer Not Cleared on Reconnect

**What goes wrong:** First connection's ping timer fires after the old `ws` instance is gone. On the second connection, two ping timers are running. After `N` reconnects, `N` ping timers fire simultaneously.

**Why it happens:** `cleanup()` not called before creating a new `WebSocket` in the reconnect path.

**How to avoid:** Always call `stopHeartbeat()` in the close handler before scheduling reconnect.

```typescript
ws.on("close", (code) => {
  this.stopHeartbeat();  // MUST be before scheduleReconnect
  this.ws = null;
  if (this.shouldReconnect) {
    this.setState("reconnecting");
    this.scheduleReconnect();
  }
});
```

**Warning signs:** Ping interval appears to double after each reconnect; excessive pong-timeout false positives.

### Pitfall 4: Pong Timer Not Cleared on Clean Pong

**What goes wrong:** Pong arrives, but the timeout callback fires anyway (delayed execution). `ws.terminate()` is called on a healthy connection.

**Why it happens:** `clearTimeout` not called in the `pong` handler, or called on a stale timer reference.

**How to avoid:** Clear `pongTimer` reference immediately in the pong handler:

```typescript
ws.on("pong", () => {
  if (this.pongTimer) {
    clearTimeout(this.pongTimer);
    this.pongTimer = null;  // Clear reference — prevents double-clear
  }
});
```

**Warning signs:** Connections terminate ~50s after establishing; logs show "pong timeout" even when server is healthy.

### Pitfall 5: State Emitted Multiple Times for Same Transition

**What goes wrong:** Multiple `close` events or error handlers all call `setState("reconnecting")`, emitting the state event multiple times.

**Why it happens:** Both `error` and `close` events can fire for the same disconnect. `ws` guarantees `error` is followed by `close`, but if both handlers call `scheduleReconnect()`, two reconnects are scheduled.

**How to avoid:** Only schedule reconnect in the `close` handler. The `error` handler only logs:

```typescript
ws.on("error", (err) => {
  // Log only. close event fires next and handles reconnect.
  this.logger.error(`pipes-bot-channel: WS error: ${err.message}`);
});

ws.on("close", (code) => {
  // Single reconnect decision point
  this.stopHeartbeat();
  this.ws = null;
  if (this.shouldReconnect && isTransientClose(code)) {
    this.setState("reconnecting");
    this.scheduleReconnect();
  } else if (!this.shouldReconnect) {
    this.setState("disconnected");
  }
});
```

**Warning signs:** Log shows two "reconnect attempt" messages for a single disconnect; attempt counter increments by 2.

### Pitfall 6: Attempt Counter Not Reset After Successful Open

**What goes wrong:** A successful reconnect after 5 attempts should reset the backoff to 1s. If `reconnectAttempts` is not reset, the 6th disconnect starts at 64s delay instead of 1s.

**How to avoid:** Reset `reconnectAttempts = 0` in the `open` handler, not in the reconnect schedule function.

```typescript
ws.on("open", () => {
  this.reconnectAttempts = 0;  // Reset here — connection is confirmed open
  this.setState("connected");
  this.startHeartbeat(ws);
  this.logger.info("pipes-bot-channel: connected");
});
```

---

## Code Examples

### Full Connection Class Skeleton

```typescript
// src/connection.ts
// Source: Pattern derived from @pipes-bot/plugin ws-client.ts (MEDIUM confidence)
// + PipesBot docs (HIGH confidence) + OpenClaw plugin SDK types (HIGH confidence)
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import type { PluginLogger } from "openclaw/plugin-sdk";

type ConnectionState = "connected" | "disconnected" | "reconnecting";

const BASE_MS = 1_000;
const MAX_MS = 120_000;   // 2 minutes — user decision
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 50_000;  // 75s total: 25s interval + 50s wait = WS-03 compliance

function computeBackoffDelay(attempt: number): number {
  const cap = Math.min(MAX_MS, BASE_MS * Math.pow(2, attempt));
  return Math.floor(Math.random() * cap);  // Full jitter
}

function buildWsUrl(apiKey: string): string {
  return `wss://api.pipes.bot/ws?apiKey=${encodeURIComponent(apiKey)}`;
}

export class PipesBotConnection extends EventEmitter {
  private apiKey: string;
  private logger: PluginLogger;
  private ws: WebSocket | null = null;
  private state: ConnectionState = "disconnected";
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;

  constructor(apiKey: string, logger: PluginLogger) {
    super();
    this.apiKey = apiKey;
    this.logger = logger;
  }

  getState(): ConnectionState {
    return this.state;
  }

  connect(): void {
    this.shouldReconnect = true;
    this.doConnect();
  }

  disconnect(): void {
    this.shouldReconnect = false;           // 1. Prevent reconnects
    this.stopHeartbeat();                    // 2. Stop ping/pong timers
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close(1000, "service stopping");
    }
    this.ws = null;
    this.setState("disconnected");
  }

  send(message: object): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private doConnect(): void {
    // Never log the URL (contains apiKey in query string)
    const ws = new WebSocket(buildWsUrl(this.apiKey), {
      handshakeTimeout: 10_000,
    });
    this.ws = ws;

    ws.on("unexpected-response", (_req, response) => {
      const status = response.statusCode;
      if (status === 401 || status === 403) {
        this.logger.error(
          `pipes-bot-channel: authentication failed (HTTP ${status}) — stopping`
        );
        this.shouldReconnect = false;
        this.setState("disconnected");
        this.emit("error", new Error(`Auth failed: HTTP ${status}`));
      } else {
        this.logger.error(
          `pipes-bot-channel: HTTP ${status} during WS upgrade — will retry`
        );
        this.scheduleReconnect();
      }
    });

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.setState("connected");
      this.startHeartbeat(ws);
      this.logger.info("pipes-bot-channel: connected");
    });

    ws.on("message", (data) => {
      try {
        const msg: unknown = JSON.parse(data.toString());
        this.emit("message", msg);
      } catch {
        this.logger.warn("pipes-bot-channel: received unparseable message");
      }
    });

    ws.on("error", (err) => {
      // Log only. close event fires next.
      this.logger.error(`pipes-bot-channel: WS error: ${err.message}`);
    });

    ws.on("close", (code) => {
      this.stopHeartbeat();
      this.ws = null;
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      } else {
        this.setState("disconnected");
      }
    });
  }

  private scheduleReconnect(): void {
    this.setState("reconnecting");
    this.reconnectAttempts++;
    const delayMs = computeBackoffDelay(this.reconnectAttempts - 1);
    this.logger.info(
      `pipes-bot-channel: reconnect attempt ${this.reconnectAttempts}, next in ${Math.round(delayMs / 1000)}s`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) this.doConnect();
    }, delayMs);
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit("state", next);
    // Log state changes per CONTEXT.md
    if (next === "connected") this.logger.info("pipes-bot-channel: state → connected");
    if (next === "disconnected") this.logger.info("pipes-bot-channel: state → disconnected");
    // "reconnecting" logged in scheduleReconnect with attempt number
  }

  private startHeartbeat(ws: WebSocket): void {
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.ping();
      this.pongTimer = setTimeout(() => {
        this.logger.error("pipes-bot-channel: pong timeout — terminating connection");
        ws.terminate();  // Triggers close → reconnect
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);

    ws.on("pong", () => {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
    });
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }
}
```

### Updated `service.ts` Skeleton

```typescript
// src/service.ts (updated for Phase 2)
// Source: Phase 1 service.ts + PipesBotConnection integration
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { PipesBotConnection } from "./connection.js";

export function createPipesBotService(): OpenClawPluginService {
  let connection: PipesBotConnection | null = null;

  return {
    id: "pipes-bot-channel",

    start(ctx: OpenClawPluginServiceContext): void {
      const pluginConfig = ctx.config.plugins?.entries?.["pipes-bot-channel"]
        ?.config as { apiKey?: string } | undefined;
      const apiKey = pluginConfig?.apiKey;

      if (!apiKey || !apiKey.startsWith("pk_")) {
        ctx.logger.error(
          "pipes-bot-channel: invalid or missing pk_ API key — not starting"
        );
        return;
      }

      connection = new PipesBotConnection(apiKey, ctx.logger);

      connection.on("error", (err: Error) => {
        ctx.logger.error(`pipes-bot-channel: fatal error — ${err.message}`);
        // Phase 4: surface to OpenClaw dashboard
      });

      connection.on("message", (msg: unknown) => {
        // Phase 3: dispatch to OpenClaw agent pipeline
        void msg;
      });

      connection.connect();
    },

    stop(ctx: OpenClawPluginServiceContext): void {
      connection?.disconnect();
      connection = null;
      ctx.logger.info("pipes-bot-channel: service stopped");
    },
  };
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `ws` v7 API | `ws` v8 API | 2022 | v8 adds `autoPong` option and `pause()`/`resume()` methods; otherwise API-compatible for this use case |
| Browser WebSocket reconnect with `onerror` | Node.js `ws` with `unexpected-response` event | — | Browser WS fires `onerror` for HTTP 401 failures; Node `ws` fires `unexpected-response` with full response object; critical for auth failure detection |

**Deprecated/outdated:**
- Relying on `onerror` to detect HTTP-level auth failures: In Node.js `ws`, the `error` event does NOT fire for HTTP-level rejections (401/403). The `unexpected-response` event fires instead. This is a common migration mistake from browser WebSocket code.

---

## Open Questions

1. **PipesBot custom close codes (if any)**
   - What we know: PipesBot docs do not document any custom 4000–4999 close codes. The standard docs only mention standard codes. The blocker in STATE.md confirms this.
   - What's unclear: Whether PipesBot ever sends a custom close code for specific conditions (session expired, account suspended, etc.)
   - Recommendation: Follow the CONTEXT.md decision: treat all unknown close codes as transient. When testing against a real connection in Phase 2, observe any unexpected close codes and update the classification map if needed. Log the raw close code and reason in all close events at debug level.

2. **Pong timer accumulation on rapid reconnects**
   - What we know: If `ws.terminate()` is called (pong timeout), this fires the `close` event, which calls `stopHeartbeat()` which clears the `pongTimer`. But `pongTimer` is the timeout that called `terminate()` — it is already executing, so `clearTimeout` is a no-op.
   - What's unclear: Whether the pong timer reference gets nulled correctly before the next connection's heartbeat starts.
   - Recommendation: The pattern in Pitfall 4 handles this correctly — `pongTimer = null` after clearing. The critical path is `stopHeartbeat()` in close handler before `doConnect()` in reconnect, which ensures no old pong timer persists.

3. **`connected` message timing relative to queue drain**
   - What we know: PipesBot sends a `connected` event immediately after upgrade. For user-scoped connections, queued messages drain after `connected` (750ms between each).
   - What's unclear: Whether the Phase 2 implementation needs to distinguish `connected` envelope messages from `whatsapp_message` envelopes, or if both are just emitted as `message` events to Phase 3.
   - Recommendation: In Phase 2, emit all messages raw via the `message` event. Phase 3 will filter by `event.type`. The `connected` envelope serves as the handshake confirmation but needs no special handling in the transport layer.

---

## Sources

### Primary (HIGH confidence)

- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-docs/content/docs/websocket/index.mdx` — PipesBot WS endpoint, auth behavior, ping cadence, reconnection parameters, message types
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-docs/content/docs/websocket/messages.mdx` — Message envelope structure
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-docs/content/docs/websocket/offline-queuing.mdx` — Queue drain behavior on reconnect
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-channel/node_modules/openclaw/dist/plugin-sdk/plugins/types.d.ts` — `OpenClawPluginService`, `OpenClawPluginServiceContext`, `PluginLogger` types
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-channel/node_modules/@types/ws/index.d.ts` — `ws` v8 TypeScript API
- `https://websocket.org/reference/close-codes/` — Standard WS close code reference

### Secondary (MEDIUM confidence)

- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot/packages/plugin/src/ws-client.ts` — Reference PipesBot WS client (PipesBot's own implementation); used to cross-verify URL construction, ping interval, and reconnect pattern
- `https://oneuptime.com/blog/post/2026-01-27-websocket-reconnection/view` — Full jitter algorithm formula

### Tertiary (LOW confidence)

- `https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/` — AWS jitter principles (page content inaccessible via fetch, but concepts confirmed by secondary source above)

---

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — packages already installed and verified locally
- PipesBot API: HIGH — read from local docs repo in the same monorepo
- Architecture patterns: HIGH — derived from reference client + ws type definitions + PipesBot docs
- Close code classification: HIGH — standard spec + PipesBot docs confirm no custom codes
- Backoff algorithm: HIGH — standard math, user decisions locked
- Heartbeat design: HIGH — PipesBot docs + ws API verified; timing math satisfies WS-03
- Pitfalls: HIGH — derived from ws source code behavior, not blog posts

**Research date:** 2026-02-17
**Valid until:** 2026-03-17 (30 days — stable PipesBot API; ws v8 is stable; openclaw types may shift per STATE.md blocker)
