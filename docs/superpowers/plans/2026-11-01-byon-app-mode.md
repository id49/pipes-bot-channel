# BYON App Mode (API v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the OpenClaw channel run on a BYON number with an `ak_` App key (API v2), delivering only allowlisted senders to the agent, while sandbox (`pk_`) mode stays exactly as it is.

**Architecture:** Two pure adapters (legacy `whatsapp_message`, v2 `event`) turn frames into one `InboundMessage` shape. A frame router dedupes, applies the trusted-sender gate in App mode, and hands messages to a protocol-agnostic `handleInbound`. Replies go out as `whatsapp_reply` (legacy) or `send` (v2), and v2 failures come back through `send_result` and `failed` statuses as agent-facing system events.

**Tech Stack:** TypeScript (strict, nodenext, `noEmit`), `ws`, `zod`, OpenClaw plugin SDK 2026.2.15 (devDependency, unchanged), vitest 5 (new devDependency).

**Spec:** `docs/superpowers/specs/2026-10-31-byon-app-mode-design.md`

## Global Constraints

- Sandbox (`pk_`) behavior and context fields must not change. Task 7 pins this with a test.
- Mode comes from the key prefix only: `pk_` → `"sandbox"`, `ak_` → `"app"`. No mode setting.
- Imports between source files use `.js` extensions (nodenext), like the existing code.
- Log lines start with `pipes-bot-channel: `, like the existing code.
- OpenClaw SDK devDependency stays at the installed version. No other new runtime dependencies.
- `npx tsc --noEmit` and `npm test` must both pass at the end of every task.
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` after a blank line.
- Exact copy (do not reword):
  - Empty allowlist warning: `pipes-bot-channel: App mode has no trusted senders (allowFrom is empty) -- dropping all inbound messages`
  - Untrusted drop: `pipes-bot-channel: dropping message from untrusted sender phone=<phone|-> user_id=<userId|-> -- add one of these to allowFrom to trust them`
  - Auth failure status: `Authentication failed -- check your API key (pk_ for sandbox, ak_ for a BYON App)`
  - Empty allowlist status: `No trusted senders configured (allowFrom)`
  - 131047: `Unable to send reply: the 24-hour WhatsApp messaging window has expired. The contact must send a new message to reopen the conversation.`

## Review Focus

- **Malformed or unexpected frames** (`{type:"event",data:{}}`, `event` with no `whatsapp`, `messages` not an array, unknown frame types): nothing throws out of the router, nothing is dispatched. Test in Task 8.
- **One envelope with a trusted and an untrusted sender:** only the trusted message is dispatched. Test in Task 8.
- **Editing `allowFrom` while the gateway runs:** the next message uses the new list without a restart, because the router reads settings per frame. Test in Task 8.
- **`allowFrom` typed as one comma-separated entry** (`"+55 11 99999-0000, US.123"`): treated as two entries. Test in Task 2.
- **A reply while the socket is down:** `send` returns false, a warning is logged, nothing is tracked, no crash. Test in Task 8.

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `package.json` | modify | vitest devDependency, `test` script, version, description |
| `tsconfig.json` | modify | include `test` |
| `src/config-schema.ts` | modify | `allowFrom`, `poolNumberId` |
| `src/channel.ts` | modify | key/mode/settings resolution, UI hints, status snapshot |
| `src/trust.ts` | create | allowlist parsing and sender matching (pure) |
| `src/dedupe.ts` | create | bounded TTL set (pure) |
| `src/inbound-message.ts` | create | `InboundMessage`, `ReplyTarget`, `SenderIds` types |
| `src/adapters/legacy.ts` | create | `whatsapp_message` → `InboundMessage` (pure) |
| `src/adapters/v2.ts` | create | v2 envelope → messages + failed statuses (pure) |
| `src/types.ts` | modify | legacy BSUID fields; v2 frame types |
| `src/outbound-v2.ts` | create | `send` frames, `send_result` / failed status handling |
| `src/inbound.ts` | modify | dispatch an `InboundMessage` (no envelope parsing) |
| `src/router.ts` | create | frame routing, dedupe, trust gate, reply closures |
| `src/connection.ts` | modify | injectable base URL, close `4000` reconnect |
| `src/service.ts` | modify | wire connection → router; mode-aware startup |
| `README.md` | modify | App mode docs |
| `test/**` | create | tests, fixtures, helpers |

---

### Task 1: Test harness, config schema and mode resolution

**Files:**
- Modify: `package.json`, `tsconfig.json`, `src/config-schema.ts`, `src/channel.ts`
- Test: `test/channel.test.ts`

**Interfaces:**
- Produces:
  - `export type PipesBotMode = "sandbox" | "app"` in `src/channel.ts`
  - `resolveApiKey(cfg: OpenClawConfig): string | undefined` — now accepts `pk_` or `ak_`
  - `resolveMode(apiKey: string): PipesBotMode`
  - `PipesBotConfigSchema` with `allowFrom?: string[]`, `poolNumberId?: string`

- [ ] **Step 1: Add vitest**

Run: `npm install -D vitest@^5` and add `"test": "vitest run"` to `scripts`. Add `"test"` to `tsconfig.json` `include`.
Expected: `npx vitest --version` prints 5.x.

- [ ] **Step 2: Write the failing tests** in `test/channel.test.ts`

```ts
const cfg = (c: object) => ({ channels: { "pipes-bot-channel": c } }) as never;

test("resolveApiKey accepts pk_ and ak_ keys", () => {
  expect(resolveApiKey(cfg({ apiKey: "pk_abc" }))).toBe("pk_abc");
  expect(resolveApiKey(cfg({ apiKey: "ak_live_abc" }))).toBe("ak_live_abc");
  expect(resolveApiKey(cfg({ apiKey: "sk_abc" }))).toBeUndefined();
  expect(resolveApiKey(cfg({}))).toBeUndefined();
});

test("resolveMode derives the mode from the key prefix", () => {
  expect(resolveMode("pk_abc")).toBe("sandbox");
  expect(resolveMode("ak_live_abc")).toBe("app");
});

test("config schema accepts allowFrom and poolNumberId", () => {
  const parsed = PipesBotConfigSchema.parse({ apiKey: "ak_x", allowFrom: ["+5511999990000"], poolNumberId: "pn_1" });
  expect(parsed.allowFrom).toEqual(["+5511999990000"]);
  expect(parsed.poolNumberId).toBe("pn_1");
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npm test -- test/channel.test.ts`
Expected: FAIL (`resolveMode` is not exported; `ak_` returns undefined).

- [ ] **Step 4: Implement**

`src/config-schema.ts`: add `allowFrom: z.array(z.string()).optional()` and `poolNumberId: z.string().optional()`.
`src/channel.ts`: `resolveApiKey` accepts `startsWith("pk_") || startsWith("ak_")`; add `resolveMode`. UI hints (exact copy):
- `apiKey`: placeholder `pk_... or ak_...`, help `PipesBot account key (pk_, sandbox numbers) or BYON App key (ak_, API v2)`
- `allowFrom`: label `Trusted senders`, help `Phone numbers (any format) or WhatsApp user IDs (CC.…) allowed to talk to the agent in App mode`
- `poolNumberId`: label `BYON number ID`, help `Only answer on this BYON number (pn_…). Leave empty for all numbers in the App`

- [ ] **Step 5: Run tests and type-check**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json src/config-schema.ts src/channel.ts test/channel.test.ts
git commit -m "feat: accept ak_ App keys and add allowFrom/poolNumberId config"
```

---

### Task 2: Trusted-sender matching and App settings

**Files:**
- Create: `src/trust.ts`
- Modify: `src/channel.ts`
- Test: `test/trust.test.ts`, `test/channel.test.ts`

**Interfaces:**
- Produces (`src/trust.ts`):
  - `export type SenderIds = { phone?: string; userId?: string; parentUserId?: string }`
  - `parseAllowFrom(raw: unknown): string[]` — accepts `string[]` or `string`; splits every entry on `,` and `;`, trims, drops empties; anything else → `[]`
  - `isTrustedSender(sender: SenderIds, allowFrom: readonly string[]): boolean`
- Produces (`src/channel.ts`):
  - `export type AppSettings = { allowFrom: string[]; poolNumberId?: string }`
  - `resolveAppSettings(cfg: OpenClawConfig): AppSettings` — `poolNumberId` trimmed, empty → undefined

Matching rule (from the spec): an entry containing `.` is a BSUID and is compared exactly (after trim) to `userId` and `parentUserId`. Any other entry is a phone number: compare its digits to `phone`'s digits. An entry with no digits never matches. An empty `allowFrom` never matches.

- [ ] **Step 1: Write the failing tests** in `test/trust.test.ts`

```ts
test("phone entries match regardless of formatting", () => {
  expect(isTrustedSender({ phone: "5511999990000" }, ["+55 (11) 99999-0000"])).toBe(true);
  expect(isTrustedSender({ phone: "+5511999990000" }, ["5511999990000"])).toBe(true);
  expect(isTrustedSender({ phone: "5511999990001" }, ["5511999990000"])).toBe(false);
});

test("BSUID entries match userId or parentUserId exactly", () => {
  expect(isTrustedSender({ userId: "US.13491208655302741918" }, ["US.13491208655302741918"])).toBe(true);
  expect(isTrustedSender({ parentUserId: "US.ENT.11815799212886844830" }, [" US.ENT.11815799212886844830 "])).toBe(true);
  expect(isTrustedSender({ userId: "US.13491208655302741918" }, ["US.1349120865530274191"])).toBe(false);
});

test("a BSUID entry never matches a phone by digits", () => {
  expect(isTrustedSender({ phone: "13491208655302741918" }, ["US.13491208655302741918"])).toBe(false);
});

test("empty list and digitless entries never match", () => {
  expect(isTrustedSender({ phone: "5511999990000" }, [])).toBe(false);
  expect(isTrustedSender({ phone: "" }, ["abc"])).toBe(false);
  expect(isTrustedSender({}, ["5511999990000"])).toBe(false);
});

test("parseAllowFrom splits comma-separated entries", () => {
  expect(parseAllowFrom(["+55 11 99999-0000, US.123", " ", "15550001111;16505551234"]))
    .toEqual(["+55 11 99999-0000", "US.123", "15550001111", "16505551234"]);
  expect(parseAllowFrom("5511999990000")).toEqual(["5511999990000"]);
  expect(parseAllowFrom(undefined)).toEqual([]);
  expect(parseAllowFrom(42)).toEqual([]);
});
```

In `test/channel.test.ts`:

```ts
test("resolveAppSettings reads allowFrom and poolNumberId", () => {
  expect(resolveAppSettings(cfg({ allowFrom: ["a, b"], poolNumberId: " pn_1 " }))).toEqual({ allowFrom: ["a", "b"], poolNumberId: "pn_1" });
  expect(resolveAppSettings(cfg({ poolNumberId: "" }))).toEqual({ allowFrom: [], poolNumberId: undefined });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- test/trust.test.ts test/channel.test.ts`
Expected: FAIL (module `src/trust.js` not found).

- [ ] **Step 3: Implement** `src/trust.ts` and `resolveAppSettings` with the signatures above.

- [ ] **Step 4: Run tests and type-check**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trust.ts src/channel.ts test/trust.test.ts test/channel.test.ts
git commit -m "feat: trusted-sender allowlist matching for App mode"
```

---

### Task 3: Dedupe set

**Files:**
- Create: `src/dedupe.ts`
- Test: `test/dedupe.test.ts`

**Interfaces:**
- Produces: `export class Dedupe { constructor(opts?: { ttlMs?: number; max?: number; now?: () => number }); seen(key: string): boolean }`
  - Defaults: `ttlMs = 600_000` (10 min), `max = 5_000`, `now = Date.now`
  - `seen(key)` returns `true` if `key` was recorded and has not expired; otherwise records it and returns `false`
  - When recording would exceed `max`, evict the oldest entry (a `Map` keeps insertion order)

- [ ] **Step 1: Write the failing tests**

```ts
test("second sighting is a duplicate", () => {
  const d = new Dedupe();
  expect(d.seen("evt_1")).toBe(false);
  expect(d.seen("evt_1")).toBe(true);
});

test("entries expire after ttl", () => {
  let t = 0;
  const d = new Dedupe({ ttlMs: 1000, now: () => t });
  d.seen("a");
  t = 1001;
  expect(d.seen("a")).toBe(false);
});

test("oldest entry is evicted past max", () => {
  const d = new Dedupe({ max: 2 });
  d.seen("a"); d.seen("b"); d.seen("c");
  expect(d.seen("a")).toBe(false);
  expect(d.seen("c")).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- test/dedupe.test.ts`, expected FAIL (module not found).
- [ ] **Step 3: Implement** `Dedupe` as specified.
- [ ] **Step 4: Run tests and type-check** — `npm test && npx tsc --noEmit`, expected PASS.
- [ ] **Step 5: Commit**

```bash
git add src/dedupe.ts test/dedupe.test.ts
git commit -m "feat: bounded TTL dedupe set"
```

---

### Task 4: `InboundMessage` and the legacy adapter

**Files:**
- Create: `src/inbound-message.ts`, `src/adapters/legacy.ts`
- Modify: `src/types.ts` (add `userId?`, `parentUserId?`, `username?` to `PipesBotMessageData`)
- Test: `test/adapters/legacy.test.ts`

**Interfaces:**
- Consumes: `SenderIds` (Task 2), `PipesBotContact`, `PipesBotLocation`, `isPipesBotMessage` (`src/types.ts`)
- Produces (`src/inbound-message.ts`):

```ts
export type InboundType = "text" | "image" | "audio" | "video" | "document" | "sticker" | "location" | "contacts" | "reaction";

export type ReplyTarget =
  | { kind: "legacy"; conversationId: string; poolNumberId: string; toNumber: string }
  | { kind: "v2"; poolNumberId: string; to?: string; recipient?: string };

export type InboundMessage = {
  messageId: string;
  poolNumberId: string;
  sender: SenderIds & { name?: string };
  senderId: string;   // legacy: fromNumber; v2: userId ?? phone
  toId: string;       // legacy: poolNumberPhoneNumber; v2: display_phone_number ?? poolNumberId
  peerId: string;     // legacy: conversationId; v2: `${poolNumberId}:${senderId}`
  sessionKey: string; // `default:${peerId}`
  timestamp: number;  // ms
  type: InboundType;
  body: string;
  media?: { downloadUrl: string; mimeType: string; fileName?: string };
  mediaUnavailable?: boolean;
  location?: PipesBotLocation;
  contacts?: PipesBotContact[];
  replyToId?: string;
  replyTarget: ReplyTarget;
};
```

- Produces (`src/adapters/legacy.ts`): `fromLegacyFrame(frame: unknown): InboundMessage | null`

Mapping (must reproduce what `inbound.ts` reads today):
- `null` for non-`whatsapp_message` frames, `type: "unsupported"`, and reactions with no `reaction.emoji`
- `body`: text → `data.body`; reaction → `reaction.emoji`; location/contacts → `""`; media types → `data.body ?? ""`
- `media` when `data.media.downloadUrl` exists and `unavailable` is not true; `mediaUnavailable: true` when `data.media?.unavailable`
- `sender.phone = fromNumber` unless it contains `.`, in which case `sender.userId = fromNumber`; `data.userId` / `data.parentUserId` fill `userId` / `parentUserId` when present; `sender.name = fromName`
- `senderId = fromNumber`, `toId = poolNumberPhoneNumber`, `peerId = conversationId`, `sessionKey = "default:" + conversationId`, `timestamp = new Date(data.timestamp).getTime()`, `replyToId = reaction.messageId` for reactions
- `replyTarget = { kind: "legacy", conversationId, poolNumberId, toNumber: fromNumber }`

- [ ] **Step 1: Write the failing tests** with a `legacyFrame(overrides)` helper in the test file (a `whatsapp_message` with `messageId: "msg_1"`, `conversationId: "conv_1"`, `poolNumberId: "pool_1"`, `poolNumberPhoneNumber: "+15550001111"`, `fromNumber: "+5511999990000"`, `fromName: "Ana"`, `type: "text"`, `body: "oi"`, `text: "oi"`, `timestamp: "2026-11-01T10:00:00.000Z"`).

```ts
test("text frame maps to InboundMessage", () => {
  expect(fromLegacyFrame(legacyFrame())).toEqual({
    messageId: "msg_1", poolNumberId: "pool_1",
    sender: { phone: "+5511999990000", name: "Ana" },
    senderId: "+5511999990000", toId: "+15550001111", peerId: "conv_1", sessionKey: "default:conv_1",
    timestamp: Date.parse("2026-11-01T10:00:00.000Z"), type: "text", body: "oi",
    replyTarget: { kind: "legacy", conversationId: "conv_1", poolNumberId: "pool_1", toNumber: "+5511999990000" },
  });
});
test("BSUID in fromNumber goes to sender.userId", ...)          // fromNumber "US.123", userId "US.123" → sender { userId: "US.123" }, no phone
test("image with downloadUrl sets media", ...)                  // media { downloadUrl, mimeType, fileName }
test("unavailable media sets mediaUnavailable and no media", ...)
test("reaction maps emoji and replyToId; removal returns null", ...)
test("unsupported and non-message frames return null", ...)     // type "unsupported"; { type: "reply_status" }; null
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- test/adapters/legacy.test.ts`, expected FAIL.
- [ ] **Step 3: Implement** the types and `fromLegacyFrame` as mapped above.
- [ ] **Step 4: Run tests and type-check** — `npm test && npx tsc --noEmit`, expected PASS.
- [ ] **Step 5: Commit**

```bash
git add src/inbound-message.ts src/adapters/legacy.ts src/types.ts test/adapters/legacy.test.ts
git commit -m "feat: normalized InboundMessage and legacy frame adapter"
```

---

### Task 5: v2 envelope adapter

**Files:**
- Create: `src/adapters/v2.ts`, `test/fixtures/byon-v2/*.json`, `test/helpers/fixtures.ts`
- Modify: `src/types.ts` (v2 frame types)
- Test: `test/adapters/v2.test.ts`

**Interfaces:**
- Consumes: `InboundMessage`, `ReplyTarget` (Task 4)
- Produces (`src/types.ts`):
  - `export type V2EventFrame = { type: "event"; data: unknown }`, `isV2EventFrame(msg: unknown): msg is V2EventFrame`
  - `export type V2SendResult = { type: "send_result"; requestId?: string; success: boolean; messageId?: string; error?: { code?: string | number; message?: string; title?: string } }`, `isV2SendResult(msg: unknown): msg is V2SendResult`
- Produces (`src/adapters/v2.ts`):
  - `export type V2FailedStatus = { wamid: string; error?: { code?: string | number; message?: string; title?: string } }`
  - `export type V2ParseResult = { envelopeId?: string; poolNumberId?: string; messages: InboundMessage[]; failedStatuses: V2FailedStatus[] }`
  - `parseV2Envelope(envelope: unknown): V2ParseResult` — never throws; anything malformed yields empty arrays
- Produces (`test/helpers/fixtures.ts`): `loadFixture(name: string): unknown` reading `test/fixtures/byon-v2/<name>.json` with `fs.readFileSync`

Rules (spec, "v2 inbound"): only `field === "messages"` yields messages and failed statuses. Message type mapping table, sender name from the `contacts[]` entry whose `user_id` or `wa_id` matches the sender (else the first contact; `profile.name ?? profile.username`), `timestamp = Number(ts) * 1000`, `senderId = from_user_id ?? from`, `toId = metadata.display_phone_number ?? poolNumberId`, `peerId = poolNumberId + ":" + senderId`, `replyTarget = { kind: "v2", poolNumberId, to: from }` or `{ kind: "v2", poolNumberId, recipient: from_user_id }` when there is no `from`. A message with neither `from` nor `from_user_id` is skipped. `failedStatuses` lists `statuses[]` with `status === "failed"`, `error = errors?.[0]`.

- [ ] **Step 1: Copy fixtures**

Run: `mkdir -p test/fixtures/byon-v2 && cp ../pipes-bot-docs/public/fixtures/byon-v2/*.json test/fixtures/byon-v2/`
Expected: 11 files. Also add hand-written `message-echo.json` (`field: "smb_message_echoes"`, `whatsapp.message_echoes[0]` text from `15550001111` to `16505551234`), `message-reaction.json`, `message-reaction-removed.json` (no `emoji`), `message-location.json`, `message-interactive.json` (`interactive.button_reply.title: "Yes"`), `message-button.json` (`button.text: "Stop"`), `message-two-senders.json` (two text messages, `from` `16505551234` and `15559998888`), and `message-image-unavailable.json` (image whose `pipes.media` entry is `{ "unavailable": true }`). Each uses `pipes.poolNumberId: "pn_abc123"` and `metadata.display_phone_number: "15550001111"`.

- [ ] **Step 2: Write the failing tests** (values come from the fixtures)

```ts
test("message-text: phone and BSUID sender", () => {
  const r = parseV2Envelope(loadFixture("message-text"));
  expect(r.envelopeId).toBe("evt_0f1e2d3c4b5a69788796a5b4c3d2e1f0");
  expect(r.messages).toHaveLength(1);
  expect(r.messages[0]).toMatchObject({
    messageId: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
    poolNumberId: "pn_abc123", type: "text", body: "Does it come in another color?",
    sender: { phone: "16505551234", userId: "US.13491208655302741918", name: "Sheena Nelson" },
    senderId: "US.13491208655302741918", toId: "15550001111",
    peerId: "pn_abc123:US.13491208655302741918", sessionKey: "default:pn_abc123:US.13491208655302741918",
    replyTarget: { kind: "v2", poolNumberId: "pn_abc123", to: "16505551234" },
  });
});
test("message-text-bsuid-only: replies with recipient", ...)        // replyTarget { recipient: "US.13491208655302741918" }, no to; sender has no phone
test("message-text-parent-bsuid: carries parentUserId", ...)        // sender.parentUserId "US.ENT.11815799212886844830"
test("message-image: media from pipes.media with caption", ...)     // body "Do you have this one in blue?", media { downloadUrl "/v1/media/download/aBcDeFgHiJkLmNoPqRs1t", mimeType "image/jpeg" }
test("message-image-unavailable: mediaUnavailable, no media", ...)
test("message-contact-request: contacts mapped", ...)               // contacts[0] { name: { formatted_name: "Sheena Nelson" }, phones: [{ phone: "+1 650-555-1234", type: "CELL" }] }, body ""
test("reaction, removed reaction, location, interactive, button", ...) // removed reaction → no message; interactive → type "text" body "Yes"; button → "Stop"
test("system messages are skipped", ...)                           // both system-* fixtures → messages []
test("echoes and template updates yield nothing", ...)              // message-echo, template-status-update → messages [] and failedStatuses []
test("status-failed surfaces a failed status; delivered does not", ...) // wamid "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=", error.code 131049
test("two senders in one envelope yield two messages", ...)
test("malformed envelopes never throw", () => {
  for (const bad of [null, {}, { field: "messages" }, { field: "messages", whatsapp: { messages: "x" } }, { field: "messages", whatsapp: { messages: [{ type: "text" }] } }]) {
    expect(parseV2Envelope(bad)).toMatchObject({ messages: [], failedStatuses: [] });
  }
});
```

- [ ] **Step 3: Run to verify they fail** — `npm test -- test/adapters/v2.test.ts`, expected FAIL.
- [ ] **Step 4: Implement** the types and `parseV2Envelope`.
- [ ] **Step 5: Run tests and type-check** — `npm test && npx tsc --noEmit`, expected PASS.
- [ ] **Step 6: Commit**

```bash
git add src/adapters/v2.ts src/types.ts test/adapters/v2.test.ts test/fixtures test/helpers/fixtures.ts
git commit -m "feat: API v2 envelope adapter"
```

---

### Task 6: v2 outbound and failure reporting

**Files:**
- Create: `src/outbound-v2.ts`
- Test: `test/outbound-v2.test.ts`

**Interfaces:**
- Consumes: `ReplyTarget` (Task 4), `V2SendResult` (Task 5), `V2FailedStatus` (Task 5), `PluginLogger`
- Produces:
  - `buildSendFrame(target: Extract<ReplyTarget, { kind: "v2" }>, text: string, requestId: string): object` — exactly the spec's `send` frame (`messaging_product: "whatsapp"`, `recipient_type: "individual"`, `to` or `recipient`, `type: "text"`, `text: { body }`)
  - `classifyV2Failure(error: unknown): string` — the spec's classification table
  - `export class V2Outbound { constructor(opts?: { now?: () => number }); trackSend(requestId: string, sessionKey: string): void; handleSendResult(frame: V2SendResult, deps: V2Deps): void; handleFailedStatus(status: V2FailedStatus, deps: V2Deps): void }`
  - `export type V2Deps = { logger: PluginLogger; enqueueSystemEvent: (text: string, opts: { sessionKey: string }) => void }`

Pending sends: 30s TTL, lazy eviction (as in `outbound.ts`). Successful `send_result` moves `messageId` → `sessionKey` into `sentMessages` (24h TTL, max 1,000, oldest evicted). A failed `send_result` enqueues `classifyV2Failure(frame.error)` on the pending session; with no pending entry it only logs. A failed status enqueues only when its `wamid` is in `sentMessages`.

- [ ] **Step 1: Write the failing tests**

```ts
test("send frame uses to for phones and recipient for BSUIDs", () => {
  expect(buildSendFrame({ kind: "v2", poolNumberId: "pn_1", to: "16505551234" }, "hi", "req_1")).toEqual({
    type: "send", requestId: "req_1", poolNumberId: "pn_1",
    message: { messaging_product: "whatsapp", recipient_type: "individual", to: "16505551234", type: "text", text: { body: "hi" } },
  });
  expect(buildSendFrame({ kind: "v2", poolNumberId: "pn_1", recipient: "US.1" }, "hi", "req_1").message).toMatchObject({ recipient: "US.1" });
});

test("classifyV2Failure", () => {
  expect(classifyV2Failure({ code: 131047, message: "Re-engagement message" })).toBe("Unable to send reply: the 24-hour WhatsApp messaging window has expired. The contact must send a new message to reopen the conversation.");
  expect(classifyV2Failure({ code: 131062, message: "x" })).toBe("Reply failed: Meta error 131062: x");
  expect(classifyV2Failure({ code: 131049, title: "t" })).toBe("Reply failed: Meta error 131049: t");
  expect(classifyV2Failure({ code: "NOT_FOUND", message: "BYON number not found" })).toBe("Reply failed: NOT_FOUND: BYON number not found");
  expect(classifyV2Failure({ message: "boom" })).toBe("Reply failed: boom");
  expect(classifyV2Failure(undefined)).toBe("Reply failed: unknown error");
});

test("failed send_result enqueues on the tracked session", ...)      // trackSend("req_1","default:pn_1:US.1"); handleSendResult({success:false, requestId:"req_1", error:{code:"FORBIDDEN",message:"m"}}) → enqueue("Reply failed: FORBIDDEN: m", {sessionKey:"default:pn_1:US.1"})
test("expired pending entry enqueues nothing", ...)                  // now advances 30_001 ms
test("failed status for our wamid enqueues; unknown wamid does not", ...) // success result messageId "wamid.A" then handleFailedStatus({wamid:"wamid.A", error:{code:131047}})
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- test/outbound-v2.test.ts`, expected FAIL.
- [ ] **Step 3: Implement** `src/outbound-v2.ts`.
- [ ] **Step 4: Run tests and type-check** — `npm test && npx tsc --noEmit`, expected PASS.
- [ ] **Step 5: Commit**

```bash
git add src/outbound-v2.ts test/outbound-v2.test.ts
git commit -m "feat: v2 send frames and failure reporting"
```

---

### Task 7: Protocol-agnostic `handleInbound`

**Files:**
- Modify: `src/inbound.ts`
- Create: `test/helpers/runtime-stub.ts`
- Test: `test/inbound.test.ts`

**Interfaces:**
- Consumes: `InboundMessage` (Task 4), `downloadPipesBotMedia` (`src/media.ts`, unchanged)
- Produces:
  - `handleInbound(message: InboundMessage, opts: { apiKey: string; accountId: string; commandAuthorized?: boolean; reply: (text: string) => boolean; logger: PluginLogger }): Promise<void>`
  - `test/helpers/runtime-stub.ts`: `createRuntimeStub(cfg?: object): { core: PluginRuntime; contexts: object[]; dispatches: number; systemEvents: Array<{ text: string; sessionKey: string }>; fetchRemoteMedia: Mock }`. The stub's `dispatchReplyWithBufferedBlockDispatcher` calls `dispatcherOptions.deliver({ text: "agent reply" })` once; `finalizeInboundContext` returns its input and records it in `contexts`; `saveMediaBuffer` resolves `{ path: "/tmp/saved", contentType }`; `fetchRemoteMedia` resolves `{ buffer: Buffer.from("x"), contentType: "image/jpeg" }`; `resolveAgentRoute` returns `{ agentId: "main" }`; `resolveStorePath` returns `"/tmp/store"`; `loadConfig` returns `cfg`.

`handleInbound` keeps steps 5–14 of today's file, reading from `message`: media download only when `message.media` (log the existing "media unavailable" warning when `message.mediaUnavailable`), contacts → vCard, location → `toLocationContext`, `peer: { kind: "direct", id: message.peerId }`, `SessionKey: message.sessionKey`, `From: "pipes-bot-channel:" + senderId`, `To: "pipes-bot-channel:" + toId`, `SenderId: senderId`, `SenderName` / `ConversationLabel` from `sender.name ?? senderId`, `OriginatingTo: "pipes-bot-channel:" + peerId`, `ReplyToId`, and `CommandAuthorized` **only when** `opts.commandAuthorized` is true (the key is absent otherwise). `deliver` calls `opts.reply(payload.text ?? "")` and keeps today's warning when it returns false.

- [ ] **Step 1: Write the failing tests** (call `setPipesBotRuntime(stub.core)` in `beforeEach`)

```ts
test("sandbox context is identical to the pre-refactor fields", async () => {
  const stub = createRuntimeStub(); setPipesBotRuntime(stub.core);
  const msg = fromLegacyFrame(legacyFrame())!;   // same helper values as Task 4
  const replies: string[] = [];
  await handleInbound(msg, { apiKey: "pk_x", accountId: "default", reply: (t) => (replies.push(t), true), logger: stubLogger() });
  expect(stub.contexts[0]).toEqual({
    Body: "oi", RawBody: "oi", CommandBody: "oi",
    From: "pipes-bot-channel:+5511999990000", To: "pipes-bot-channel:+15550001111",
    SessionKey: "default:conv_1", AccountId: "default", ChatType: "direct",
    SenderName: "Ana", SenderId: "+5511999990000", Provider: "pipes-bot-channel", Surface: "pipes-bot-channel",
    MessageSid: "msg_1", Timestamp: Date.parse("2026-11-01T10:00:00.000Z"), ConversationLabel: "Ana",
    ReplyToId: undefined, OriginatingChannel: "pipes-bot-channel", OriginatingTo: "pipes-bot-channel:conv_1",
  });
  expect(replies).toEqual(["agent reply"]);
});
test("commandAuthorized sets CommandAuthorized: true", ...)
test("media message downloads via downloadUrl", ...)        // stub global fetch → 302 with location; expect fetchRemoteMedia called with the redirect URL
test("mediaUnavailable dispatches text-only without fetching", ...)
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- test/inbound.test.ts`, expected FAIL (signature mismatch).
- [ ] **Step 3: Implement** the new `handleInbound` signature; remove envelope parsing and `whatsapp_reply` building from `src/inbound.ts`. `src/service.ts` will fail to type-check until Task 8; in this task, adapt its call site minimally: `const m = fromLegacyFrame(msg); if (m) void handleInbound(m, { ..., reply: (text) => send({ type: "whatsapp_reply", data: { conversationId, poolNumberId, toNumber, text } }) })` using `m.replyTarget`.
- [ ] **Step 4: Run tests and type-check** — `npm test && npx tsc --noEmit`, expected PASS.
- [ ] **Step 5: Commit**

```bash
git add src/inbound.ts src/service.ts test/inbound.test.ts test/helpers/runtime-stub.ts
git commit -m "refactor: handleInbound dispatches a normalized InboundMessage"
```

---

### Task 8: Frame router with the trusted-sender gate

**Files:**
- Create: `src/router.ts`
- Modify: `src/service.ts`
- Test: `test/router.test.ts`

**Interfaces:**
- Consumes: `fromLegacyFrame` (Task 4), `parseV2Envelope`, `isV2EventFrame`, `isV2SendResult` (Task 5), `V2Outbound`, `buildSendFrame` (Task 6), `handleInbound` (Task 7), `isTrustedSender` (Task 2), `AppSettings` (Task 2), `Dedupe` (Task 3), `handleReplyStatus`, `trackOutboundReply` (`src/outbound.ts`, unchanged), `isPipesBotReplyStatus`
- Produces:
  - `export type RouterDeps = { mode: PipesBotMode; apiKey: string; send: (frame: object) => boolean; logger: PluginLogger; loadAppSettings: () => AppSettings; newRequestId?: () => string }`
  - `createFrameRouter(deps: RouterDeps): (frame: unknown) => Promise<void>` — catches and logs every error; never rejects

Routing (spec "Frame routing"): `connected` → info log with `scope`, `authType`, `appId`; `reply_status` → `handleReplyStatus`; `send_result` → `v2Outbound.handleSendResult`; `whatsapp_message` → dedupe on `data.messageId` → `fromLegacyFrame` → gate → `handleInbound`; `event` → dedupe on envelope id → `parseV2Envelope` → for each failed status, dedupe on `wamid + ":failed"` → `handleFailedStatus`; for each message, dedupe on `messageId` → gate → `handleInbound`; else debug log.

Gate (App mode only, spec "Trusted-sender gate"): settings come from `loadAppSettings()` on every frame. Order: `poolNumberId` filter (debug log) → empty `allowFrom` (warning, logged once per router) → `isTrustedSender(message.sender, allowFrom)` else the untrusted info log (Global Constraints copy). Trusted → `handleInbound(..., { commandAuthorized: true })`. Sandbox → `handleInbound` with no `commandAuthorized`.

Reply closures from `message.replyTarget`: legacy → `send({ type: "whatsapp_reply", data: { conversationId, poolNumberId, toNumber, text } })`, and `trackOutboundReply(conversationId)` when it returns true. v2 → `requestId = newRequestId()` (default `crypto.randomUUID()`), `send(buildSendFrame(target, text, requestId))`, and `trackSend(requestId, message.sessionKey)` only when it returns true.

`service.ts`: compute `mode = resolveMode(apiKey)`, create the router with `loadAppSettings: () => resolveAppSettings(getPipesBotRuntime().config.loadConfig() as OpenClawConfig)`, and route every `connection` `message` event through it (keep the raw-message logs). Error copy on start: `pipes-bot-channel: invalid or missing API key (pk_ or ak_) -- not starting`.

- [ ] **Step 1: Write the failing tests** (`createRuntimeStub` from Task 7; `sent` collects frames from `send`)

```ts
const appRouter = (settings: AppSettings, sent: object[] = []) =>
  createFrameRouter({ mode: "app", apiKey: "ak_x", send: (f) => (sent.push(f), true), logger, loadAppSettings: () => settings, newRequestId: () => "req_1" });

test("trusted v2 sender is dispatched with CommandAuthorized and replies with send", async () => {
  const sent: object[] = [];
  await appRouter({ allowFrom: ["16505551234"] }, sent)({ type: "event", data: loadFixture("message-text") });
  expect(stub.contexts[0]).toMatchObject({ CommandAuthorized: true, SessionKey: "default:pn_abc123:US.13491208655302741918" });
  expect(sent[0]).toMatchObject({ type: "send", requestId: "req_1", poolNumberId: "pn_abc123", message: { to: "16505551234", text: { body: "agent reply" } } });
});
test("untrusted sender: not dispatched, no fetch, nothing sent, log names ids", ...) // image fixture, allowFrom ["15559998888"]; global fetch spy not called; info log contains "phone=16505551234 user_id=US.13491208655302741918"
test("other poolNumberId is ignored", ...)                    // poolNumberId "pn_other"
test("empty allowFrom drops and warns once", ...)             // two events → one warning with the exact copy
test("mixed envelope dispatches only the trusted sender", ...) // message-two-senders, allowFrom ["15559998888"]
test("allowFrom changes apply on the next frame", ...)        // settings object mutated between two different fixtures
test("duplicate envelope and duplicate wamid are dropped", ...) // same fixture twice; then message-text-username-with-phone (same wamid, new evt id) → 1 dispatch total
test("send_result failure becomes a system event", ...)       // after the trusted test's send, frame {type:"send_result", requestId:"req_1", success:false, error:{code:131047}}
test("sandbox frame bypasses the gate and replies with whatsapp_reply", ...) // mode "sandbox"; no CommandAuthorized key; sent[0].type "whatsapp_reply"
test("reply while disconnected warns and tracks nothing", ...) // send returns false; then send_result for req_1 enqueues nothing
test("malformed frames never throw or dispatch", async () => {
  const route = appRouter({ allowFrom: ["16505551234"] });
  for (const f of [null, "x", {}, { type: "event" }, { type: "event", data: {} }, { type: "send_result" }, { type: "whatsapp_message" }, { type: "nope" }]) {
    await expect(route(f)).resolves.toBeUndefined();
  }
  expect(stub.contexts).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- test/router.test.ts`, expected FAIL.
- [ ] **Step 3: Implement** `src/router.ts` and rewire `src/service.ts`.
- [ ] **Step 4: Run tests and type-check** — `npm test && npx tsc --noEmit`, expected PASS.
- [ ] **Step 5: Commit**

```bash
git add src/router.ts src/service.ts test/router.test.ts
git commit -m "feat: route v2 events through the trusted-sender gate"
```

---

### Task 9: Reconnect on API version change and status snapshot

**Files:**
- Modify: `src/connection.ts`, `src/channel.ts`, `src/service.ts`
- Test: `test/connection.test.ts`, `test/channel.test.ts`

**Interfaces:**
- Produces:
  - `new PipesBotConnection(apiKey: string, logger: PluginLogger, opts?: { baseUrl?: string })` — `baseUrl` default `wss://api.pipes.bot/ws`; URL is `${baseUrl}?apiKey=${encodeURIComponent(apiKey)}`
  - On `close` with code `4000`: reset `reconnectAttempts` to 0 and reconnect after 0 ms (other codes keep the backoff)
  - `buildAccountSnapshot` adds `mode` (`resolveMode` of the configured key, omitted with no key) and the error copy rules below

Snapshot `lastError` precedence: `authFailed` → `Authentication failed -- check your API key (pk_ for sandbox, ak_ for a BYON App)`; else `status.lastError`; else, in App mode with empty `resolveAppSettings(cfg).allowFrom`, `No trusted senders configured (allowFrom)`; else `runtime?.lastError ?? null`.

- [ ] **Step 1: Write the failing tests**

```ts
test("close 4000 reconnects immediately", async () => {
  const wss = new WebSocketServer({ port: 0 });
  let connections = 0;
  wss.on("connection", (ws) => { connections++; if (connections === 1) ws.close(4000, "api_version_changed"); });
  const port = (wss.address() as AddressInfo).port;
  const conn = new PipesBotConnection("ak_x", stubLogger(), { baseUrl: `ws://127.0.0.1:${port}/ws` });
  conn.connect();
  await vi.waitFor(() => expect(connections).toBe(2), { timeout: 500 });
  conn.disconnect(); wss.close();
});

test("snapshot reports app mode and the empty-allowlist error", () => {
  const snap = pipesBotChannelPlugin.status!.buildAccountSnapshot!({ account: {} as never, cfg: cfg({ apiKey: "ak_x" }) }) as ChannelAccountSnapshot;
  expect(snap).toMatchObject({ mode: "app", lastError: "No trusted senders configured (allowFrom)" });
});
test("snapshot reports sandbox mode with no allowlist error", ...)
test("auth failure copy mentions both key types", ...)        // updateConnectionStatus({ authFailed: true }) then reset in afterEach
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- test/connection.test.ts test/channel.test.ts`, expected FAIL.
- [ ] **Step 3: Implement** the connection option, the `4000` branch in the `close` handler (`ws.on("close", (code) => ...)`), and the snapshot.
- [ ] **Step 4: Run tests and type-check** — `npm test && npx tsc --noEmit`, expected PASS.
- [ ] **Step 5: Commit**

```bash
git add src/connection.ts src/channel.ts src/service.ts test/connection.test.ts test/channel.test.ts
git commit -m "feat: reconnect on API version change and report mode in status"
```

---

### Task 10: README, version and final verification

**Files:**
- Modify: `README.md`, `package.json`

- [ ] **Step 1: Update `package.json`**: `"version": "0.2.0"`, `"description": "WhatsApp channel via PipesBot (sandbox numbers and BYON Apps)"`.

- [ ] **Step 2: Update `README.md`**
  - Overview: sandbox (`pk_`) and BYON App (`ak_`, API v2) modes
  - Configuration: `apiKey`, `allowFrom`, `poolNumberId`, `enabled`, with an App mode example:
    ```json5
    { channels: { "pipes-bot-channel": { apiKey: "ak_live_…", allowFrom: ["+55 11 99999-0000", "US.13491208655302741918"], poolNumberId: "pn_abc123" } } }
    ```
  - Trusted senders: App numbers are public, so only `allowFrom` senders reach the agent; others are dropped silently; empty list drops everything; to find a sender's ids, read the `dropping message from untrusted sender phone=… user_id=…` log line
  - Behavior notes: echoes and statuses never reach the agent; trusted App senders get `CommandAuthorized`; media needs a PipesBot server with `ak_` media download (pipes-bot#72); if the App has a webhook URL, events received while the plugin is offline go to the webhook only and are not replayed
  - Architecture: add `router.ts`, `trust.ts`, `dedupe.ts`, `inbound-message.ts`, `adapters/`, `outbound-v2.ts`; update the message flow
  - Development: `npm test`

- [ ] **Step 3: Full verification**

Run: `npm test && npx tsc --noEmit && npm pack --dry-run`
Expected: all tests pass, no type errors, the tarball lists `src/**/*.ts` (including `src/adapters/*.ts`) and no `test/` files.

- [ ] **Step 4: Commit**

```bash
git add README.md package.json package-lock.json
git commit -m "docs: document BYON App mode and bump to 0.2.0"
```

- [ ] **Step 5: Manual end-to-end check (with your human partner)** — needs an `ak_` key for a v2 App, a number, and pipes-bot#72 in production: trusted phone (text, image, reply), untrusted phone (no reply, drop log with ids), and an echo from the WhatsApp Business app (ignored).
