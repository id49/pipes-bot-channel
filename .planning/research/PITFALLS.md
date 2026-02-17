# Pitfalls Research

**Domain:** OpenClaw channel plugin — WebSocket-based WhatsApp bridge via PipesBot
**Researched:** 2026-02-17
**Confidence:** MEDIUM-HIGH (multiple sources cross-referenced; some PipesBot-specific details from project context, not external docs)

---

## Critical Pitfalls

### Pitfall 1: Infinite Reconnection Loop Starves the Event Loop

**What goes wrong:**
The WebSocket reconnect loop runs without a retry cap. When PipesBot hub is in a persistent failure state (bad auth token, server-side error code, unexpected close code), the plugin retries infinitely. With `maxAttempts: Infinity` or no cap, 2,000+ reconnection attempts fill the Node.js event loop, blocking OpenClaw's cron, heartbeat, and other subsystems. The gateway becomes unresponsive without crashing cleanly.

**Why it happens:**
Developers assume "always reconnect" is safe because transient network drops require reconnection. They don't distinguish between transient failures (retry) and permanent failures (stop and exit). The distinction requires mapping close codes to intent.

**How to avoid:**
- Cap reconnection attempts at a finite number (e.g., 50 attempts, ~25 minutes with exponential backoff).
- Map WebSocket close codes to retry strategy: transient codes (1001, 1006, 1012, 1013) → retry with backoff; permanent codes (1008 bad token, 4001 unauthorized) → stop immediately, surface error.
- After cap is exhausted, call the registered service's error callback or log a fatal and exit cleanly — do not loop silently.

**Warning signs:**
- Gateway logs show hundreds of "reconnecting..." entries for a single plugin.
- CPU stays elevated without messages being processed.
- OpenClaw's heartbeat or scheduled tasks miss their cadence.
- `openclaw status` shows gateway "OK" but no messages flow through.

**Phase to address:**
Phase 1 (WebSocket client foundation). The reconnection state machine must be designed correctly from the first implementation, not bolted on later.

---

### Pitfall 2: Silent Dead Connection — Reconnect Never Triggers

**What goes wrong:**
The WebSocket connection appears open but is actually dead. Network interruptions (router restart, firewall rule change, IP change, NAT timeout) can sever TCP without emitting a `close` event on the socket. The plugin's reconnect logic never fires because it only listens to `close`. OpenClaw's gateway reports the channel as "connected" while no messages flow. This can persist for hours.

**Why it happens:**
Developers trust the `close` event as the sole reconnect trigger. TCP connections can silently die without the application layer being notified. This is a documented real-world failure mode in the OpenClaw Mattermost plugin (issue #11796).

**How to avoid:**
- Implement an application-level heartbeat independent of PipesBot's ping/pong.
- PipesBot sends a ping every 25 seconds; track when the last ping was received.
- If no ping is received within 2–3x the expected interval (e.g., 75 seconds), treat the connection as dead: call `ws.terminate()` and trigger reconnect.
- Do not rely solely on responding to pings — also verify receipt of pings by timestamp.
- Use `ws.terminate()` (not `ws.close()`) when forcing a dead-connection cleanup, since `close()` waits for a graceful handshake that may never arrive on a dead socket.

**Warning signs:**
- Channel shows "connected" in OpenClaw status but incoming WhatsApp messages are not arriving.
- No incoming messages for an extended period when activity is expected.
- Gap in received ping timestamps visible in debug logs.

**Phase to address:**
Phase 1 (WebSocket client). Build heartbeat monitoring before considering the client "production-ready."

---

### Pitfall 3: openclaw Declared as Direct Dependency Instead of Peer Dependency

**What goes wrong:**
`openclaw` is listed in `dependencies` or `devDependencies` in `package.json` with a `workspace:*` specifier copied from monorepo development. When the plugin is published to npm and installed via `openclaw plugins install`, npm resolves the workspace reference and fails, or installs a duplicate openclaw alongside the host — causing version conflicts and doubled module loading.

**Why it happens:**
Developers build the plugin locally inside the OpenClaw workspace where `workspace:*` resolves correctly. The error only manifests at publish/install time. The OpenClaw docs explicitly warn about this but it's easy to miss.

**How to avoid:**
- Declare `openclaw` in `peerDependencies` with a version range (e.g., `">=2026.2.0"`).
- Never use `workspace:*` specifiers in published packages.
- The openclaw runtime resolves `openclaw/plugin-sdk` via a jiti alias — the plugin does not bundle OpenClaw itself.
- Verify with `npm pack` and inspect the tarball before publishing.
- Test `npm install --omit=dev` in a clean directory to simulate how OpenClaw installs the plugin.

**Warning signs:**
- `openclaw plugins install` fails with npm resolution errors.
- Two openclaw instances appear in `node_modules`.
- Plugin loads but type errors appear at runtime from mismatched openclaw versions.

**Phase to address:**
Phase 1 (project setup and manifest). Lock down `package.json` structure before writing any plugin logic.

---

### Pitfall 4: Manifest Channel ID Mismatch Prevents Plugin from Loading

**What goes wrong:**
The channel ID declared in `package.json`'s `openclaw.extensions[].channel.id` field does not match the key used in `openclaw.json` configuration or the plugin's internal `registerService` call. The gateway silently skips loading the plugin, or loads it but cannot wire its configuration. Debugging is difficult because the failure looks like "plugin not installed."

**Why it happens:**
Channel IDs are strings set in multiple places: `package.json` manifest, `openclaw.json` config key (`channels.<id>`), and the plugin's internal register call. A typo or casing difference in any one breaks the chain. OpenClaw validates IDs strictly — unknown `channels.<id>` keys are errors.

**How to avoid:**
- Define the channel ID as a single exported constant (e.g., `CHANNEL_ID = "pipes-bot"`) and reference it everywhere.
- Verify that the manifest `channel.id`, the `openclaw.json` config key, and the `registerService` call all use the identical string.
- Read the OpenClaw plugin loading logs at startup — manifest validation errors appear as warnings before the plugin is skipped.
- Add a smoke test that loads the plugin manifest and validates the ID chain end-to-end.

**Warning signs:**
- `openclaw channels list` does not show the plugin's channel.
- `openclaw.json` has the channel config section but the gateway logs say no handler registered.
- Manifest validation warnings in gateway startup logs.

**Phase to address:**
Phase 1 (plugin registration scaffold). Validate the entire ID chain before building message handling.

---

### Pitfall 5: Postinstall Build Scripts Make the Plugin Uninstallable

**What goes wrong:**
The plugin uses a native dependency or a package with a postinstall build step (e.g., `node-gyp`, `bcrypt`, `canvas`). OpenClaw installs plugins with `npm install --ignore-scripts`, so postinstall scripts are skipped. The package installs but fails at runtime when the native module cannot be found or is unbuilt.

**Why it happens:**
Developers test locally with `npm install` (which runs scripts), so the native dependency works in development. In production OpenClaw installs, scripts are suppressed by design for security. The constraint is documented ("keep dependency trees as pure JS/TS") but easy to overlook when adding "just one" convenience dependency.

**How to avoid:**
- Treat the constraint as absolute: zero native dependencies. This means no `node-gyp` builds, no binary blobs, no Rust/C++ bindings.
- For WebSocket: use `ws` (pure JS). For crypto: use Node.js built-in `crypto`. For UUID: use `crypto.randomUUID()`.
- Before adding any dependency, check its `package.json` for `postinstall`, `install`, or `preinstall` scripts.
- Run `npm install --ignore-scripts` in a clean directory as part of the pre-publish check.

**Warning signs:**
- `npm install --ignore-scripts` succeeds but `node plugin/index.js` throws "Cannot find module" or "invalid ELF header."
- Any dependency with a `.node` file in its dist directory.
- `package.json` of a dependency contains `"install": "node-gyp rebuild"`.

**Phase to address:**
Phase 1 (project setup). The constraint must be enforced from the first dependency added.

---

### Pitfall 6: Missing stop() Cleanup Causes Resource Leaks on Gateway Restart

**What goes wrong:**
The plugin's `registerService` stop() method does not fully clean up: the WebSocket connection is not terminated, heartbeat timers are not cleared, or event listeners are not removed. On gateway restart (or plugin reload), a new plugin instance starts while the old connection and timers still run. Two competing connections deliver duplicate messages; timer memory grows unboundedly.

**Why it happens:**
Developers implement `start()` thoroughly but treat `stop()` as a formality. The lifecycle contract requires that stop() fully reverses start(). Node.js event emitters retain listeners until explicitly removed; the `ws` library's underlying TCP socket can remain `ESTABLISHED` even after `ws.close()` if the connection was in an unexpected-response state.

**How to avoid:**
- Implement stop() as a teardown mirror of start(): clear all timers, remove all event listeners, call `ws.terminate()` (not just `ws.close()`), and set internal state to "stopped."
- Use a single `isRunning` flag gated at the top of all callbacks — if stop() sets it to false, inbound callbacks no-op immediately.
- Track all `setTimeout`/`setInterval` handles and clear them in stop().
- Remove all `ws.on(...)` listeners in stop() using named handler references (not anonymous functions).

**Warning signs:**
- Duplicate messages appear after a gateway restart.
- Memory usage grows steadily across plugin restarts.
- Logs show two simultaneous "received message" entries for the same PipesBot message ID.

**Phase to address:**
Phase 1 (WebSocket client). Stop() must be a first-class concern from day one, not a cleanup task.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| `maxAttempts: Infinity` on reconnect | Always reconnects after transient drops | Infinite loops starve event loop on permanent failures | Never |
| Anonymous functions as event listeners | Less boilerplate | Cannot be removed in stop(); creates memory leaks | Never in plugin lifecycle code |
| `ws.close()` instead of `ws.terminate()` for forced cleanup | Sends polite close frame | Hangs if socket is dead; TCP stays ESTABLISHED | Only when doing graceful shutdown with confirmed live connection |
| Hardcoding channel ID string in multiple files | Fast to write | One typo breaks loading silently; hard to rename | Never — use a shared constant |
| No jitter in backoff delays | Simpler implementation | Thundering herd if multiple gateway instances restart simultaneously | Never in production |
| Passing media download URLs through without TTL metadata | Simpler message envelope | Agent tries to fetch expired URLs 50 hours later, gets 403 | Never — include `url_expires_at` timestamp |
| Catching `reply_status` errors silently | No user-visible noise | SERVICE_WINDOW_EXPIRED errors accumulate; agent never learns the reply failed | Never — surface errors to OpenClaw's error pipeline |

---

## Integration Gotchas

Common mistakes when connecting to external services.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| PipesBot WebSocket auth | Putting API key in header instead of query param | PipesBot requires `?apiKey=pk_XXX` in the connection URL — not a header or subprotocol |
| PipesBot ping/pong | Ignoring incoming pings entirely | Respond to protocol-level pings; also track timestamps to detect silent dead connections |
| PipesBot hub URL | Hardcoding `wss://hub.pipes-bot.com` | Read from plugin config; allow override for self-hosted or staging deployments |
| WhatsApp 24h service window | Attempting to send replies without checking window | Check `reply_status` for `SERVICE_WINDOW_EXPIRED`; do not retry on this error; surface it as a channel-level constraint to the agent |
| Media download URLs | Treating URL as permanent | PipesBot/R2 URLs have a 48h TTL — include expiry metadata in the forwarded message envelope; never cache raw URLs beyond TTL |
| WhatsApp media URL | Attempting to re-download after TTL expiry | Treat expired media as permanently unavailable; log and skip, do not retry |
| OpenClaw config validation | Relying on runtime to catch schema errors | Test config validation explicitly with invalid inputs; the gateway rejects the plugin at load time, not at message time |

---

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Backoff without jitter | Multiple restarts of the gateway all reconnect at the same second | Add `jitter = Math.random() * delay * 0.5` to each backoff delay | When gateway is restarted in a multi-instance setup or rapid restart cycle |
| Event listener accumulation | Memory grows on every reconnect; old listeners still fire | Use named references; call `ws.removeAllListeners()` before re-attaching in reconnect | After ~10-20 reconnect cycles in long-running sessions |
| Synchronous message processing in WebSocket `message` event | One slow message blocks all subsequent messages on the event loop | Use async handlers; never do blocking I/O synchronously in the ws `message` handler | First time a slow OpenClaw agent response coincides with a burst of inbound messages |
| No cap on pending outbound queue during reconnect | Unlimited messages queue while disconnected; reconnect floods PipesBot with stale messages | Implement a bounded queue (e.g., 50 messages); drop oldest or return errors to caller on overflow | During extended disconnect periods with active conversation load |

---

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Logging the full API key (`pk_XXX`) in debug output | API key exposure in log files or log aggregators | Log only the key prefix (e.g., `pk_****...last4`) or a redacted placeholder |
| Using `dmPolicy: "allow"` in production config | Any WhatsApp number can trigger the OpenClaw agent — no access control | Document that `dmPolicy` must be set to `"pairing"` or `"allowlist"` before production; add a config warning if `"allow"` is detected |
| Not validating message sender against expected phone number format | Malformed sender IDs passed to OpenClaw session key resolution | Validate sender format (e.g., E.164 + `@s.whatsapp.net` suffix) before forwarding |
| Trusting arbitrary PipesBot message fields as safe input | Injected content in message body reaching OpenClaw agent context | Treat all inbound message content as untrusted user input — let OpenClaw's agent sandbox handle it, do not parse or execute content in the plugin |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **WebSocket reconnection:** Timer-based retry loop works — but is there a cap, and does the retry stop on 4001/1008 (auth failure) rather than looping forever?
- [ ] **Heartbeat:** Ping/pong response exists — but does the plugin also detect when no ping arrives for 75+ seconds and self-terminate?
- [ ] **stop() lifecycle:** `ws.close()` is called — but are all timers cleared, all listeners removed, and is `ws.terminate()` called as fallback for dead connections?
- [ ] **24h service window:** `reply_status` is received — but is `SERVICE_WINDOW_EXPIRED` surfaced to the caller, not silently swallowed?
- [ ] **Media URLs:** URLs are forwarded — but is the 48h expiry timestamp included in the message envelope so downstream agents know when the URL becomes invalid?
- [ ] **npm distribution:** Plugin installs locally — but does `npm install --ignore-scripts` in a clean directory succeed without errors?
- [ ] **Manifest ID chain:** Channel ID works during dev — but is it a single constant, and have you verified that `package.json`, `openclaw.json`, and `registerService` all use the exact same string?
- [ ] **openclaw dependency:** `openclaw` is referenced — but is it in `peerDependencies`, not `dependencies`, and is there no `workspace:*` specifier?
- [ ] **Config validation:** Schema validates correct config — but does it reject missing API key and malformed hub URL with a clear error message?
- [ ] **Backoff jitter:** Exponential backoff exists — but is jitter applied to prevent simultaneous reconnects after server restarts?
- [ ] **All message types:** Text messages work — but have image, audio, document, video, sticker, location, contacts, and reaction types been tested with real PipesBot payloads?

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Infinite reconnect loop detected in production | LOW | Cap attempts and redeploy; add close-code classification; no data loss since WS is stateless |
| Silent dead connection causing message loss | MEDIUM | Implement heartbeat; messages lost during silent period are unrecoverable from PipesBot (no replay API) — accept the gap, monitor going forward |
| openclaw dependency conflict after publish | MEDIUM | Republish package with corrected `peerDependencies`; instruct users to `openclaw plugins remove` and reinstall |
| Channel ID mismatch discovered post-deploy | LOW | Fix constant definition and redeploy; no data migration needed |
| Native dependency breaks install | MEDIUM | Identify offending package, replace with pure-JS alternative, republish; may require users to reinstall plugin |
| stop() leak causes duplicate messages | MEDIUM | Implement proper teardown; on affected instances, restart the OpenClaw gateway to clear dangling connections |
| Media URL passed without TTL, agent gets 403 | LOW | Add `url_expires_at` field to message envelope; existing conversations must re-request media from WhatsApp user |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Infinite reconnection loop | Phase 1: WebSocket client | Unit test: simulate close code 4001, verify retry stops immediately |
| Silent dead connection | Phase 1: WebSocket client | Integration test: cut TCP without close event, verify reconnect fires within 90s |
| openclaw as wrong dependency type | Phase 1: Project setup | Run `npm install --ignore-scripts` in clean dir; inspect `node_modules` for duplicate openclaw |
| Channel ID mismatch | Phase 1: Plugin scaffold | Smoke test: load plugin in real OpenClaw instance, verify channel appears in `openclaw channels list` |
| Postinstall/native dependency | Phase 1: Project setup | CI: install with `--ignore-scripts` flag; grep dependencies for `.node` files |
| Missing stop() cleanup | Phase 1: WebSocket client | Test: call start() then stop() three times in sequence; verify no listener accumulation |
| Media URL without TTL metadata | Phase 2: Message handling | Review message envelope schema: confirm `url_expires_at` field is present for all media types |
| SERVICE_WINDOW_EXPIRED not surfaced | Phase 2: Message handling | Test with expired conversation: verify OpenClaw receives an error, not silence |
| API key logged in plaintext | Phase 1: WebSocket client | Log output review: search for `pk_` in all log lines during connection; none should appear |
| Backoff without jitter | Phase 1: WebSocket client | Code review: confirm `Math.random()` jitter in backoff calculation |
| dmPolicy: allow in production | Phase 2/3: Config + docs | Config schema: warn if `dmPolicy` is `"allow"`; document required value in README |

---

## Sources

- OpenClaw GitHub issue #11836: Discord gateway infinite reconnection loop (2026-02-10 fix, PR #12230) — [https://github.com/openclaw/openclaw/issues/11836](https://github.com/openclaw/openclaw/issues/11836)
- OpenClaw GitHub issue #11796: Mattermost WebSocket silent disconnection, heartbeat fix (PR #11822) — [https://github.com/openclaw/openclaw/issues/11796](https://github.com/openclaw/openclaw/issues/11796)
- OpenClaw plugin docs (official): dependency, lifecycle, manifest requirements — [https://docs.openclaw.ai/tools/plugin](https://docs.openclaw.ai/tools/plugin)
- DeepWiki: OpenClaw extensions and plugins architecture — [https://deepwiki.com/openclaw/openclaw/10-extensions-and-plugins](https://deepwiki.com/openclaw/openclaw/10-extensions-and-plugins)
- ws library GitHub issue #1869: TCP socket left ESTABLISHED after ws.close() on unexpected-response — [https://github.com/websockets/ws/issues/1869](https://github.com/websockets/ws/issues/1869)
- OneUptime blog: WebSocket reconnection logic pitfalls (2026) — [https://oneuptime.com/blog/post/2026-01-27-websocket-reconnection/view](https://oneuptime.com/blog/post/2026-01-27-websocket-reconnection/view)
- OneUptime blog: WebSocket heartbeat/ping-pong implementation (2026) — [https://oneuptime.com/blog/post/2026-01-27-websocket-heartbeat/view](https://oneuptime.com/blog/post/2026-01-27-websocket-heartbeat/view)
- Teleport PR #9133: Jitter and backoff to prevent thundering herd on auth reconnect — [https://github.com/gravitational/teleport/pull/9133](https://github.com/gravitational/teleport/pull/9133)
- clawdbot-feishu package.json: real-world openclaw channel plugin peerDependency pattern — [https://github.com/m1heng/clawdbot-feishu/blob/main/package.json](https://github.com/m1heng/clawdbot-feishu/blob/main/package.json)
- WhatsApp Cloud API rate limits and 24h service window — [https://www.wati.io/en/blog/whatsapp-business-api/whatsapp-api-rate-limits/](https://www.wati.io/en/blog/whatsapp-business-api/whatsapp-api-rate-limits/)
- Project context: PROJECT.md (PipesBot protocol details, 48h media TTL, 24h service window, pk_ auth)

---
*Pitfalls research for: OpenClaw channel plugin — WebSocket WhatsApp bridge (PipesBot)*
*Researched: 2026-02-17*
