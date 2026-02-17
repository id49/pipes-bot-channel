# Phase 01: Plugin Scaffold - Research

**Researched:** 2026-02-17
**Domain:** OpenClaw plugin system, TypeScript npm package scaffolding
**Confidence:** HIGH

## Summary

Phase 01 requires creating a minimal OpenClaw channel plugin that loads cleanly, validates a PipesBot `pk_` API key, and implements gateway lifecycle (start/stop). The source of truth for all plugin mechanics was read directly from the OpenClaw source tree at `/Users/tulio/Projects/temp/openclaw`, verified against the loader, manifest parser, service runner, and six existing extension implementations.

The OpenClaw plugin system is mature and well-defined. There is a precise contract: two JSON files (`package.json` and `openclaw.plugin.json`), a TypeScript default export, and `registerService` for lifecycle. The WhatsApp and IRC extensions are the canonical reference for channel plugins; the `diagnostics-otel` extension is the canonical reference for `registerService`.

Config for the API key does NOT belong under `channels.<id>` — for a non-built-in channel that sources messages via its own WS connection (PipesBot), the cleanest approach is `plugins.entries.pipes-bot-channel.config.apiKey` validated by `openclaw.plugin.json` `configSchema`. This is confirmed by how `memory-lancedb` handles its `apiKey` field. The `registerService` start/stop pattern is used for the WS lifecycle so the gateway controls teardown cleanly.

**Primary recommendation:** Two-file plugin scaffold (`openclaw.plugin.json` + `index.ts`) with `registerService` for lifecycle and `configSchema` in the manifest for `pk_` key validation. No channel registration in Phase 1 — that is Phase 2.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `openclaw` | `2026.2.16` | Plugin SDK types and helpers | Required peer — loaded via jiti alias |
| `ws` | `^8.18.0` | WebSocket client | Already used in `@pipes-bot/plugin`; standard Node.js WS library |
| `typescript` | workspace catalog | TypeScript compiler | Required for type checking |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@types/ws` | `^8.5.13` | TypeScript types for `ws` | Always with `ws` |
| `tsdown` | `^0.16.5` | Build for dist output | If distributing compiled — but jiti loads `.ts` directly |
| `tsx` | `^4.19.2` | Dev runner | Optional for standalone dev mode |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `ws` | `@pipes-bot/plugin` WS client | Decision already locked: custom WS client for OpenClaw lifecycle integration |
| `registerService` | `api.on("gateway_start")` hook | Hooks exist but `registerService` is the documented, clean pattern for background services |

**Installation:**
```bash
npm install ws
npm install --save-dev @types/ws typescript openclaw
```

Note: For npm distribution, `openclaw` should be in `devDependencies` (it is loaded in-process by the gateway, not bundled). `ws` goes in `dependencies` since it is installed into the plugin's `node_modules` by `openclaw plugins install`.

## Architecture Patterns

### Recommended Project Structure
```
pipes-bot-channel/
├── openclaw.plugin.json     # Plugin manifest (id, channels, configSchema)
├── package.json             # npm package (name, openclaw.extensions entry point)
├── index.ts                 # Plugin entry point (default export)
├── src/
│   ├── channel.ts           # ChannelPlugin object (Phase 2+)
│   └── service.ts           # OpenClawPluginService (lifecycle, WS client)
└── tsconfig.json            # TypeScript config for type checking
```

For Phase 1 (scaffold only), `src/channel.ts` can be a stub or omitted. The service is the main focus.

### Pattern 1: Plugin Manifest (`openclaw.plugin.json`)
**What:** JSON file that OpenClaw reads before loading any code. Declares the plugin id, which channels it provides, and the JSON Schema for config validation.

**When to use:** Always — the manifest is mandatory. Missing `id` or `configSchema` causes a hard load failure.

**Example:**
```json
{
  "id": "pipes-bot-channel",
  "channels": ["pipes-bot"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["apiKey"],
    "properties": {
      "apiKey": {
        "type": "string",
        "minLength": 1,
        "pattern": "^pk_"
      }
    }
  },
  "uiHints": {
    "apiKey": {
      "label": "PipesBot API Key",
      "sensitive": true,
      "placeholder": "pk_..."
    }
  }
}
```

Source: `/Users/tulio/Projects/temp/openclaw/src/plugins/manifest.ts` — `id` and `configSchema` are required; manifest load fails without them.

### Pattern 2: Plugin Default Export (`index.ts`)
**What:** TypeScript module with a default export object containing `id`, `name`, `description`, `configSchema`, and `register(api)`.

**When to use:** Always — this is the entrypoint jiti loads.

**Example:**
```typescript
// Source: /Users/tulio/Projects/temp/openclaw/extensions/diagnostics-otel/index.ts
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { createPipesBotService } from "./src/service.js";

const plugin = {
  id: "pipes-bot-channel",
  name: "PipesBot Channel",
  description: "WhatsApp channel via PipesBot managed proxy",
  configSchema: emptyPluginConfigSchema(), // Phase 1: replaced with real schema in Phase 2
  register(api: OpenClawPluginApi) {
    api.registerService(createPipesBotService(api));
  },
};

export default plugin;
```

**Critical note on configSchema in `index.ts` vs `openclaw.plugin.json`:** The `configSchema` in the export is used for runtime parsing (via `api.pluginConfig`), while the `configSchema` in `openclaw.plugin.json` is used for **pre-load JSON Schema validation**. Both must be consistent. The manifest schema runs first (JSON Schema), then if the plugin loads, the export's `configSchema.safeParse` is called. For Phase 1, use `emptyPluginConfigSchema()` in the export and the real JSON Schema in the manifest.

### Pattern 3: Service Lifecycle (`src/service.ts`)
**What:** `OpenClawPluginService` with `start` and `stop` methods. `start` receives config (including `pluginConfig`), initializes the WS client. `stop` tears down cleanly.

**When to use:** Any resource (WS connections, intervals, timers) that must start with the gateway and stop cleanly.

**Example:**
```typescript
// Source: /Users/tulio/Projects/temp/openclaw/src/plugins/types.ts (OpenClawPluginService type)
// Pattern: /Users/tulio/Projects/temp/openclaw/extensions/diagnostics-otel/src/service.ts
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";

export function createPipesBotService(): OpenClawPluginService {
  let ws: WebSocket | null = null;
  let shouldReconnect = true;

  return {
    id: "pipes-bot-channel",
    async start(ctx: OpenClawPluginServiceContext) {
      const pluginConfig = ctx.config.plugins?.entries?.["pipes-bot-channel"]?.config as
        | { apiKey: string }
        | undefined;
      const apiKey = pluginConfig?.apiKey;

      if (!apiKey || !apiKey.startsWith("pk_")) {
        ctx.logger.error("pipes-bot-channel: invalid or missing pk_ API key");
        return;
      }

      ctx.logger.info("pipes-bot-channel: starting WS connection");
      // ... connect WS
    },
    async stop(ctx: OpenClawPluginServiceContext) {
      shouldReconnect = false;
      ws?.close(1000, "gateway stopping");
      ws = null;
      ctx.logger.info("pipes-bot-channel: stopped");
    },
  };
}
```

### Pattern 4: `package.json` for npm Distribution
**What:** `package.json` with `"openclaw": { "extensions": ["./index.ts"] }` — this is how OpenClaw discovers the entry point.

**Example:**
```json
{
  "name": "@pipes-bot/openclaw-channel",
  "version": "0.1.0",
  "description": "PipesBot WhatsApp channel plugin for OpenClaw Gateway",
  "type": "module",
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.13",
    "openclaw": "^2026.2.16",
    "typescript": "^5.0.0"
  },
  "openclaw": {
    "extensions": [
      "./index.ts"
    ]
  }
}
```

Source: `/Users/tulio/Projects/temp/openclaw/extensions/*/package.json` — all extensions follow this pattern.

### Pattern 5: Config in `openclaw.json` for the Installed Plugin
**What:** The user adds plugin config under `plugins.entries.<id>.config` in `openclaw.json`.

**Example:**
```json
{
  "plugins": {
    "entries": {
      "pipes-bot-channel": {
        "config": {
          "apiKey": "pk_live_abc123"
        }
      }
    }
  }
}
```

Note: `openclaw plugins install` installs the package but does NOT auto-add the `config` block — the user must add it. Validation uses the `configSchema` from `openclaw.plugin.json` and fails at startup if `apiKey` is missing or does not match `^pk_`.

### Anti-Patterns to Avoid
- **Missing `configSchema` in `openclaw.plugin.json`:** The loader checks `if (!configSchema) return error("plugin manifest requires configSchema")`. An empty schema (`{ "type": "object", "additionalProperties": false, "properties": {} }`) is valid; a missing key is not.
- **Async `register` function:** The loader explicitly warns: "plugin register returned a promise; async registration is ignored." Keep `register` synchronous; move async work into `registerService`.
- **Using `channels.<id>` instead of `plugins.entries.<id>.config` for the API key:** The `channels` config section is for channel-level config (account bindings, enabled/disabled). The `pk_` key is plugin-level — it goes in `plugins.entries.<id>.config`.
- **`openclaw` in `dependencies` (not `devDependencies`):** The openclaw module is available in-process at runtime via jiti. Putting it in `dependencies` causes a redundant install and version conflicts.
- **Not clearing all resources in `stop`:** If `stop` doesn't clear reconnect timers and intervals, the gateway hangs on shutdown. The `@pipes-bot/plugin` WS client's `disconnect()` method is a good reference for this pattern.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| WS exponential backoff | Custom retry loop | Pattern from `@pipes-bot/plugin` WS client (`ws-client.ts`) | Edge cases: immediate reconnect on error, max delay cap, shouldReconnect flag |
| JSON Schema validation | Custom validator | `openclaw.plugin.json` `configSchema` (handled by openclaw loader) | OpenClaw validates before loading any plugin code |
| TypeScript loading | Compiling to dist | jiti (openclaw's built-in loader) | Plugins are loaded as `.ts` directly; no build step needed for local install |

**Key insight:** The OpenClaw plugin system does most of the heavy lifting for Phase 1. The scaffold is genuinely minimal — the two most important files are `openclaw.plugin.json` (manifest) and `index.ts` (default export with `register`).

## Common Pitfalls

### Pitfall 1: Plugin ID Mismatch Between Files
**What goes wrong:** `openclaw.plugin.json` `id` is `"pipes-bot-channel"` but `package.json` `name` is `@pipes-bot/openclaw-channel`. OpenClaw uses the unscoped package name as the plugin ID (removes `@pipes-bot/` scope). The loader will warn if the export `id` doesn't match the manifest `id`.
**Why it happens:** Three different places declare or imply the plugin ID.
**How to avoid:** Set manifest `id` = `unscopedPackageName(package.name)`. For `@pipes-bot/openclaw-channel` that is `openclaw-channel`. Or use `pipes-bot-channel` as both the unscoped name and manifest ID.
**Warning signs:** Loader emits "plugin id mismatch" diagnostic; plugin may load but with wrong ID.

### Pitfall 2: Register Function Returning a Promise
**What goes wrong:** The `register(api)` function is `async`. OpenClaw warns: "plugin register returned a promise; async registration is ignored." Any setup done in `await` after the first yield point is lost.
**Why it happens:** Developers want to do async initialization (connect WS) in `register`.
**How to avoid:** Use `api.registerService({ start: async (ctx) => ... })`. The service `start` is properly awaited by the gateway.
**Warning signs:** WS client never connects; no errors logged.

### Pitfall 3: `configSchema` in Manifest vs Export Mismatch
**What goes wrong:** The manifest's `configSchema` (JSON Schema) requires `apiKey` but the export's `configSchema` is `emptyPluginConfigSchema()`, which rejects non-empty config objects.
**Why it happens:** Two separate validation layers exist.
**How to avoid:** In Phase 1, use `emptyPluginConfigSchema()` in both the manifest and export (no config needed yet). In Phase 2 when apiKey is needed, update both simultaneously.
**Warning signs:** Plugin loads but `api.pluginConfig.apiKey` is undefined; config validation passes manifest check but fails export parse.

### Pitfall 4: API Key Not Available in `register`, Only in `start`
**What goes wrong:** Attempting to read `api.pluginConfig.apiKey` to create the WS client directly in `register`. But `api.pluginConfig` reflects the validated config from `openclaw.json` entries — the WS client must not be created until `start` is called (gateway running).
**Why it happens:** The service pattern is less obvious than directly using `api.pluginConfig` in `register`.
**How to avoid:** Create the WS client inside `service.start`, not in `register`. Pass `api` or just read `ctx.config` in `start`.
**Warning signs:** WS connects before gateway starts channels; resource leak if gateway setup fails.

### Pitfall 5: `stop` Not Called Reliably if `start` Throws
**What goes wrong:** If `service.start` throws, the gateway logs the error but does NOT call `service.stop`. Resources allocated before the throw are leaked.
**Why it happens:** Service runner wraps `start` in try/catch; on error, the service is not added to the running list.
**How to avoid:** Make `start` safe to call partially; clean up inside `start`'s own catch block if initialization fails mid-way.
**Warning signs:** Hanging processes on repeated gateway restarts.

### Pitfall 6: `openclaw plugins install` Requires `npm pack`-Compatible Files
**What goes wrong:** Files listed in `openclaw.extensions` (`./index.ts`) must exist in the `npm pack` output. TypeScript source files are not included by default in npm packs unless `files` in `package.json` explicitly includes them.
**Why it happens:** `npm pack` respects `files` or `.npmignore`. Without a `files` field, it uses default exclusions (which exclude `.ts` files if there's a `.gitignore` or similar).
**How to avoid:** Add `"files": ["index.ts", "src/**/*.ts", "openclaw.plugin.json"]` to `package.json`. Alternatively, set `"main"` to a `.ts` file so npm pack captures it.
**Warning signs:** `openclaw plugins install` reports "extension entry not found".

## Code Examples

Verified patterns from source:

### Minimal Valid `openclaw.plugin.json`
```json
{
  "id": "pipes-bot-channel",
  "channels": ["pipes-bot"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["apiKey"],
    "properties": {
      "apiKey": {
        "type": "string",
        "minLength": 1,
        "pattern": "^pk_"
      }
    }
  },
  "uiHints": {
    "apiKey": {
      "label": "PipesBot API Key (pk_...)",
      "sensitive": true,
      "placeholder": "pk_live_..."
    }
  }
}
```
Source: `/Users/tulio/Projects/temp/openclaw/src/plugins/manifest.ts` — `id` and `configSchema` required; `channels` for channel registration; `uiHints` for UI display.

### Minimal Valid `index.ts` (Phase 1 scaffold)
```typescript
// Source pattern: /Users/tulio/Projects/temp/openclaw/extensions/diagnostics-otel/index.ts
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const plugin = {
  id: "pipes-bot-channel",
  name: "PipesBot Channel",
  description: "WhatsApp channel via PipesBot managed proxy",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.logger.info("pipes-bot-channel: registered");
    api.registerService({
      id: "pipes-bot-channel",
      start(ctx) {
        ctx.logger.info("pipes-bot-channel: service started (Phase 1 stub)");
      },
      stop(ctx) {
        ctx.logger.info("pipes-bot-channel: service stopped");
      },
    });
  },
};

export default plugin;
```

### Custom configSchema for `pk_` API Key Validation (Phase 1 with real validation)
```typescript
// Source pattern: /Users/tulio/Projects/temp/openclaw/src/plugins/config-schema.ts
import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";

type PluginConfig = { apiKey: string };
type ParseResult =
  | { success: true; data: PluginConfig }
  | { success: false; error: { issues: Array<{ path: string[]; message: string }> } };

export function pipesBotPluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    safeParse(value: unknown): ParseResult {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { success: false, error: { issues: [{ path: [], message: "expected config object" }] } };
      }
      const obj = value as Record<string, unknown>;
      const apiKey = obj.apiKey;
      if (typeof apiKey !== "string" || apiKey.trim() === "") {
        return { success: false, error: { issues: [{ path: ["apiKey"], message: "apiKey is required" }] } };
      }
      if (!apiKey.startsWith("pk_")) {
        return { success: false, error: { issues: [{ path: ["apiKey"], message: "apiKey must start with pk_" }] } };
      }
      return { success: true, data: { apiKey: apiKey.trim() } };
    },
  };
}
```

### Service with `pluginConfig` Access
```typescript
// How to access the validated apiKey in service.start
// Source: /Users/tulio/Projects/temp/openclaw/src/plugins/services.ts (OpenClawPluginServiceContext shape)
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";

export function createPipesBotService(): OpenClawPluginService {
  let stopped = false;

  return {
    id: "pipes-bot-channel",
    async start(ctx: OpenClawPluginServiceContext) {
      // Access plugin config from the config entries
      const entries = ctx.config.plugins?.entries ?? {};
      const pluginEntry = entries["pipes-bot-channel"] as { config?: { apiKey?: string } } | undefined;
      const apiKey = pluginEntry?.config?.apiKey;

      if (!apiKey?.startsWith("pk_")) {
        ctx.logger.error("pipes-bot-channel: pk_ API key missing or invalid — not connecting");
        return;
      }

      ctx.logger.info("pipes-bot-channel: starting");
      // connect WS client here
    },
    async stop(ctx: OpenClawPluginServiceContext) {
      stopped = true;
      ctx.logger.info("pipes-bot-channel: stopped");
      // close WS here
    },
  };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `clawdbot.json` manifest | `openclaw.plugin.json` | Recent (name change in openclaw) | Old name from legacy compatibility; new name is `openclaw.plugin.json` |
| Config via env vars | Config via `plugins.entries.<id>.config` in `openclaw.json` | When plugin system was added | Proper config validation with JSON Schema |
| Blocking `register` function | `registerService` for async lifecycle | Current | Loader ignores promise-returning register; services are awaited properly |

**Deprecated/outdated:**
- `clawdbot.plugin.json`: The OpenClaw source references `MANIFEST_KEY` for backward compat but new plugins must use `openclaw.plugin.json`. Source: `/Users/tulio/Projects/temp/openclaw/src/compat/legacy-names.ts`.
- `activate` function: The loader checks `def.register ?? def.activate` — `activate` is the old name, `register` is current.

## Open Questions

1. **Channel registration in Phase 1 vs Phase 2**
   - What we know: The `openclaw.plugin.json` lists `"channels": ["pipes-bot"]` which tells OpenClaw to expect a channel with that ID. But the `ChannelPlugin` registration via `api.registerChannel()` is what actually wires the channel into the routing system.
   - What's unclear: Does declaring `"channels": ["pipes-bot"]` in the manifest without calling `api.registerChannel()` cause a diagnostic error, or is it purely informational?
   - Recommendation: Include `"channels": ["pipes-bot"]` in the manifest now (required for `openclaw plugins list` to show the channel). If this causes a diagnostic warning, remove it for Phase 1 and add it in Phase 2 alongside the channel implementation.

2. **`openclaw` package version to pin in `devDependencies`**
   - What we know: Current version is `2026.2.16`. The context notes "ChannelPlugin type signatures may shift."
   - What's unclear: Is there a stable minor version or should we use `workspace:*` for local dev and lock a specific version for npm?
   - Recommendation: For Phase 1, use `"openclaw": "*"` in `devDependencies` (installed via `openclaw plugins install`, so openclaw is already present in-process). Document the version lock concern for the blocker note.

3. **How `pluginConfig` is populated in `OpenClawPluginApi`**
   - What we know: In `loader.ts`, `api.pluginConfig` is set to `validatedConfig.value` which is `entry?.config` from `openclaw.json`. So `api.pluginConfig` in `register()` already contains the validated config object.
   - What's unclear: Does `service.start(ctx)` also have access to this same validated config, or only to `ctx.config` (the full OpenClawConfig)?
   - Recommendation: Use `ctx.config.plugins?.entries?.["pipes-bot-channel"]?.config` in `start`. This is the same value but accessed through the full config tree. Alternatively, capture `api.pluginConfig` in `register` closure and pass it to the service factory.

## Sources

### Primary (HIGH confidence)
- `/Users/tulio/Projects/temp/openclaw/src/plugins/manifest.ts` — PluginManifest type, validation rules, required fields (`id`, `configSchema`)
- `/Users/tulio/Projects/temp/openclaw/src/plugins/loader.ts` — Full plugin loading lifecycle: jiti, manifest validation, configSchema validation, register call, async-register warning
- `/Users/tulio/Projects/temp/openclaw/src/plugins/types.ts` — `OpenClawPluginDefinition`, `OpenClawPluginApi`, `OpenClawPluginService` type signatures
- `/Users/tulio/Projects/temp/openclaw/src/plugins/registry.ts` — `createApi`, `registerService`, `registerChannel` implementations
- `/Users/tulio/Projects/temp/openclaw/src/plugins/services.ts` — `startPluginServices` — how `start`/`stop` are called at gateway startup/shutdown
- `/Users/tulio/Projects/temp/openclaw/src/plugins/config-schema.ts` — `emptyPluginConfigSchema` implementation
- `/Users/tulio/Projects/temp/openclaw/extensions/diagnostics-otel/index.ts` + `src/service.ts` — Canonical `registerService` pattern
- `/Users/tulio/Projects/temp/openclaw/extensions/irc/index.ts` — Simplest channel plugin scaffold
- `/Users/tulio/Projects/temp/openclaw/extensions/whatsapp/index.ts` — Channel plugin with runtime injection pattern
- `/Users/tulio/Projects/temp/openclaw/extensions/memory-lancedb/index.ts` — Plugin with non-empty `configSchema` and `api.pluginConfig` usage
- `/Users/tulio/Projects/temp/openclaw/docs/tools/plugin.md` — Official plugin documentation with config examples and CLI reference
- `/Users/tulio/Projects/temp/openclaw/src/plugins/install.ts` — `installPluginFromNpmSpec`, install flow mechanics

### Secondary (MEDIUM confidence)
- `/Users/tulio/Projects/id49/pipes-bot/pipes-bot/packages/plugin/src/ws-client.ts` — Reference WS client implementation (reconnect pattern, ping interval, cleanup)

### Tertiary (LOW confidence)
- None — all findings verified against source code directly.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — verified from extension `package.json` files and `loader.ts` jiti setup
- Architecture: HIGH — read directly from OpenClaw source, multiple extensions verified
- Pitfalls: HIGH — derived from loader code, not blog posts

**Research date:** 2026-02-17
**Valid until:** 2026-03-17 (30 days — stable plugin API, but note blocker: ChannelPlugin type signatures may shift with openclaw package bumps)
