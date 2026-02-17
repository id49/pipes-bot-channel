# Phase 4: Outbound and Status - Research

**Researched:** 2026-02-17
**Domain:** PipesBot reply protocol, delivery status correlation, connection health reporting, OpenClaw channel status dashboard
**Confidence:** HIGH

---

## Summary

Phase 4 completes the send path and surfaces delivery outcomes and connection health. The PipesBot WebSocket protocol already supports `whatsapp_reply` (already partially wired in Phase 3's `deliver` callback) and `reply_status` events (not yet consumed). This phase makes delivery status observable and adds structured error handling for known failure codes.

The biggest architectural decision in this phase is **how to surface connection health to the OpenClaw dashboard** (OUT-04). The dashboard's `channels.status` gateway method only queries channel plugins registered via `api.registerChannel(ChannelPlugin)`. The current implementation uses `api.registerService()`, which is not included in that query. Two options exist: (1) add a `registerChannel` registration alongside the service, or (2) use `core.channel.activity.record()` which does flow into the `channels.status` snapshot via `getChannelActivity`. Option 2 is the correct fit — `recordChannelActivity` is already part of the runtime, requires no new plugin type, and the `channels.status` handler already reads activity timestamps when a plugin has no snapshot. The connection state itself (connected vs disconnected) can be maintained in a module-level variable and exposed via a lightweight `ChannelPlugin` registration or by annotating the `channel.activity` record with the connection state via the `connected` field in `ChannelAccountSnapshot`. After careful analysis, **the right approach is to add a minimal `registerChannel` call that exposes a static `ChannelPlugin` with a `status.buildAccountSnapshot` that reads from a module-level state store**. This is how IRC does it.

For delivery status correlation, `reply_status` events arrive asynchronously after sending. The correlation key is `conversationId` — the PipesBot docs confirm this is what ties a `reply_status` back to the `whatsapp_reply` that triggered it. There is no per-message sequence ID in the WebSocket protocol; only one reply per conversation can be in-flight at a time (PipesBot serializes per conversation on the server side). A `Map<string, PendingReply>` keyed by `conversationId` with a TTL-based expiry is the right pattern.

**Primary recommendation:** Handle `reply_status` events in `service.ts`'s message handler (alongside `whatsapp_message`). Add a module-level `statusStore` Map for pending correlation. Add a `registerChannel` call with a minimal `ChannelPlugin` for dashboard status. The deliver callback in `inbound.ts` stays fire-and-forget; failures surface through the `reply_status` event.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ws` (already installed) | `^8.18.0` | WebSocket send for outbound replies | Already in use; `PipesBotConnection.send()` is the send API |
| `openclaw/plugin-sdk` (peer dep) | installed | `ChannelPlugin`, `ChannelAccountSnapshot`, `recordChannelActivity`, `registerChannel` | Runtime APIs for health reporting and channel registration |
| `node:events` | Node built-in | Already used by `PipesBotConnection` | EventEmitter already owned by connection class |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| None | — | No new packages needed | All needed APIs are already installed |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Module-level `statusStore` Map for pending replies | Promise-based per-send tracking | Map is simpler; WS reply dispatch is fire-and-forget so no promise to resolve |
| `registerChannel` for dashboard status | `registerService` only (no dashboard) | Service-only registration is invisible to `channels.status`; adding a minimal channel registration is the only way to appear in the dashboard |
| TTL-based Map expiry via `setTimeout` | Never expiring | Memory leak if `reply_status` never arrives (e.g. WS drop before ack); TTL prevents accumulation |

**Installation:**

```bash
# No new packages needed
```

---

## PipesBot Reply Protocol

Source: `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-docs/content/docs/websocket/replies.mdx` (HIGH confidence)

### Sending a reply (whatsapp_reply)

The Phase 3 `deliver` callback already constructs this message correctly:

```json
{
  "type": "whatsapp_reply",
  "data": {
    "conversationId": "conv_xyz789",
    "poolNumberId": "pool_123",
    "toNumber": "+15559876543",
    "text": "Thanks for reaching out!"
  }
}
```

Fields from inbound message: `conversationId`, `poolNumberId`, `fromNumber` (maps to `toNumber`).
Text max: 4096 characters.
WebSocket-only: text only. Media replies require the REST API (out of scope for v1 per REQUIREMENTS.md).

### reply_status event

Arrives asynchronously after a `whatsapp_reply`:

```typescript
// Success
{
  type: "reply_status",
  data: {
    conversationId: "conv_xyz789",
    success: true,
    messageId: "wamid.abc123..."
  }
}

// Failure
{
  type: "reply_status",
  data: {
    conversationId: "conv_xyz789",
    success: false,
    error: "Service window expired — last inbound message is older than 24 hours.",
    code: "SERVICE_WINDOW_EXPIRED"
  }
}
```

### Known error codes (from REST API docs — apply to WS too)

Source: `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-docs/content/docs/sending-messages.mdx`

| Code | Meaning |
|------|---------|
| `SERVICE_WINDOW_EXPIRED` | Last inbound message older than 24 hours |
| `RATE_LIMITED` | 60 req/min exceeded (less relevant for WS but documented) |
| `INVALID_REQUEST` | Missing required fields |
| `FORBIDDEN` | Conversation belongs to another tenant |
| `NOT_FOUND` | Conversation not found |
| `SEND_FAILED` | WhatsApp rejected the message |

### Correlation: reply_status → whatsapp_reply

The `reply_status` identifies the conversation via `conversationId`. There is **no per-message sequence ID** in the WebSocket protocol. The server processes replies per conversation serially.

Correlation strategy: `Map<conversationId, PendingEntry>` where each entry contains the timestamp the reply was sent and a TTL expiry. When `reply_status` arrives, look up by `conversationId`, log outcome, evict entry.

---

## Architecture Patterns

### Recommended Project Structure

```
src/
├── connection.ts       # Phase 2 (unchanged)
├── runtime.ts          # Phase 2/3 (unchanged)
├── types.ts            # Phase 3: add PipesBotReplyStatus type
├── inbound.ts          # Phase 3: deliver callback stays fire-and-forget
├── media.ts            # Phase 3 (unchanged)
├── outbound.ts         # NEW: handleReplyStatus(), statusStore
├── channel.ts          # NEW: pipesBotChannelPlugin (ChannelPlugin) for dashboard
└── service.ts          # UPDATE: route reply_status events, connect activity recording
```

### Pattern 1: reply_status Handling

```typescript
// src/outbound.ts

export type ReplyFailureKind =
  | "SERVICE_WINDOW_EXPIRED"
  | "RATE_LIMITED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "SEND_FAILED"
  | "UNKNOWN";

export type PendingReply = {
  conversationId: string;
  sentAt: number;
  expiresAt: number;
};

// Module-level correlation store
const PENDING_TTL_MS = 30_000; // 30s TTL for pending reply tracking
const pendingReplies = new Map<string, PendingReply>();

export function trackOutboundReply(conversationId: string): void {
  const now = Date.now();
  pendingReplies.set(conversationId, {
    conversationId,
    sentAt: now,
    expiresAt: now + PENDING_TTL_MS,
  });
  // Evict expired entries
  const expired = [...pendingReplies.entries()]
    .filter(([, v]) => now > v.expiresAt)
    .map(([k]) => k);
  for (const key of expired) {
    pendingReplies.delete(key);
  }
}

export function handleReplyStatus(
  msg: unknown,
  opts: { logger: PluginLogger; core: PluginRuntime },
): void {
  if (!isPipesBotReplyStatus(msg)) return;
  const data = msg.data;
  const pending = pendingReplies.get(data.conversationId);
  pendingReplies.delete(data.conversationId);

  if (data.success) {
    opts.logger.info(
      `pipes-bot-channel: reply delivered to ${data.conversationId} (messageId: ${data.messageId})`,
    );
    // Record outbound activity for dashboard
    opts.core.channel.activity.record({
      channel: "pipes-bot-channel" as never,
      accountId: "default",
      direction: "outbound",
    });
    return;
  }

  // Parse error code
  const kind = classifyReplyFailure(data.code);
  const message = buildFailureMessage(kind, data.error);

  opts.logger.error(
    `pipes-bot-channel: reply failed for ${data.conversationId}: [${kind}] ${data.error ?? "unknown error"}`,
  );

  // Emit OpenClaw system event for agent-facing notification
  if (pending) {
    opts.core.system.enqueueSystemEvent(message, {
      sessionKey: `default:${data.conversationId}`,
    });
  }
}

function classifyReplyFailure(code?: string): ReplyFailureKind {
  switch (code) {
    case "SERVICE_WINDOW_EXPIRED": return "SERVICE_WINDOW_EXPIRED";
    case "RATE_LIMITED":           return "RATE_LIMITED";
    case "FORBIDDEN":              return "FORBIDDEN";
    case "NOT_FOUND":              return "NOT_FOUND";
    case "SEND_FAILED":            return "SEND_FAILED";
    default:                       return "UNKNOWN";
  }
}

function buildFailureMessage(kind: ReplyFailureKind, raw?: string): string {
  if (kind === "SERVICE_WINDOW_EXPIRED") {
    return (
      "Unable to send reply: the 24-hour WhatsApp messaging window has expired. " +
      "The contact must send a new message to reopen the conversation."
    );
  }
  return `Reply failed: ${raw ?? kind}`;
}
```

### Pattern 2: Typed reply_status Type Guard

```typescript
// Add to src/types.ts

export type PipesBotReplyStatus = {
  type: "reply_status";
  data: {
    conversationId: string;
    success: boolean;
    messageId?: string;    // Present on success
    error?: string;        // Present on failure
    code?: string;         // Present on failure
  };
};

export function isPipesBotReplyStatus(msg: unknown): msg is PipesBotReplyStatus {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    (msg as { type: unknown }).type === "reply_status" &&
    "data" in msg
  );
}
```

### Pattern 3: service.ts message routing

Route both `whatsapp_message` and `reply_status` in the same message handler:

```typescript
// src/service.ts — updated message handler
connection.on("message", (msg: object) => {
  // Route reply_status events
  if (isPipesBotReplyStatus(msg)) {
    handleReplyStatus(msg, { logger: ctx.logger, core: getPipesBotRuntime() });
    return;
  }

  // Route whatsapp_message events
  void handleInbound(msg, {
    apiKey,
    accountId: "default",
    send: (payload: object) => {
      const sent = connection!.send(payload);
      if (sent) {
        // Track the outbound for reply_status correlation
        const replyData = (payload as { data?: { conversationId?: string } }).data;
        if (replyData?.conversationId) {
          trackOutboundReply(replyData.conversationId);
        }
      }
      return sent;
    },
    logger: ctx.logger,
  }).catch((err: unknown) => {
    ctx.logger.error(`pipes-bot-channel: inbound error: ${String(err)}`);
  });
});
```

**Note:** The existing `deliver` callback in `inbound.ts` calls `send()`. The `trackOutboundReply` call wraps the send callback in `service.ts` so correlation tracking is transparent to `inbound.ts`.

### Pattern 4: Connection Health for Dashboard (OUT-04)

The `channels.status` gateway method queries `ChannelPlugin` registrations only. The current service registers via `registerService`. To appear in the dashboard, add a minimal `registerChannel` call.

Key finding from `src/gateway/server-methods/channels.ts`: the `channels.status` handler calls `buildChannelAccountSnapshot` which reads from `runtime` (the gateway's per-channel state store), then falls back to `getChannelActivity` for `lastInboundAt`/`lastOutboundAt` timestamps.

For plugins that register via `registerChannel` with a `ChannelPlugin.status.buildAccountSnapshot`, the snapshot is computed on demand from the plugin's account config + runtime state. This is how IRC reports its `running`, `connected`, `lastError` fields.

Since the plugin has no `accounts` in the usual sense (single account, no `listAccountIds` config), the simplest approach is a minimal `ChannelPlugin` that:
1. Returns `["default"]` from `listAccountIds`
2. Returns a fixed config object from `resolveAccount`
3. Implements `status.buildAccountSnapshot` reading from a module-level connection state store
4. Has `status.defaultRuntime` with `connected: false`

```typescript
// src/status-store.ts (NEW)

export type PipesBotConnectionStatus = {
  connected: boolean;
  authFailed: boolean;
  lastConnectedAt: number | null;
  lastError: string | null;
};

let _status: PipesBotConnectionStatus = {
  connected: false,
  authFailed: false,
  lastConnectedAt: null,
  lastError: null,
};

export function updateConnectionStatus(patch: Partial<PipesBotConnectionStatus>): void {
  _status = { ..._status, ...patch };
}

export function getConnectionStatus(): PipesBotConnectionStatus {
  return { ..._status };
}
```

```typescript
// src/channel.ts (NEW)
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
    defaultRuntime: {
      accountId: "default",
      connected: false,
      lastError: null,
    },
    buildAccountSnapshot: ({ runtime }) => {
      const status = getConnectionStatus();
      return {
        accountId: "default",
        connected: status.connected,
        running: !status.authFailed,
        lastConnectedAt: status.lastConnectedAt,
        lastError: status.authFailed
          ? "Authentication failed — check your pk_ API key"
          : (status.lastError ?? runtime?.lastError ?? null),
      };
    },
  },
};
```

```typescript
// index.ts — add registerChannel alongside registerService
import { pipesBotChannelPlugin } from "./src/channel.js";

register(api: OpenClawPluginApi): void {
  setPipesBotRuntime(api.runtime);
  api.registerChannel({ plugin: pipesBotChannelPlugin });  // ADD for dashboard status
  api.registerService(createPipesBotService());
  api.logger.info("pipes-bot-channel: registered");
}
```

### Pattern 5: Wiring connection state → statusStore

The `PipesBotConnection` emits `"state"` events with `ConnectionState` values. Wire these in `service.ts`:

```typescript
// src/service.ts — in start()
connection.on("state", (state: ConnectionState) => {
  updateConnectionStatus({
    connected: state === "connected",
    ...(state === "connected" ? { lastConnectedAt: Date.now(), lastError: null } : {}),
  });
});

connection.on("error", (err: Error) => {
  const isAuthFailure = err.message.includes("auth failed");
  updateConnectionStatus({
    connected: false,
    authFailed: isAuthFailure,
    lastError: err.message,
  });
  ctx.logger.error(`pipes-bot-channel: fatal connection error: ${err.message}`);
});
```

### Pattern 6: Activity recording for inbound/outbound timestamps

Call `core.channel.activity.record` from the inbound handler (inbound direction) and from the `deliver` callback (outbound direction):

```typescript
// In handleInbound() deliver callback:
core.channel.activity.record({
  channel: "pipes-bot-channel" as never,
  accountId: "default",
  direction: "outbound",
});

// After successful message dispatch:
core.channel.activity.record({
  channel: "pipes-bot-channel" as never,
  accountId: accountId,
  direction: "inbound",
  at: new Date(data.timestamp).getTime(),
});
```

The `channel` parameter type is `ChannelId = ChatChannelId | (string & {})`, so `"pipes-bot-channel" as never` (or just the string without cast, since `ChannelId` allows any string) works correctly. Use `"pipes-bot-channel" as ChannelId` to be safe.

### Anti-Patterns to Avoid

- **Blocking deliver on reply_status:** The `deliver` callback must return immediately; do NOT await a reply_status Promise inside it. Use fire-and-forget.
- **Correlating by messageId instead of conversationId:** `reply_status.data.messageId` is only present on success. Use `conversationId` as the correlation key (it is always present in both the send payload and the reply_status event).
- **Forgetting to evict expired pending entries:** Without TTL eviction, the `pendingReplies` Map grows unboundedly under packet loss or WS drops.
- **Using `enqueueSystemEvent` without a valid sessionKey:** The function throws if `sessionKey` is empty string. Always construct the session key as `${accountId}:${conversationId}`.
- **Registering `pipesBotChannelPlugin` without a `meta` field:** `ChannelPlugin.meta` is required and must include at minimum `id`, `label`, `selectionLabel`, `docsPath`, `blurb`. Missing these causes dashboard rendering failures.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Activity timestamps in dashboard | Manual state file or DB | `core.channel.activity.record({ direction: "inbound"/"outbound" })` | Already wired into `channels.status` snapshot — zero extra code |
| Custom event bus for reply failures | Custom EventEmitter | `core.system.enqueueSystemEvent(message, { sessionKey })` | Prepended to the agent's next prompt automatically; no poll loop needed |
| Dashboard status without ChannelPlugin | HTTP endpoint or polling | `registerChannel` + `ChannelPlugin.status.buildAccountSnapshot` | Only approach wired into the `channels.status` gateway method |
| Reply status tracking without TTL | Unbounded Map | `Map` with TTL eviction on `Date.now() > expiresAt` | Prevents memory leak under disconnects or dropped acks |

**Key insight:** The OpenClaw channel activity API already integrates with the dashboard. Use it for all activity tracking rather than maintaining a separate state file.

---

## Common Pitfalls

### Pitfall 1: reply_status Never Arrives (WS Drops Mid-Send)

**What goes wrong:** If the WebSocket disconnects after `whatsapp_reply` is sent but before `reply_status` arrives, the pending entry in `pendingReplies` is never evicted. Over time this leaks memory.

**Why it happens:** `reply_status` is an asynchronous server callback. No receipt guarantee.

**How to avoid:** Implement TTL eviction. Sweep expired entries on every `trackOutboundReply` call (lazy eviction). 30 seconds is a safe TTL — the PipesBot API responds within seconds under normal operation.

**Warning signs:** `pendingReplies.size` grows monotonically under stress testing.

### Pitfall 2: Channel Plugin meta field is Required

**What goes wrong:** `ChannelPlugin.meta` is required. Omitting it or providing an incomplete `meta` object causes the dashboard to throw when rendering the channel list.

**Why it happens:** `buildChannelUiCatalog(plugins)` in the `channels.status` handler reads `plugin.meta` unconditionally.

**How to avoid:** Always provide all required `meta` fields: `id`, `label`, `selectionLabel`, `docsPath`, `blurb`. Optional: `order`, `aliases`.

**Warning signs:** Dashboard crashes or shows blank channel entry when `pipes-bot-channel` is installed.

### Pitfall 3: enqueueSystemEvent with Empty sessionKey

**What goes wrong:** `core.system.enqueueSystemEvent(text, { sessionKey: "" })` throws `"system events require a sessionKey"`.

**Why it happens:** The function validates the key is non-empty. If `conversationId` is somehow empty, the session key evaluates to `"default:"` which is non-empty, but `"default:"` is a valid key format (consistent with inbound session keys).

**How to avoid:** Always construct `sessionKey` as `${accountId}:${conversationId}` before calling. Guard with `if (!conversationId) return;` before enqueue.

**Warning signs:** Unhandled exception in the `reply_status` handler path.

### Pitfall 4: ChannelId Type Cast

**What goes wrong:** `core.channel.activity.record({ channel: "pipes-bot-channel", ... })` — the `channel` parameter type is `ChannelId = ChatChannelId | (string & {})`. TypeScript may complain if the type is narrowed incorrectly.

**Why it happens:** `ChatChannelId` is a union of built-in channel IDs. Custom plugin IDs like `"pipes-bot-channel"` are valid via `(string & {})` but TypeScript may need the cast.

**How to avoid:** Use `"pipes-bot-channel" as ChannelId` or just use `"pipes-bot-channel"` — the `(string & {})` type allows any string literal. The prior decision (from Phase 3) confirmed that `OriginatingChannel: "pipes-bot-channel"` works without cast due to the same union type.

**Warning signs:** TypeScript error `Type '"pipes-bot-channel"' is not assignable to type 'ChatChannelId'`.

### Pitfall 5: Connecting State → dashboard "disconnected"

**What goes wrong:** Per the context decision, `reconnecting` counts as `disconnected` (two states, not three). If `updateConnectionStatus({ connected: false })` is called on `reconnecting` state, but the last error is cleared, the dashboard shows "disconnected, no error" which is slightly misleading.

**Why it happens:** The `ConnectionState.reconnecting` state is a transient state that doesn't map to a stable condition.

**How to avoid:** When `state === "reconnecting"`, set `connected: false` but preserve `lastError`. Do NOT clear `lastError` on reconnecting — only clear it when `state === "connected"`.

**Warning signs:** Dashboard shows "disconnected" with no error after a brief network hiccup.

### Pitfall 6: Auth failure detection from error message

**What goes wrong:** Detecting auth failures by parsing the error message string (`err.message.includes("auth failed")`) is fragile.

**Why it happens:** The error message format is internal to `PipesBotConnection`.

**How to avoid:** In `PipesBotConnection`, the `error` event emits with `new Error("WebSocket auth failed: HTTP 401")`. Use `err.message.includes("auth failed")` for now — but better: add a specific `authFailed` event or include a `cause` property. For Phase 4, matching the known string from `connection.ts` line 103 is sufficient.

**Warning signs:** Auth failures show as "disconnected" instead of "auth error" in the dashboard.

---

## Code Examples

Verified patterns from source inspection:

### complete types.ts additions

```typescript
// Add to src/types.ts

export type PipesBotReplyStatus = {
  type: "reply_status";
  data: {
    conversationId: string;
    success: boolean;
    messageId?: string;
    error?: string;
    code?: string;
  };
};

export function isPipesBotReplyStatus(msg: unknown): msg is PipesBotReplyStatus {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    (msg as { type: unknown }).type === "reply_status" &&
    "data" in msg
  );
}
```

### enqueueSystemEvent usage pattern

```typescript
// Source: extensions/feishu/src/bot.ts
core.system.enqueueSystemEvent(
  "Unable to reply: the 24-hour WhatsApp window has expired. Wait for the contact to message again.",
  { sessionKey: `default:${data.conversationId}` },
);
```

### channel.activity.record usage pattern

```typescript
// Source: extensions/irc/src/monitor.ts:104-109
core.channel.activity.record({
  channel: "pipes-bot-channel",   // ChannelId = ChatChannelId | (string & {})
  accountId: "default",
  direction: "inbound",
  at: message.timestamp,
});
```

### IRC-style buildAccountSnapshot

```typescript
// Source: extensions/irc/src/channel.ts:327-344
buildAccountSnapshot: ({ account, runtime, probe }) => ({
  accountId: account.accountId,
  connected: runtime?.connected ?? false,
  running: runtime?.running ?? false,
  lastConnectedAt: runtime?.lastConnectedAt ?? null,
  lastError: runtime?.lastError ?? null,
  lastInboundAt: runtime?.lastInboundAt ?? null,
  lastOutboundAt: runtime?.lastOutboundAt ?? null,
}),
```

### ChannelPlugin minimal registration

```typescript
// Source: extensions/irc/index.ts pattern
register(api: OpenClawPluginApi): void {
  setPipesBotRuntime(api.runtime);
  api.registerChannel({ plugin: pipesBotChannelPlugin });
  api.registerService(createPipesBotService());
  api.logger.info("pipes-bot-channel: registered");
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Poll for delivery acks | Async `reply_status` events via WebSocket | PipesBot protocol design | No polling needed; status arrives on same connection |
| Separate HTTP endpoint for health | `registerChannel` + `buildAccountSnapshot` | OpenClaw dashboard architecture | Single gateway call returns all channel health |
| Untyped error codes | Typed `ReplyFailureKind` enum | Phase 4 decision | Enables per-code handling and human-readable messages |

**Deprecated/outdated:**
- REST API fallback: explicitly out of scope per REQUIREMENTS.md (WebSocket-only replies for v1)
- Media outbound via WebSocket: v2 only (WebSocket only supports text; media requires REST)

---

## Open Questions

1. **Does `registerChannel` alongside `registerService` create any ordering or lifecycle conflict?**
   - What we know: `registerChannel` is a static declaration; it does not start a connection. `registerService` starts the WS connection. The channel plugin registration happens at load time.
   - What's unclear: Whether the gateway manager will try to call `plugin.gateway.startAccount` when it sees the registered channel plugin, which would conflict with the service-managed connection.
   - Recommendation: Omit `plugin.gateway` entirely from `pipesBotChannelPlugin`. Only provide `plugin.config`, `plugin.status`, `plugin.capabilities`, and `plugin.meta`. Without a `gateway` adapter, the channel manager will not try to start it.

2. **Status TTL: what is the right value for `PENDING_TTL_MS`?**
   - What we know: PipesBot processes replies quickly (sub-second under normal conditions). The 24-hour window error is returned promptly.
   - What's unclear: Maximum observed round-trip time from send to `reply_status` in production.
   - Recommendation: 30 seconds (30_000 ms). Generous enough for slow networks, tight enough to prevent significant memory accumulation under drop scenarios.

3. **Does `enqueueSystemEvent` require an active session?**
   - What we know: `enqueueSystemEvent` is session-keyed and the event is prepended to the next agent prompt for that session key. If no session exists for `${accountId}:${conversationId}`, the event is enqueued but may never be consumed.
   - What's unclear: Whether enqueueing without an active session silently drops the event or accumulates.
   - Recommendation: Inspect the implementation — `enqueueSystemEvent` accepts any sessionKey, caps at 20 events per key, and drains on next agent invocation. Safe to call even if the session is currently idle — the event persists until the next message arrives.

---

## Sources

### Primary (HIGH confidence)

- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-docs/content/docs/websocket/replies.mdx`
  - `whatsapp_reply` schema, `reply_status` schema, `conversationId` as correlation key
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-docs/content/docs/sending-messages.mdx`
  - Error code table (`SERVICE_WINDOW_EXPIRED`, `RATE_LIMITED`, `SEND_FAILED`, etc.)
- `/Users/tulio/Projects/temp/openclaw/src/channels/plugins/types.core.ts`
  - `ChannelAccountSnapshot` type (all fields: `connected`, `running`, `lastError`, `lastConnectedAt`, etc.)
- `/Users/tulio/Projects/temp/openclaw/src/channels/plugins/types.adapters.ts`
  - `ChannelStatusAdapter`, `ChannelConfigAdapter`, `ChannelPlugin` type
- `/Users/tulio/Projects/temp/openclaw/src/channels/plugins/types.plugin.ts`
  - `ChannelPlugin` full type definition
- `/Users/tulio/Projects/temp/openclaw/src/infra/channel-activity.ts`
  - `recordChannelActivity`, `getChannelActivity` implementation
- `/Users/tulio/Projects/temp/openclaw/src/infra/system-events.ts`
  - `enqueueSystemEvent` implementation and session key requirements
- `/Users/tulio/Projects/temp/openclaw/src/gateway/server-methods/channels.ts`
  - `channels.status` handler — confirms only `ChannelPlugin` registrations appear, plus `getChannelActivity` fallback for inbound/outbound timestamps
- `/Users/tulio/Projects/temp/openclaw/src/gateway/server-channels.ts`
  - `ChannelRuntimeSnapshot` — how runtime state is stored and retrieved
- `/Users/tulio/Projects/temp/openclaw/extensions/irc/src/channel.ts`
  - `ircPlugin.status.buildAccountSnapshot` — reference implementation for per-account status snapshots
- `/Users/tulio/Projects/temp/openclaw/extensions/irc/src/monitor.ts`
  - `core.channel.activity.record` usage pattern for inbound and outbound
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-channel/src/connection.ts`
  - `PipesBotConnection` state machine — `"state"` event emits `ConnectionState`, `"error"` emits auth failure
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-channel/src/service.ts`
  - Current service wiring — where to add `reply_status` routing and state listeners
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-channel/src/inbound.ts`
  - Existing `deliver` callback — fire-and-forget send, no delivery correlation

### Secondary (MEDIUM confidence)

- `extensions/feishu/src/bot.ts` — `enqueueSystemEvent` usage pattern (verified against `system-events.ts` implementation)
- `extensions/irc/index.ts` — `registerChannel` + `registerService` coexistence pattern

---

## Metadata

**Confidence breakdown:**
- PipesBot reply protocol: HIGH — from local docs repo (authoritative)
- reply_status event schema: HIGH — from local docs repo, cross-verified with index.mdx example
- Error code taxonomy: HIGH — from sending-messages.mdx (REST + WS share codes)
- OpenClaw activity recording: HIGH — from source (`channel-activity.ts`)
- ChannelPlugin status adapter pattern: HIGH — from source (`types.adapters.ts`, IRC reference)
- channels.status query mechanism: HIGH — from source (`server-methods/channels.ts`)
- enqueueSystemEvent behavior: HIGH — from source (`system-events.ts`)
- registerChannel + registerService coexistence: MEDIUM — inferred from IRC pattern; no explicit documentation, but both are registration-only calls that don't conflict
- Pending reply TTL value (30s): LOW — no documented round-trip SLA from PipesBot; 30s is a reasonable estimate

**Research date:** 2026-02-17
**Valid until:** 2026-03-19 (30 days — stable APIs, local docs repo)
