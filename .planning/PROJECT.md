# PipesBot OpenClaw Channel Plugin

## What This Is

An OpenClaw channel plugin that connects WhatsApp messaging through PipesBot's WebSocket API. Users configure their PipesBot API key, and the plugin establishes a persistent WebSocket connection to receive and send WhatsApp messages — making WhatsApp a first-class chat surface in OpenClaw.

## Core Value

WhatsApp messages flow seamlessly through PipesBot into OpenClaw's agent system, and replies flow back — with full media support and reliable reconnection.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Plugin registers as an OpenClaw channel with proper manifest (`openclaw.plugin.json`)
- [ ] Custom WebSocket client connects to PipesBot hub using `pk_` API key
- [ ] Automatic reconnection with exponential backoff on disconnect
- [ ] Receives all WhatsApp message types: text, image, audio, document, video, sticker, location, contacts, reaction
- [ ] Forwards inbound messages to OpenClaw's agent pipeline with sender info, conversation context, and media metadata
- [ ] Sends agent replies back via WebSocket `whatsapp_reply` messages
- [ ] Handles `reply_status` confirmations and surfaces errors (e.g., `SERVICE_WINDOW_EXPIRED`)
- [ ] Media download URLs are passed through so OpenClaw can access media content
- [ ] Plugin is configurable via OpenClaw's config system (hub URL, API key)
- [ ] Publishes as an npm package for easy installation

### Out of Scope

- App-scoped (`ak_`) key support — user-scoped `pk_` keys only for v1
- REST API fallback for sending — WebSocket only
- Media upload from OpenClaw to WhatsApp — text replies only for outbound in v1
- Webhook delivery mode — WebSocket only
- Conversation-scoped connections — full user scope only

## Context

- **PipesBot** is a managed WhatsApp Cloud API proxy with WebSocket and REST interfaces
- **OpenClaw** is an AI agent framework with a plugin system supporting channel registrations
- PipesBot's WebSocket protocol: connect with `?apiKey=pk_XXX`, receive `whatsapp_message` events, send `whatsapp_reply` messages, get `reply_status` confirmations
- PipesBot pings every 25s to keep connections alive; clients should handle pong
- The existing `@pipes-bot/plugin` package has a WS client, but we're writing a custom one tailored to OpenClaw's service lifecycle (`start`/`stop`)
- WhatsApp enforces a 24-hour service window — replies can only be sent within 24h of last inbound message
- Media files are stored in Cloudflare R2 with 48-hour TTL download URLs

## Constraints

- **Tech stack**: TypeScript — OpenClaw plugins are TypeScript modules loaded via jiti
- **Runtime**: Runs in-process with OpenClaw Gateway as trusted code
- **Distribution**: npm package, installable via `openclaw plugins install`
- **Protocol**: Must match PipesBot's WebSocket message format exactly
- **Dependencies**: Minimal — `ws` for WebSocket, no heavy frameworks

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Custom WS client over @pipes-bot/plugin | Tighter integration with OpenClaw service lifecycle (start/stop), no external dependency coupling | — Pending |
| User-scoped pk_ keys only | Simpler auth model, covers primary use case | — Pending |
| WebSocket-only replies (no REST fallback) | Simpler architecture, single connection handles both directions | — Pending |
| All media types supported inbound | WhatsApp users send all types; limiting creates poor UX | — Pending |

---
*Last updated: 2026-02-17 after initialization*
