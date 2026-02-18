# PipesBot OpenClaw Channel Plugin

## What This Is

An OpenClaw channel plugin that connects WhatsApp messaging through PipesBot's WebSocket API. Users configure their PipesBot API key, and the plugin establishes a persistent WebSocket connection to receive and send WhatsApp messages — making WhatsApp a first-class chat surface in OpenClaw.

## Core Value

WhatsApp messages flow seamlessly through PipesBot into OpenClaw's agent system, and replies flow back — with full media support and reliable reconnection.

## Requirements

### Validated

- Plugin registers as an OpenClaw channel with proper manifest (`openclaw.plugin.json`) — v1.0
- Custom WebSocket client connects to PipesBot hub using `pk_` API key — v1.0
- Automatic reconnection with exponential backoff on disconnect — v1.0
- Receives all WhatsApp message types: text, image, audio, document, video, sticker, location, contacts, reaction — v1.0
- Forwards inbound messages to OpenClaw's agent pipeline with sender info, conversation context, and media metadata — v1.0
- Sends agent replies back via WebSocket `whatsapp_reply` messages — v1.0
- Handles `reply_status` confirmations and surfaces errors (e.g., `SERVICE_WINDOW_EXPIRED`) — v1.0
- Media download URLs are passed through so OpenClaw can access media content — v1.0
- Plugin is configurable via OpenClaw's config system (hub URL, API key) — v1.0
- Publishes as an npm package for easy installation — v1.0

### Active

(None yet — define for next milestone)

### Out of Scope

- App-scoped (`ak_`) key support — user-scoped `pk_` keys only for now
- REST API fallback for sending — WebSocket only
- Media upload from OpenClaw to WhatsApp — text replies only for outbound
- Webhook delivery mode — WebSocket only
- Conversation-scoped connections — full user scope only
- Group chat support — not in PipesBot's current Cloud API offering

## Context

- **PipesBot** is a managed WhatsApp Cloud API proxy with WebSocket and REST interfaces
- **OpenClaw** is an AI agent framework with a plugin system supporting channel registrations
- PipesBot's WebSocket protocol: connect with `?apiKey=pk_XXX`, receive `whatsapp_message` events, send `whatsapp_reply` messages, get `reply_status` confirmations
- PipesBot pings every 25s to keep connections alive; clients should handle pong
- WhatsApp enforces a 24-hour service window — replies can only be sent within 24h of last inbound message
- Media files are stored in Cloudflare R2 with 48-hour TTL download URLs
- **Shipped v1.0** with 882 LOC TypeScript across 9 source files
- **Tech stack:** TypeScript, ws, OpenClaw plugin SDK, jiti runtime loading

## Constraints

- **Tech stack**: TypeScript — OpenClaw plugins are TypeScript modules loaded via jiti
- **Runtime**: Runs in-process with OpenClaw Gateway as trusted code
- **Distribution**: npm package, installable via `openclaw plugins install`
- **Protocol**: Must match PipesBot's WebSocket message format exactly
- **Dependencies**: Minimal — `ws` for WebSocket, no heavy frameworks

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Custom WS client over @pipes-bot/plugin | Tighter integration with OpenClaw service lifecycle (start/stop), no external dependency coupling | Good |
| User-scoped pk_ keys only | Simpler auth model, covers primary use case | Good |
| WebSocket-only replies (no REST fallback) | Simpler architecture, single connection handles both directions | Good |
| All media types supported inbound | WhatsApp users send all types; limiting creates poor UX | Good |
| Unscoped package name `pipes-bot-channel` | Matches manifest id exactly, avoids OpenClaw resolution pitfall | Good |
| noEmit: true in tsconfig | jiti handles runtime loading, tsc is type-check only | Good |
| dispatchReplyWithBufferedBlockDispatcher (IRC pattern) | PipesBot has no typing API; simpler than createReplyDispatcherWithTyping | Good |
| No gateway property on ChannelPlugin | Prevents lifecycle conflict with registerService | Good |
| Lazy TTL eviction for pendingReplies | No timer overhead, bounded by outbound rate | Good |

---
*Last updated: 2026-02-18 after v1.0 milestone*
