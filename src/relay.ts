/**
 * Relay v1 webhook shapes and the small REST client this starter needs.
 *
 * Source of truth:
 * ../_worktrees/Relay-Server-local/contracts/developer/openapi.yaml
 */
import { Webhook } from "standardwebhooks";

export const RELAY_OPENAPI_SHA256 =
  "8561112386f0fe92e125f2d93ac93c5b70a960722426cc1ee8f23bc260b2c8a5";
export const RELAY_WEBHOOK_VERSION = "2026-08-30";
export const RELAY_WEBHOOK_EVENT_TYPES = [
  "message.sent",
  "message.received",
  "message.read",
  "message.delivered",
  "reaction.added",
  "reaction.removed",
  "participant.added",
  "participant.removed",
  "chat.created",
  "chat.group_name_updated",
  "chat.group_icon_updated",
  "chat.typing_indicator.started",
  "chat.typing_indicator.stopped",
] as const;

export type RelayWebhookEventType =
  (typeof RELAY_WEBHOOK_EVENT_TYPES)[number];

export interface RelayChatHandle {
  id: string;
  handle: string;
  joined_at: string;
  kind?: "user" | "agent";
  is_me?: boolean | null;
}

export type RelayPart =
  | {
      type: "text";
      value: string;
      mention?: string | null;
      mention_range?: [number, number] | null;
    }
  | {
      type: "media";
      id: string;
      url: string;
      filename: string;
      mime_type: string;
      size_bytes: number;
    }
  | { type: "link"; value: string };

export interface RelayMessageEvent {
  chat: {
    id: string;
    is_group?: boolean | null;
    owner_handle?: RelayChatHandle | null;
  };
  id: string;
  direction: "inbound" | "outbound";
  sender_handle: RelayChatHandle;
  parts: RelayPart[];
  reply_to?: { message_id: string; part_index?: number } | null;
}

export interface RelayEventEnvelope {
  api_version: "v1";
  webhook_version: typeof RELAY_WEBHOOK_VERSION;
  event_id: string;
  event_type: RelayWebhookEventType;
  created_at: string;
  trace_id: string;
  agent_id: string;
  data?: RelayMessageEvent;
}

/** The complete verified event. This object is durably stored before 2xx. */
export interface RelayEventReference {
  eventId: string;
  chatId: string;
  messageId: string;
  envelope: RelayEventEnvelope;
}

/** True only for a structured mention of the receiving agent's Handle. */
export function mentionsAgent(
  message: RelayMessageEvent,
  agentHandle: string | undefined,
): boolean {
  const handle = agentHandle?.replace(/^@/, "").toLowerCase();
  if (!handle) return false;
  return message.parts.some((part) =>
    part.type === "text"
    && typeof part.mention === "string"
    && part.mention.replace(/^@/, "").toLowerCase() === handle);
}

export type GroupReplyPolicy = "mentions" | "all";

export function shouldReplyToMessage(input: {
  message: RelayMessageEvent;
  policy: GroupReplyPolicy;
}): boolean {
  if (!input.message.chat.is_group) return true;
  if (input.policy === "all") return true;
  return mentionsAgent(
    input.message,
    input.message.chat.owner_handle?.handle,
  );
}

/** Verify Standard Webhooks over the unmodified request body. */
export async function verifyRelayWebhook(
  request: Request,
  secret: string,
): Promise<string> {
  const body = await request.text();
  new Webhook(secret).verify(body, {
    "webhook-id": request.headers.get("webhook-id") ?? "",
    "webhook-timestamp": request.headers.get("webhook-timestamp") ?? "",
    "webhook-signature": request.headers.get("webhook-signature") ?? "",
  });
  return body;
}

/** Stable Durable Object name for one Chat. */
export async function chatInstanceName(chatId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(chatId),
  );
  return `chat-${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

/** Stable key for one logical reply body. */
export async function replyIdempotencyKey(
  eventId: string,
  ordinal: number,
  content: unknown,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(content)),
  );
  const hex = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("").slice(0, 32);
  return `${eventId.slice(0, 180)}:${ordinal}:${hex}`;
}

export type AcceptOutcome =
  | { status: 202 }
  | { status: 200; reason: "duplicate" };

export interface AcceptDependencies {
  lookup(eventId: string): string | undefined;
  /** Must commit the complete verified envelope durably. */
  record(event: RelayEventReference): void;
  /** Must create durable work before the webhook can be acknowledged. */
  arm(eventId: string): Promise<void>;
  markQueued(eventId: string): void;
  markFailed(eventId: string, error: string): void;
}

/** Durable acceptance ordering: event commit -> durable alarm -> 2xx. */
export async function acceptRelayEvent(
  event: RelayEventReference,
  deps: AcceptDependencies,
): Promise<AcceptOutcome> {
  const existing = deps.lookup(event.eventId);
  if (existing === "completed" || existing === "ignored") {
    return { status: 200, reason: "duplicate" };
  }
  if (existing !== undefined && existing !== "failed") return { status: 202 };
  deps.record(event);
  try {
    await deps.arm(event.eventId);
  } catch (error) {
    deps.markFailed(event.eventId, sanitizeFailure(error));
    throw error;
  }
  deps.markQueued(event.eventId);
  return { status: 202 };
}

export function needsRecoveryArm(status: string): boolean {
  return status === "accepting" || status === "processing";
}

export function sanitizeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

export class RelayRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "RelayRequestError";
  }
}

export function isRetryableRelayError(error: unknown): boolean {
  if (!(error instanceof RelayRequestError)) return true;
  return error.status >= 500 || error.status === 408 || error.status === 429;
}

/** Minimal client for the current Relay v1 Chats/Messages contract. */
export class RelayClient {
  constructor(
    private readonly origin: string,
    private readonly token: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  private async typing(chatId: string, method: "POST" | "DELETE"): Promise<void> {
    try {
      const response = await fetch(
        `${this.origin}/v1/chats/${encodeURIComponent(chatId)}/typing`,
        { method, headers: this.headers() },
      );
      await response.body?.cancel();
      if (!response.ok) {
        console.error(JSON.stringify({
          event: "relay_typing_indicator_failed",
          operation: method === "POST" ? "start" : "stop",
          status: response.status,
          chat_id: chatId,
        }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "relay_typing_indicator_failed",
        operation: method === "POST" ? "start" : "stop",
        error: sanitizeFailure(error),
        chat_id: chatId,
      }));
    }
  }

  async startTyping(chatId: string): Promise<void> {
    await this.typing(chatId, "POST");
  }

  async stopTyping(chatId: string): Promise<void> {
    await this.typing(chatId, "DELETE");
  }

  /** Mark every visible Message in the Chat Read. The route has no body. */
  async markRead(chatId: string): Promise<void> {
    try {
      const response = await fetch(
        `${this.origin}/v1/chats/${encodeURIComponent(chatId)}/read`,
        { method: "POST", headers: this.headers() },
      );
      if (!response.ok) {
        console.error(JSON.stringify({
          event: "relay_read_receipt_failed",
          status: response.status,
          chat_id: chatId,
        }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "relay_read_receipt_failed",
        error: sanitizeFailure(error),
        chat_id: chatId,
      }));
    }
  }

  async sendText(input: {
    chatId: string;
    text: string;
    idempotencyKey: string;
  }): Promise<void> {
    const response = await fetch(
      `${this.origin}/v1/chats/${encodeURIComponent(input.chatId)}/messages`,
      {
        method: "POST",
        headers: {
          ...this.headers(),
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify({
          message: {
            parts: [{ type: "text", value: input.text }],
          },
        }),
      },
    );
    if (!response.ok) {
      throw new RelayRequestError(
        `Relay send failed: ${response.status}`,
        response.status,
      );
    }
  }
}

export function messageText(message: RelayMessageEvent): string {
  return message.parts
    .flatMap((part) =>
      part.type === "text" || part.type === "link" ? [part.value] : [])
    .join("\n")
    .trim();
}

export function messageContent(
  message: RelayMessageEvent,
): { text: string; mediaCount: number } {
  return {
    text: messageText(message),
    mediaCount: message.parts.filter((part) => part.type === "media").length,
  };
}
