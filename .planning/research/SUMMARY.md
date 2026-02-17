# Project Research Summary

**Project:** PipesBot OpenClaw Channel Plugin
**Domain:** OpenClaw channel plugin -- WhatsApp integration via PipesBot WebSocket
**Researched:** 2026-02-17
**Confidence:** HIGH

## Executive Summary

This project is an OpenClaw channel plugin that bridges WhatsApp messaging through PipesBot's WebSocket protocol. OpenClaw has a well-defined plugin architecture with established patterns across existing channel plugins (IRC, Mattermost, Telegram, Discord, DingTalk, Feishu). The correct approach is to follow the existing channel plugin conventions exactly -- runtime singleton injection, adapter-based registration, connect-once + reconnect-loop WebSocket pattern -- while implementing PipesBot-specific protocol handling (JSON message types, 25s ping interval, `pk_` API key authentication). The stack is straightforward: TypeScript 5.9, `ws` for WebSocket, `zod` for runtime validation, bundled with `tsdown` as ESM. There are zero ambiguities about core technology choices.

The primary risk is WebSocket reliability. Two pitfalls -- infinite reconnection loops on permanent failures and silent dead connections that never trigger reconnection -- have caused production incidents in other OpenClaw channel plugins (Discord #11836, Mattermost #11796). Both must be addressed in the first implementation, not retrofitted. The secondary risk is the WhatsApp 24h service window constraint, which is a hard Cloud API limitation: replies to conversations older than 24 hours will fail, and the plugin must surface this error explicitly rather than swallowing it. These are well-understood problems with documented solutions.

The plugin's feature scope for v1 is clearly bounded: text and all media types inbound (URL passthrough, no download), text-only outbound, delivery status surfacing, automatic reconnection with exponential backoff, and proper lifecycle management (AbortSignal-based teardown). Media outbound sending, group chat, and app-scoped keys are explicitly deferred. This is a focused plugin with a small surface area -- roughly 10 source files, each with a single responsibility -- making it well-suited for sequential phase delivery.

## Key Findings

### Recommended Stack

The stack is constrained by the OpenClaw plugin ecosystem and the PipesBot protocol. There are no genuinely open technology decisions; every choice follows from platform requirements or established precedent in the monorepo.

**Core technologies:**
- **TypeScript 5.9.3**: Required by OpenClaw's jiti-based plugin loader; strict mode enforced by the runtime
- **`ws` 8.19.0**: WebSocket client prescribed by PipesBot docs and the existing `@pipes-bot/plugin` reference; needed for frame-level ping/pong control (Node.js built-in WebSocket lacks this)
- **`zod` 4.3.6**: Runtime config validation at plugin init; used by the DingTalk reference plugin; Zod 4 is current
- **`tsdown` 0.20.3**: ESM bundler producing single `dist/index.js` for jiti loading; successor to tsup, already used in the parent monorepo
- **`openclaw` >=2026.2.15 (peer dependency)**: Must be peer, never direct -- the plugin runs inside the host process

**Critical version requirement:** Node.js >=22.12.0 (inherited from OpenClaw 2026.x).

**What NOT to use:** Do not import `@pipes-bot/plugin` as a dependency (it is a standalone script, not a library). Do not use `reconnecting-websocket` (custom 30-line reconnection gives needed control). Do not use `dotenv` (config comes from `openclaw.json`, not environment variables). No CommonJS -- ESM throughout.

### Expected Features

**Must have (table stakes):**
- API key configuration in `openclaw.json`
- WebSocket connection with automatic reconnection and ping handling
- Text inbound/outbound (the core messaging loop)
- All media types inbound: image, audio, video, document, sticker, location, contacts, reaction (URL passthrough to agent, no download)
- Delivery status surfacing (especially `SERVICE_WINDOW_EXPIRED`)
- Sender identity and conversation context scoping (session isolation per WhatsApp sender)
- Clean npm installation via `openclaw plugins install`

**Should have (differentiators):**
- 24h service window awareness with human-readable error messages
- Offline message queue deduplication on reconnect
- Sticker/location/contacts normalization to agent-readable text formats

**Defer (v2+):**
- Outbound media sending (requires Meta media upload API -- separate integration surface)
- Group chat support (not in PipesBot's current Cloud API offering)
- App-scoped (`ak_`) key support (multi-tenant routing complexity)
- Connection scoping flexibility (conversation-scoped WS connections for high-volume deployments)

### Architecture Approach

The plugin follows OpenClaw's established channel plugin pattern: a thin registration entry point (`index.ts`) injects the runtime singleton and registers a `ChannelPlugin` object that wires adapters for config, security, outbound messaging, and gateway lifecycle. The gateway adapter spawns a persistent WebSocket monitor loop per account, which uses a connect-once + reconnect pattern with exponential backoff and AbortSignal-based teardown. Inbound messages pass through a security gate, route resolution, session update, and dispatch pipeline before reaching the OpenClaw agent. This architecture is proven across IRC, Mattermost, and the built-in WhatsApp (Baileys) channel.

**Major components:**
1. **`index.ts` + `runtime.ts`** -- Plugin entry point and runtime singleton; boilerplate shared by all OpenClaw channel plugins
2. **`accounts.ts` + `config-schema.ts`** -- Config validation and account resolution from `openclaw.json`
3. **`websocket.ts` + `reconnect.ts` + `monitor.ts`** -- WebSocket transport layer: connect-once factory, exponential backoff loop, ping/pong heartbeat, connection lifecycle
4. **`inbound.ts`** -- Message handling pipeline: security gate, routing, session, context payload, dispatch to agent
5. **`send.ts`** -- Outbound message formatting and delivery over active WebSocket
6. **`channel.ts`** -- Adapter wiring: connects all components into the `ChannelPlugin` interface
7. **`normalize.ts`** -- Pure utility functions for phone number normalization and target ID validation

### Critical Pitfalls

1. **Infinite reconnection loop on permanent failures** -- Map WebSocket close codes to retry strategy: transient codes (1001, 1006) retry with backoff, permanent codes (1008, 4001 auth failure) stop immediately. Cap total attempts at ~50. This has caused production incidents in the Discord plugin.
2. **Silent dead connection (no close event)** -- Track PipesBot ping timestamps; if no ping arrives within 75 seconds (3x the 25s interval), call `ws.terminate()` and trigger reconnect. TCP connections can silently die without emitting a close event. This caused a production incident in the Mattermost plugin.
3. **`openclaw` declared as direct dependency** -- Must be `peerDependencies` with `">=2026.2.15"`. Using `workspace:*` or `dependencies` causes duplicate module loading and npm resolution failures on publish. Verify with `npm pack` before publishing.
4. **Manifest channel ID mismatch** -- Define channel ID as a single exported constant referenced by `package.json`, `openclaw.json`, and the register call. A typo in any location causes silent plugin load failure.
5. **Missing stop() cleanup** -- `gateway.startAccount` teardown must clear all timers, remove all listeners, and call `ws.terminate()` (not just `ws.close()`). Missing cleanup causes duplicate messages and memory leaks on gateway restart.

## Implications for Roadmap

Based on research, the project maps naturally to 5 phases following dependency order. The architecture's component boundaries directly dictate phase grouping.

### Phase 1: Project Scaffold and Plugin Registration
**Rationale:** Every subsequent phase depends on the package manifest, TypeScript configuration, and the plugin registration boilerplate. The channel ID constant and `openclaw` peer dependency must be correct from the start -- fixing them later causes cascade failures.
**Delivers:** Working plugin that loads into OpenClaw Gateway (no functionality yet). `package.json`, `openclaw.plugin.json`, `index.ts`, `runtime.ts`, `config-schema.ts`, `accounts.ts`, `normalize.ts`. Build pipeline (`tsdown`), test pipeline (`vitest`), lint (`oxlint`).
**Addresses:** API key configuration, plugin installs cleanly via npm.
**Avoids:** Pitfall 3 (wrong dependency type), Pitfall 4 (channel ID mismatch), Pitfall 5 (native dependencies in install).

### Phase 2: WebSocket Transport with Reconnection
**Rationale:** The transport layer is the foundation for all message I/O. It must be built and tested in isolation before message handling is layered on. The two most critical pitfalls (infinite reconnect, silent dead connection) live here.
**Delivers:** `websocket.ts`, `reconnect.ts`, `monitor.ts`. Persistent WebSocket connection to PipesBot with exponential backoff + jitter, ping/pong heartbeat monitoring, AbortSignal teardown, status sink reporting. The `gateway.startAccount` adapter wired to the monitor loop.
**Addresses:** Automatic reconnection, keep-alive handling.
**Avoids:** Pitfall 1 (infinite reconnect loop -- close code classification + attempt cap), Pitfall 2 (silent dead connection -- ping timestamp monitoring), Pitfall 6 (missing stop() cleanup -- AbortSignal + terminate).

### Phase 3: Inbound Message Handling
**Rationale:** Depends on the WebSocket transport from Phase 2. Inbound message handling is the next dependency in the chain -- outbound sending needs inbound context to function (session keys, routing).
**Delivers:** `inbound.ts` fully wired: security gate (DM policy, allow-from, pairing), route resolution, session management, context payload construction, dispatch via `dispatchReplyFromConfig`. All message types handled: text, image, audio, video, document, sticker, location, contacts, reaction. Media URLs forwarded with 48h TTL metadata.
**Addresses:** Text inbound, all media types inbound, sender identity, conversation context scoping, security gate.
**Avoids:** Anti-Pattern 2 (bypassing dispatch pipeline), Anti-Pattern 5 (skipping security gate). Addresses media URL TTL metadata debt pattern.

### Phase 4: Outbound Messaging and Delivery Status
**Rationale:** Completes the core loop. Outbound depends on having an active WebSocket connection (Phase 2) and a reply delivery callback wired into the dispatch pipeline (Phase 3).
**Delivers:** `send.ts` for outbound message formatting. `outbound.sendText` adapter in `channel.ts`. Delivery status processing: `reply_status` messages parsed, `SERVICE_WINDOW_EXPIRED` surfaced as structured error to OpenClaw. The full `channel.ts` wiring of all required adapters (config, capabilities, meta, gateway, outbound).
**Addresses:** Text outbound, delivery status surfacing, 24h service window awareness.
**Avoids:** Anti-Pattern 3 (opening new WS per send), silent SERVICE_WINDOW_EXPIRED swallowing.

### Phase 5: Polish, Status, and Distribution
**Rationale:** All core functionality exists. This phase adds production-readiness features: health monitoring, status reporting, setup wizard support, and npm distribution verification.
**Delivers:** `status.buildAccountSnapshot` adapter, `heartbeat.checkReady` adapter, `setup.applyAccountConfig` adapter. Offline queue deduplication logic. End-to-end integration tests with real PipesBot payloads. `npm pack` verification, README, publication readiness.
**Addresses:** P2 features (service window status, queue deduplication). Production monitoring surface.
**Avoids:** "Looks done but isn't" checklist items -- systematic verification of all edge cases.

### Phase Ordering Rationale

- **Dependency-driven:** Each phase produces artifacts required by the next. Scaffold -> Transport -> Inbound -> Outbound -> Polish follows the data flow direction.
- **Risk-front-loaded:** The two most critical pitfalls (infinite reconnect, dead connection) are addressed in Phase 2, the earliest phase where they can be built and tested.
- **Architecture-aligned:** Phase boundaries match the component boundaries from ARCHITECTURE.md. Each phase corresponds to a clearly separable set of source files.
- **Pitfall-aware:** Every pitfall from PITFALLS.md has a designated phase where it must be prevented, not a later "hardening" pass.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2 (WebSocket Transport):** The reconnection state machine with close code classification is the highest-complexity component. The Mattermost extension's `runWithReconnect` can be adapted, but PipesBot-specific close codes need validation against real server behavior.
- **Phase 3 (Inbound Message Handling):** The OpenClaw security gate (DM policy, pairing, allow-from) has multiple code paths. The IRC and Mattermost inbound handlers should be studied as reference implementations during planning.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Scaffold):** Boilerplate; the DingTalk and Feishu plugins provide exact templates to follow.
- **Phase 4 (Outbound):** `sendText` is a straightforward JSON-over-WebSocket send. The PipesBot `whatsapp_reply` format is documented.
- **Phase 5 (Polish):** Status and heartbeat adapters follow a uniform pattern across all channel plugins.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All versions verified against npm registry; patterns confirmed across multiple reference plugins (DingTalk, Feishu, Mattermost); zero open technology decisions |
| Features | HIGH | Feature set derived from PipesBot protocol docs, WhatsApp Cloud API constraints, and direct comparison with OpenClaw's native Baileys channel; clear table-stakes vs differentiator separation |
| Architecture | HIGH | Sourced directly from OpenClaw source tree at `/Users/tulio/Projects/temp/openclaw`; cross-referenced against 6 existing channel plugins (IRC, Mattermost, Telegram, Discord, WhatsApp/Baileys, DingTalk) |
| Pitfalls | MEDIUM-HIGH | Critical pitfalls (reconnect loop, dead connection) backed by real OpenClaw GitHub issues with fix PRs; PipesBot-specific pitfalls (service window, media TTL) inferred from protocol docs rather than production incident reports |

**Overall confidence:** HIGH

### Gaps to Address

- **PipesBot WebSocket close codes:** The exact close codes PipesBot sends for auth failures, rate limits, and server-side errors are not fully documented. During Phase 2 planning, test against a real PipesBot connection to catalog close code behavior.
- **OpenClaw `ChannelPlugin` TypeScript types:** The exact type signatures for all adapter methods come from the OpenClaw source tree. If the `openclaw` package version bumps between now and implementation, adapter signatures may change. Pin the peer dependency floor and re-verify types at Phase 1 build time.
- **Offline queue drain behavior:** PipesBot's documentation states it queues up to 100 messages, but the exact delivery order and deduplication guarantees on reconnect are not documented. During Phase 5, test with real disconnection scenarios to validate assumptions.
- **Multi-account concurrency:** The architecture supports multiple accounts (one monitor per account), but concurrent account startup and shared module-level state (e.g., active WS reference in `monitor.ts`) need careful design. Address during Phase 2 planning to ensure per-account isolation.

## Sources

### Primary (HIGH confidence)
- `@pipes-bot/plugin` source (`/Users/tulio/Projects/id49/pipes-bot/pipes-bot/packages/plugin/`) -- WS client implementation, reconnection pattern, message types
- PipesBot WebSocket docs (`/Users/tulio/Projects/id49/pipes-bot/pipes-bot-docs/content/docs/websocket/`) -- protocol specification, keepalive, reply format
- OpenClaw source tree (`/Users/tulio/Projects/temp/openclaw`) -- `ChannelPlugin` interface, all adapter types, 6 reference channel implementations
- OpenClaw plugin docs (https://docs.openclaw.ai/tools/plugin) -- plugin structure, register function, npm distribution
- DeepWiki OpenClaw extensions (https://deepwiki.com/openclaw/openclaw/10-extensions-and-plugins) -- manifest fields, lifecycle phases
- DingTalk reference plugin (https://github.com/soimy/openclaw-channel-dingtalk) -- peer dep pattern, zod 4, ESM structure
- npm registry -- verified version numbers for all dependencies

### Secondary (MEDIUM confidence)
- OpenClaw GitHub issues #11836 (Discord reconnect loop) and #11796 (Mattermost dead connection) -- production pitfall evidence
- Wemble blog (https://wemble.com/2026/01/31/building-an-openclaw-plugin.html) -- step-by-step plugin guide
- Feishu plugin (https://github.com/ogromwang/openclaw-feishu) -- additional reference implementation
- WeCom channel plugin PR (https://github.com/openclaw/openclaw/pull/13228) -- adapter pattern reference
- OneUptime WebSocket blogs -- reconnection and heartbeat patterns

### Tertiary (LOW confidence)
- WhatsApp Cloud API rate limit documentation (https://www.wati.io/en/blog/whatsapp-business-api/whatsapp-api-rate-limits/) -- 24h service window details; third-party source, cross-referenced with PipesBot docs

---
*Research completed: 2026-02-17*
*Ready for roadmap: yes*
