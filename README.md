# @pipes.bot/pipes-bot-channel

OpenClaw channel plugin that connects WhatsApp messaging through the [PipesBot](https://pipes.bot) managed proxy.

## Overview

This plugin registers a `pipes-bot-channel` channel in OpenClaw, enabling agents to receive and reply to WhatsApp messages via a persistent WebSocket connection to the PipesBot API.

It runs in one of two modes, chosen by the API key prefix:

| Mode | Key | Number | Protocol |
|------|-----|--------|----------|
| Sandbox | `pk_...` | PipesBot sandbox number | Legacy WebSocket messages |
| BYON App | `ak_...` | Your own WhatsApp Business number (BYON) | PipesBot API v2 events |

There is no mode setting. Sandbox behavior is the same as before App mode existed.

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

In App mode, interactive replies (buttons and lists) and quick-reply buttons are also accepted inbound. Their title or text reaches the agent as a text message.

## Installation

```bash
openclaw plugins install @pipes.bot/pipes-bot-channel
```

## Configuration

In the OpenClaw settings UI, enable the PipesBot channel and provide your API key: `pk_...` for a sandbox number or `ak_...` for a BYON App.

The channel config schema accepts:

- **apiKey** (`string`) - Your PipesBot API key (`pk_...` or `ak_...`)
- **allowFrom** (`string[]`) - App mode only. Trusted senders: phone numbers or WhatsApp user IDs
- **poolNumberId** (`string`) - App mode only. Only answer on this BYON number (`pn_...`). Leave empty for all numbers in the App
- **enabled** (`boolean`) - Whether the channel is active

`allowFrom` and `poolNumberId` are ignored with a `pk_` key.

App mode example:

```json5
{
  channels: {
    "pipes-bot-channel": {
      apiKey: "ak_live_…",
      allowFrom: ["+55 11 99999-0000", "US.13491208655302741918"],
      poolNumberId: "pn_abc123"
    }
  }
}
```

### Trusted senders

A BYON number is a normal business number, so anyone can message it. In App mode only senders listed in `allowFrom` reach the agent. Everyone else is dropped silently: nothing is sent back to them.

- **Phone numbers** can be written in any format. They are compared by digits only, so `+55 (11) 99999-0000` matches `5511999990000`
- **WhatsApp user IDs** (BSUIDs, for example `US.13491208655302741918`) are entries that contain a `.`. They are compared exactly against the sender's user ID and parent user ID
- An entry can also hold several senders separated by `,` or `;`
- An empty or missing `allowFrom` drops every message. The channel still connects, logs a warning once, and shows `No trusted senders configured (allowFrom)` in its status
- `allowFrom` is read again for each incoming message, so changes apply without restarting

To find the ids of a sender you want to trust, ask them to send a message and read the drop log line:

```
pipes-bot-channel: dropping message from untrusted sender phone=5511999990000 user_id=US.13491208655302741918 -- add one of these to allowFrom to trust them
```

Either value works in `allowFrom`. A `-` means that id was not provided, for example no phone when the user has not shared their number.

### App mode behavior

- Echoes (messages you send from the WhatsApp Business app) and delivery statuses never reach the agent
- Trusted App senders are dispatched with `CommandAuthorized`, so they can run owner-level commands
- Inbound media needs a PipesBot server that accepts `ak_` keys on media download (pipes-bot#72). Without it, the download fails and the message continues as text only
- If your App has a webhook URL, events received while the plugin is offline go to the webhook only and are not replayed to the plugin
- Reply failures (for example the 24-hour WhatsApp messaging window having expired) are reported back to the agent as a system event

## Architecture

```
index.ts                 Plugin entry point — registers channel + service
src/
  channel.ts             Channel plugin definition (config, mode, setup, status)
  service.ts             Service lifecycle — connects WebSocket, hands frames to the router
  connection.ts          WebSocket client with heartbeat + exponential backoff reconnection
  router.ts              Routes frames by type, dedupes, applies the trusted-sender gate, dispatches
  trust.ts               Trusted-sender matching (phone digits, BSUIDs) for App mode
  dedupe.ts              Bounded TTL set used to drop repeated messages and events
  inbound-message.ts     Protocol-agnostic InboundMessage type shared by both adapters
  adapters/
    legacy.ts            Sandbox whatsapp_message frame -> InboundMessage
    v2.ts                API v2 event envelope -> InboundMessage[] + failed send statuses
  inbound.ts             Inbound pipeline (media, routing, session, dispatch to the agent)
  outbound.ts            Sandbox reply tracking + reply_status handling
  outbound-v2.ts         API v2 send frames, send_result and failed-status handling
  media.ts               Media download via PipesBot API (follows R2 redirects)
  types.ts               TypeScript types and type guards for PipesBot frames
  config-schema.ts       Zod schema for channel config
  runtime.ts             Singleton runtime context
  status-store.ts        In-memory connection status state
```

### Message flow

1. **WebSocket connection** — `PipesBotConnection` connects to `wss://api.pipes.bot/ws` with the API key, maintains a ping/pong heartbeat (25s interval), and reconnects with exponential backoff (1s-2min cap) on transient failures.

2. **Frame routing** — `createFrameRouter()` routes each frame by type:

   | Frame | Handling |
   |-------|----------|
   | `whatsapp_message` | Legacy adapter, then `handleInbound()` |
   | `event` | App mode only: v2 adapter, then `handleInbound()` per message. Ignored with a `pk_` key |
   | `reply_status` | `handleReplyStatus()` (sandbox replies) |
   | `send_result` | `V2Outbound.handleSendResult()` (App replies) |
   | `connected` | Logs scope, auth type and app id |

   Repeated messages are dropped: legacy frames by message id, v2 events by envelope id, message id and failed-status id (10-minute window).

3. **Trusted-sender gate (App mode)** — Before anything is downloaded, a message is dropped if it is for another `poolNumberId`, if `allowFrom` is empty, or if the sender is not in `allowFrom`. Sandbox messages skip the gate.

4. **Inbound processing** — `handleInbound()` downloads media if present, converts contacts to vCard, normalizes location data, resolves the agent route, records the session, and dispatches to the agent pipeline.

5. **Agent dispatch** — The agent processes the message and produces a reply. The reply goes back through the WebSocket as a `whatsapp_reply` message (sandbox) or a v2 `send` frame (App).

6. **Reply tracking** — Sandbox replies are tracked with a 30s TTL for correlation with `reply_status` events. App sends are tracked by request id (30s) and then by WhatsApp message id (24h), so both `send_result` errors and later `failed` statuses reach the right session. Failures are classified (for example the expired 24-hour window or `RATE_LIMITED`) and surfaced as agent-facing system events.

### Connection resilience

- **Auth failures** (401/403) stop reconnection permanently
- **API version change** (close code 4000, when the App is upgraded to API v2) reconnects immediately, without backoff
- **Transient failures** trigger exponential backoff with jitter
- **Pong timeout** (50s) terminates dead connections to trigger reconnect
- **Graceful disconnect** tears down timers and WebSocket cleanly

## Development

```bash
# Run the tests
npm test

# Type-check
npx tsc --noEmit
```

## License

MIT
