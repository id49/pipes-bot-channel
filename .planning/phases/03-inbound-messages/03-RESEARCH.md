# Phase 3: Inbound Messages - Research

**Researched:** 2026-02-17
**Domain:** WhatsApp message normalization, OpenClaw inbound pipeline, media downloading, agent dispatch
**Confidence:** HIGH

---

## Summary

Phase 3 wires the PipesBot WebSocket message stream into the OpenClaw agent pipeline. The `PipesBotConnection` from Phase 2 already emits parsed JSON objects via an EventEmitter `message` event. Phase 3 replaces the `void msg; // Phase 3 stub` in `service.ts` with a full normalization and dispatch pipeline.

The core challenge is bridging two schemas: PipesBot's `whatsapp_message` envelope (documented locally in `pipes-bot-docs`) and OpenClaw's `MsgContext` / `FinalizedMsgContext` (sourced from `openclaw/plugin-sdk`). The mapping is deterministic and fully specifiable from existing docs. No unknown APIs are involved.

Media handling is the most complex requirement: PipesBot delivers relative download URLs (`/v1/media/download/{mediaId}`) that must be fetched with an Authorization header, redirected (302 to presigned R2 URL), and saved locally via `core.channel.media.fetchRemoteMedia` + `core.channel.media.saveMediaBuffer`. The runtime exposes exactly these two functions. Other extensions (Zalo, Mattermost, Google Chat, Matrix) all follow the same pattern.

Special types (sticker, location, contacts, reaction) each have a defined normalization rule per the CONTEXT.md decisions. None require custom infrastructure — they are pure schema mapping with one file-write for contacts (.vcf).

**Primary recommendation:** Implement a single `handleInbound(msg, runtime, apiKey, logger)` function in a new `src/inbound.ts` file. Call it from `service.ts`'s `connection.on("message", ...)` handler. Isolate media downloading into `src/media.ts`. Wire `reply()`, `sendMedia()`, and `sendComposing()` callbacks inside `inbound.ts` using the existing `PipesBotConnection.send()` method.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `openclaw/plugin-sdk` | installed (peer) | `MsgContext`, `buildAgentMediaPayload`, `NormalizedLocation`, `toLocationContext`, `finalizeInboundContext`, `dispatchReplyFromConfig`, `dispatchReplyWithBufferedBlockDispatcher` | The authoritative SDK — all channel plugins use these exact functions |
| `node:fs/promises` | Node built-in | Write `.vcf` files for contact normalization | No external dep; contacts → vcf is one `writeFile` call |
| `node:path` | Node built-in | Construct file paths for saved media | Built-in; used by all existing extensions |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `ws` (already installed) | `^8.18.0` | `PipesBotConnection.send()` for `whatsapp_reply` and typing | Already in use from Phase 2 |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `core.channel.media.fetchRemoteMedia` + `saveMediaBuffer` | Direct `fetch` + `fs.writeFile` | The runtime APIs handle SSRF protection, MIME sniffing, UUID filename generation, and media directory management. Custom implementations would miss all of these. Use the runtime APIs. |
| `dispatchReplyWithBufferedBlockDispatcher` with typing | `dispatchReplyFromConfig` (simpler) | Both are valid. Mattermost uses `createReplyDispatcherWithTyping` → `dispatchReplyFromConfig`. IRC uses `dispatchReplyWithBufferedBlockDispatcher` directly. Either works. Given the context decision to wire `sendComposing()`, prefer the typing-dispatcher pattern. |

**Installation:**

```bash
# No new packages needed — ws is installed, openclaw is a peer dep
```

---

## PipesBot Message Schema

Source: `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-docs/content/docs/websocket/messages.mdx` (HIGH confidence)

### Envelope (all types share these fields)

```typescript
// All whatsapp_message events
type PipesBotEnvelope = {
  type: "whatsapp_message";
  data: {
    messageId: string;
    conversationId: string;       // Use this as conversationId for SessionKey
    poolNumberId: string;
    poolNumberPhoneNumber: string; // The "our" phone number
    fromNumber: string;            // Sender's phone (use as SenderId)
    fromName?: string;             // Sender's push name (use as SenderName)
    text: string;                  // Same as body
    body: string;                  // Text content or caption
    timestamp: string;             // ISO 8601
    label?: string;
    type: "text" | "image" | "audio" | "video" | "document" | "sticker" | "location" | "contacts" | "reaction" | "unsupported";
    // Type-specific fields below
  };
};
```

### Type-specific fields

```typescript
// Media types: image, audio, video, document, sticker
media?: {
  mediaId?: string;
  downloadUrl?: string;   // Relative: "/v1/media/download/{mediaId}" — prepend base URL
  mimeType: string;       // e.g. "image/jpeg", "audio/ogg", "image/webp"
  fileName?: string;      // Only for documents
  byteSize: number;
  unavailable?: boolean;  // true if PipesBot couldn't fetch from WhatsApp
};

// Location type
location?: {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
};

// Contacts type
contacts?: Array<{
  name: { formatted_name: string };
  phones?: Array<{ phone: string; type?: string }>;
  emails?: Array<{ email: string; type?: string }>;
  addresses?: Array<unknown>;
  org?: unknown;
  urls?: unknown;
}>;

// Reaction type
reaction?: {
  messageId: string;  // ID of the message being reacted to
  emoji?: string;     // Absent when reaction removed
};
```

### Download URL construction

The `downloadUrl` field is a relative path. Construct the absolute URL as:
```
https://api.pipes.bot{downloadUrl}
```
with header `Authorization: Bearer {apiKey}`.

The endpoint returns `302` to a presigned R2 URL (5-minute TTL on the presigned URL). `fetchRemoteMedia` follows redirects automatically.

---

## Architecture Patterns

### Recommended Project Structure

```
src/
├── connection.ts       # Phase 2: PipesBotConnection (already exists)
├── service.ts          # Phase 2: start()/stop() lifecycle (already exists)
├── inbound.ts          # NEW: handleInbound() — normalize + dispatch
├── media.ts            # NEW: downloadPipesBotMedia() — fetch + saveMediaBuffer
├── send.ts             # NEW: sendReply(), sendComposing() — outbound helpers
└── types.ts            # NEW: PipesBotMessage type definitions (discriminated union)
```

### Pattern 1: Runtime Singleton (MANDATORY)

The existing `service.ts` accesses `api.runtime` via the `OpenClawPluginServiceContext`. However, `OpenClawPluginServiceContext` does NOT include `runtime` — it only has `config`, `workspaceDir`, `stateDir`, and `logger`.

**Critical finding:** `PluginRuntime` (with `channel.reply.*`, `channel.media.*`, etc.) is only available at `api.runtime` during `register()`. It must be stored in a module-level singleton during registration, then accessed via `getRuntime()` in `inbound.ts`.

The current `service.ts` does NOT store `api.runtime`. Phase 3 must add this singleton pattern.

```typescript
// src/runtime.ts (NEW)
import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setPipesBotRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getPipesBotRuntime(): PluginRuntime {
  if (!runtime) throw new Error("pipes-bot-channel: runtime not initialized");
  return runtime;
}
```

```typescript
// index.ts (UPDATE register())
register(api: OpenClawPluginApi): void {
  setPipesBotRuntime(api.runtime);  // ADD THIS
  api.registerService(createPipesBotService());
  api.logger.info("pipes-bot-channel: registered");
}
```

Source: Verified from `openclaw/src/plugins/types.ts` — `OpenClawPluginServiceContext` does not include `runtime`. All extensions (irc, feishu, zalo, mattermost) call `setXxxRuntime(api.runtime)` in `register()`.

### Pattern 2: Message Handler Structure

```typescript
// src/inbound.ts
export async function handleInbound(
  msg: unknown,
  opts: {
    apiKey: string;
    accountId: string;
    send: (payload: object) => boolean;
    logger: PluginLogger;
  },
): Promise<void> {
  const core = getPipesBotRuntime();
  const cfg = core.config.loadConfig() as OpenClawConfig;

  // 1. Parse and validate the envelope
  if (!isPipesBotMessage(msg)) return;
  const data = msg.data;

  // 2. Normalize to MsgContext fields
  const body = resolveBody(data);       // caption or empty for media
  const mediaPayload = await resolveMedia(data, opts.apiKey, opts.logger);
  const locationPayload = resolveLocation(data);
  const replyToId = resolveReplyToId(data);

  // 3. Build SessionKey
  const sessionKey = `${opts.accountId}:${data.conversationId}`;

  // 4. Route
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "pipes-bot-channel",
    accountId: opts.accountId,
    peer: { kind: "direct", id: data.conversationId },
  });

  // 5. Record session
  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey,
  });

  // 6. Finalize context
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: data.body ?? "",
    CommandBody: data.body ?? "",
    From: `pipes-bot-channel:${data.fromNumber}`,
    To: `pipes-bot-channel:${data.poolNumberPhoneNumber}`,
    SessionKey: sessionKey,
    AccountId: opts.accountId,
    ChatType: "direct",
    SenderName: data.fromName ?? undefined,
    SenderId: data.fromNumber,
    Provider: "pipes-bot-channel",
    Surface: "pipes-bot-channel",
    MessageSid: data.messageId,
    Timestamp: new Date(data.timestamp).getTime(),
    ConversationLabel: data.fromName ?? data.fromNumber,
    ReplyToId: replyToId,
    OriginatingChannel: "pipes-bot-channel",
    OriginatingTo: `pipes-bot-channel:${data.conversationId}`,
    ...mediaPayload,
    ...locationPayload,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      opts.logger.error(`pipes-bot-channel: session record error: ${String(err)}`);
    },
  });

  // 7. Dispatch to agent
  await core.channel.reply.dispatchReplyFromConfig({
    ctx: ctxPayload,
    cfg,
    dispatcher: {
      deliver: async (payload) => {
        opts.send({
          type: "whatsapp_reply",
          data: {
            conversationId: data.conversationId,
            poolNumberId: data.poolNumberId,
            toNumber: data.fromNumber,
            text: payload.text ?? "",
          },
        });
      },
      onError: (err, info) => {
        opts.logger.error(`pipes-bot-channel: ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {},
  });
}
```

### Pattern 3: Media Download

```typescript
// src/media.ts
const PIPES_BOT_API_BASE = "https://api.pipes.bot";

export async function downloadPipesBotMedia(params: {
  downloadUrl: string;   // e.g. "/v1/media/download/aBcDeFgH..."
  mimeType: string;
  fileName?: string;
  apiKey: string;
  logger: PluginLogger;
}): Promise<{ path: string; contentType?: string } | null> {
  const core = getPipesBotRuntime();
  const absoluteUrl = `${PIPES_BOT_API_BASE}${params.downloadUrl}`;

  try {
    const fetched = await core.channel.media.fetchRemoteMedia({
      url: absoluteUrl,
      fetchImpl: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${params.apiKey}`);
        return fetch(input, { ...init, headers });
      },
      filePathHint: params.fileName,
      // No maxBytes — trust PipesBot's upstream constraints (per decision)
    });
    const saved = await core.channel.media.saveMediaBuffer(
      fetched.buffer,
      fetched.contentType ?? params.mimeType,
      "inbound",
    );
    return { path: saved.path, contentType: saved.contentType ?? params.mimeType };
  } catch (err) {
    params.logger.error(
      `pipes-bot-channel: media download failed for ${params.downloadUrl}: ${String(err)}`
    );
    return null;
  }
}
```

Source: Pattern from `extensions/zalo/src/monitor.ts:324-335` and `extensions/mattermost/src/mattermost/monitor.ts:256-267` — both use `fetchRemoteMedia` + `saveMediaBuffer`. HIGH confidence.

### Pattern 4: Message Type Normalization

All normalizations are pure functions with no I/O (except contact .vcf write):

```typescript
// Text → Body from data.body, no media
// Image → Body = data.body (caption) or "", MediaPath + MediaType = "image/jpeg"
// Audio → Body = "", MediaPath + MediaType = "audio/ogg" (or mimeType from payload)
// Video → Body = data.body or "", MediaPath + MediaType = "video/mp4"
// Document → Body = data.body or "", MediaPath + MediaType from media.mimeType, fileName preserved
// Sticker → Body = "", download as image/webp per decision
// Location → Body = "", LocationLat + LocationLon via toLocationContext()
// Contacts → Body = "", save .vcf file, set as MediaPath + MediaType = "text/vcard"
// Reaction → Body = data.reaction.emoji ?? "", ReplyToId = data.reaction.messageId
// Unsupported → skip (return early)
```

#### Location context

```typescript
import { toLocationContext, type NormalizedLocation } from "openclaw/plugin-sdk";

function resolveLocationPayload(data: PipesBotMessage["data"]) {
  if (data.type !== "location" || !data.location) return {};
  const loc: NormalizedLocation = {
    latitude: data.location.latitude,
    longitude: data.location.longitude,
    name: data.location.name,
    address: data.location.address,
  };
  return toLocationContext(loc);
}
```

#### Contacts → VCF

```typescript
import fs from "node:fs/promises";
import path from "node:path";
import { getMediaDir } from "openclaw/plugin-sdk"; // if exported, else use core.config path

async function saveContactVcf(contacts: PipesBotContact[]): Promise<string> {
  const vcard = contacts.map(formatVCard).join("\n");
  const dir = path.join(/* mediaDir */, "inbound");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${crypto.randomUUID()}.vcf`);
  await fs.writeFile(filePath, vcard, { mode: 0o600 });
  return filePath;
}

function formatVCard(contact: PipesBotContact): string {
  const name = contact.name?.formatted_name ?? "Unknown";
  const phones = (contact.phones ?? [])
    .map((p) => `TEL;TYPE=${p.type ?? "CELL"}:${p.phone}`)
    .join("\n");
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${name}`,
    phones,
    "END:VCARD",
  ].filter(Boolean).join("\n");
}
```

Source: Per CONTEXT.md decision: "Contact cards (vCards) → save as .vcf file, set as media attachment". MediaType = "text/vcard". HIGH confidence.

#### Media payload construction

```typescript
import { buildAgentMediaPayload } from "openclaw/plugin-sdk";

// For single media:
const mediaPayload = buildAgentMediaPayload([{ path: saved.path, contentType: saved.contentType }]);
// Returns: { MediaPath, MediaType, MediaUrl, MediaPaths, MediaUrls, MediaTypes }
```

Source: `src/plugin-sdk/agent-media-payload.ts` — verified from OpenClaw source. HIGH confidence.

### Pattern 5: SessionKey Construction

Per CONTEXT.md decision:
```
SessionKey = `${accountId}:${conversationId}`
```

The `accountId` is the account identifier from plugin config. The `conversationId` comes directly from PipesBot's `data.conversationId` field. Do not derive it from phone numbers.

### Pattern 6: Typing Indicator (sendComposing)

PipesBot WebSocket does NOT have a typing indicator API. The `sendComposing()` callback is described in the phase context as something to implement — however there is no PipesBot protocol message for typing. This callback can be a no-op or omitted from the dispatcher.

**Decision: implement as no-op.** WhatsApp Cloud API does not support sending typing indicators to users. This is confirmed by the FEATURES.md research ("Typing indicators (sent to WhatsApp user) → Omit. WhatsApp Cloud API does not support this.").

If `createReplyDispatcherWithTyping` is used, pass `start: async () => {}` and `stop: async () => {}` to satisfy the interface without sending anything.

### Anti-Patterns to Avoid

- **Skipping the `unavailable` flag check:** If `media.unavailable === true`, the media fields `downloadUrl` and `mediaId` will be absent. Attempting to download will panic. Always check `!data.media.unavailable` before downloading.
- **Constructing absolute URL without the base:** The `downloadUrl` from PipesBot is a relative path (`/v1/media/download/...`), not an absolute URL. Prepend `https://api.pipes.bot`.
- **Missing Authorization header on media download:** Unlike some other APIs, PipesBot media download requires `Authorization: Bearer {apiKey}`. The `fetchImpl` override is needed because `fetchRemoteMedia` doesn't automatically add auth headers.
- **Using `data.from` instead of `data.fromNumber`:** The field is `fromNumber` (not `from`). The common fields table in PipesBot docs confirms this.
- **Blocking the message handler on media download:** The `connection.on("message")` handler fires synchronously. Launch the async `handleInbound()` with `void handleInbound(...)` (fire-and-forget) or ensure it's awaited inside an async IIFE. Do NOT `await` in the event callback itself without wrapping in a `Promise` — this could block the WS message loop.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Fetch media + save to disk | Custom `fetch` + `fs.writeFile` | `core.channel.media.fetchRemoteMedia` + `core.channel.media.saveMediaBuffer` | Handles SSRF, MIME sniffing, UUID filenames, media directory, file permissions (0o600), cleanup. Missing any of these is a security or correctness bug. |
| Media field population in MsgContext | Manually set `MediaPath`, `MediaType`, etc. | `buildAgentMediaPayload(mediaList)` from `openclaw/plugin-sdk` | Correctly populates `MediaPath`, `MediaPaths`, `MediaUrl`, `MediaUrls`, `MediaTypes` in one call. Manual population misses the `MediaUrls`/`MediaPaths` arrays that agents expect. |
| Location formatting | Custom `"lat: X, lon: Y"` text | `toLocationContext(location)` which populates `LocationLat`, `LocationLon`, `LocationName`, etc. | OpenClaw agents receive structured location fields, not formatted strings. Custom text loses machine-readable coordinates. |
| Context payload normalization | Manually set all MsgContext fields | `core.channel.reply.finalizeInboundContext(ctx)` | Handles `Body` newline normalization, `BodyForAgent` fallback chain, `MediaType`/`MediaTypes` alignment, `CommandAuthorized` default-deny. Missing this causes prompt formatting bugs. |
| Session persistence | Custom file store | `core.channel.session.recordInboundSession(...)` | Multi-turn context, session TTL, cross-agent routing. Custom stores break the OpenClaw session model entirely. |

**Key insight:** The OpenClaw runtime exposes precisely the APIs needed. Using them is not optional — skipping them produces subtle correctness bugs that are hard to trace.

---

## Common Pitfalls

### Pitfall 1: Runtime Not Available in Service Context

**What goes wrong:** `service.ts`'s `start(ctx)` has `ctx.logger` and `ctx.config` but NOT `ctx.runtime` (the `PluginRuntime` with `channel.reply.*`). Attempting `ctx.runtime.channel.reply.finalizeInboundContext(...)` will throw `TypeError: Cannot read properties of undefined`.

**Why it happens:** `OpenClawPluginServiceContext` does not include `runtime`. The runtime is only available at registration time via `api.runtime`.

**How to avoid:** Create `src/runtime.ts` with `setPipesBotRuntime()`/`getPipesBotRuntime()`. Call `setPipesBotRuntime(api.runtime)` in `index.ts`'s `register()`. Call `getPipesBotRuntime()` everywhere else.

**Warning signs:** TypeScript will catch this if types are correct — `OpenClawPluginServiceContext` does not have a `runtime` property. If types are wrong or cast to `any`, the runtime error appears at first message arrival.

### Pitfall 2: Blocking Event Loop on Media Download

**What goes wrong:** Media downloads are HTTP fetches (potentially hundreds of milliseconds). If `handleInbound()` is `await`ed inside the `ws` `message` event handler synchronously, subsequent messages queue up behind the fetch. Under burst load, this creates backpressure and message processing delays.

**Why it happens:** The `ws` `message` event fires synchronously. Handlers that do I/O should be async and fire-and-forget.

**How to avoid:**
```typescript
connection.on("message", (msg: object) => {
  void handleInbound(msg, opts).catch((err) => {
    logger.error(`pipes-bot-channel: inbound handler error: ${String(err)}`);
  });
});
```

**Warning signs:** Messages arrive in order but with increasing delay; the first message in a burst is fast, the last is slow.

### Pitfall 3: Missing `unavailable` Check on Media

**What goes wrong:** If PipesBot couldn't fetch the media from WhatsApp, it delivers the message with `media.unavailable: true` and no `downloadUrl` or `mediaId`. Attempting `downloadPipesBotMedia({ downloadUrl: data.media.downloadUrl! })` will call `fetchRemoteMedia` with `undefined`, which throws.

**Why it happens:** The `unavailable` flag is a documented edge case that's easy to miss when writing the happy path first.

**How to avoid:** Always check before downloading:
```typescript
if (data.media && !data.media.unavailable && data.media.downloadUrl) {
  // download
} else if (data.media?.unavailable) {
  logger.warn(`pipes-bot-channel: media unavailable for message ${data.messageId}`);
  // proceed with Body-only dispatch
}
```

**Warning signs:** Unhandled promise rejection on media messages when PipesBot cannot reach WhatsApp CDN.

### Pitfall 4: Wrong SessionKey Format Breaks Multi-Account

**What goes wrong:** Using just `conversationId` as the session key works for a single-account setup but breaks when multiple PipesBot accounts are configured — the same conversationId from different accounts would share a session.

**Why it happens:** The pattern looks obvious (`conversationId` seems globally unique), but the session store is shared across all accounts.

**How to avoid:** Always prefix with `accountId`:
```typescript
const sessionKey = `${accountId}:${data.conversationId}`;
```

**Warning signs:** Messages from different accounts interfere with each other's conversation history in multi-account setups.

### Pitfall 5: Contacts VCF Missing Media Directory

**What goes wrong:** Attempting to write the `.vcf` file before `ensureMediaDir()` (or equivalent mkdir) fails with `ENOENT` on first run when the media directory doesn't exist yet.

**Why it happens:** The media directory is created lazily. On a fresh install, it doesn't exist until first media save.

**How to avoid:** Use `fs.mkdir(dir, { recursive: true })` before writing the VCF file. Alternatively, call `core.channel.media.saveMediaBuffer(Buffer.from(vcard), "text/vcard", "inbound")` which handles directory creation internally — this also makes it consistent with other media saves.

**Warning signs:** `ENOENT: no such file or directory, open '.../media/inbound/xxxx.vcf'` on first contact message.

### Pitfall 6: Reaction with No Emoji Dispatches Empty Body

**What goes wrong:** When a user removes a reaction, `data.reaction.emoji` is absent. Using `data.reaction.emoji ?? ""` means an empty `Body` is dispatched to the agent. Depending on agent config, an empty Body may trigger unexpected behavior or be silently dropped.

**Why it happens:** The reaction removal is a legitimate event but has no text content.

**How to avoid:** Check for emoji presence:
```typescript
const emoji = data.reaction?.emoji;
if (!emoji) {
  // Reaction removed — skip dispatch or dispatch with a placeholder
  return; // simplest: skip
}
const body = emoji;
const replyToId = data.reaction.messageId;
```

Per the phase decisions, reactions are dispatched as regular messages. A removed reaction (no emoji) can be skipped — it carries no actionable information for the agent.

---

## Code Examples

Verified patterns from official sources:

### Complete inbound handler skeleton

```typescript
// src/inbound.ts
// Source: Pattern from extensions/irc/src/inbound.ts + extensions/zalo/src/monitor.ts

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  buildAgentMediaPayload,
  toLocationContext,
  type NormalizedLocation,
} from "openclaw/plugin-sdk";
import { getPipesBotRuntime } from "./runtime.js";
import { downloadPipesBotMedia } from "./media.js";

type PluginLogger = /* typeof OpenClawPluginServiceContext["logger"] */ {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};

export async function handleInbound(
  msg: unknown,
  opts: {
    apiKey: string;
    accountId: string;
    send: (payload: object) => boolean;
    logger: PluginLogger;
  },
): Promise<void> {
  // 1. Type guard
  if (!isWhatsAppMessage(msg)) return;
  const data = msg.data;

  const core = getPipesBotRuntime();
  const cfg = core.config.loadConfig() as OpenClawConfig;
  const { apiKey, accountId, send, logger } = opts;

  // 2. Unsupported: skip
  if (data.type === "unsupported") return;

  // 3. Reaction removal: skip
  if (data.type === "reaction" && !data.reaction?.emoji) return;

  // 4. Build body
  const rawBody = resolveRawBody(data);
  const body = rawBody;

  // 5. Download media (if applicable)
  const mediaPayload = await resolveMediaPayload(data, apiKey, logger);

  // 6. Location context
  const locationCtx = resolveLocationCtx(data);

  // 7. ReplyToId
  const replyToId = data.type === "reaction" ? data.reaction?.messageId : undefined;

  // 8. SessionKey
  const sessionKey = `${accountId}:${data.conversationId}`;

  // 9. Route
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "pipes-bot-channel",
    accountId,
    peer: { kind: "direct", id: data.conversationId },
  });

  // 10. Session store path
  const storePath = core.channel.session.resolveStorePath(
    cfg.session?.store,
    { agentId: route.agentId },
  );

  // 11. Finalize context
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `pipes-bot-channel:${data.fromNumber}`,
    To: `pipes-bot-channel:${data.poolNumberPhoneNumber}`,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: "direct" as const,
    SenderName: data.fromName ?? undefined,
    SenderId: data.fromNumber,
    Provider: "pipes-bot-channel",
    Surface: "pipes-bot-channel",
    MessageSid: data.messageId,
    Timestamp: new Date(data.timestamp).getTime(),
    ConversationLabel: data.fromName ?? data.fromNumber,
    ReplyToId: replyToId,
    OriginatingChannel: "pipes-bot-channel" as const,
    OriginatingTo: `pipes-bot-channel:${data.conversationId}`,
    ...mediaPayload,
    ...locationCtx,
  });

  // 12. Record session
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      logger.error(`pipes-bot-channel: session record failed: ${String(err)}`);
    },
  });

  // 13. Dispatch
  await core.channel.reply.dispatchReplyFromConfig({
    ctx: ctxPayload,
    cfg,
    dispatcher: {
      deliver: async (payload) => {
        const sent = send({
          type: "whatsapp_reply",
          data: {
            conversationId: data.conversationId,
            poolNumberId: data.poolNumberId,
            toNumber: data.fromNumber,
            text: payload.text ?? "",
          },
        });
        if (!sent) {
          logger.warn(`pipes-bot-channel: send failed (disconnected) for ${data.conversationId}`);
        }
      },
      onError: (err, info) => {
        logger.error(`pipes-bot-channel: ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {},
  });
}
```

### Media resolution helper

```typescript
async function resolveMediaPayload(
  data: PipesBotMessageData,
  apiKey: string,
  logger: PluginLogger,
): Promise<ReturnType<typeof buildAgentMediaPayload>> {
  const mediaTypes: Array<"image" | "audio" | "video" | "document" | "sticker"> = [
    "image", "audio", "video", "document", "sticker",
  ];
  if (!mediaTypes.includes(data.type as never)) return {};
  if (!data.media || data.media.unavailable || !data.media.downloadUrl) return {};

  const result = await downloadPipesBotMedia({
    downloadUrl: data.media.downloadUrl,
    mimeType: data.media.mimeType,
    fileName: data.media.fileName,
    apiKey,
    logger,
  });
  if (!result) return {};

  return buildAgentMediaPayload([{ path: result.path, contentType: result.contentType }]);
}
```

### Contacts VCF save

```typescript
// Using saveMediaBuffer to stay consistent with media pipeline
async function resolveContactsPayload(
  contacts: PipesBotContact[],
): Promise<ReturnType<typeof buildAgentMediaPayload>> {
  const core = getPipesBotRuntime();
  const vcard = contacts.map(formatVCard).join("\n");
  const saved = await core.channel.media.saveMediaBuffer(
    Buffer.from(vcard, "utf-8"),
    "text/vcard",
    "inbound",
  );
  return buildAgentMediaPayload([{ path: saved.path, contentType: "text/vcard" }]);
}
```

### Updating service.ts to wire inbound handler

```typescript
// src/service.ts — updated message handler
connection.on("message", (msg: object) => {
  void handleInbound(msg, {
    apiKey,
    accountId: "default",         // or resolved from config
    send: (payload) => connection.send(payload),
    logger: ctx.logger,
  }).catch((err: unknown) => {
    ctx.logger.error(`pipes-bot-channel: inbound error: ${String(err)}`);
  });
});
```

### Updating index.ts to store runtime

```typescript
// index.ts
import { setPipesBotRuntime } from "./src/runtime.js";

const plugin = {
  id: "pipes-bot-channel",
  // ...
  register(api: OpenClawPluginApi): void {
    setPipesBotRuntime(api.runtime);  // MUST be first
    api.registerService(createPipesBotService());
    api.logger.info("pipes-bot-channel: registered");
  },
};
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `dispatchReplyFromConfig` (simple dispatcher) | `createReplyDispatcherWithTyping` → `dispatchReplyFromConfig` | Current OpenClaw | Typing callbacks + human delay config are now the recommended pattern for channels that support typing. For PipesBot (no typing API), either works — `dispatchReplyFromConfig` is simpler and appropriate. |
| Pass R2 URLs through to agent | Download locally via `fetchRemoteMedia` | Per CONTEXT.md decision | Local download ensures media persists beyond the 48h TTL window and avoids auth complexity in agent media tools. |
| `saveMediaSource(url)` | `fetchRemoteMedia` + `saveMediaBuffer(buffer)` | Current runtime API | Split into two steps allows auth header injection on the fetch before saving. `saveMediaSource` cannot inject custom auth headers. |

---

## Open Questions

1. **`resolveAgentRoute` channel string value**
   - What we know: All extensions pass their channel ID string (e.g., `"irc"`, `"mattermost"`) to `resolveAgentRoute({ channel: ... })`. This maps to OpenClaw's routing config `channels.<id>.agents.*`.
   - What's unclear: The exact config key the user must set in `openclaw.json` to route messages to a specific agent. Will `"pipes-bot-channel"` work as-is, or does it need to match the manifest `id` exactly?
   - Recommendation: Use `"pipes-bot-channel"` (the plugin manifest ID). Test with a real OpenClaw config to verify routing works.

2. **`accountId` derivation in service context**
   - What we know: The service `start(ctx)` has `ctx.config` (the full `OpenClawConfig`). The `accountId` is a key from the plugin config's accounts section.
   - What's unclear: There's no Phase 2 `listAccountIds` equivalent — the service is simpler than a channel plugin. How does `accountId` get resolved?
   - Recommendation: For v1 with a single account, use `"default"` as the hardcoded `accountId`. The `apiKey` comes from `ctx.config.plugins?.entries?.["pipes-bot-channel"]?.config`. This matches what `service.ts` already does for `apiKey` resolution.

3. **`OriginatingChannel` type compatibility**
   - What we know: `OriginatingChannel` in `MsgContext` is typed as `OriginatingChannelType = ChannelId | InternalMessageChannel`. The value `"pipes-bot-channel"` is a custom plugin ID, not a built-in `ChannelId`.
   - What's unclear: Whether passing a custom channel string causes a TypeScript error or runtime issue.
   - Recommendation: Cast as `"pipes-bot-channel" as OriginatingChannelType` or omit `OriginatingChannel`/`OriginatingTo` if they cause type errors. These fields are optional and primarily for internal routing.

---

## Sources

### Primary (HIGH confidence)

- OpenClaw source tree at `/Users/tulio/Projects/temp/openclaw`
  - `src/auto-reply/templating.ts` — `MsgContext` type (all fields verified)
  - `src/auto-reply/reply/inbound-context.ts` — `finalizeInboundContext` implementation
  - `src/plugin-sdk/agent-media-payload.ts` — `buildAgentMediaPayload` implementation
  - `src/channels/location.ts` — `NormalizedLocation`, `toLocationContext` implementation
  - `src/media/store.ts` — `saveMediaBuffer` implementation + media directory management
  - `src/media/fetch.ts` — `fetchRemoteMedia` implementation (follows 302, SSRF protection)
  - `src/plugins/types.ts` — `OpenClawPluginServiceContext` (confirmed: no `runtime` field), `OpenClawPluginApi` (has `runtime: PluginRuntime`)
  - `src/plugins/runtime/types.ts` — `PluginRuntime` type (confirmed: `channel.media`, `channel.reply`, `channel.session`, `channel.routing`)
  - `extensions/irc/src/inbound.ts` — full inbound handler reference (security gate, route, finalize, dispatch)
  - `extensions/zalo/src/monitor.ts:324-354` — `fetchRemoteMedia` + `saveMediaBuffer` pattern
  - `extensions/mattermost/src/mattermost/monitor.ts:256-267` — same pattern with auth headers

- PipesBot docs at `/Users/tulio/Projects/id49/pipes-bot/pipes-bot-docs/content/docs/websocket/`
  - `messages.mdx` — all message types, field names, shapes
  - `media.mdx` — download URL format, unavailable flag, 48h TTL, Node.js example with `redirect: "follow"`
  - `replies.mdx` — `whatsapp_reply` format, `reply_status` event

- Project files:
  - `src/service.ts` — existing Phase 2 implementation (confirmed apiKey resolution pattern)
  - `src/connection.ts` — `PipesBotConnection.send()` returns `boolean`, takes `object`
  - `.planning/phases/03-inbound-messages/03-CONTEXT.md` — locked decisions

### Secondary (MEDIUM confidence)

- `.planning/research/FEATURES.md` — typing indicators confirmed unsupported by Cloud API
- `.planning/research/ARCHITECTURE.md` — build order and component boundaries

---

## Metadata

**Confidence breakdown:**
- PipesBot message schema: HIGH — from local docs repo
- OpenClaw MsgContext / dispatch API: HIGH — from OpenClaw source tree
- Media download pattern: HIGH — from three independent extension implementations (Zalo, Mattermost, Google Chat)
- Contact VCF normalization: HIGH — from CONTEXT.md decision + `saveMediaBuffer` API
- Runtime singleton requirement: HIGH — confirmed from `OpenClawPluginServiceContext` type definition
- Typing indicator absence: HIGH — documented in FEATURES.md, WhatsApp Cloud API limitation

**Research date:** 2026-02-17
**Valid until:** 2026-03-19 (30 days — stable APIs, local docs repo)
