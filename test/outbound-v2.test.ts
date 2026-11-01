import { test, expect, vi } from "vitest";
import { V2Outbound, buildSendFrame, classifyV2Failure } from "../src/outbound-v2.js";
import type { V2Deps } from "../src/outbound-v2.js";

const WINDOW_EXPIRED =
  "Unable to send reply: the 24-hour WhatsApp messaging window has expired. The contact must send a new message to reopen the conversation.";

function setup() {
  let t = 1_000_000;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const enqueueSystemEvent = vi.fn();
  const deps: V2Deps = { logger, enqueueSystemEvent };
  const out = new V2Outbound({ now: () => t });
  return {
    out,
    deps,
    logger,
    enqueueSystemEvent,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test("send frame uses to for phones and recipient for BSUIDs", () => {
  expect(
    buildSendFrame({ kind: "v2", poolNumberId: "pn_1", to: "16505551234" }, "hi", "req_1")
  ).toEqual({
    type: "send",
    requestId: "req_1",
    poolNumberId: "pn_1",
    message: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "16505551234",
      type: "text",
      text: { body: "hi" },
    },
  });
  const bsuid = buildSendFrame({ kind: "v2", poolNumberId: "pn_1", recipient: "US.1" }, "hi", "req_1");
  expect(bsuid.message).toMatchObject({ recipient: "US.1" });
  expect(bsuid.message).not.toHaveProperty("to");
});

test("classifyV2Failure", () => {
  expect(classifyV2Failure({ code: 131047, message: "Re-engagement message" })).toBe(WINDOW_EXPIRED);
  expect(classifyV2Failure({ code: 131062, message: "x" })).toBe("Reply failed: Meta error 131062: x");
  expect(classifyV2Failure({ code: 131049, title: "t" })).toBe("Reply failed: Meta error 131049: t");
  expect(classifyV2Failure({ code: "NOT_FOUND", message: "BYON number not found" })).toBe(
    "Reply failed: NOT_FOUND: BYON number not found"
  );
  expect(classifyV2Failure({ message: "boom" })).toBe("Reply failed: boom");
  expect(classifyV2Failure(undefined)).toBe("Reply failed: unknown error");
});

test("classifyV2Failure treats empty message and title as absent", () => {
  expect(classifyV2Failure({ code: "NOT_FOUND", message: "" })).toBe("Reply failed: NOT_FOUND");
  expect(classifyV2Failure({ code: 131062, message: "", title: "t" })).toBe("Reply failed: Meta error 131062: t");
  expect(classifyV2Failure({ code: 131062, message: "", title: "" })).toBe("Reply failed: Meta error 131062");
  expect(classifyV2Failure({ message: "" })).toBe("Reply failed: unknown error");
});

test("classifyV2Failure edge cases", () => {
  expect(classifyV2Failure({ code: 131026 })).toBe("Reply failed: Meta error 131026");
  expect(classifyV2Failure({ code: "FORBIDDEN" })).toBe("Reply failed: FORBIDDEN");
  expect(classifyV2Failure("plain failure")).toBe("Reply failed: plain failure");
  expect(classifyV2Failure(null)).toBe("Reply failed: unknown error");
  expect(classifyV2Failure(42)).toBe("Reply failed: unknown error");
  expect(classifyV2Failure({})).toBe("Reply failed: unknown error");
});

test("failed send_result enqueues on the tracked session", () => {
  const { out, deps, logger, enqueueSystemEvent } = setup();
  out.trackSend("req_1", "default:pn_1:US.1");
  out.handleSendResult(
    { type: "send_result", success: false, requestId: "req_1", error: { code: "FORBIDDEN", message: "m" } },
    deps
  );
  expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
  expect(enqueueSystemEvent).toHaveBeenCalledWith("Reply failed: FORBIDDEN: m", {
    sessionKey: "default:pn_1:US.1",
  });
  expect(logger.error).toHaveBeenCalledWith(
    "pipes-bot-channel: v2 reply failed [requestId=req_1]: Reply failed: FORBIDDEN: m"
  );
});

test("the pending entry is removed once a result arrives", () => {
  const { out, deps, enqueueSystemEvent } = setup();
  out.trackSend("req_1", "s1");
  const frame = { type: "send_result" as const, success: false, requestId: "req_1", error: { code: "NOT_FOUND" } };
  out.handleSendResult(frame, deps);
  out.handleSendResult(frame, deps);
  expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
});

test("expired pending entry enqueues nothing", () => {
  const { out, deps, logger, enqueueSystemEvent, advance } = setup();
  out.trackSend("req_1", "s1");
  advance(30_001);
  out.handleSendResult(
    { type: "send_result", success: false, requestId: "req_1", error: { code: "INTERNAL_ERROR", message: "m" } },
    deps
  );
  expect(enqueueSystemEvent).not.toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledTimes(1);
});

test("pending entry is still valid at exactly the TTL", () => {
  const { out, deps, enqueueSystemEvent, advance } = setup();
  out.trackSend("req_1", "s1");
  advance(30_000);
  out.handleSendResult({ type: "send_result", success: false, requestId: "req_1" }, deps);
  expect(enqueueSystemEvent).toHaveBeenCalledWith("Reply failed: unknown error", { sessionKey: "s1" });
});

test("failed send_result with a missing or unknown requestId only logs", () => {
  const { out, deps, logger, enqueueSystemEvent } = setup();
  out.trackSend("req_1", "s1");
  out.handleSendResult({ type: "send_result", success: false, error: { code: "FORBIDDEN", message: "m" } }, deps);
  out.handleSendResult(
    { type: "send_result", success: false, requestId: "req_other", error: { code: "FORBIDDEN", message: "m" } },
    deps
  );
  expect(enqueueSystemEvent).not.toHaveBeenCalled();
  expect(logger.error).toHaveBeenNthCalledWith(
    1,
    "pipes-bot-channel: v2 reply failed [requestId=-]: Reply failed: FORBIDDEN: m"
  );
  expect(logger.error).toHaveBeenNthCalledWith(
    2,
    "pipes-bot-channel: v2 reply failed [requestId=req_other]: Reply failed: FORBIDDEN: m"
  );
});

test("successful send_result logs the message id and enqueues nothing", () => {
  const { out, deps, logger, enqueueSystemEvent } = setup();
  out.trackSend("req_1", "s1");
  out.handleSendResult({ type: "send_result", success: true, requestId: "req_1", messageId: "wamid.A" }, deps);
  expect(logger.info).toHaveBeenCalledWith("pipes-bot-channel: v2 reply delivered (messageId: wamid.A)");
  expect(enqueueSystemEvent).not.toHaveBeenCalled();
});

test("successful send_result with unknown requestId only logs", () => {
  const { out, deps, logger, enqueueSystemEvent } = setup();
  out.handleSendResult({ type: "send_result", success: true, messageId: "wamid.A" }, deps);
  expect(logger.info).toHaveBeenCalledWith("pipes-bot-channel: v2 reply delivered (messageId: wamid.A)");
  out.handleFailedStatus({ wamid: "wamid.A", error: { code: 131047 } }, deps);
  expect(enqueueSystemEvent).not.toHaveBeenCalled();
});

test("failed status for our wamid enqueues once; unknown wamid does not", () => {
  const { out, deps, logger, enqueueSystemEvent } = setup();
  out.trackSend("req_1", "default:pn_1:US.1");
  out.handleSendResult({ type: "send_result", success: true, requestId: "req_1", messageId: "wamid.A" }, deps);

  out.handleFailedStatus({ wamid: "wamid.UNKNOWN", error: { code: 131047 } }, deps);
  expect(enqueueSystemEvent).not.toHaveBeenCalled();

  out.handleFailedStatus({ wamid: "wamid.A", error: { code: 131047 } }, deps);
  expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
  expect(enqueueSystemEvent).toHaveBeenCalledWith(WINDOW_EXPIRED, { sessionKey: "default:pn_1:US.1" });
  expect(logger.error).toHaveBeenCalledWith(`pipes-bot-channel: v2 message wamid.A failed: ${WINDOW_EXPIRED}`);

  // entry was consumed
  out.handleFailedStatus({ wamid: "wamid.A", error: { code: 131047 } }, deps);
  expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
});

test("failed status without error classifies as unknown", () => {
  const { out, deps, enqueueSystemEvent } = setup();
  out.trackSend("req_1", "s1");
  out.handleSendResult({ type: "send_result", success: true, requestId: "req_1", messageId: "wamid.A" }, deps);
  out.handleFailedStatus({ wamid: "wamid.A" }, deps);
  expect(enqueueSystemEvent).toHaveBeenCalledWith("Reply failed: unknown error", { sessionKey: "s1" });
});

test("sent message entries expire after 24h", () => {
  const { out, deps, enqueueSystemEvent, advance } = setup();
  out.trackSend("req_1", "s1");
  out.handleSendResult({ type: "send_result", success: true, requestId: "req_1", messageId: "wamid.A" }, deps);
  advance(86_400_001);
  out.handleFailedStatus({ wamid: "wamid.A", error: { code: 131047 } }, deps);
  expect(enqueueSystemEvent).not.toHaveBeenCalled();
});

test("sent messages are capped at 1,000 with the oldest evicted", () => {
  const { out, deps, enqueueSystemEvent } = setup();
  for (let i = 0; i < 1001; i++) {
    out.trackSend(`req_${i}`, `s${i}`);
    out.handleSendResult({ type: "send_result", success: true, requestId: `req_${i}`, messageId: `wamid.${i}` }, deps);
  }
  out.handleFailedStatus({ wamid: "wamid.0", error: { code: 131047 } }, deps);
  expect(enqueueSystemEvent).not.toHaveBeenCalled();
  out.handleFailedStatus({ wamid: "wamid.1", error: { code: 131047 } }, deps);
  out.handleFailedStatus({ wamid: "wamid.1000", error: { code: 131047 } }, deps);
  expect(enqueueSystemEvent).toHaveBeenCalledTimes(2);
  expect(enqueueSystemEvent).toHaveBeenNthCalledWith(1, WINDOW_EXPIRED, { sessionKey: "s1" });
  expect(enqueueSystemEvent).toHaveBeenNthCalledWith(2, WINDOW_EXPIRED, { sessionKey: "s1000" });
});

test("successful send_result without messageId records nothing", () => {
  const { out, deps, enqueueSystemEvent } = setup();
  out.trackSend("req_1", "s1");
  out.handleSendResult({ type: "send_result", success: true, requestId: "req_1" }, deps);
  out.handleFailedStatus({ wamid: "undefined", error: { code: 131047 } }, deps);
  expect(enqueueSystemEvent).not.toHaveBeenCalled();
});
