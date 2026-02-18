---
phase: 04-outbound-and-status
plan: 02
subsystem: api
tags: [openclaw, plugin-sdk, channel-plugin, websocket, status, dashboard]

# Dependency graph
requires:
  - phase: 04-01-outbound-and-status
    provides: "reply_status type, outbound handler, service.ts with connection wiring"
  - phase: 02-websocket-transport
    provides: "PipesBotConnection with ConnectionState type and state/error events"
provides:
  - "src/status-store.ts: module-level PipesBotConnectionStatus state store with updateConnectionStatus/getConnectionStatus"
  - "src/channel.ts: ChannelPlugin with dashboard-visible status via buildAccountSnapshot"
  - "index.ts: registerChannel call exposes channel to OpenClaw dashboard"
  - "src/service.ts: state and error events wired to status store in real time"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Status store pattern: module-level singleton for cross-module state sharing without prop drilling"
    - "Channel plugin without gateway: omit gateway property to prevent channel manager from managing service lifecycle independently"
    - "buildAccountSnapshot reads from live store rather than gateway context"

key-files:
  created:
    - src/status-store.ts
    - src/channel.ts
  modified:
    - src/service.ts
    - index.ts

key-decisions:
  - "No gateway property on ChannelPlugin to prevent lifecycle conflict with registerService"
  - "auth failed substring match for auth failure detection (matches connection.ts error message)"
  - "reconnecting state maps to connected: false (two dashboard states, not three)"
  - "stop() resets status store to disconnected to avoid stale state on restart"

patterns-established:
  - "Status store: module-level let + spread for immutable updates, shallow copy on read"
  - "Channel plugin registration order: registerChannel before registerService (IRC pattern)"

# Metrics
duration: ~2min
completed: 2026-02-18
---

# Phase 4 Plan 2: Outbound and Status (Dashboard Status) Summary

**ChannelPlugin registration with live WebSocket health status in OpenClaw dashboard via module-level status store**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-02-18T00:13:00Z
- **Completed:** 2026-02-18T00:14:35Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Created `src/status-store.ts` with module-level `PipesBotConnectionStatus` state, `updateConnectionStatus` (merge patch), and `getConnectionStatus` (shallow copy)
- Created `src/channel.ts` as minimal ChannelPlugin with all required `meta` fields, reading live status from status store in `buildAccountSnapshot`
- Wired `"state"` and `"error"` events in `src/service.ts` to update status store in real time; auth failures detected via `err.message.includes("auth failed")`
- Updated `index.ts` to call `api.registerChannel({ plugin: pipesBotChannelPlugin })` before `api.registerService`

## Task Commits

Each task was committed atomically:

1. **Task 1: Create status store and channel plugin for dashboard** - `44ef9bf` (feat)
2. **Task 2: Wire connection events to status store and register channel plugin** - `a7ebad3` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `src/status-store.ts` - Module-level connection status state store with getter/setter exports
- `src/channel.ts` - Minimal ChannelPlugin for OpenClaw dashboard status reporting; no gateway property
- `src/service.ts` - Added state listener, updated error handler with authFailed detection, stop() reset
- `index.ts` - Added registerChannel call before registerService

## Decisions Made

- **No `gateway` property:** Omitting `gateway` from the ChannelPlugin prevents the channel manager from calling `startAccount`/`stopAccount` independently of the service lifecycle. The service lifecycle owns the WS connection exclusively.
- **Auth failure detection via substring:** `connection.ts` emits `new Error("WebSocket auth failed: HTTP 401")` — matching `"auth failed"` in the message string is the correct and stable approach.
- **Two dashboard states not three:** `reconnecting` maps to `connected: false` (same as `disconnected`). The dashboard shows connected/disconnected, not a third "reconnecting" state.
- **stop() resets status store:** Prevents stale `connected: true` state if the service restarts; clears `lastError` to avoid showing old errors after a clean stop.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 4 is now complete: outbound reply handling (04-01) and dashboard status reporting (04-02) are both done
- All four phases complete: plugin scaffold, WebSocket transport, inbound messages, outbound and status
- OpenClaw dashboard will show pipes-bot-channel with connected/disconnected/auth-failed states
- No remaining blockers

---
*Phase: 04-outbound-and-status*
*Completed: 2026-02-18*
