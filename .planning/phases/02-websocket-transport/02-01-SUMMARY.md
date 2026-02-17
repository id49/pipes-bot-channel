---
phase: 02-websocket-transport
plan: 01
subsystem: infra
tags: [websocket, ws, reconnection, heartbeat, exponential-backoff, event-emitter, state-machine]

# Dependency graph
requires:
  - phase: 01-plugin-scaffold
    provides: "OpenClawPluginService/ServiceContext types, service lifecycle start/stop, apiKey validation"
provides:
  - "PipesBotConnection class with full WS state machine (connected/disconnected/reconnecting)"
  - "Automatic reconnection with full-jitter exponential backoff, 2 min cap"
  - "25s ping + 50s pong timeout heartbeat (WS-03 compliance)"
  - "Auth failure handling: 401/403 = permanent stop, all close codes = transient"
  - "Clean teardown: ordered disconnect clears all timers and nulls ws reference"
affects:
  - "03-inbound-messages: consumes connection.on('message') events"
  - "04-outbound-replies: calls connection.send(message)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "EventEmitter extension for state/message/error event bus"
    - "Close-handler-only reconnect scheduling (error handler logs only)"
    - "shouldReconnect flag set before ws.close() to prevent post-disconnect reconnect"
    - "ws.terminate() for pong timeout (forces code 1006, not graceful close)"
    - "Full jitter backoff: Math.floor(Math.random() * Math.min(MAX_MS, BASE_MS * 2^attempt))"

key-files:
  created:
    - "src/connection.ts"
  modified:
    - "src/service.ts"

key-decisions:
  - "PluginLogger sourced via OpenClawPluginServiceContext['logger'] (not exported directly from openclaw/plugin-sdk)"
  - "2 min reconnect cap (confirmed from STATE.md accumulated decisions)"
  - "message handler in service.ts is a void stub for Phase 3"

patterns-established:
  - "WS-01: wss://api.pipes.bot/ws?apiKey=<encoded> (query param, never logged)"
  - "WS-02: full jitter backoff with 2 min cap, reset on open"
  - "WS-03: 25s PING_INTERVAL_MS + 50s PONG_TIMEOUT_MS = 75s heartbeat cycle"
  - "WS-04: unexpected-response 401/403 = shouldReconnect=false + emit error; other codes = transient"

# Metrics
duration: 3min
completed: 2026-02-17
---

# Phase 2 Plan 1: WebSocket Transport Summary

**PipesBotConnection class with full-jitter reconnect backoff, 25s/50s heartbeat, 401/403 auth failure detection, and clean ordered teardown wired into OpenClaw service lifecycle**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-02-17T22:22:07Z
- **Completed:** 2026-02-17T22:24:31Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- `PipesBotConnection` class implements all four WS requirements (WS-01 through WS-04) with EventEmitter state machine
- Heartbeat loop: 25s ping interval triggers a 50s pong deadline; `ws.terminate()` on timeout forces 1006 for clean reconnect
- Auth failures on `unexpected-response` (401/403) stop reconnecting permanently and emit `"error"` event; all other close codes schedule backoff reconnect
- Service lifecycle fully wired: `start()` creates and connects, `stop()` disconnects and nulls

## Task Commits

Each task was committed atomically:

1. **Task 1: Create PipesBotConnection class** - `5853183` (feat)
2. **Task 2: Wire PipesBotConnection into service lifecycle** - `2d6c3f6` (feat)

**Plan metadata:** (pending docs commit)

## Files Created/Modified

- `src/connection.ts` - `PipesBotConnection` class: state machine, reconnect scheduler, heartbeat, auth failure detection; exports `PipesBotConnection` and `ConnectionState`
- `src/service.ts` - Updated lifecycle: creates connection in `start()`, registers error/message handlers, calls `connect()`; disconnects and nulls in `stop()`

## Decisions Made

- `PluginLogger` type is NOT exported from `openclaw/plugin-sdk` -- used `OpenClawPluginServiceContext["logger"]` to derive it without adding a deeper import
- `message` handler in `service.ts` is `void msg` (no-op stub) for Phase 3 to implement

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- `PluginLogger` is not a named export from `openclaw/plugin-sdk` (only `OpenClawPluginServiceContext` is). Resolved inline without plan deviation by using the mapped type `OpenClawPluginServiceContext["logger"]`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- WebSocket transport layer complete; `connection.on("message", handler)` stub is in place for Phase 3 to implement inbound message parsing
- `connection.send(message)` available for Phase 4 outbound replies
- No blockers; `npx tsc --noEmit` passes with zero errors across both new files

---
*Phase: 02-websocket-transport*
*Completed: 2026-02-17*
