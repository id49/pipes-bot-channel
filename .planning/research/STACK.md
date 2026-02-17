# Stack Research

**Domain:** OpenClaw channel plugin with WebSocket connectivity (PipesBot WhatsApp integration)
**Researched:** 2026-02-17
**Confidence:** HIGH

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| TypeScript | `^5.9.3` | Language | OpenClaw plugins are TypeScript modules loaded via jiti — strict TS is not optional, it is required by the runtime. `5.9.x` is the current stable release. |
| `ws` | `^8.19.0` | WebSocket client | The PipesBot docs and the existing `@pipes-bot/plugin` reference implementation both prescribe `ws`. It is the de-facto Node.js WebSocket library, has zero runtime dependencies, and ships its own TypeScript declarations via `@types/ws`. No runtime overhead beyond the protocol. |
| `openclaw` | `>=2026.2.15` (peer) | Plugin host runtime | Declares the host interface. Must be a `peerDependency` — the plugin runs inside the user's OpenClaw Gateway process. Declaring it as a direct dependency would duplicate the runtime and break in-process type registration. |
| Node.js | `>=22.12.0` | Runtime | OpenClaw 2026.x requires Node 22.12+. The plugin inherits this constraint. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@types/ws` | `^8.18.1` | Type declarations for `ws` | Always — `ws` ships JS, types are in the DefinitelyTyped package. Required for TypeScript compilation. |
| `zod` | `^4.3.6` | Runtime config validation | For validating the `channels.pipesbot.accounts.<id>` config block at plugin init time. Zod 4 is current; the DingTalk reference plugin uses it. OpenClaw also ships zod in its own runtime, but the plugin should not rely on the host's version — declare it as a direct dependency to ensure version compatibility. |
| `@sinclair/typebox` | `^0.34.48` | Config schema declaration | OpenClaw uses TypeBox schemas in `openclaw.extensions.configSchema` to drive config validation and Control UI form generation. If the plugin declares a config schema in `package.json`, TypeBox is the required type. Peer-depend on the host's version (or omit if config schema is kept minimal/untyped). |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `tsdown` | Library bundler (ESM + `.d.ts`) | Replaces `tsup` as the standard library bundler in 2025. Already used by `@pipes-bot/plugin`. Produces clean ESM output with declaration files. Command: `tsdown src/index.ts --format esm --dts`. Current version: `0.20.3`. |
| `tsx` | TypeScript execution for dev/watch | Run `src/index.ts` directly without a build step during development. Current version: `4.21.0`. |
| `jiti` | Plugin loader (host-side, not in plugin) | OpenClaw's Gateway loads plugin entry points via jiti `2.6.1`. The plugin itself does not depend on jiti — it runs inside the jiti context. Understanding jiti is important for writing compatible modules (ESM, no dynamic requires). |
| `vitest` | Unit testing | Current version: `4.0.18`. Used for testing the WS client reconnection logic and message parsing without a live server. |
| `oxlint` | Linting | Current version: `1.48.0`. Used in the parent monorepo. Replaces ESLint for most rules. Significantly faster. |

---

## Installation

```bash
# Runtime dependencies (bundled into the plugin package)
npm install ws zod

# Type declarations
npm install -D @types/ws @types/node typescript tsdown tsx vitest oxlint

# Peer dependencies (host provides these at runtime — do NOT bundle)
# openclaw >=2026.2.15
```

### package.json structure

```json
{
  "name": "@pipes-bot/openclaw-channel",
  "version": "0.1.0",
  "description": "PipesBot WhatsApp channel plugin for OpenClaw",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js"
  },
  "openclaw": {
    "extensions": ["./dist/index.js"],
    "channel": {
      "id": "pipesbot-whatsapp",
      "label": "WhatsApp (PipesBot)"
    }
  },
  "peerDependencies": {
    "openclaw": ">=2026.2.15"
  },
  "dependencies": {
    "ws": "^8.19.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/node": "^22.13.14",
    "@types/ws": "^8.18.1",
    "tsdown": "^0.20.3",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3",
    "vitest": "^4.0.18",
    "oxlint": "^1.48.0"
  },
  "scripts": {
    "build": "tsdown src/index.ts --format esm --dts",
    "dev": "tsx src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "oxlint src"
  }
}
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `ws` | `socket.io-client` | Never for this use case. socket.io adds polling fallback, rooms, and event namespacing — none of which the PipesBot protocol supports or needs. `ws` is raw WebSocket, matching the protocol exactly. |
| `ws` | Native `WebSocket` (Node 22+) | Node 22 ships a built-in `WebSocket` global. It is viable but lacks `.ping()` / `.pong()` frame control needed for the PipesBot 25s keepalive. `ws` provides explicit ping/pong. Until the built-in API exposes frame-level control, use `ws`. |
| `tsdown` | `tsup` | `tsup` still works but `tsdown` is the successor by the same author (Anthony Fu), with better tree-shaking, smaller output, and faster builds. The parent monorepo already uses `tsdown`. |
| `tsdown` | `tsc` directly | `tsc` does not bundle — it emits individual files. Channel plugins are distributed as npm packages; a single bundled file (`dist/index.js`) is simpler for jiti to load and produces cleaner installs. |
| `zod` | `@sinclair/typebox` for runtime validation | TypeBox is appropriate for the static `openclaw.extensions.configSchema` declaration (the JSON schema embedded in `package.json`). Zod is better for runtime validation inside the plugin (`parse`/`safeParse` with user-friendly error messages). Use both for different jobs. |
| `vitest` | `jest` | Jest requires separate transform setup for ESM. Vitest is ESM-native and works out of the box with TypeScript modules. Given the `"type": "module"` package requirement, vitest is the correct choice. |
| `oxlint` | `eslint` | ESLint works fine but is slower. The parent monorepo uses oxlint. For a small focused plugin, consistency with the monorepo toolchain is preferred. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@pipes-bot/plugin` as dependency | It is a standalone runnable script, not a library. It owns its own process entry point, reconnection loop, and event handling — all of which conflict with OpenClaw's service lifecycle management (`gateway.start`/`gateway.stop`). Re-use the WS client pattern (exponential backoff, ping interval), not the package. | Custom `PipesBotWsClient` class inside the plugin |
| `reconnecting-websocket` | Adds an abstraction layer over `ws` with its own reconnection logic. The PipesBot docs specify exact reconnection parameters (1s, 2s, 4s … 30s max). Custom implementation is 30 lines and gives full control over the `shouldReconnect` flag needed for clean shutdown. | Hand-rolled reconnection (already proven in `@pipes-bot/plugin`) |
| `axios` / `node-fetch` for media | Media download URLs from PipesBot are plain HTTPS URLs with 48h TTL. Pass the `downloadUrl` to OpenClaw's media pipeline rather than downloading in the plugin. OpenClaw handles media fetching. | Pass `downloadUrl` through to OpenClaw |
| `dotenv` | dotenv is for standalone processes reading `.env` files. This plugin runs inside OpenClaw's process; config comes from `openclaw.json` via the plugin config system, not environment variables. | OpenClaw config adapter (`listAccountIds` / `resolveAccount`) |
| CommonJS (`require`, `.cjs`) | OpenClaw loads plugins via jiti in ESM mode. The `"type": "module"` contract must be upheld. CommonJS interop through jiti is possible but fragile and untested. | ESM throughout (`import`/`export`) |
| `nodemon` for dev | Not useful for a plugin — the plugin has no standalone entry point during development. | `tsx watch src/index.ts` or load into a local OpenClaw Gateway for integration testing |

---

## Stack Patterns by Variant

**If developing standalone (for testing outside OpenClaw):**
- Add a `src/dev.ts` entry that instantiates the WS client directly with env vars
- Use `tsx src/dev.ts` for rapid iteration
- Do NOT ship `dev.ts` in the bundle — add it to `.tsdownignore` or keep it outside `src/`

**If adding config schema for Control UI:**
- Declare TypeBox schema in `src/config-schema.ts`
- Export from `package.json` via `openclaw.extensions.configSchema`
- TypeBox `^0.34.48` — keep as `devDependency` if only used for schema declaration, not runtime validation
- Use Zod for runtime safeParse of the same fields

**If the project lives inside the pipes-bot monorepo:**
- `pnpm-workspace` is already configured in the parent
- Add `"packages/openclaw-channel"` (or similar) to the workspace `packages` array
- Share `@pipes-bot/config/tsconfig.base.json` as the base tsconfig
- The existing `tsconfig.base.json` target `ESNext` / `moduleResolution: "bundler"` is compatible with jiti loading

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `ws@8.19.0` | Node.js `>=10.0.0` | Well within OpenClaw's Node 22+ requirement. Stable since 2019; no breaking changes expected in `^8`. |
| `@types/ws@8.18.1` | `ws@^8.x` | Minor version must track `ws` major — `@types/ws@8.x` covers `ws@8.x`. |
| `typescript@5.9.3` | `tsdown@0.20.3` | tsdown uses Rolldown internally; TypeScript 5.x is fully supported. |
| `zod@4.3.6` | TypeScript `^5.x` | Zod 4 requires TypeScript 5.x. Compatible with the project's TS version. Zod 3 is still widely used but Zod 4 is current — the reference plugin (DingTalk) uses `^4.3.6`. |
| `vitest@4.0.18` | Node.js `>=18.0.0` | Within bounds. |
| `openclaw@2026.2.15` (peer) | Node.js `>=22.12.0` | Date-versioned: `2026.2.15`. Expect frequent releases. Use `>=2026.2.15` as peer dep floor to ensure the channel plugin API is present. |

---

## Sources

- `@pipes-bot/plugin` source at `/Users/tulio/Projects/id49/pipes-bot/pipes-bot/packages/plugin/` — existing WS client implementation (ws 8.18, tsdown, tsx pattern); **HIGH confidence**
- PipesBot WebSocket docs at `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-docs/content/docs/websocket/` — protocol specification, message types, reply format, keepalive spec; **HIGH confidence**
- OpenClaw Plugins docs `https://docs.openclaw.ai/tools/plugin` — plugin structure, register function, adapters, npm distribution; **HIGH confidence** (verified against multiple sources)
- DeepWiki `https://deepwiki.com/openclaw/openclaw/10-extensions-and-plugins` — plugin manifest fields, TypeBox schema, lifecycle phases; **HIGH confidence**
- DingTalk reference plugin `https://github.com/soimy/openclaw-channel-dingtalk` — real-world peer dep pattern (`openclaw >=2026.2.13`), zod 4 usage, ESM structure; **HIGH confidence**
- npm registry API (direct queries) — version numbers for `ws@8.19.0`, `typescript@5.9.3`, `@types/ws@8.18.1`, `zod@4.3.6`, `tsdown@0.20.3`, `tsx@4.21.0`, `vitest@4.0.18`, `@sinclair/typebox@0.34.48`, `openclaw@2026.2.15`; **HIGH confidence**
- OpenClaw CHANGELOG `https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md` — breaking changes audit, plugin lifecycle additions; **MEDIUM confidence** (summary only, not full changelog)

---
*Stack research for: OpenClaw channel plugin — PipesBot WhatsApp integration*
*Researched: 2026-02-17*
