---
phase: 01-plugin-scaffold
plan: 01
subsystem: plugin-scaffold
tags: [openclaw, typescript, plugin-sdk, esm, nodenext, websocket]

# Dependency graph
requires: []
provides:
  - OpenClaw plugin scaffold with package metadata, manifest, entry point, and service lifecycle
  - pk_ API key validation in service start with error logging
  - npm-packable plugin with all source files included
affects: [02-ws-client, 03-inbound-routing, 04-reply-flow]

# Tech tracking
tech-stack:
  added: [ws@^8.18.0, @types/ws@^8.5.13, openclaw@*, typescript@^5.0.0]
  patterns:
    - OpenClaw plugin default export pattern (id/name/description/configSchema/register)
    - Service factory pattern (createPipesBotService returning OpenClawPluginService)
    - ESM nodenext module resolution with .js extensions on relative imports
    - Synchronous register function (not async per OpenClaw contract)

key-files:
  created:
    - package.json
    - tsconfig.json
    - openclaw.plugin.json
    - index.ts
    - src/service.ts
  modified: []

key-decisions:
  - "Unscoped package name pipes-bot-channel matches manifest id exactly (avoids OpenClaw resolution pitfall)"
  - "noEmit: true in tsconfig -- jiti handles runtime loading, tsc is type-check only"
  - "emptyPluginConfigSchema() in export, real validation lives in openclaw.plugin.json manifest"
  - "Service reads apiKey from ctx.config.plugins.entries['pipes-bot-channel'].config (typed as Record<string, unknown>)"

patterns-established:
  - "Plugin export: synchronous register(api) calling api.registerService -- never async in Phase 1"
  - "Service start: validate config first, log error and return early on invalid key"
  - "Service stop: stub with log only -- no resources to clean up until Phase 2 adds WS"

# Metrics
duration: 2min
completed: 2026-02-17
---

# Phase 01 Plan 01: Plugin Scaffold Summary

**OpenClaw plugin scaffold with pk_ API key validation, ESM/nodenext TypeScript config, and npm-packable structure -- zero tsc errors**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-02-17T21:07:25Z
- **Completed:** 2026-02-17T21:09:44Z
- **Tasks:** 2
- **Files modified:** 5 created

## Accomplishments
- package.json with openclaw.extensions entry point, files field, and correct ESM type
- openclaw.plugin.json manifest with JSON Schema enforcing pk_ prefix on apiKey
- tsconfig.json with strict, noEmit, nodenext module/moduleResolution, es2022 target
- index.ts default-exporting synchronous plugin with registerService call
- src/service.ts with start (pk_ validation + error logging) and stop (clean stub)
- npx tsc --noEmit passes with zero errors against real openclaw types
- npm pack --dry-run confirms all 4 source files included

## Files Created/Modified
- `package.json` - npm metadata, openclaw.extensions, files field for npm pack
- `tsconfig.json` - strict, noEmit, nodenext, es2022
- `openclaw.plugin.json` - plugin manifest with configSchema enforcing pk_ pattern
- `index.ts` - plugin default export with synchronous register calling api.registerService
- `src/service.ts` - createPipesBotService factory with start/stop lifecycle

## Decisions Made
- Unscoped package name `pipes-bot-channel` (not `@org/pipes-bot-channel`) to match manifest id exactly
- `noEmit: true` in tsconfig because jiti loads .ts at runtime; tsc is type-check only
- `emptyPluginConfigSchema()` in plugin export for Phase 1; real validation in manifest JSON Schema
- `ctx.config.plugins?.entries?.["pipes-bot-channel"]?.config` is the correct config path (per PluginsConfig type: `entries?: Record<string, PluginEntryConfig>` where `PluginEntryConfig.config` is `Record<string, unknown>`)
- `.js` extension on relative import (`./src/service.js`) required for ESM nodenext resolution

## Deviations from Plan

None - plan executed exactly as written.

The verify steps in Task 2 noted that openclaw might not be installable from npm registry, but it resolved from the local node_modules (version 2026.2.15) and tsc passed cleanly.

## Issues Encountered
- None. openclaw was already installed locally; tsc passed on first run.

## Next Phase Readiness
- Plugin scaffold is complete. Phase 2 (WS client) can import createPipesBotService and extend start/stop with WebSocket lifecycle.
- The stop stub in service.ts is intentionally empty for Phase 1; Phase 2 will add ws.close() and cleanup here.
- Blocker from STATE.md: PipesBot WebSocket close codes need testing against real connection -- still pending Phase 2.

---
*Phase: 01-plugin-scaffold*
*Completed: 2026-02-17*
