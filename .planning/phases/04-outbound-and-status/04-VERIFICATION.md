---
status: passed
score: 4/4 must-haves verified
---

# Phase 4: Outbound and Status — Verification Report

**Phase Goal:** Agents can reply to WhatsApp conversations and see whether their messages were delivered
**Verified:** 2026-02-17T00:00:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Must-Have Verification

### 1. Agent text reply sent to correct WhatsApp conversation via PipesBot WebSocket (OUT-01)

**Status:** Verified
**Evidence:**
The `deliver` callback inside `handleInbound` in `src/inbound.ts` (lines 118–133) constructs a `whatsapp_reply` message with the exact format required by PipesBot:

```typescript
send({
  type: "whatsapp_reply",
  data: {
    conversationId: data.conversationId,
    poolNumberId: data.poolNumberId,
    toNumber: data.fromNumber,
    text: payload.text ?? "",
  },
});
```

The `send` callback wraps `connection.send()` in `src/service.ts` (lines 61–71), which calls `this.ws.send(JSON.stringify(message))` in `src/connection.ts` (line 78). The `conversationId` is taken from the inbound message data, ensuring the reply routes to the correct conversation. The send is substantive (real WebSocket write), not a stub.

**Files:**
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-channel/src/inbound.ts` (lines 118–133)
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-channel/src/service.ts` (lines 61–71)
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-channel/src/connection.ts` (lines 74–80)

---

### 2. Delivery confirmations (reply_status with success) surfaced to OpenClaw (OUT-02)

**Status:** Verified
**Evidence:**
Three-level wiring is complete:

**Level 1 — Type and guard exist:** `src/types.ts` (lines 90–109) defines `PipesBotReplyStatus` type and `isPipesBotReplyStatus` guard checking `type === "reply_status"` and presence of `data`.

**Level 2 — Handler is substantive:** `src/outbound.ts` (lines 55–88) implements `handleReplyStatus` which:
- Pops the pending entry from the TTL map
- On `data.success === true`, logs delivery confirmation with `conversationId` and `messageId`
- On failure, classifies the error code and enqueues an agent-facing system event

**Level 3 — Router wires it before inbound:** `src/service.ts` (lines 51–55) checks `isPipesBotReplyStatus(msg)` first in the message handler, calls `handleReplyStatus`, and returns early — preventing `reply_status` events from reaching `handleInbound`. After a successful `connection.send()`, `trackOutboundReply(replyData.conversationId)` is called (line 67) to correlate future `reply_status` events.

**Files:**
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-channel/src/types.ts` (lines 90–109)
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-channel/src/outbound.ts` (lines 55–88)
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-channel/src/service.ts` (lines 51–70)

---

### 3. SERVICE_WINDOW_EXPIRED produces a clear, human-readable message (OUT-03)

**Status:** Verified
**Evidence:**
`src/outbound.ts` (lines 109–113) implements `buildFailureMessage`:

```typescript
function buildFailureMessage(kind: ReplyFailureKind, raw?: string): string {
  if (kind === "SERVICE_WINDOW_EXPIRED") {
    return "Unable to send reply: the 24-hour WhatsApp messaging window has expired. The contact must send a new message to reopen the conversation.";
  }
  return `Reply failed: ${raw ?? kind}`;
}
```

`classifyReplyFailure` (lines 92–107) maps the `code` field `"SERVICE_WINDOW_EXPIRED"` to the `"SERVICE_WINDOW_EXPIRED"` kind. The human-readable message is then passed to `opts.core.system.enqueueSystemEvent(message, { sessionKey: 'default:{conversationId}' })` (line 84) so it surfaces as a system event in the agent's conversation — but only if a pending entry existed (guard on line 83), preventing phantom events for stale replies.

**Files:**
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-channel/src/outbound.ts` (lines 92–114)

---

### 4. OpenClaw dashboard shows connection health status for each configured PipesBot account (OUT-04)

**Status:** Verified
**Evidence:**
A complete three-component chain is wired:

**Status store** (`src/status-store.ts`, 21 lines): Module-level `PipesBotConnectionStatus` singleton with `updateConnectionStatus` (merge patch) and `getConnectionStatus` (shallow copy). Starts as `{ connected: false, authFailed: false, lastConnectedAt: null, lastError: null }`.

**Connection events update the store** (`src/service.ts`, lines 31–48):
- `"state"` event: sets `connected: state === "connected"`, clears `lastError` and sets `lastConnectedAt` on connect
- `"error"` event: sets `connected: false`, detects auth failure via `err.message.includes("auth failed")`, sets `authFailed` and `lastError`
- `stop()` (line 84): resets to `{ connected: false, lastError: null }` to prevent stale state on restart

**Channel plugin** (`src/channel.ts`, 42 lines): `pipesBotChannelPlugin` implements `ChannelPlugin` with `buildAccountSnapshot` reading live status from `getConnectionStatus()`. Returns `connected`, `running` (false if auth failed), `lastConnectedAt`, and a human-readable `lastError` ("Authentication failed -- check your pk_ API key" for auth failures).

**Registration** (`index.ts`, line 15): `api.registerChannel({ plugin: pipesBotChannelPlugin })` is called before `api.registerService()`, exposing the channel to OpenClaw's `channels.status` gateway. TypeScript compilation confirms zero errors (`npx tsc --noEmit` passes).

**Files:**
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-channel/src/status-store.ts`
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-channel/src/channel.ts`
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-channel/src/service.ts` (lines 31–48, 84)
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-channel/index.ts` (line 15)

---

## Gaps

None.

## Human Verification

### 1. Delivery confirmation visibility in agent UI

**Test:** Send an agent reply through a live PipesBot-connected conversation, then check whether a successful `reply_status` event produces any visible feedback in OpenClaw's agent interface (beyond the server-side log).
**Expected:** The delivery log appears at INFO level. No agent-visible UI feedback is wired — only the logger call for success. This is by design (system events are only enqueued on failure).
**Why human:** The gap between "logged on the server" and "surfaced in the UI" is a product decision requiring runtime observation.

### 2. Dashboard status display after auth failure

**Test:** Configure the plugin with an invalid `pk_` API key, start the service, open the OpenClaw dashboard channels view.
**Expected:** The PipesBot account entry shows `connected: false`, `running: false`, and the error message "Authentication failed -- check your pk_ API key".
**Why human:** Requires a live OpenClaw instance with the plugin loaded; cannot verify dashboard rendering from source alone.

---

## Summary

All four phase 4 success criteria are verified by code inspection:

- OUT-01: `whatsapp_reply` message format is constructed correctly and sent via WebSocket in `inbound.ts`
- OUT-02: `reply_status` events are routed before inbound handling, correlated via a 30s TTL pending map, and logged/classified in `outbound.ts`
- OUT-03: `SERVICE_WINDOW_EXPIRED` produces the exact human-readable message and enqueues it as an agent-facing system event
- OUT-04: A `ChannelPlugin` backed by a module-level status store is registered, reads live connection state from `service.ts` event listeners, and exposes it to the OpenClaw dashboard via `buildAccountSnapshot`

TypeScript compilation passes with zero errors. No stub patterns, placeholder content, or unconnected artifacts were found.

---
*Verified: 2026-02-17*
*Verifier: Claude (gsd-verifier)*
