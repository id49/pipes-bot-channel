# Feature Research

**Domain:** OpenClaw channel plugin — WhatsApp via PipesBot WebSocket
**Researched:** 2026-02-17
**Confidence:** HIGH (meta/capabilities/config/outbound interface); MEDIUM (optional adapter signatures); LOW (group chat via Cloud API)

---

## Context: This Plugin vs the Native WhatsApp Channel

OpenClaw ships a built-in WhatsApp channel based on the Baileys library (WhatsApp Web reverse-engineering). This plugin is not that. It is a **separate channel** that routes through PipesBot, which uses Meta's official WhatsApp Cloud API. The two channels coexist. Knowing what Baileys does is the baseline for understanding what PipesBot must match, exceed, or honestly fall short of.

**Where PipesBot wins over Baileys:**
- No session management (no QR code, no `~/.openclaw/whatsapp-sessions/`)
- No account ban risk (official Cloud API, not reverse-engineered protocol)
- Offline message queuing (100 messages, up to ~15 minutes offline)
- Works behind NAT/firewalls with no exposed ports
- Managed infra (PipesBot handles reconnects, pings, authentication)

**Where PipesBot trails Baileys:**
- 24h service window is enforced (Baileys has none; personal numbers bypass it)
- Group chat is Cloud API-constrained (Baileys supports any group natively)
- Sending reactions is not in the Cloud API's standard free-tier feature set
- Media upload from agent to WhatsApp is not in v1 scope (Baileys supports full outbound media)
- Pool numbers, not personal numbers (different user mental model)

These tradeoffs directly shape which features are table stakes, which are differentiators, and which are anti-features.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these makes the plugin feel broken or incomplete for a WhatsApp integration.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Text inbound | WhatsApp is primarily text. Receiving text is the primitive everything else builds on. | LOW | PipesBot `whatsapp_message` type `text`. Required from day 1. |
| Text outbound (reply) | Agent must respond. A read-only channel is not useful. | LOW | `whatsapp_reply` via WebSocket. The `sendText()` adapter. Core loop. |
| Delivery status surfacing | Users need to know if a message failed to send. WhatsApp's `SERVICE_WINDOW_EXPIRED` is a hard error that must be communicated. | LOW | `reply_status` WebSocket messages. Map errors to OpenClaw error surface. Failing silently is a bug. |
| Image inbound | WhatsApp users send photos constantly. Dropping images silently creates confusing conversations. | MEDIUM | PipesBot provides Cloudflare R2 URL (48h TTL). Pass URL through to agent; do not download to disk. |
| Audio inbound | Voice notes are a primary WhatsApp communication mode, especially on mobile. | MEDIUM | Same URL-passthrough pattern. Agent can transcribe via its own tools. |
| Document inbound | PDFs, spreadsheets, contracts — common business use case. | MEDIUM | URL passthrough. Agent tools handle extraction. |
| Video inbound | Video messages are common. Dropping them silently degrades UX. | MEDIUM | URL passthrough. |
| Sender identity in envelope | Agent needs to know who is speaking. Without sender info, context and personalization are impossible. | LOW | Map PipesBot `from` field to `SenderId`/`SenderName` in OpenClaw envelope. |
| Conversation context scoping | Each sender gets an isolated agent session. Cross-user context leakage is a correctness bug. | LOW | Session key construction: `agent:{id}:pipesbot:{accountId}:{from}`. Standard OpenClaw pattern. |
| API key configuration | Users must be able to provide their PipesBot `pk_` key. Without this the plugin cannot connect. | LOW | `channels.pipesbot.accounts.<id>.apiKey` in `openclaw.json`. Validated at startup. |
| Automatic reconnection | WebSocket connections drop. Without reconnection, the channel goes dark silently. | MEDIUM | Exponential backoff. PipesBot pings every 25s — detect missed pings, reconnect. Standard WS resilience. |
| Plugin installs cleanly via npm | Extension channels distribute via npm. Installation must be one command. | LOW | `openclaw plugins install @pipes-bot/openclaw-channel` or equivalent. Proper `package.json` manifest. |

### Differentiators (Competitive Advantage)

Features that set this plugin apart. Not universally expected, but valued by the target audience.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| 24h service window awareness | PipesBot enforces this; Baileys does not. Surfacing it explicitly (logging, error message to agent, config-visible) helps users understand why a reply failed rather than silently failing or timing out. | LOW | Check `reply_status` for `SERVICE_WINDOW_EXPIRED`. Surface it as a structured error, not a generic failure. Potential: expose `lastMessageAt` timestamp on conversation state for agent awareness. |
| Sticker inbound | Sticker messages are distinct from images in WhatsApp. Most integrations silently drop them or handle them as images. Handling them explicitly (even just as a text placeholder) is a small but visible quality signal. | LOW | `type: sticker` in PipesBot messages. Map to `[sticker]` placeholder or pass URL through. |
| Location inbound | Location sharing is a meaningful WhatsApp use case (meeting spots, delivery addresses, field reports). Few integrations handle it. | LOW | `type: location` with lat/lng/name. Normalize to text in envelope: `[location: Name, lat, lng]`. Agent can then use it. |
| Contacts inbound | WhatsApp contact cards (vCards) are used for referrals. Normalizing them to text makes them agent-readable. | LOW | `type: contacts`. Format as `[contact: Name, +Phone]`. |
| Reaction inbound | WhatsApp users react to messages to acknowledge or respond. Receiving reactions and surfacing them to the agent (e.g., as confirmation signals) is a differentiator. | LOW | `type: reaction` in PipesBot. Map to agent-readable format; don't silently discard. |
| Offline message queuing transparency | PipesBot queues up to 100 messages during disconnect. Surfacing queue state (or at minimum not losing messages on reconnect) is a reliability differentiator vs rolling your own WS client. | MEDIUM | Handled by PipesBot, but the plugin must correctly drain the queue on reconnect without duplicate processing. Deduplication by message ID. |
| Friendly service window config hint | When `SERVICE_WINDOW_EXPIRED`, show a human-readable explanation in the OpenClaw status surface. Newcomers don't know what the 24h window is; context saves support tickets. | LOW | Implementation: status adapter message on error type. |
| Connection scoping flexibility (future) | PipesBot supports both user-scoped and conversation-scoped connections. Conversation scoping means one WS per active chat, which is better for high-volume deployments. v1 uses user scope, but the architecture should not prevent v2 from adding conversation scope. | HIGH | Do not hard-code user-scope assumptions into the message routing layer. Keep scope as a config parameter even if only user scope is wired in v1. |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem reasonable but create disproportionate complexity, surface bugs, or set incorrect expectations.

| Anti-Feature | Why Requested | Why Problematic | Alternative |
|--------------|---------------|-----------------|-------------|
| Sending media outbound (images, files) | Agents generate images; users want rich replies. | WhatsApp Cloud API requires pre-uploading media to Meta servers before sending. This adds an async upload step, a separate API credential, failure modes, and file size enforcement. Builds a second integration surface beyond the PipesBot WebSocket. Out of scope for v1. | Text-only outbound for v1. Add media outbound as a v2 feature once the core loop is stable. Document the limitation clearly in plugin config blurb. |
| Group chat support | WhatsApp group chats are common; users want the bot in groups. | WhatsApp Cloud API (which PipesBot uses) has additional restrictions on group messaging compared to Baileys/WhatsApp Web. PipesBot's current public docs do not advertise group chat support. Attempting group support on an unsupported substrate causes confusing failures. | Explicitly declare `chatTypes: ["direct"]` in capabilities. Document that group support requires Baileys-based channel, not PipesBot. Revisit if PipesBot adds group support. |
| REST API fallback for sending | More robust if WebSocket drops; belt-and-suspenders. | PipesBot provides a REST send API, but adding it requires a second code path, different auth handling, and increased surface area. The WebSocket channel already handles reconnection. Two paths for the same thing creates inconsistency and maintenance cost. | Single WebSocket path. Solid reconnection logic (exponential backoff + ping monitoring) makes the REST fallback unnecessary. |
| Webhook delivery mode | Users familiar with other WhatsApp integrations may expect this. | PipesBot supports webhooks for n8n/Make/Zapier, but OpenClaw is a persistent process — WebSocket is the correct mode. Webhooks require an exposed HTTP endpoint, defeating PipesBot's NAT-traversal value proposition. | WebSocket-only. Document this as a feature (no public port needed). |
| App-scoped (`ak_`) key support | Some users have app keys from PipesBot's multi-tenant tier. | App-scoped keys route messages differently and require tenant-resolution logic not present in OpenClaw's standard per-account model. Adds auth complexity for an edge case. | User-scoped `pk_` keys only for v1. Document `ak_` as out of scope. |
| Typing indicators (sent to WhatsApp user) | Feels polished; Baileys channel does this. | WhatsApp Cloud API does not support sending typing indicators to end users. Attempting to fake this would require unsupported API calls that may fail silently or cause errors. | Omit. The `streaming` adapter in OpenClaw is optional. Leave it unimplemented. Document why. |
| Read receipts (sent to WhatsApp user) | Baileys does this; users may expect parity. | WhatsApp Cloud API read receipts are sent automatically by Meta's infrastructure; the plugin cannot suppress or control them. Do not implement an explicit read-receipt adapter — it's either handled for you or impossible. | Treat as managed by PipesBot/Cloud API. No implementation needed. |
| Per-message ACK reactions | Baileys channel sends an emoji reaction to acknowledge receipt before replying. Polished UX. | Cloud API reaction sending requires a dedicated API call. Not in the PipesBot WebSocket protocol for v1. Adds complexity without clear user demand. | Omit. The acknowledgment is implicit in the reply delivery. |

---

## Feature Dependencies

```
[API key config]
    └──required by──> [WebSocket connection]
                          └──required by──> [Text inbound]
                          └──required by──> [Media inbound (all types)]
                          └──required by──> [Delivery status surfacing]

[Text inbound]
    └──required by──> [Text outbound / sendText()]
                          └──required by──> [Delivery status surfacing]

[Sender identity in envelope]
    └──required by──> [Conversation context scoping]

[Automatic reconnection]
    └──enhances──> [Offline message queuing transparency]

[Delivery status surfacing]
    └──enhances──> [24h service window awareness]

[Conversation context scoping]
    └──enables (future)──> [Connection scoping flexibility]
```

### Dependency Notes

- **API key config requires WebSocket connection**: No key, no connection. Validation at init prevents silent failures.
- **Text inbound requires sendText()**: OpenClaw routes inbound to an agent session; the session's reply path must exist.
- **Delivery status surfacing requires sendText()**: You only have delivery status if you sent something.
- **Automatic reconnection enhances offline queuing**: PipesBot queues messages, but the plugin must reconnect to receive them. These are separate concerns that compose.
- **Delivery status enhances service window awareness**: `SERVICE_WINDOW_EXPIRED` is a delivery status code. The service window feature is built on top of delivery status, not alongside it.
- **Conversation context scoping enables future connection scoping**: If session keys are built cleanly (accountId + sender), switching from user-scoped to conversation-scoped WS connections is a transport change, not a routing redesign.

---

## MVP Definition

### Launch With (v1)

Minimum viable product — what is needed to validate the concept.

- [ ] API key configuration in `openclaw.json` — without this nothing works
- [ ] WebSocket connection to PipesBot hub with automatic reconnection and ping handling — the transport layer
- [ ] Text inbound: receive and normalize `whatsapp_message` type `text` into OpenClaw envelope with sender identity and conversation scoping
- [ ] All media types inbound: image, audio, video, document, sticker, location, contacts, reaction — pass URL/normalized text through to agent, no download
- [ ] Text outbound: `sendText()` sends `whatsapp_reply` via WebSocket
- [ ] Delivery status: `reply_status` processed, errors (especially `SERVICE_WINDOW_EXPIRED`) surfaced as structured errors

### Add After Validation (v1.x)

Features to add once core is working and user feedback is gathered.

- [ ] Service window status in OpenClaw status adapter — trigger: users ask "why did my reply fail?"
- [ ] Connection scoping config parameter — trigger: high-volume deployments request it
- [ ] Improved envelope enrichment (normalize contacts, location to richer format) — trigger: agent tool usage shows gaps

### Future Consideration (v2+)

Features to defer until product-market fit is established.

- [ ] Outbound media sending — defer: requires Meta media upload API integration, second code path, significant scope increase
- [ ] Group chat support — defer: depends on PipesBot adding Cloud API group support; not in their current public offering
- [ ] App-scoped (`ak_`) key support — defer: multi-tenant routing complexity not needed for v1 use case

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| API key config | HIGH | LOW | P1 |
| WebSocket connection + reconnection | HIGH | MEDIUM | P1 |
| Text inbound | HIGH | LOW | P1 |
| Text outbound / sendText() | HIGH | LOW | P1 |
| Delivery status surfacing | HIGH | LOW | P1 |
| Image inbound | HIGH | LOW | P1 |
| Audio inbound | HIGH | LOW | P1 |
| Document inbound | HIGH | LOW | P1 |
| Video inbound | MEDIUM | LOW | P1 |
| Sticker inbound | LOW | LOW | P1 (low cost — bundle with media pass-through) |
| Location inbound | MEDIUM | LOW | P1 (low cost — normalize to text) |
| Contacts inbound | LOW | LOW | P1 (low cost — normalize to text) |
| Reaction inbound | LOW | LOW | P1 (low cost — don't discard) |
| 24h service window awareness | HIGH | LOW | P2 |
| Offline queue deduplication | MEDIUM | MEDIUM | P2 |
| Outbound media sending | HIGH | HIGH | P3 |
| Group chat | HIGH | HIGH | P3 |
| Connection scoping flexibility | MEDIUM | HIGH | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

---

## Competitor Feature Analysis

The most direct comparison is OpenClaw's native Baileys-based WhatsApp channel, since users choosing this plugin are giving up Baileys.

| Feature | Baileys (native) | This Plugin (PipesBot) |
|---------|-----------------|------------------------|
| Auth model | QR code, session files | API key (pk_) |
| Session persistence | Self-managed, failure-prone | Managed by PipesBot |
| Ban risk | High (unofficial protocol) | None (official Cloud API) |
| Service window | None (personal number bypass) | 24h enforced |
| Group chat | Full native support | Not supported (Cloud API limits) |
| Text inbound/outbound | Yes | Yes |
| Media inbound | Yes (download to local store) | Yes (URL passthrough, 48h TTL) |
| Media outbound | Yes | Not in v1 |
| Reactions (send) | Yes | No (Cloud API limitation) |
| Reactions (receive) | Yes | Yes |
| Typing indicators | Yes (send + receive) | Receive only (Cloud API) |
| Read receipts | Send + receive | Cloud API managed (no plugin control) |
| Threading | Yes | No (Cloud API direct messages only) |
| Multi-account | Yes | Yes (multiple accounts config) |
| Offline queuing | No | Yes (PipesBot queues 100 messages) |
| NAT traversal | Outbound WS (Baileys) | Outbound WS (PipesBot) |

**Our approach:** Lean into the reliability and compliance wins (no ban risk, no session management, offline queuing). Be transparent about the service window and group chat gaps. Don't try to fake Baileys features on a Cloud API substrate.

---

## Sources

- OpenClaw WhatsApp channel docs (official): https://docs.openclaw.ai/channels/whatsapp — HIGH confidence
- OpenClaw DeepWiki channel overview: https://deepwiki.com/openclaw/openclaw/8-channels — HIGH confidence
- OpenClaw DeepWiki WhatsApp integration: https://deepwiki.com/openclaw/openclaw/8.4-whatsapp-integration — HIGH confidence (Baileys capabilities baseline)
- OpenClaw DeepWiki extensions and plugins: https://deepwiki.com/openclaw/openclaw/10-extensions-and-plugins — HIGH confidence
- OpenClaw DeepWiki creating custom plugins: https://deepwiki.com/openclaw/openclaw/10.3-creating-custom-plugins — MEDIUM confidence (interface, not complete types)
- OpenClaw DeepWiki channel message flow: https://deepwiki.com/openclaw/openclaw/8.3-channel-message-flow — HIGH confidence
- OpenClaw channel routing and access control: https://deepwiki.com/openclaw/openclaw/8.1-channel-routing-and-access-control — HIGH confidence
- Building an OpenClaw channel plugin (step-by-step guide): https://wemble.com/2026/01/31/building-an-openclaw-plugin.html — MEDIUM confidence
- OpenClaw DingTalk plugin (reference implementation): https://github.com/soimy/openclaw-channel-dingtalk — MEDIUM confidence
- OpenClaw Feishu plugin (reference implementation): https://github.com/ogromwang/openclaw-feishu — MEDIUM confidence
- WeCom channel plugin PR: https://github.com/openclaw/openclaw/pull/13228 — MEDIUM confidence
- PipesBot homepage (features/pricing/capabilities): https://www.pipes.bot/ — HIGH confidence
- WhatsApp Business API feature set 2026: https://www.unipile.com/whatsapp-api-a-complete-guide-to-integration/ — MEDIUM confidence

---
*Feature research for: OpenClaw channel plugin — WhatsApp via PipesBot WebSocket*
*Researched: 2026-02-17*
