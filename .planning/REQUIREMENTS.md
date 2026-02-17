# Requirements: PipesBot OpenClaw Channel Plugin

**Defined:** 2026-02-17
**Core Value:** WhatsApp messages flow seamlessly through PipesBot into OpenClaw's agent system, and replies flow back -- with full media support and reliable reconnection.

## v1 Requirements

### Plugin Infrastructure

- [x] **INFRA-01**: Plugin registers as an OpenClaw channel via `openclaw.plugin.json` manifest with correct channel ID
- [x] **INFRA-02**: Plugin accepts PipesBot API key (`pk_`) configuration via OpenClaw's config system (`openclaw.json`)
- [x] **INFRA-03**: Plugin installs cleanly via `openclaw plugins install` as an npm package
- [x] **INFRA-04**: Plugin implements gateway lifecycle (start/stop) with clean teardown of all resources

### WebSocket Transport

- [ ] **WS-01**: WebSocket client connects to PipesBot hub using `pk_` API key authentication
- [ ] **WS-02**: Automatic reconnection with exponential backoff and jitter on transient disconnects
- [ ] **WS-03**: Ping/pong heartbeat monitoring detects silent dead connections (no ping within 75s triggers reconnect)
- [ ] **WS-04**: Close code classification distinguishes transient failures (retry) from permanent failures (stop)

### Inbound Messages

- [ ] **IN-01**: Text messages received and dispatched to OpenClaw agent pipeline with sender info and conversation context
- [ ] **IN-02**: Media messages (image, audio, video, document) received with download URL passthrough and 48h TTL metadata
- [ ] **IN-03**: Special message types (sticker, location, contacts, reaction) received and normalized for agent consumption
- [ ] **IN-04**: Sender identity (phone number, push name) and conversation context preserved in dispatched messages

### Outbound Messages

- [ ] **OUT-01**: Agent text replies sent back via WebSocket `whatsapp_reply` message format
- [ ] **OUT-02**: Delivery status confirmations (`reply_status`) processed and surfaced to OpenClaw
- [ ] **OUT-03**: `SERVICE_WINDOW_EXPIRED` errors surfaced with human-readable messaging
- [ ] **OUT-04**: Health monitoring adapter reports connection status to OpenClaw dashboard

## v2 Requirements

### Media Outbound

- **MEDIA-01**: Agent can send image attachments to WhatsApp via media upload API
- **MEDIA-02**: Agent can send document attachments to WhatsApp

### Multi-tenant

- **MULTI-01**: App-scoped (`ak_`) key support for multi-tenant deployments
- **MULTI-02**: Conversation-scoped connections for high-volume deployments

## Out of Scope

| Feature | Reason |
|---------|--------|
| App-scoped (`ak_`) key support | Multi-tenant routing complexity; `pk_` covers primary use case |
| REST API fallback for sending | Single WS connection handles both directions; simpler architecture |
| Media upload from OpenClaw to WhatsApp | Requires Meta media upload API -- separate integration surface |
| Webhook delivery mode | WebSocket-only for v1 |
| Conversation-scoped connections | Full user scope only; high-volume optimization deferred |
| Group chat support | Not in PipesBot's current Cloud API offering |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | Phase 1 | Complete |
| INFRA-02 | Phase 1 | Complete |
| INFRA-03 | Phase 1 | Complete |
| INFRA-04 | Phase 1 | Complete |
| WS-01 | Phase 2 | Pending |
| WS-02 | Phase 2 | Pending |
| WS-03 | Phase 2 | Pending |
| WS-04 | Phase 2 | Pending |
| IN-01 | Phase 3 | Pending |
| IN-02 | Phase 3 | Pending |
| IN-03 | Phase 3 | Pending |
| IN-04 | Phase 3 | Pending |
| OUT-01 | Phase 4 | Pending |
| OUT-02 | Phase 4 | Pending |
| OUT-03 | Phase 4 | Pending |
| OUT-04 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 16 total
- Mapped to phases: 16
- Unmapped: 0

---
*Requirements defined: 2026-02-17*
*Last updated: 2026-02-17 after roadmap creation*
