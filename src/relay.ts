/**
 * Everything that talks to Relay: webhook verification, the API client, and the
 * two ordering rules that keep a redelivered event from double posting.
 *
 * Nothing in this file imports the Durable Object runtime, so it is testable in
 * plain Node.
 */
import { Webhook } from "standardwebhooks";

export interface RelayPart {
  part_index?: number;
  type: "text" | "media" | "voice_memo" | "link_preview" | "data";
  text?: string;
  url?: string;
  attachment_id?: string;
  data?: unknown;
}

export interface RelayMessage {
  id: string;
  conversation_id: string;
  sequence?: number;
  sender?: { kind?: "user" | "agent" | "system"; id?: string };
  fallback_text?: string;
  parts?: RelayPart[];
}

export interface RelayEventEnvelope {
  event_id: string;
  event_type: string;
  agent_id?: string;
  created_at?: string;
  data?: {
    message?: RelayMessage;
    /**
     * Group deliveries only. The reply, the /responding call, and the typing
     * call must all carry it or Relay rejects them.
     */
    invocation_id?: string;
  };
}

/** Just enough of an event to drive a reply, and nothing a user wrote. */
export interface RelayEventReference {
  eventId: string;
  conversationId: string;
  messageId: string;
  invocationId?: string;
}

/**
 * Verify the Standard Webhooks signature over the exact raw body, before any
 * parsing. Reading the body any other way first (request.json()) breaks the
 * signature, because it is computed over these exact bytes.
 */
export async function verifyRelayWebhook(request: Request, secret: string): Promise<string> {
  const body = await request.text();
  new Webhook(secret).verify(body, {
    "webhook-id": request.headers.get("webhook-id") ?? "",
    "webhook-timestamp": request.headers.get("webhook-timestamp") ?? "",
    "webhook-signature": request.headers.get("webhook-signature") ?? "",
  });
  return body;
}

/** Stable Durable Object name for one conversation. */
export async function conversationInstanceName(conversationId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(conversationId));
  return `conversation-${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

/**
 * Idempotency key for one reply: the event, the reply's position, and a digest
 * of what is being sent.
 *
 * The content term is the part that matters. Keyed on position alone, a retry
 * whose model wrote different words reuses the first key with a different body,
 * which Relay answers with 409 idempotency_conflict, and the event can never
 * complete. With the digest in the key, an identical retry replays and a
 * different reply gets a new key.
 */
export async function replyIdempotencyKey(
  eventId: string,
  ordinal: number,
  content: unknown,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(content)),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
  return `${eventId.slice(0, 180)}:${ordinal}:${hex}`;
}

export type AcceptOutcome =
  | { status: 202 }
  | { status: 200; reason: "duplicate" }
  | { status: 204; reason: "ignored" };

export interface AcceptDependencies {
  /** Existing ledger status for this event, if any. */
  lookup(eventId: string): string | undefined;
  /** Write the 'accepting' row. Must be durable before the alarm is armed. */
  record(event: RelayEventReference): void;
  /** Arm the alarm that will do the work. */
  arm(event: RelayEventReference): Promise<void>;
  /** Move the row to 'queued' once the alarm exists. */
  markQueued(eventId: string): void;
  /** Move the row to 'failed' when arming threw. */
  markFailed(eventId: string, error: string): void;
}

/**
 * The ack contract, in one place so it can be tested without a Durable Object.
 *
 * 202 means Relay may stop retrying, so it is only returned once the ledger row
 * AND the alarm both exist. If arming throws, this rethrows: the Worker answers
 * 5xx and Relay redelivers. Returning 202 after a failed arm would drop the
 * reply on the floor.
 */
export async function acceptRelayEvent(
  event: RelayEventReference,
  deps: AcceptDependencies,
): Promise<AcceptOutcome> {
  const existing = deps.lookup(event.eventId);
  if (existing === "completed") return { status: 200, reason: "duplicate" };
  if (existing === "accepting" || existing === "queued" || existing === "processing") {
    return { status: 202 };
  }
  deps.record(event);
  try {
    await deps.arm(event);
  } catch (error) {
    deps.markFailed(event.eventId, sanitizeFailure(error));
    throw error;
  }
  deps.markQueued(event.eventId);
  return { status: 202 };
}

export function sanitizeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

/** Client for Relay's public agent API. */
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

  /**
   * Mark the inbound message Read and start the typing signal, in one call.
   * Do this before model work, so the sender sees Read while they wait.
   */
  async beginResponding(
    conversationId: string,
    messageId: string,
    invocationId?: string,
  ): Promise<void> {
    const response = await fetch(
      `${this.origin}/v1/conversations/${encodeURIComponent(conversationId)}/responding`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          message_id: messageId,
          ...(invocationId ? { invocation_id: invocationId } : {}),
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Relay responding failed: ${response.status} ${await response.text()}`);
    }
  }

  /** Stop typing. Best effort: never fail a delivered reply over this. */
  async stopTyping(conversationId: string, invocationId?: string): Promise<void> {
    await fetch(`${this.origin}/v1/conversations/${encodeURIComponent(conversationId)}/typing`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        started: false,
        ...(invocationId ? { invocation_id: invocationId } : {}),
      }),
    }).catch(() => {});
  }

  async sendText(input: {
    conversationId: string;
    text: string;
    idempotencyKey: string;
    invocationId?: string;
  }): Promise<void> {
    const response = await fetch(`${this.origin}/v1/messages`, {
      method: "POST",
      headers: { ...this.headers(), "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({
        conversation_id: input.conversationId,
        parts: [{ type: "text", text: input.text }],
        fallback_text: input.text,
        ...(input.invocationId ? { invocation_id: input.invocationId } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`Relay send failed: ${response.status} ${await response.text()}`);
    }
  }

  /**
   * Re-read the inbound message from Relay at reply time.
   *
   * The ledger stores identifiers only, never anything a user wrote, so the
   * canonical text is fetched here rather than parked in Durable Object
   * storage. Returns undefined if the message is gone.
   */
  async fetchMessage(conversationId: string, messageId: string): Promise<RelayMessage | undefined> {
    const response = await fetch(
      `${this.origin}/v1/conversations/${encodeURIComponent(conversationId)}/messages?limit=10`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    if (!response.ok) {
      throw new Error(`Relay history failed: ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as { messages?: RelayMessage[] };
    return (payload.messages ?? []).find((message) => message.id === messageId);
  }

  /** The agent's own identity, used to name itself in the reply. */
  async me(): Promise<{ handle: string; display_name: string }> {
    const response = await fetch(`${this.origin}/v1/agents/me`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      throw new Error(`Relay identity failed: ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as {
      agent?: { handle?: string; display_name?: string };
    };
    return {
      handle: payload.agent?.handle ?? "agent",
      display_name: payload.agent?.display_name ?? "Agent",
    };
  }
}

/** Plain text of a message, joining its text parts in order. */
export function messageText(message: RelayMessage): string {
  return (message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .sort((a, b) => (a.part_index ?? 0) - (b.part_index ?? 0))
    .map((part) => part.text)
    .join("\n")
    .trim();
}
