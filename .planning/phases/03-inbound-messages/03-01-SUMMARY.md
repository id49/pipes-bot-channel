---
phase: 03-inbound-messages
plan: 01
subsystem: messaging
tags: [openclaw, plugin-sdk, typescript, whatsapp, pipes-bot, media, runtime-singleton]

# Dependency graph
requires:
  - phase: 02-websocket-transport
    provides: PipesBotConnection and service scaffold (service.ts, connection.ts)
provides:
  - Runtime singleton (setPipesBotRuntime/getPipesBotRuntime) for accessing PluginRuntime in handlers
  - PipesBot message type definitions (PipesBotMessage discriminated union, isPipesBotMessage guard)
  - Media download function (downloadPipesBotMedia) using OpenClaw runtime APIs
  - index.ts wired to store runtime at registration time
affects:
  - 03-02 (inbound handler depends on all three files created here)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Runtime singleton: setPipesBotRuntime in register(), getPipesBotRuntime in handlers -- matches all other OpenClaw extensions"
    - "Discriminated union on data.type for PipesBot message envelope"
    - "Media download via fetchRemoteMedia + saveMediaBuffer (not direct fetch + fs.writeFile)"

key-files:
  created:
    - src/runtime.ts
    - src/types.ts
    - src/media.ts
  modified:
    - index.ts

key-decisions:
  - "PluginLogger alias derived from OpenClawPluginServiceContext['logger'] (PluginLogger not re-exported from openclaw/plugin-sdk top-level)"
  - "downloadPipesBotMedia returns { path, contentType } (not optional contentType) to match caller expectations"
  - "fetchImpl override in media.ts injects Authorization header before redirect; fetchRemoteMedia follows 302 to presigned R2 URL automatically"

patterns-established:
  - "runtime.ts: module-level let + set/get exports -- use this pattern in all Phase 3 files"
  - "types.ts: PipesBotContact exported separately (needed by inbound handler for VCF generation)"
  - "media.ts: constructs absolute URL as PIPES_BOT_API_BASE + relative downloadUrl"

# Metrics
duration: 2min
completed: 2026-02-17
---

# Phase 3 Plan 01: Runtime Types Media Summary

**PluginRuntime singleton, PipesBot WhatsApp message discriminated union, and auth-injecting media downloader using OpenClaw fetchRemoteMedia + saveMediaBuffer**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-02-17T23:10:10Z
- **Completed:** 2026-02-17T23:12:24Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Runtime singleton pattern: `setPipesBotRuntime` stores `api.runtime` at registration, `getPipesBotRuntime` retrieves it in handlers (matches established OpenClaw extension pattern)
- Typed PipesBot message envelope: discriminated union on `data.type` covering all 10 message types (text, image, audio, video, document, sticker, location, contacts, reaction, unsupported)
- `downloadPipesBotMedia` correctly injects `Authorization: Bearer` header via `fetchImpl` override, constructs absolute URL from relative `downloadUrl`, and uses `fetchRemoteMedia` + `saveMediaBuffer` runtime APIs
- `index.ts` updated to call `setPipesBotRuntime(api.runtime)` as first line in `register()`

## Task Commits

Each task was committed atomically:

1. **Task 1: Create runtime singleton, types, and update index.ts** - `3d87d3d` (feat)
2. **Task 2: Create media download function** - `648de67` (feat)

**Plan metadata:** (pending - this commit)

## Files Created/Modified

- `src/runtime.ts` - Runtime singleton: `setPipesBotRuntime` / `getPipesBotRuntime`
- `src/types.ts` - `PipesBotMessage`, `PipesBotMessageData`, `PipesBotMedia`, `PipesBotLocation`, `PipesBotContact`, `PipesBotReaction`, `isPipesBotMessage`, `PluginLogger`
- `src/media.ts` - `downloadPipesBotMedia` with auth header injection via `fetchImpl`
- `index.ts` - Added `setPipesBotRuntime(api.runtime)` before `api.registerService(...)`

## Decisions Made

- `PluginLogger` aliased as `OpenClawPluginServiceContext["logger"]` because `PluginLogger` is not re-exported from the `openclaw/plugin-sdk` top-level index (confirmed by type check error TS2305 on first attempt)
- `downloadPipesBotMedia` return type is `{ path: string; contentType: string } | null` (not optional contentType) to simplify caller logic in the inbound handler

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed PluginLogger import path**

- **Found during:** Task 1 (Create runtime singleton, types, and update index.ts)
- **Issue:** Plan specified `PluginLogger = OpenClawPluginServiceContext["logger"]` but first attempt used `import type { PluginLogger } from "openclaw/plugin-sdk"` which fails with TS2305 (not re-exported from top-level)
- **Fix:** Changed import to `OpenClawPluginServiceContext` and derived `PluginLogger` via the index accessor pattern as the plan originally specified
- **Files modified:** src/types.ts
- **Verification:** `npx tsc --noEmit` passes with zero errors
- **Committed in:** 3d87d3d (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug -- wrong import path, corrected immediately)
**Impact on plan:** No scope creep. Fix matches the pattern the plan already prescribed.

## Issues Encountered

None - type check passed cleanly after import correction.

## User Setup Required

None - no external service configuration required for this plan.

## Next Phase Readiness

- All three foundational files ready for Plan 02 (inbound handler)
- `isPipesBotMessage` type guard ready for use in `handleInbound()`
- `downloadPipesBotMedia` ready for use in media resolution helper
- `getPipesBotRuntime()` ready for use in inbound.ts and future send.ts
- No blockers

---
*Phase: 03-inbound-messages*
*Completed: 2026-02-17*
