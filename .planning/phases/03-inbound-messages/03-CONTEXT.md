# Phase 3: Inbound Messages - Context

**Gathered:** 2026-02-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Receive all WhatsApp message types from PipesBot via WebSocket, normalize them into OpenClaw's `WebInboundMessage` contract, and dispatch to the agent pipeline with full sender context. Also wire up reply/sendMedia/sendComposing callbacks so agents can respond immediately. No group support (PipesBot/WhatsApp API doesn't support groups). Delivery status tracking is Phase 4.

</domain>

<decisions>
## Implementation Decisions

### Media handling
- Download media locally to OpenClaw's media directory (don't pass R2 URLs through)
- No media size limit — trust PipesBot's upstream constraints
- Voice notes treated as audio media (download file, no transcription)
- PipesBot provides Cloudflare R2 URLs with 48-hour TTL; plugin downloads before dispatching

### Message normalization
- Stickers → download as image media (mediaType: image/webp)
- Contact cards (vCards) → save as .vcf file, set as media attachment
- Reactions → dispatch as regular messages with emoji in Body, reacted-to message ID in replyToId
- Location → populate NormalizedLocation object (lat/lng only), Body stays empty
- Body field for non-text media: use caption if available, otherwise empty string

### Session scoping
- SessionKey = `accountId:conversationId` (composite key for multi-account uniqueness)
- conversationId comes from PipesBot, not derived from phone numbers
- No group handling needed — PipesBot only delivers DM conversations

### Message envelope
- Populate sender fields with whatever PipesBot provides (from, pushName) — no E.164 parsing or transformation
- sendComposing() callback implemented — sends typing indicator back to WhatsApp user
- reply() and sendMedia() callbacks wired up in this phase (not deferred to Phase 4)
- Timestamps use whatever format PipesBot provides

### Claude's Discretion
- Exact media download implementation (streaming, temp files, error handling)
- How to structure the message parsing/dispatch pipeline internally
- Error handling for malformed messages or failed media downloads
- How to populate fields PipesBot doesn't provide (reasonable defaults)

</decisions>

<specifics>
## Specific Ideas

- "The way to connect with PipesBot is using the conversationId" — conversationId is the primary session identifier from PipesBot, not phone numbers or JIDs
- Reply/sendMedia callbacks wired early so agents get end-to-end functionality after this phase

</specifics>

<deferred>
## Deferred Ideas

- Voice note transcription — could be a future enhancement
- Group message support — blocked by WhatsApp API/PipesBot limitations
- Delivery status tracking — Phase 4

</deferred>

---

*Phase: 03-inbound-messages*
*Context gathered: 2026-02-17*
