import type { ReplyTarget } from "./inbound-message.js";
import type { PluginLogger, V2SendResult } from "./types.js";
import type { V2FailedStatus } from "./adapters/v2.js";

export type V2Deps = {
  logger: PluginLogger;
  enqueueSystemEvent: (text: string, opts: { sessionKey: string }) => void;
};

export type V2SendFrame = {
  type: "send";
  requestId: string;
  poolNumberId: string;
  message: {
    messaging_product: "whatsapp";
    recipient_type: "individual";
    to?: string;
    recipient?: string;
    type: "text";
    text: { body: string };
  };
};

// ── Frame building ────────────────────────────────────────────────────────────

export function buildSendFrame(
  target: Extract<ReplyTarget, { kind: "v2" }>,
  text: string,
  requestId: string
): V2SendFrame {
  // Phone numbers go in `to`; BSUID-only senders (no phone) go in `recipient`.
  const address = target.to !== undefined ? { to: target.to } : { recipient: target.recipient };
  return {
    type: "send",
    requestId,
    poolNumberId: target.poolNumberId,
    message: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      ...address,
      type: "text",
      text: { body: text },
    },
  };
}

// ── Failure classification ────────────────────────────────────────────────────

const WINDOW_EXPIRED_CODE = 131047;

// An empty string carries no detail, so it counts as absent.
const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

export function classifyV2Failure(error: unknown): string {
  if (typeof error === "string") return `Reply failed: ${error}`;
  if (typeof error !== "object" || error === null) return "Reply failed: unknown error";

  const { code, message, title } = error as {
    code?: unknown;
    message?: unknown;
    title?: unknown;
  };

  if (typeof code === "number") {
    if (code === WINDOW_EXPIRED_CODE) {
      return "Unable to send reply: the 24-hour WhatsApp messaging window has expired. The contact must send a new message to reopen the conversation.";
    }
    const detail = nonEmpty(message) ?? nonEmpty(title);
    return detail !== undefined
      ? `Reply failed: Meta error ${code}: ${detail}`
      : `Reply failed: Meta error ${code}`;
  }
  if (typeof code === "string") {
    const detail = nonEmpty(message);
    return detail !== undefined ? `Reply failed: ${code}: ${detail}` : `Reply failed: ${code}`;
  }
  return `Reply failed: ${nonEmpty(message) ?? "unknown error"}`;
}

// ── Send tracking ─────────────────────────────────────────────────────────────

type Tracked = { sessionKey: string; expiresAt: number };

const PENDING_TTL_MS = 30_000; // 30 seconds
const SENT_TTL_MS = 86_400_000; // 24 hours
const SENT_MAX_ENTRIES = 1_000;

/**
 * Correlates v2 `send` frames with their `send_result` and with later Meta
 * `failed` status events, turning failures into agent-facing system events.
 */
export class V2Outbound {
  private readonly now: () => number;
  private readonly pendingSends = new Map<string, Tracked>();
  private readonly sentMessages = new Map<string, Tracked>();

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Track an outbound send until its send_result arrives. Lazily evicts expired entries. */
  trackSend(requestId: string, sessionKey: string): void {
    const now = this.now();
    evictExpired(this.pendingSends, now);
    this.pendingSends.set(requestId, { sessionKey, expiresAt: now + PENDING_TTL_MS });
  }

  handleSendResult(frame: V2SendResult, deps: V2Deps): void {
    const now = this.now();
    const pending = this.takePending(frame.requestId, now);

    if (frame.success) {
      deps.logger.info(`pipes-bot-channel: v2 reply delivered (messageId: ${frame.messageId})`);
      if (pending && frame.messageId) this.recordSent(frame.messageId, pending.sessionKey, now);
      return;
    }

    const message = classifyV2Failure(frame.error);
    deps.logger.error(
      `pipes-bot-channel: v2 reply failed [requestId=${frame.requestId ?? "-"}]: ${message}`
    );
    if (pending) deps.enqueueSystemEvent(message, { sessionKey: pending.sessionKey });
  }

  handleFailedStatus(status: V2FailedStatus, deps: V2Deps): void {
    const now = this.now();
    const sent = this.sentMessages.get(status.wamid);
    this.sentMessages.delete(status.wamid);
    if (!sent || now > sent.expiresAt) return;

    const message = classifyV2Failure(status.error);
    deps.logger.error(`pipes-bot-channel: v2 message ${status.wamid} failed: ${message}`);
    deps.enqueueSystemEvent(message, { sessionKey: sent.sessionKey });
  }

  private takePending(requestId: string | undefined, now: number): Tracked | undefined {
    if (requestId === undefined) return undefined;
    const pending = this.pendingSends.get(requestId);
    this.pendingSends.delete(requestId);
    return pending && now <= pending.expiresAt ? pending : undefined;
  }

  private recordSent(wamid: string, sessionKey: string, now: number): void {
    evictExpired(this.sentMessages, now);
    this.sentMessages.delete(wamid); // re-insert so it counts as newest
    this.sentMessages.set(wamid, { sessionKey, expiresAt: now + SENT_TTL_MS });
    while (this.sentMessages.size > SENT_MAX_ENTRIES) {
      const oldest = this.sentMessages.keys().next().value;
      if (oldest === undefined) break;
      this.sentMessages.delete(oldest);
    }
  }
}

function evictExpired(map: Map<string, Tracked>, now: number): void {
  for (const [key, entry] of map) {
    if (now > entry.expiresAt) map.delete(key);
  }
}
