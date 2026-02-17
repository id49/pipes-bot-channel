# Phase 4: Outbound and Status - Context

**Gathered:** 2026-02-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Send agent replies back through WhatsApp via PipesBot WebSocket and surface delivery status. Agents can reply with text and all media types. Delivery confirmations and failures are tracked, correlated, and surfaced. Dashboard shows connection health per account.

</domain>

<decisions>
## Implementation Decisions

### Reply content types
- All media types supported: text, images, audio, video, documents — match what inbound supports
- WhatsApp formatting supported in text replies (*bold*, _italic_, ```code```, lists)
- One message per reply call — no multi-part replies
- Media attachment method: Claude's discretion (based on OpenClaw reply patterns and PipesBot protocol)

### Delivery status surfacing
- Successful deliveries: log only, no UI indicator
- Failures: log AND return error to agent so it can respond
- Fire-and-forget sending: reply returns immediately, reply_status arrives async
- Async failure events: log AND emit OpenClaw event for other systems to react
- Correlate reply_status events back to original messages by tracking message IDs
- Status TTL for pending message IDs: Claude's discretion
- Typed error reasons: parse and categorize known PipesBot errors (WINDOW_EXPIRED, RATE_LIMITED, INVALID_NUMBER, etc.) into distinct failure types
- SERVICE_WINDOW_EXPIRED message is agent-facing: human-readable text the agent can relay to the user explaining the 24-hour window constraint

### Connection health display
- Simple connected/disconnected binary status per account
- Reconnecting counts as disconnected (two states, not three)
- Auth failures (invalid key, revoked access) show as distinct error state — separate from transient disconnect
- How status is exposed to dashboard: Claude's discretion (based on OpenClaw channel status patterns)

### Error & failure behavior
- No message queuing: if WebSocket is disconnected when agent sends, fail immediately
- Retry behavior on transient failures: Claude's discretion
- Error messages just report failure — no retry hints or guidance
- Validate reply payload before sending (check media exists, message not empty) — reject obviously bad messages locally before hitting PipesBot

### Claude's Discretion
- Media attachment method (file path, URL, or buffer — based on OpenClaw patterns)
- Status TTL for pending message correlation
- Reply retry strategy for transient failures
- Dashboard status exposure mechanism
- Exact typed error categories (based on what PipesBot actually returns)

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-outbound-and-status*
*Context gathered: 2026-02-17*
