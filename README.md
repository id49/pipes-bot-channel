# @pipes.bot/pipes-bot-channel

OpenClaw channel plugin that connects WhatsApp messaging through the [PipesBot](https://pipes.bot) managed proxy.

## Overview

This plugin registers a `pipes-bot-channel` channel in OpenClaw, enabling agents to receive and reply to WhatsApp messages via a persistent WebSocket connection to the PipesBot API.

### Supported message types

| Type | Inbound | Outbound |
|------|---------|----------|
| Text | Yes | Yes |
| Image | Yes (downloaded) | - |
| Audio | Yes (downloaded) | - |
| Video | Yes (downloaded) | - |
| Document | Yes (downloaded) | - |
| Sticker | Yes (downloaded) | - |
| Location | Yes (structured) | - |
| Contacts | Yes (vCard) | - |
| Reactions | Yes (emoji) | - |

## Installation

```bash
openclaw plugins install @pipes.bot/pipes-bot-channel
```

## Configuration

In the OpenClaw settings UI, enable the PipesBot channel and provide your API key (starts with `pk_`).

The channel config schema accepts:

- **apiKey** (`string`) - Your PipesBot API key (`pk_...`)
- **enabled** (`boolean`) - Whether the channel is active

## Architecture

```
index.ts                 Plugin entry point — registers channel + service
src/
  channel.ts             Channel plugin definition (config, setup, status)
  service.ts             Service lifecycle — connects WebSocket, routes messages
  connection.ts          WebSocket client with heartbeat + exponential backoff reconnection
  inbound.ts             Inbound message pipeline (type resolution, media, routing, dispatch)
  outbound.ts            Outbound reply tracking + reply_status handling
  media.ts               Media download via PipesBot API (follows R2 redirects)
  types.ts               TypeScript types and type guards for PipesBot message envelopes
  config-schema.ts       Zod schema for channel config
  runtime.ts             Singleton runtime context
  status-store.ts        In-memory connection status state
```

### Message flow

1. **WebSocket connection** — `PipesBotConnection` connects to `wss://api.pipes.bot/ws` with the API key, maintains a ping/pong heartbeat (25s interval), and reconnects with exponential backoff (1s-2min cap) on transient failures.

2. **Message routing** — The service receives JSON messages from the WebSocket and routes them by type: `whatsapp_message` goes to `handleInbound()`, `reply_status` goes to `handleReplyStatus()`.

3. **Inbound processing** — `handleInbound()` validates the message, resolves body text, downloads media if present, converts contacts to vCard, normalizes location data, resolves the agent route, records the session, and dispatches to the agent pipeline.

4. **Agent dispatch** — The agent processes the message and produces a reply, which is sent back through the WebSocket as a `whatsapp_reply` message.

5. **Reply tracking** — Outbound replies are tracked with a 30s TTL for correlation with `reply_status` events. Failures are classified (e.g., `SERVICE_WINDOW_EXPIRED`, `RATE_LIMITED`) and surfaced as agent-facing system events when relevant.

### Connection resilience

- **Auth failures** (401/403) stop reconnection permanently
- **Transient failures** trigger exponential backoff with jitter
- **Pong timeout** (50s) terminates dead connections to trigger reconnect
- **Graceful disconnect** tears down timers and WebSocket cleanly

## Development

```bash
# Type-check
npx tsc --noEmit
```

## License

MIT
