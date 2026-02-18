---
phase: 04-outbound-and-status
plan: "01"
subsystem: outbound-feedback
tags: [reply-status, outbound, failure-classification, system-events, whatsapp]

dependency-graph:
  requires:
    - 03-02: inbound handler and service wiring (send callback, connection)
  provides:
    - reply_status event routing and handling
    - outbound reply tracking with TTL eviction
    - failure classification (SERVICE_WINDOW_EXPIRED, RATE_LIMITED, etc.)
    - agent-facing system event for 24-hour window failures
  affects:
    - 04-02: any further outbound or status plans in this phase

tech-stack:
  added: []
  patterns:
    - Lazy TTL eviction on Map (pendingReplies)
    - Early-return type guard routing (reply_status before whatsapp_message)
    - Send callback wrapper for outbound correlation tracking

key-files:
  created:
    - src/outbound.ts
  modified:
    - src/types.ts
    - src/service.ts

decisions:
  - id: D-04-01-A
    title: Pending entry required for enqueueSystemEvent
    choice: Only enqueue system event if a pending reply entry existed for the conversation
    rationale: Prevents phantom system events for reply_status arrivals we did not initiate (e.g. stale or re-delivered events after restart)
  - id: D-04-01-B
    title: Lazy eviction strategy for pendingReplies map
    choice: Evict expired entries on each trackOutboundReply call rather than a setInterval
    rationale: No timer overhead; eviction is bounded by outbound reply rate which is always initiated from the same path

metrics:
  duration: "~2 min"
  completed: "2026-02-17"
---

# Phase 4 Plan 01: Outbound Status Handling Summary

**One-liner:** Reply_status event routing with failure classification, 30s TTL pending reply map, and SERVICE_WINDOW_EXPIRED agent-facing system event via enqueueSystemEvent.

## What Was Built

### src/types.ts — PipesBotReplyStatus type and guard

Added `PipesBotReplyStatus` type matching the PipesBot `reply_status` envelope:

```typescript
export type PipesBotReplyStatus = {
  type: "reply_status";
  data: {
    conversationId: string;
    success: boolean;
    messageId?: string; // Present on success
    error?: string;     // Present on failure
    code?: string;      // Present on failure
  };
};

export function isPipesBotReplyStatus(msg: unknown): msg is PipesBotReplyStatus { ... }
```

Follows the same pattern as the existing `isPipesBotMessage` guard.

### src/outbound.ts — New module

Full outbound reply status handling:

- **`ReplyFailureKind`** union type: `SERVICE_WINDOW_EXPIRED | RATE_LIMITED | FORBIDDEN | NOT_FOUND | SEND_FAILED | UNKNOWN`
- **`trackOutboundReply(conversationId)`** — Adds entry to `pendingReplies` Map with 30s TTL. Performs lazy eviction of expired entries on each call.
- **`handleReplyStatus(msg, opts)`** — Main handler:
  - Early returns if not a `reply_status` message
  - Pops pending entry from map
  - Logs success: `pipes-bot-channel: reply delivered to {conversationId} (messageId: {messageId})`
  - On failure: classifies code via `classifyReplyFailure()`, builds human-readable message via `buildFailureMessage()`, logs error
  - If pending entry existed AND `conversationId` non-empty: enqueues agent-facing system event via `opts.core.system.enqueueSystemEvent(message, { sessionKey: 'default:{conversationId}' })`
- `SERVICE_WINDOW_EXPIRED` message: _"Unable to send reply: the 24-hour WhatsApp messaging window has expired. The contact must send a new message to reopen the conversation."_

### src/service.ts — Reply_status routing + send callback tracking

- Added imports: `isPipesBotReplyStatus`, `handleReplyStatus`, `trackOutboundReply`, `getPipesBotRuntime`
- Message handler now checks `isPipesBotReplyStatus(msg)` first — routes to `handleReplyStatus` and returns early, preventing `reply_status` events from reaching `handleInbound`
- `send` callback wrapped: after a successful `connection.send()`, extracts `payload.data.conversationId` and calls `trackOutboundReply(conversationId)` for future correlation

## Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| D-04-01-A | Only enqueue system event if pending entry existed | Prevents phantom events from stale reply_status arrivals |
| D-04-01-B | Lazy TTL eviction on each trackOutboundReply call | No timer overhead; bounded by outbound rate |

## Verification Results

1. `npx tsc --noEmit` passes with zero errors
2. `src/outbound.ts` exports `handleReplyStatus`, `trackOutboundReply`, `ReplyFailureKind`
3. `src/types.ts` contains `PipesBotReplyStatus` type and `isPipesBotReplyStatus` guard
4. `src/service.ts` routes `reply_status` before inbound handler (early return pattern)
5. `src/service.ts` send callback calls `trackOutboundReply` after successful send
6. `SERVICE_WINDOW_EXPIRED` produces human-readable agent-facing message

## Deviations from Plan

None - plan executed exactly as written.

## Next Phase Readiness

Phase 04-02 (if it exists) can build on:
- `handleReplyStatus` and `trackOutboundReply` exports from `src/outbound.ts`
- `ReplyFailureKind` union for any additional failure-mode handling
- Established pattern: `reply_status` events are fully handled before reaching `handleInbound`

No blockers or concerns for continuation.
