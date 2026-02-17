# Architecture Research

**Domain:** OpenClaw channel plugin (WhatsApp bridge via PipesBot WebSocket)
**Researched:** 2026-02-17
**Confidence:** HIGH (sourced from OpenClaw source tree at /Users/tulio/Projects/temp/openclaw)

---

## Standard Architecture

### System Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                          OpenClaw Gateway Process                       │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                     Plugin Registration Layer                     │  │
│  │  index.ts: { id, name, configSchema, register(api) }             │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                │                                        │
│              ┌─────────────────▼──────────────────┐                   │
│              │         PluginRuntime (api.runtime)  │                   │
│              │  channel.reply, channel.routing,     │                   │
│              │  channel.session, channel.pairing,   │                   │
│              │  channel.text, channel.activity,     │                   │
│              │  channel.media, logging, config       │                   │
│              └────────────────────────────────────--┘                   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                  Channel Plugin (channel.ts)                      │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │  │
│  │  │  config  │ │ security │ │ outbound │ │     gateway       │   │  │
│  │  │ adapter  │ │ adapter  │ │ adapter  │ │     adapter       │   │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────┬─────────┘   │  │
│  └───────────────────────────────────────────────────┼─────────────┘  │
│                                                       │                 │
│  ┌────────────────────────────────────────────────────▼─────────────┐  │
│  │             Monitor / WebSocket Loop (monitor.ts / inbound.ts)    │  │
│  │  gateway.startAccount() → monitorProvider() → runWithReconnect() │  │
│  │  ┌──────────────────────────────────────────────────────────┐    │  │
│  │  │  connectOnce() → ws.on(message) → handleInbound()        │    │  │
│  │  │  handleInbound() → routing → session → dispatchReply()   │    │  │
│  │  └──────────────────────────────────────────────────────────┘    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
           │ outbound.sendText()               ▲ inbound messages
           ▼                                   │
┌─────────────────────────────────────────────────────────────────────────┐
│                         PipesBot WebSocket                               │
│   wss://host/ws?apiKey=pk_XXX                                           │
│   Receive: whatsapp_message events                                      │
│   Send:    whatsapp_reply messages                                      │
│   Confirm: reply_status responses                                       │
│   Keep-alive: ping every 25s                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| `index.ts` | Plugin entry point; calls `setRuntime(api.runtime)` and `api.registerChannel({ plugin })` | ~15 lines, always identical across channel plugins |
| `openclaw.plugin.json` | Manifest declaring plugin id, channel ids, and config schema stub | JSON file, minimal in practice |
| `package.json` | NPM package with `"openclaw": { "extensions": ["./index.ts"] }` field | Declares `openclaw` as workspace devDependency |
| `src/runtime.ts` | Holds singleton reference to `PluginRuntime` injected at registration time | ~15 lines: `setRuntime()` / `getRuntime()` pair |
| `src/channel.ts` | The `ChannelPlugin<ResolvedAccount>` object; all adapter wiring | Core file; see Adapter Inventory below |
| `src/config-schema.ts` | TypeBox schema for `channels.pipesbot.*` config section | Used by `buildChannelConfigSchema()` |
| `src/accounts.ts` | `listAccountIds()`, `resolveAccount()`, `ResolvedAccount` type | Reads from `cfg.channels.pipesbot` |
| `src/monitor.ts` | `monitorPipesBotProvider()` — WebSocket loop with reconnection via `runWithReconnect()` | Spawned by `gateway.startAccount()` |
| `src/websocket.ts` | `connectOnce()` factory — raw WebSocket open/message/close/error handling | Testable via factory injection |
| `src/inbound.ts` | `handleInbound()` — security gate, routing, session, dispatch | Calls `core.channel.reply.dispatchReplyFromConfig()` |
| `src/send.ts` | `sendMessage()` — formats and sends `whatsapp_reply` over active or transient WS connection | Used by `outbound.sendText()` |
| `src/normalize.ts` | `normalizeTarget()`, `looksLikeTargetId()`, E.164 phone normalization | Pure functions, easily unit tested |
| `src/reconnect.ts` | `runWithReconnect()` with exponential backoff + jitter + `AbortSignal` | Can be copied from Mattermost extension verbatim |

---

## Recommended Project Structure

```
pipes-bot-channel/
├── index.ts                    # Plugin entry point (register + runtime injection)
├── openclaw.plugin.json        # Manifest: { id, channels, configSchema }
├── package.json                # { "openclaw": { "extensions": ["./index.ts"] } }
└── src/
    ├── runtime.ts              # PluginRuntime singleton (get/set)
    ├── channel.ts              # ChannelPlugin<ResolvedPipesBotAccount> object
    ├── config-schema.ts        # TypeBox schema for channels.pipesbot.*
    ├── accounts.ts             # listAccountIds, resolveAccount, ResolvedPipesBotAccount
    ├── normalize.ts            # normalizeTarget, looksLikeId, E.164 helpers
    ├── reconnect.ts            # runWithReconnect (exponential backoff, AbortSignal)
    ├── websocket.ts            # createConnectOnce: raw WS open/msg/close/error
    ├── monitor.ts              # monitorPipesBotProvider: reconnect loop + ping timer
    ├── inbound.ts              # handleInbound: security → routing → session → dispatch
    └── send.ts                 # sendMessage: format + deliver whatsapp_reply over WS
```

### Structure Rationale

- **`index.ts` at root:** OpenClaw extension loader expects `./index.ts` as declared in `package.json`'s `openclaw.extensions` field.
- **`runtime.ts`:** Module-level singleton is the established pattern across all OpenClaw channel plugins (irc, telegram, discord, slack, whatsapp). Avoids threading runtime through every call site.
- **`websocket.ts` separated from `monitor.ts`:** Enables injecting a factory for testing without a real WebSocket server (pattern from Mattermost's `monitor-websocket.ts` + `MattermostWebSocketFactory`).
- **`reconnect.ts`:** Isolated utility; the Mattermost implementation is a clean 100-line module that can be reused or copied directly.
- **`inbound.ts` separated from `monitor.ts`:** Keeps the long security/routing/dispatch logic independently testable (pattern from IRC's `inbound.ts`).

---

## Architectural Patterns

### Pattern 1: Runtime Singleton Injection

**What:** The plugin's `register(api)` function calls `setRuntime(api.runtime)` immediately, storing `api.runtime` in a module-level variable. All internal modules call `getRuntime()` to access OpenClaw facilities (logging, reply dispatch, session, routing, etc.).

**When to use:** Always. This is universal across all OpenClaw channel plugins.

**Trade-offs:** Simplifies call signatures dramatically; makes the module non-reusable in isolation (acceptable since plugins are always in-process with Gateway).

**Example:**
```typescript
// src/runtime.ts
import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setPipesBotRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getPipesBotRuntime(): PluginRuntime {
  if (!runtime) throw new Error("PipesBot runtime not initialized");
  return runtime;
}

// index.ts
register(api) {
  setPipesBotRuntime(api.runtime);
  api.registerChannel({ plugin: pipesBotPlugin });
}
```

### Pattern 2: WebSocket Connect-Once + Reconnect Loop

**What:** The connection logic is split into two layers. The inner layer (`connectOnce`) returns a Promise that resolves on clean close and rejects on error (before open). The outer loop (`runWithReconnect`) wraps it with exponential backoff, jitter, and `AbortSignal` support.

**When to use:** Any channel plugin connecting to an external WebSocket (Mattermost, and now PipesBot). Required for production robustness.

**Trade-offs:** The Promise resolution semantics (resolve = clean close, reject = failure before open) must be understood to correctly classify reconnect vs. non-retry scenarios.

**Example:**
```typescript
// src/websocket.ts
export function createConnectOnce(opts: ConnectOnceOpts): () => Promise<void> {
  return async () => {
    const ws = new WebSocket(`wss://${opts.host}/ws?apiKey=${opts.apiKey}`);
    const onAbort = () => ws.terminate();
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        let opened = false;
        ws.on("open", () => {
          opened = true;
          opts.statusSink?.({ connected: true, lastConnectedAt: Date.now() });
          startPingInterval(ws, opts);
        });
        ws.on("message", (data) => opts.onMessage(data));
        ws.on("close", (code) => {
          opts.statusSink?.({ connected: false });
          opened ? resolve() : reject(new Error(`closed before open: ${code}`));
        });
        ws.on("error", (err) => {
          opts.statusSink?.({ lastError: String(err) });
          ws.close();
        });
      });
    } finally {
      opts.abortSignal?.removeEventListener("abort", onAbort);
    }
  };
}

// src/monitor.ts
await runWithReconnect(createConnectOnce(opts), {
  abortSignal: opts.abortSignal,
  jitterRatio: 0.2,
  onError: (err) => runtime.error?.(`pipesbot: connection failed: ${String(err)}`),
  onReconnect: (ms) => runtime.log?.(`pipesbot: reconnecting in ${Math.round(ms / 1000)}s`),
});
```

### Pattern 3: Gateway Adapter as Process Lifecycle Hook

**What:** `gateway.startAccount(ctx)` is called by OpenClaw's Gateway when it wants to start the channel for a given account. It receives an `abortSignal` to tear down cleanly and a `statusSink` to push live connection status. The function is expected to run until the abort signal fires.

**When to use:** All channels that maintain a persistent connection. The gateway adapter is the bridge between OpenClaw's lifecycle management and the channel's own connection loop.

**Trade-offs:** The `startAccount` function must not resolve until the channel is stopped. It does not return a cleanup handle — shutdown is done via `ctx.abortSignal`.

**Example:**
```typescript
// in channel.ts
gateway: {
  startAccount: async (ctx) => {
    ctx.log?.info(`[${ctx.accountId}] starting PipesBot provider`);
    await monitorPipesBotProvider({
      accountId: ctx.accountId,
      config: ctx.cfg,
      runtime: ctx.runtime,
      abortSignal: ctx.abortSignal,
      statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
    });
  },
},
```

### Pattern 4: Inbound Message → Context Payload → Dispatch

**What:** Every inbound message goes through a fixed pipeline: (1) security gate (DM policy, allow-from, group policy), (2) route resolution (which agent handles this conversation), (3) session update, (4) context payload construction (`finalizeInboundContext`), (5) dispatch via `dispatchReplyFromConfig` or `dispatchReplyWithBufferedBlockDispatcher`.

**When to use:** Always for the inbound handler. Skipping security gates or routing is a critical mistake.

**Trade-offs:** The pipeline is verbose but comprehensive. Most fields in `finalizeInboundContext` have defaults — only the required fields (`Body`, `From`, `To`, `SessionKey`, `Provider`, `Surface`) are strictly required for minimal operation.

---

## Data Flow

### Inbound Message Flow (PipesBot → OpenClaw Agent)

```
PipesBot WebSocket
    │  whatsapp_message event (JSON)
    ▼
websocket.ts: ws.on("message")
    │  parse JSON → raw message fields
    ▼
monitor.ts: onMessage()
    │  check abortSignal, update activity timestamp
    ▼
inbound.ts: handleInbound()
    │
    ├── Security Gate
    │     resolveAccount() → dmPolicy / groupPolicy
    │     readAllowFromStore() (pairing store)
    │     allow / drop / send pairing reply
    │
    ├── Mention Gate (group messages only)
    │     buildMentionRegexes() → wasMentioned?
    │     requireMention? → drop if not mentioned
    │
    ├── Route Resolution
    │     core.channel.routing.resolveAgentRoute()
    │     → { agentId, sessionKey, accountId }
    │
    ├── Session Update
    │     core.channel.session.recordInboundSession()
    │     or updateLastRoute() for DMs
    │
    ├── Context Payload Construction
    │     core.channel.reply.finalizeInboundContext({
    │       Body, From, To, SessionKey, Provider, Surface,
    │       ChatType, SenderName, SenderId, Timestamp, ...
    │     })
    │
    └── Dispatch
          core.channel.reply.dispatchReplyFromConfig()
          → LLM inference → reply payload
          → deliver() callback → send.ts → PipesBot WS
```

### Outbound Message Flow (OpenClaw Agent → PipesBot)

```
outbound.sendText({ to, text, accountId })
    │
    ▼
send.ts: sendMessage(to, text, opts)
    │  format whatsapp_reply JSON
    │  use active WS connection (held in monitor.ts)
    ▼
PipesBot WebSocket: ws.send(JSON)
    │
    ▼
PipesBot: reply_status confirmation
    │  (optional: wait for ack)
    ▼
return { channel: "pipesbot", messageId }
```

### Keep-Alive Flow

```
monitor.ts: after WS open
    │
    ▼
setInterval(ping, 25_000)
    │  ws.send(JSON.stringify({ type: "ping" }))
    │
    ▼
PipesBot: pong response (or silent ack)

On WS close/abort: clearInterval(pingTimer)
```

### Status Flow

```
websocket.ts: on("open") / on("close") / on("error")
    │  statusSink({ connected, lastConnectedAt, lastError, ... })
    ▼
monitor.ts: opts.statusSink(patch)
    │
    ▼
gateway.startAccount ctx.setStatus({ accountId, ...patch })
    │
    ▼
OpenClaw Gateway: ChannelAccountSnapshot
    (visible in `openclaw status`, heartbeat checks)
```

---

## Component Boundaries

| Boundary | Communication | Direction | Notes |
|----------|---------------|-----------|-------|
| `index.ts` ↔ `channel.ts` | Import — exports `pipesBotPlugin` | index imports channel | One-way; index just wires things |
| `index.ts` ↔ `runtime.ts` | Import — calls `setRuntime(api.runtime)` | index calls setter | One-time at registration |
| `channel.ts` ↔ `runtime.ts` | Import — calls `getRuntime()` | channel calls getter | All adapters use this |
| `channel.ts` ↔ `monitor.ts` | Import — `gateway.startAccount` calls `monitorPipesBotProvider` | channel invokes monitor | Awaits until abort |
| `channel.ts` ↔ `send.ts` | Import — `outbound.sendText` calls `sendMessage` | channel invokes send | Synchronous call path |
| `monitor.ts` ↔ `websocket.ts` | Import — calls `createConnectOnce` factory | monitor composes websocket | WS factory allows DI for tests |
| `monitor.ts` ↔ `reconnect.ts` | Import — `runWithReconnect(connectOnce, opts)` | monitor uses reconnect loop | Reconnect is a pure utility |
| `monitor.ts` ↔ `inbound.ts` | Import — `onMessage` handler calls `handleInbound` | monitor delegates to inbound | Separation enables unit testing |
| `inbound.ts` ↔ `send.ts` | Import — `deliverReply` calls `sendMessage` for the pairing reply and inline replies | inbound calls send | Only for pairing + inline delivery |
| `inbound.ts` ↔ `runtime.ts` | Import — all `core.channel.*` calls via `getRuntime()` | inbound calls getter | Routing, session, reply dispatch |
| `send.ts` ↔ `runtime.ts` | Import — `getRuntime()` for activity tracking, logging | send calls getter | Records outbound activity |

---

## Suggested Build Order

Dependencies determine the build sequence. Each phase can only be built after its prerequisites are complete.

### Phase 1: Scaffolding (no dependencies)

Build these first — they have no internal dependencies:

1. `openclaw.plugin.json` — declares id and channel list
2. `package.json` — NPM manifest with `openclaw.extensions`
3. `src/runtime.ts` — PluginRuntime singleton; ~15 lines, depends on nothing
4. `src/reconnect.ts` — Pure utility; copy from Mattermost extension or reimplement; depends on nothing
5. `src/normalize.ts` — Pure functions for target normalization; depends on nothing
6. `src/config-schema.ts` — TypeBox schema for `channels.pipesbot.*`

### Phase 2: Core Data Layer

7. `src/accounts.ts` — depends on `config-schema.ts` and `normalize.ts`

### Phase 3: WebSocket Transport

8. `src/websocket.ts` — depends on `runtime.ts` (for logging), `accounts.ts` (for config)
   - Implement `createConnectOnce` with PipesBot-specific message parsing
   - Handle ping/pong keep-alive (25s interval inside `on("open")`)
   - Status sink wired to `ChannelAccountSnapshot` fields

### Phase 4: Connection Lifecycle

9. `src/monitor.ts` — depends on `websocket.ts`, `reconnect.ts`, `runtime.ts`
   - Calls `runWithReconnect(createConnectOnce(opts), { ... })`
   - Holds the active WS reference for `send.ts` to use

### Phase 5: Message I/O

10. `src/send.ts` — depends on `monitor.ts` (active WS reference), `runtime.ts`, `normalize.ts`
11. `src/inbound.ts` — depends on `accounts.ts`, `send.ts` (pairing replies), `runtime.ts`
    - Security gate: DM policy, allow-from, pairing flow
    - Route resolution via `core.channel.routing.resolveAgentRoute`
    - Context payload via `core.channel.reply.finalizeInboundContext`
    - Dispatch via `core.channel.reply.dispatchReplyFromConfig`

### Phase 6: Channel Plugin Wiring

12. `src/channel.ts` — depends on everything above
    - Wire `config`, `security`, `outbound`, `gateway`, `status`, `heartbeat` adapters
    - Start minimal: implement only required adapters first

13. `index.ts` — depends on `channel.ts`, `runtime.ts`
    - Call `setRuntime`, call `api.registerChannel`

### Adapter Priority within `channel.ts`

Not all adapters are needed for a working v1. Build in this order:

| Priority | Adapter | Reason |
|----------|---------|--------|
| Required | `config` (listAccountIds, resolveAccount) | Plugin cannot start without it |
| Required | `capabilities` | Declares chatTypes, media support |
| Required | `meta` | Channel label, docs path, blurb |
| Required | `gateway.startAccount` | Triggers the WebSocket loop |
| Required | `outbound.sendText` | Without this, OpenClaw cannot reply |
| High | `status.buildAccountSnapshot` | Needed for `openclaw status` to show real data |
| High | `heartbeat.checkReady` | Needed for health monitoring |
| Medium | `security.resolveDmPolicy` | Pairing / allowFrom enforcement |
| Medium | `setup.applyAccountConfig` | Needed for `openclaw setup` CLI wizard |
| Low | `onboarding` | CLI interactive wizard; can be added post-MVP |
| Low | `directory` | Peer/group listing; not needed for basic operation |
| Low | `actions` | Reactions, polls; not needed for text-only MVP |

---

## Anti-Patterns

### Anti-Pattern 1: Accessing `api.runtime` directly from adapters

**What people do:** Store `api` (the full `OpenClawPluginApi`) rather than `api.runtime`, then call `api.runtime.channel.reply.*` in adapters.

**Why it's wrong:** The `api` object is only valid during `register()`. Adapters are called long after registration. The runtime singleton pattern (`setRuntime` / `getRuntime`) is the correct approach and is consistent across all plugins.

**Do this instead:** Call `setRuntime(api.runtime)` in `register()`, and always access via `getRuntime()` in adapters.

### Anti-Pattern 2: Sending replies directly from `inbound.ts` without `dispatchReplyFromConfig`

**What people do:** Call `sendMessage()` directly after receiving an inbound message, bypassing the OpenClaw reply dispatch pipeline.

**Why it's wrong:** Skips model selection, session management, streaming, tool use, and the entire agent system. The result is a hard-coded echo bot rather than an OpenClaw-powered agent.

**Do this instead:** Always call `core.channel.reply.dispatchReplyFromConfig(ctx, cfg, dispatcher, replyOptions)` (or `dispatchReplyWithBufferedBlockDispatcher`). Only the `deliver` callback inside the dispatcher should call `sendMessage`.

### Anti-Pattern 3: Running the WebSocket in `outbound.sendText` instead of the gateway

**What people do:** Open a new WebSocket connection on every outbound send.

**Why it's wrong:** Creates N connections for N messages, bypasses the reconnect loop, and cannot receive inbound messages. The monitor loop must hold the persistent connection.

**Do this instead:** `monitor.ts` holds a module-level reference to the active WS. `send.ts` reads this reference. If the connection is unavailable, fail fast with a clear error rather than opening a transient connection (unlike IRC which opens a transient connection for sends).

### Anti-Pattern 4: Omitting `AbortSignal` handling

**What people do:** Implement `gateway.startAccount` without wiring up `ctx.abortSignal` to the WebSocket and ping timer.

**Why it's wrong:** OpenClaw cannot cleanly stop the channel (e.g., on config reload or shutdown). The connection and the ping timer leak, causing duplicate message handling on restart.

**Do this instead:** Pass `abortSignal` through to `runWithReconnect`, `createConnectOnce`, and use `abortSignal.addEventListener("abort", ...)` to cancel the ping timer and terminate the WebSocket.

### Anti-Pattern 5: Skipping the security gate in `inbound.ts`

**What people do:** Forward every inbound message to the agent without checking `dmPolicy`, `allowFrom`, or group policy.

**Why it's wrong:** Makes the bot respond to anyone who can send messages, bypassing OpenClaw's access control model. Users who expect pairing-based security will have an open bot.

**Do this instead:** Implement the security gate using `core.channel.pairing.readAllowFromStore`, `core.channel.pairing.upsertPairingRequest`, and the policy checks from `accounts.ts`. Follow the IRC or Mattermost inbound handlers as reference.

---

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| PipesBot WebSocket | Persistent WebSocket via `ws` npm package | URL: `wss://host/ws?apiKey=pk_XXX`; JSON protocol |
| PipesBot keep-alive | `setInterval(ping, 25_000)` inside `on("open")` | Clear interval on close/abort |
| PipesBot reply_status | Optional: await confirmation after `whatsapp_reply` send | Can be fire-and-forget initially |

### Internal Boundaries (plugin ↔ OpenClaw core)

| Boundary | Communication | Notes |
|----------|---------------|-------|
| plugin ↔ Gateway lifecycle | `gateway.startAccount(ctx)` called on channel start | Must await until `ctx.abortSignal` fires |
| plugin ↔ config system | `config.listAccountIds(cfg)`, `config.resolveAccount(cfg, id)` | Called on every message; must be synchronous and fast |
| plugin ↔ agent routing | `core.channel.routing.resolveAgentRoute(...)` | Returns `{ agentId, sessionKey, accountId }` |
| plugin ↔ reply dispatch | `core.channel.reply.dispatchReplyFromConfig(...)` | Handles model selection, streaming, tool use |
| plugin ↔ session store | `core.channel.session.recordInboundSession(...)` | Persists session state for multi-turn conversations |
| plugin ↔ pairing store | `core.channel.pairing.readAllowFromStore(channelId)` | Returns approved sender IDs |
| plugin ↔ status tracking | `ctx.setStatus({ accountId, connected, lastMessageAt, ... })` | Surfaces to `openclaw status` |

---

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1 account, low volume | Single WebSocket connection; no queue needed; fire-and-forget send |
| Multiple accounts | One `monitorPipesBotProvider` instance per account; `accountId` distinguishes state |
| High message volume | Add debouncer (see Mattermost's `createInboundDebouncer`); gate concurrent reply dispatches per session key |

### Scaling Priorities

1. **First bottleneck:** Concurrent messages to same session — the reply dispatcher queues per session key internally, but the `deliver` callback must not block the inbound loop.
2. **Second bottleneck:** PipesBot WS reconnect storm — `runWithReconnect` with `jitterRatio: 0.2` and `maxDelayMs: 60_000` prevents thundering herd on broker restart.

---

## Sources

- OpenClaw source tree: `/Users/tulio/Projects/temp/openclaw`
  - `src/channels/plugins/types.plugin.ts` — `ChannelPlugin<>` interface
  - `src/channels/plugins/types.core.ts` — `ChannelMeta`, `ChannelCapabilities`, adapter types
  - `src/channels/plugins/types.adapters.ts` — All adapter interfaces
  - `extensions/irc/` — WebSocket-like persistent connection reference (monitor + inbound + send)
  - `extensions/mattermost/` — WebSocket channel with reconnect loop, status sink, debouncer
  - `extensions/whatsapp/` — whatsapp channel with gateway adapter, multi-account support
  - `extensions/telegram/` — Minimal plugin entry point pattern
  - All `index.ts`, `runtime.ts`, `channel.ts`, `openclaw.plugin.json`, `package.json` files

---
*Architecture research for: OpenClaw channel plugin — PipesBot WhatsApp bridge*
*Researched: 2026-02-17*
