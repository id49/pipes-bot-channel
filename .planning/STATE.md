# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-17)

**Core value:** WhatsApp messages flow seamlessly through PipesBot into OpenClaw's agent system, and replies flow back -- with full media support and reliable reconnection.
**Current focus:** Phase 4 - Outbound and Status (COMPLETE)

## Current Position

Phase: 4 of 4 (Outbound and Status)
Plan: 2 of 2 in current phase
Status: Phase complete
Last activity: 2026-02-18 — Completed quick task 001: Fix authFailed reset and pongTimer leak

Progress: [██████████] 100% (6 of 6 plans complete)

## Performance Metrics

**Velocity:**
- Total plans completed: 6
- Average duration: ~2.2 min
- Total execution time: ~13 min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-plugin-scaffold | 1 | ~2 min | 2 min |
| 02-websocket-transport | 1 | ~3 min | 3 min |
| 03-inbound-messages | 2 | ~5 min | 2.5 min |
| 04-outbound-and-status | 2 | ~4 min | 2 min |

**Recent Trend:**
- Last 6 plans: 01-01 (2 min), 02-01 (3 min), 03-01 (2 min), 03-02 (3 min), 04-01 (2 min), 04-02 (2 min)
- Trend: Stable, within baseline

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Custom WS client over @pipes-bot/plugin (tighter OpenClaw lifecycle integration)
- User-scoped pk_ keys only for v1
- WebSocket-only replies (no REST fallback)
- Unscoped package name `pipes-bot-channel` (not scoped) to match manifest id exactly
- `noEmit: true` in tsconfig -- jiti handles runtime loading, tsc is type-check only
- `emptyPluginConfigSchema()` in plugin export for Phase 1; real validation in manifest JSON Schema
- `.js` extension on relative imports required for ESM nodenext resolution
- `PluginLogger` type derived via `OpenClawPluginServiceContext["logger"]` (not a named export from openclaw/plugin-sdk top-level)
- 2 min reconnect backoff cap (confirmed)
- WS heartbeat: 25s ping + 50s pong timeout = 75s total cycle (WS-03)
- Auth failures (401/403) use `unexpected-response` event -- stops reconnecting permanently
- Runtime singleton: setPipesBotRuntime in register(), getPipesBotRuntime in handlers (matches all other OpenClaw extensions)
- downloadPipesBotMedia uses fetchRemoteMedia + saveMediaBuffer (not raw fetch + fs.writeFile) for SSRF protection, MIME sniffing, and directory management
- dispatchReplyWithBufferedBlockDispatcher used for agent dispatch (not dispatchReplyFromConfig directly) -- IRC pattern; PipesBot has no typing API so typing callbacks are no-ops
- OriginatingChannel: "pipes-bot-channel" works without cast -- ChannelId = ChatChannelId | (string & {}) allows custom strings
- connection! non-null assertion in send callback (message event only fires while connection alive)
- D-04-01-A: Only enqueue system event if pending entry existed (prevents phantom events from stale reply_status arrivals)
- D-04-01-B: Lazy TTL eviction on each trackOutboundReply call (no timer overhead, bounded by outbound rate)
- D-04-02-A: No gateway property on ChannelPlugin to prevent lifecycle conflict with registerService
- D-04-02-B: reconnecting state maps to connected: false (two dashboard states, not three)
- D-04-02-C: stop() resets status store to prevent stale connected state on restart

### Pending Todos

None.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 001 | Fix authFailed reset on stop() and pongTimer overwrite without clearing | 2026-02-18 | 87728ac | [001-fix-authfailed-reset-and-pongtimer-leak](./quick/001-fix-authfailed-reset-and-pongtimer-leak/) |

### Blockers/Concerns

- PipesBot WebSocket close codes not fully documented -- real-connection test deferred to integration testing (Phase 2 transport implemented without this blocker)

## Session Continuity

Last session: 2026-02-18T00:14:35Z
Stopped at: Completed 04-02-PLAN.md (status store, channel plugin, service wiring, registerChannel)
Resume file: None
