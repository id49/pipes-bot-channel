import type { PluginRuntime } from "openclaw/plugin-sdk";
import { isPipesBotReplyStatus } from "./types.js";
import type { PluginLogger } from "./types.js";

// ── Failure classification ────────────────────────────────────────────────────

export type ReplyFailureKind =
  | "SERVICE_WINDOW_EXPIRED"
  | "RATE_LIMITED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "SEND_FAILED"
  | "UNKNOWN";

// ── Pending reply tracking ────────────────────────────────────────────────────

type PendingReply = {
  conversationId: string;
  trackedAt: number;
  expiresAt: number;
};

const PENDING_TTL_MS = 30_000; // 30 seconds

const pendingReplies = new Map<string, PendingReply>();

/**
 * Track an outbound reply for reply_status correlation.
 * Performs lazy eviction of expired entries on each call.
 */
export function trackOutboundReply(conversationId: string): void {
  // Lazy eviction of expired entries
  const now = Date.now();
  for (const [key, entry] of pendingReplies) {
    if (now > entry.expiresAt) {
      pendingReplies.delete(key);
    }
  }

  pendingReplies.set(conversationId, {
    conversationId,
    trackedAt: now,
    expiresAt: now + PENDING_TTL_MS,
  });
}

// ── Reply status handler ──────────────────────────────────────────────────────

/**
 * Handle a reply_status event from PipesBot.
 * - Logs success events
 * - Classifies and logs failure events
 * - Enqueues agent-facing system event for SERVICE_WINDOW_EXPIRED failures
 */
export function handleReplyStatus(
  msg: unknown,
  opts: { logger: PluginLogger; core: PluginRuntime }
): void {
  if (!isPipesBotReplyStatus(msg)) return;

  const { data } = msg;

  // Look up and remove pending entry (we no longer need it after reply_status)
  const pending = pendingReplies.get(data.conversationId);
  pendingReplies.delete(data.conversationId);

  if (data.success) {
    opts.logger.info(
      `pipes-bot-channel: reply delivered to ${data.conversationId} (messageId: ${data.messageId})`
    );
    return;
  }

  // Failure path
  const kind = classifyReplyFailure(data.code);
  const message = buildFailureMessage(kind, data.error);

  opts.logger.error(
    `pipes-bot-channel: reply failed for ${data.conversationId}: [${kind}] ${data.error ?? "unknown error"}`
  );

  // Enqueue agent-facing system event if we had context for this conversation
  if (pending && data.conversationId) {
    opts.core.system.enqueueSystemEvent(message, {
      sessionKey: `default:${data.conversationId}`,
    });
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function classifyReplyFailure(code?: string): ReplyFailureKind {
  switch (code) {
    case "SERVICE_WINDOW_EXPIRED":
      return "SERVICE_WINDOW_EXPIRED";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "FORBIDDEN":
      return "FORBIDDEN";
    case "NOT_FOUND":
      return "NOT_FOUND";
    case "SEND_FAILED":
      return "SEND_FAILED";
    default:
      return "UNKNOWN";
  }
}

function buildFailureMessage(kind: ReplyFailureKind, raw?: string): string {
  if (kind === "SERVICE_WINDOW_EXPIRED") {
    return "Unable to send reply: the 24-hour WhatsApp messaging window has expired. The contact must send a new message to reopen the conversation.";
  }
  return `Reply failed: ${raw ?? kind}`;
}
