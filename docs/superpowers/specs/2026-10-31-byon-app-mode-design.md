# BYON App mode (API v2) with trusted senders

Date: 2026-10-31
Status: Approved design, pending spec review

## Goal

Let the OpenClaw channel run on a BYON number through a PipesBot App key (`ak_`, API v2), not only on a sandbox number (`pk_`).

On a sandbox number, the pool number activation already binds one trusted sender. A BYON number is a real business number, and anyone can message it. In App mode the channel must therefore decide itself who is trusted: only senders on an allowlist reach the agent.

## Scope

In scope:

- App mode, selected by an `ak_` key, speaking the API v2 WebSocket protocol (`event`, `send`, `send_result`)
- Trusted-sender allowlist (`allowFrom`) for App mode, failing closed
- Optional `poolNumberId` filter for Apps with several numbers
- Inbound text, media, location, contacts, reactions and interactive replies on v2
- Text replies on v2, with failure reporting to the agent
- Event dedupe
- Test runner (vitest) and tests for the new code
- README and version bump (0.2.0)

Out of scope:

- Server change for media download with `ak_` keys: tracked in [id49/pipes-bot#71](https://github.com/id49/pipes-bot/issues/71). The plugin depends on it for inbound media in App mode (see Dependencies)
- Sandbox behavior changes: `pk_` mode stays exactly as it is today
- OpenClaw pairing flow, `dmPolicy` setting and access groups
- Legacy (non-v2) Apps as a supported target. They may work through the legacy path (see Frame routing), but they are not tested
- Outbound media, templates, typing indicators, message chunking
- OpenClaw SDK upgrade (the devDependency stays at the current version)
- Public docs page `/docs/openclaw-plugin` in pipes-bot-docs (follow-up)

## Decisions

| Question | Decision |
| --- | --- |
| How is App mode selected? | By key prefix: `pk_` = sandbox, `ak_` = App mode. No mode setting |
| Who is trusted in App mode? | Senders whose phone number or BSUID is in `allowFrom`. Everyone else is silently dropped |
| Empty `allowFrom` in App mode? | Fail closed: connect, deliver nothing, warn in logs and status |
| Sandbox gating? | None, unchanged |
| Several numbers in one App? | Connect app-wide; optional `poolNumberId` filter on the client |
| Owner-level actions | Trusted App-mode senders get `CommandAuthorized: true` |
| Architecture | One protocol-agnostic inbound pipeline fed by two adapters (legacy and v2) |
| Media with `ak_` | Fixed server-side (pipes-bot#71); the plugin degrades to text-only if download fails |

## Configuration

`src/config-schema.ts`:

```ts
export const PipesBotConfigSchema = z.object({
  enabled: z.boolean().optional(),
  apiKey: z.string().optional(),          // pk_... (sandbox) or ak_... (App, API v2)
  allowFrom: z.array(z.string()).optional(), // App mode: trusted phone numbers and/or BSUIDs
  poolNumberId: z.string().optional(),       // App mode: only handle this BYON number
});
```

- `resolveApiKey` accepts keys that start with `pk_` or `ak_`. A new `resolveMode(apiKey)` returns `"sandbox"` or `"app"`.
- `allowFrom` and `poolNumberId` are ignored in sandbox mode.
- UI hints: the `apiKey` placeholder and help mention both prefixes. `allowFrom` help: "Phone numbers (any format) or WhatsApp user IDs (CC.…) allowed to talk to the agent in App mode". `poolNumberId` help: "Only answer on this BYON number (pn_…). Leave empty for all numbers in the App".
- `setup.applyAccountConfig` keeps accepting `apiKey`.

## Architecture

```
PipesBotConnection (unchanged transport: heartbeat, backoff)
        │ frames
        ▼
service.ts ── routes by frame type ─────────────────────────────┐
   │                                                            │
   ├─ whatsapp_message ──► adapters/legacy.ts ─┐                │
   ├─ event ─────────────► adapters/v2.ts ─────┤ InboundMessage │
   │                                           ▼                │
   │                         trust.ts (gate, App mode only)     │
   │                                           ▼                │
   │                         inbound.ts (OpenClaw dispatch)     │
   │                                           │ reply(text)    │
   │                                           ▼                │
   ├─ reply_status ──► outbound.ts (legacy, unchanged)          │
   └─ send_result ───► outbound-v2.ts ◄── send frames ──────────┘
                       (also fed by v2 "failed" status events)
dedupe.ts sits in front of both adapters.
```

### Units

| File | Purpose | Depends on |
| --- | --- | --- |
| `src/inbound-message.ts` | The `InboundMessage` type shared by both adapters | — |
| `src/adapters/legacy.ts` | `whatsapp_message` frame → `InboundMessage` (pure) | types |
| `src/adapters/v2.ts` | v2 envelope → `InboundMessage[]` plus failed-status list (pure) | types |
| `src/trust.ts` | `isTrustedSender(senderIds, allowFrom)` and phone normalization (pure) | — |
| `src/dedupe.ts` | Bounded TTL set: `seen(id): boolean` | — |
| `src/outbound-v2.ts` | Builds `send` frames, tracks `requestId` and `wamid`, classifies failures, enqueues system events | runtime |
| `src/inbound.ts` | Takes an `InboundMessage` + `reply`, downloads media, builds the OpenClaw context, dispatches | runtime, media |
| `src/service.ts` | Wires connection → dedupe → adapter → gate → inbound; mode-aware | all of the above |

`inbound.ts` no longer parses PipesBot envelopes. Its current logic (route, session, `finalizeInboundContext`, `recordInboundSession`, `dispatchReplyWithBufferedBlockDispatcher`) stays the same, but reads from `InboundMessage` and calls `reply(text)` instead of building `whatsapp_reply` itself.

### `InboundMessage`

```ts
type InboundMessage = {
  messageId: string;            // wamid (v2) or PipesBot message id (legacy)
  poolNumberId: string;
  poolNumberPhone?: string;     // metadata.display_phone_number (v2) / poolNumberPhoneNumber (legacy)
  sender: {
    phone?: string;             // v2 messages[].from, legacy fromNumber
    userId?: string;            // v2 messages[].from_user_id (BSUID), legacy userId
    parentUserId?: string;      // v2 messages[].from_parent_user_id, legacy parentUserId
    name?: string;              // contacts[].profile.name, else profile.username
  };
  senderKey: string;            // userId ?? phone
  sessionKey: string;           // see Session keys
  peerId: string;               // routing peer id
  timestamp: number;            // ms
  type: "text" | "image" | "audio" | "video" | "document" | "sticker"
      | "location" | "contacts" | "reaction";
  body: string;
  media?: { downloadUrl: string; mimeType: string; fileName?: string };
  mediaUnavailable?: boolean;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: PipesBotContact[];
  replyToId?: string;           // reaction target
};
```

Legacy `fromNumber` holds a BSUID when the user hasn't shared their phone. The legacy adapter treats a `fromNumber` containing `.` as `userId`, not `phone`, and keeps `sessionKey = default:<conversationId>`.

The adapters return `null` (legacy) or skip (v2) for messages that must never reach the agent: `unsupported`, `system`, and reaction removals (no emoji).

## Frame routing

`service.ts` routes by frame `type`, not by key:

- `whatsapp_message` → legacy adapter
- `reply_status` → `outbound.ts` (unchanged)
- `event` → v2 adapter
- `send_result` → `outbound-v2.ts`
- `connected` → log `scope`, `authType`, `appId`
- anything else → debug log, ignored

The reply function given to `inbound.ts` depends on the frame that produced the message: `whatsapp_reply` for legacy, `send` for v2. A legacy App on an `ak_` key therefore goes through the legacy path with the trust gate applied. That is a side effect, not a supported target.

## v2 inbound

Only envelopes with `field === "messages"` produce messages. For each `whatsapp.messages[]` entry:

| Meta `type` | `InboundMessage` |
| --- | --- |
| `text` | `body = text.body` |
| `image`, `audio`, `video`, `document`, `sticker` | `body = <obj>.caption ?? ""`; `media` from `pipes.media[<obj>.id]`; `fileName` from `document.filename`; an entry with `unavailable: true` (or no entry) sets `mediaUnavailable` |
| `location` | `location = { latitude, longitude, name, address }`, `body = ""` |
| `contacts` | `contacts` mapped to the existing `PipesBotContact` shape (`name.formatted_name`, `phones[].phone/type`), `body = ""` |
| `reaction` | `body = reaction.emoji`, `replyToId = reaction.message_id`; skip if no emoji |
| `interactive` | `body = button_reply.title ?? list_reply.title`, `type = "text"` |
| `button` | `body = button.text`, `type = "text"` |
| `system`, `unsupported`, others | skipped |

The sender name comes from the `contacts[]` entry whose `user_id` or `wa_id` matches the message sender, falling back to the first contact.

Ignored with no agent delivery:

- `field === "smb_message_echoes"`: messages the business sent from the phone. Treating them as inbound would make the agent answer itself
- `whatsapp.statuses[]`, except `status === "failed"` for a `wamid` we sent (see Outbound)
- `message_template_status_update` and every other field

`timestamp` is Meta's Unix seconds string × 1000.

## Session keys

- Sandbox: `default:<conversationId>` (unchanged), peer id `conversationId`
- App mode: `default:<poolNumberId>:<senderKey>`, peer id `<poolNumberId>:<senderKey>`

The same person on two numbers gets two sessions. In App mode, `From` is `pipes-bot-channel:<senderKey>`, `To` is `pipes-bot-channel:<poolNumberPhone ?? poolNumberId>`, `OriginatingTo` is `pipes-bot-channel:<peerId>` and `SenderId` is `senderKey`. Sandbox keeps today's values (`fromNumber`, `poolNumberPhoneNumber`, `conversationId`).

## Trusted-sender gate

Runs in App mode only, after dedupe and before any media download, in this order:

1. **Number filter.** If `poolNumberId` is configured and differs from the message's number, drop (debug log).
2. **Empty allowlist.** If `allowFrom` is empty or missing, drop. Log a warning once per process start: `App mode has no trusted senders (allowFrom is empty) -- dropping all inbound messages`.
3. **Match.** Trusted if any of `sender.phone`, `sender.userId`, `sender.parentUserId` matches any `allowFrom` entry:
   - Entries that contain a `.` are BSUIDs, compared exactly after trimming (`CC.<id>`, `CC.ENT.<id>`)
   - Other entries are phone numbers, compared digits-only on both sides (`+55 (11) 99999-0000` = `5511999990000`). Entries with no digits are ignored
4. **Untrusted.** Drop silently. Nothing is sent to the sender. Info log: `dropping message from untrusted sender phone=<phone|-> user_id=<userId|-> -- add one of these to allowFrom to trust them`.

Trusted senders are dispatched with `CommandAuthorized: true`. Sandbox messages skip the gate and keep today's context (no `CommandAuthorized`).

## Outbound (v2)

`reply(text)` sends:

```json
{
  "type": "send",
  "requestId": "<crypto.randomUUID()>",
  "poolNumberId": "<message poolNumberId>",
  "message": {
    "messaging_product": "whatsapp",
    "recipient_type": "individual",
    "to": "<sender.phone>",
    "type": "text",
    "text": { "body": "<text>" }
  }
}
```

When the sender has no phone, `recipient: <sender.userId>` replaces `to`. If `connection.send` returns false, log a warning (as today).

Tracking in `outbound-v2.ts`:

- `pendingSends: Map<requestId, { sessionKey, expiresAt }>`, 30s TTL, lazy eviction (same pattern as `outbound.ts`)
- `sentMessages: Map<wamid, { sessionKey, expiresAt }>`, 24h TTL, capped at 1,000 entries (oldest evicted), filled from successful `send_result`

`send_result` handling:

- `success: true`: info log with `messageId`; move to `sentMessages`
- `success: false`: classify `error`, error log, and enqueue a system event on the pending session (if still tracked)

Failed status: a v2 `messages` envelope with `statuses[].status === "failed"` whose `id` is in `sentMessages` is classified from `statuses[].errors[0]` and enqueued on that session. Other statuses are ignored.

Classification (`error.code`):

| Code | Agent-facing message |
| --- | --- |
| `131047` (number) | `Unable to send reply: the 24-hour WhatsApp messaging window has expired. The contact must send a new message to reopen the conversation.` |
| other number | `Reply failed: Meta error <code>: <message or title>` |
| string (`NOT_FOUND`, `FORBIDDEN`, `REGISTRATION_PENDING`, `NO_CREDENTIALS`, `META_UNREACHABLE`, `META_INVALID_RESPONSE`, `META_ERROR`, `INTERNAL_ERROR`, `INVALID_REQUEST`, …) | `Reply failed: <code>: <message>` |
| missing | `Reply failed: <message ?? "unknown error">` |

System events use `core.system.enqueueSystemEvent(message, { sessionKey })`.

## Dedupe

`dedupe.ts` keeps a bounded set (10-minute TTL, 5,000 entries max, oldest evicted). For v2 events, the envelope `id` is checked first, then each message `wamid`, so a message delivered in two different envelopes is still handled once. Legacy frames are checked by `data.messageId`. Duplicates are dropped with a debug log.

## Connection and status

- `PipesBotConnection` keeps its behavior. `ak_` connections never send `poolNumberId` or `conversationId` query params, so the App offline queue drains on connect.
- A close with code `4000` (`api_version_changed`) resets the backoff and reconnects immediately (attempt 0).
- An HTTP 401/403 at upgrade still stops reconnecting. Status error copy: `Authentication failed -- check your API key (pk_ for sandbox, ak_ for a BYON App)`.
- The status snapshot adds `mode: "sandbox" | "app"`. In App mode with an empty `allowFrom`, `lastError` (when no other error is set) is `No trusted senders configured (allowFrom)`.

## Media

`downloadPipesBotMedia` is unchanged and called with the configured key. In App mode it depends on [id49/pipes-bot#71](https://github.com/id49/pipes-bot/issues/71). Until that ships, downloads fail with 401, the existing error path logs it, and the message continues text-only.

## Testing

Add `vitest` (devDependency) and `"test": "vitest run"`. Work test-first.

Fixtures: copy the v2 fixtures from pipes-bot-docs (`public/fixtures/byon-v2/*.json`) into `test/fixtures/byon-v2/`, plus hand-written envelopes for an echo, a reaction, location, contacts and an interactive reply, and a legacy `whatsapp_message` frame.

Unit tests:

- `adapters/v2`: text; image with `pipes.media` hit, miss and `unavailable`; BSUID-only sender (`recipient` path, `senderKey` = BSUID); username with phone; parent BSUID; contact request; system messages skipped; echoes skipped; template status ignored; failed status surfaced; delivered status ignored; reaction with and without emoji; interactive and button replies
- `adapters/legacy`: current frame shapes map to the same `InboundMessage` fields today's code reads
- `trust`: phone formats, BSUID exact match, parent BSUID, no match, empty list, entries without digits
- `outbound-v2`: frame shape for phone and BSUID recipients; `send_result` success and failure; numeric 131047; other numeric; string codes; missing code; expired pending entry produces no event; failed status matched by `wamid`
- `dedupe`: repeat id, TTL expiry, size cap

Pipeline tests (stubbed OpenClaw runtime):

- App mode, trusted sender: dispatched with `CommandAuthorized: true` and the App session key; the reply produces a `send` frame
- App mode, untrusted sender: not dispatched, no media fetch, nothing sent
- App mode, other `poolNumberId`: not dispatched
- App mode, empty `allowFrom`: not dispatched, warning logged once
- Sandbox: context identical to today's (no `CommandAuthorized`, `default:<conversationId>`), reply produces `whatsapp_reply`

`npx tsc --noEmit` must stay clean.

Manual end-to-end check after pipes-bot#71 is deployed: a real v2 App and number, a trusted phone (text, image, reply), an untrusted phone (no reply, log line with ids), and an echo from the WhatsApp Business app (ignored).

## Release

- Version `0.2.0`
- README: App mode setup (`ak_`), `allowFrom` (phone and BSUID formats, how to read a sender's ids from the drop log), `poolNumberId`, echoes ignored, media dependency on the server fix, updated architecture section
- `package.json` description: "WhatsApp channel via PipesBot (sandbox numbers and BYON Apps)"

## Dependencies

- [id49/pipes-bot#71](https://github.com/id49/pipes-bot/issues/71): media download with `ak_` keys. Needed for inbound media in App mode. Not needed for text, and does not block shipping the plugin.
