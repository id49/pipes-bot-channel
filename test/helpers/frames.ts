import type { PipesBotMessage, PipesBotMessageData } from "../../src/types.js";

export function legacyFrame(overrides: Partial<PipesBotMessageData> = {}): PipesBotMessage {
  return {
    type: "whatsapp_message",
    data: {
      messageId: "msg_1",
      conversationId: "conv_1",
      poolNumberId: "pool_1",
      poolNumberPhoneNumber: "+15550001111",
      fromNumber: "+5511999990000",
      fromName: "Ana",
      type: "text",
      body: "oi",
      text: "oi",
      timestamp: "2026-11-01T10:00:00.000Z",
      ...overrides,
    },
  };
}
