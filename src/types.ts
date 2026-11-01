import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk";

// ── PipesBot message media field ─────────────────────────────────────────────

export type PipesBotMedia = {
  mediaId?: string;
  downloadUrl?: string;
  mimeType: string;
  fileName?: string;
  byteSize: number;
  unavailable?: boolean;
};

// ── PipesBot message location field ──────────────────────────────────────────

export type PipesBotLocation = {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
};

// ── PipesBot message contacts field ──────────────────────────────────────────

export type PipesBotContact = {
  name: { formatted_name: string };
  phones?: Array<{ phone: string; type?: string }>;
  emails?: Array<{ email: string; type?: string }>;
};

// ── PipesBot message reaction field ──────────────────────────────────────────

export type PipesBotReaction = {
  messageId: string;
  emoji?: string;
};

// ── PipesBot message data (all fields, type-specific fields optional) ─────────

export type PipesBotMessageData = {
  messageId: string;
  conversationId: string;
  poolNumberId: string;
  poolNumberPhoneNumber: string;
  fromNumber: string;
  fromName?: string;
  userId?: string;
  parentUserId?: string;
  username?: string;
  text: string;
  body: string;
  timestamp: string;
  label?: string;
  type:
    | "text"
    | "image"
    | "audio"
    | "video"
    | "document"
    | "sticker"
    | "location"
    | "contacts"
    | "reaction"
    | "unsupported";
  // Type-specific optional fields
  media?: PipesBotMedia;
  location?: PipesBotLocation;
  contacts?: PipesBotContact[];
  reaction?: PipesBotReaction;
};

// ── PipesBot message envelope ─────────────────────────────────────────────────

export type PipesBotMessage = {
  type: "whatsapp_message";
  data: PipesBotMessageData;
};

// ── Type guard ────────────────────────────────────────────────────────────────

export function isPipesBotMessage(msg: unknown): msg is PipesBotMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    (msg as { type: unknown }).type === "whatsapp_message" &&
    "data" in msg
  );
}

// ── PipesBot reply_status envelope ───────────────────────────────────────────

export type PipesBotReplyStatus = {
  type: "reply_status";
  data: {
    conversationId: string;
    success: boolean;
    messageId?: string; // Present on success
    error?: string; // Present on failure
    code?: string; // Present on failure
  };
};

export function isPipesBotReplyStatus(msg: unknown): msg is PipesBotReplyStatus {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    (msg as { type: unknown }).type === "reply_status" &&
    "data" in msg
  );
}

// ── PluginLogger convenience alias ────────────────────────────────────────────

export type PluginLogger = OpenClawPluginServiceContext["logger"];
