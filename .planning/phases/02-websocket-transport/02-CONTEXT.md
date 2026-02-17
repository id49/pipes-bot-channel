# Phase 2: WebSocket Transport - Context

**Gathered:** 2026-02-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Persistent WebSocket connection to PipesBot with automatic reconnection, heartbeat detection, and clean teardown. This phase delivers the transport layer — no message parsing or routing (Phase 3), no outbound replies (Phase 4).

</domain>

<decisions>
## Implementation Decisions

### Reconnection strategy
- Max backoff delay: 2 minutes between reconnection attempts
- Backoff resets immediately on successful reconnect (no decay)
- Always re-handshake on new connection — send auth + init every time, don't assume server remembers session

### Error classification
- Auth failure (invalid/revoked API key): stop reconnection immediately, surface error to OpenClaw
- Unknown/unexpected close codes: treat as transient, attempt reconnection
- WhatsApp session issues (phone logged out, QR expired): same handling as network errors — PipesBot manages WhatsApp session state, plugin just reconnects
- Researcher should investigate PipesBot's specific close codes and error messages to build the transient/permanent mapping

### Connection health reporting
- Expose both events and queryable status
- 3-state model: connected, disconnected, reconnecting
- No metrics tracking (no attempt counts, uptime, etc.) — just current state
- Phase 4 consumes the state for dashboard display; Phase 2 just exposes it

### Logging & observability
- Use OpenClaw's built-in logger — consistent with other channel plugins
- Minimal by default: only log errors and state changes (connected, disconnected) in normal operation
- Log each reconnection attempt individually (e.g., "Reconnect attempt 3, next in 8s")
- Never log API keys — not even masked/partial keys

### Claude's Discretion
- Retry strategy (forever vs limited) — Claude picks based on transport layer best practices
- Exact backoff algorithm (exponential, jitter, etc.)
- Heartbeat/ping timeout handling details
- Internal connection state machine design

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

*Phase: 02-websocket-transport*
*Context gathered: 2026-02-17*
