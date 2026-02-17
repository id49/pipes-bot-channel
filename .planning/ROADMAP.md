# Roadmap: PipesBot OpenClaw Channel Plugin

## Overview

This roadmap delivers a WhatsApp channel plugin for OpenClaw in four phases following the data flow direction: scaffold the plugin so it loads into the gateway, establish a reliable WebSocket transport to PipesBot, handle all inbound WhatsApp message types, then complete the loop with outbound replies and delivery status. Each phase produces artifacts the next phase depends on, with the two highest-risk components (reconnection and dead connection detection) front-loaded in Phase 2.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Plugin Scaffold** - Package, manifest, config, and lifecycle so the plugin loads into OpenClaw Gateway
- [ ] **Phase 2: WebSocket Transport** - Persistent connection to PipesBot with reconnection, heartbeat, and clean teardown
- [ ] **Phase 3: Inbound Messages** - Receive all WhatsApp message types and dispatch to OpenClaw agent pipeline
- [ ] **Phase 4: Outbound and Status** - Send agent replies back through WhatsApp and surface delivery status

## Phase Details

### Phase 1: Plugin Scaffold
**Goal**: Plugin loads into OpenClaw Gateway with valid configuration and proper lifecycle management
**Depends on**: Nothing (first phase)
**Requirements**: INFRA-01, INFRA-02, INFRA-03, INFRA-04
**Success Criteria** (what must be TRUE):
  1. Running `openclaw plugins install` with the package installs the plugin without errors
  2. OpenClaw Gateway recognizes the plugin as a channel and lists it in available channels
  3. Configuring a PipesBot `pk_` API key in `openclaw.json` is validated at startup (rejects missing or malformed keys)
  4. Gateway start and stop lifecycle calls complete without resource leaks or hanging processes
**Plans**: 1 plan

Plans:
- [x] 01-01-PLAN.md — Package scaffold, manifest, plugin entry, and service lifecycle

### Phase 2: WebSocket Transport
**Goal**: Plugin maintains a reliable, persistent WebSocket connection to PipesBot that recovers from failures automatically
**Depends on**: Phase 1
**Requirements**: WS-01, WS-02, WS-03, WS-04
**Success Criteria** (what must be TRUE):
  1. Plugin connects to PipesBot hub using the configured `pk_` API key and receives a successful handshake
  2. After a transient disconnect (network drop, server restart), the plugin reconnects automatically with increasing delay between attempts
  3. A silently dead connection (no ping received within 75 seconds) is detected and triggers reconnection
  4. A permanent failure (invalid API key, auth revoked) stops reconnection attempts and reports the error
  5. Stopping the gateway account tears down the WebSocket cleanly with no lingering timers or listeners
**Plans**: 1 plan

Plans:
- [ ] 02-01-PLAN.md — PipesBotConnection class and service lifecycle wiring

### Phase 3: Inbound Messages
**Goal**: All WhatsApp message types received through PipesBot reach the OpenClaw agent pipeline with full context
**Depends on**: Phase 2
**Requirements**: IN-01, IN-02, IN-03, IN-04
**Success Criteria** (what must be TRUE):
  1. A text message from WhatsApp arrives in the OpenClaw agent pipeline with the sender's phone number, push name, and conversation context
  2. Media messages (image, audio, video, document) arrive with their download URL and 48-hour TTL metadata intact
  3. Special message types (sticker, location, contacts, reaction) are received and normalized into a format the agent can consume
  4. Each inbound message is scoped to the correct sender session so agents maintain per-conversation context
**Plans**: TBD

Plans:
- [ ] 03-01: TBD
- [ ] 03-02: TBD

### Phase 4: Outbound and Status
**Goal**: Agents can reply to WhatsApp conversations and see whether their messages were delivered
**Depends on**: Phase 3
**Requirements**: OUT-01, OUT-02, OUT-03, OUT-04
**Success Criteria** (what must be TRUE):
  1. An agent's text reply is sent to the correct WhatsApp conversation via the PipesBot WebSocket
  2. Delivery confirmations (`reply_status` with success) are surfaced to OpenClaw
  3. A `SERVICE_WINDOW_EXPIRED` error produces a clear, human-readable message explaining the 24-hour window constraint
  4. OpenClaw dashboard shows the connection health status for each configured PipesBot account
**Plans**: TBD

Plans:
- [ ] 04-01: TBD
- [ ] 04-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Plugin Scaffold | 1/1 | Complete | 2026-02-17 |
| 2. WebSocket Transport | 0/TBD | Not started | - |
| 3. Inbound Messages | 0/TBD | Not started | - |
| 4. Outbound and Status | 0/TBD | Not started | - |
