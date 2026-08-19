/**
 * Everything that talks to Relay: webhook verification, the API client, and the
 * two ordering rules that keep a redelivered event from double posting.
 *
 * Nothing in this file imports the Durable Object runtime, so it is testable in
 * plain Node.
 */
import { Webhook } from "standardwebhooks";

export interface RelayPart {
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
 * Idempotency key for one reply: the turn, the reply's position within the
 * turn, and a digest of what is being sent.
 *
 * The content term is the part that matters. Keyed on position alone, a retry
 * whose model wrote different words reuses the first key with a different body,
 * which Relay answers with 409 idempotency_conflict, and the turn can never
 * complete. With the digest in the key, an identical retry replays and a
 * different reply gets a new key.
 */
export async function replyIdempotencyKey(
  turnId: string,
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
  return `${turnId.slice(0, 180)}:${ordinal}:${hex}`;
}

export type AcceptOutcome =
  | { status: 202 }
  | { status: 200; reason: "duplicate" };

/**
 * One user turn. A single send can arrive as several message.received events
 * (Relay splits at ingest), and the agent should reply once to the turn, not
 * once per fragment. Events are grouped into a turn and the turn is what gets
 * processed, retried, and completed.
 */
export interface AcceptDependencies {
  /**
   * Status of the turn this event already belongs to, if the event was seen
   * before. Undefined for a first delivery.
   */
  lookupEvent(eventId: string): string | undefined;
  /**
   * Record the event durably and place it in a turn: join the turn still
   * collecting events for this send, or open a new one. Returns the turn and
   * whether it still needs its alarm (a joined turn already has one).
   */
  record(event: RelayEventReference): { turnId: string; needsAlarm: boolean };
  /** Arm the alarm that will close the window and do the work. */
  arm(turnId: string): Promise<void>;
  /** Move the new turn to 'collecting' once its alarm exists. */
  markCollecting(turnId: string): void;
  /** Move the new turn to 'failed' when arming threw. */
  markFailed(turnId: string, error: string): void;
}

/**
 * The ack contract, in one place so it can be tested without a Durable Object.
 *
 * 202 means Relay may stop retrying, so it is only returned once the ledger row
 * AND the alarm both exist. If arming throws, this rethrows: the Worker answers
 * 5xx and Relay redelivers. Returning 202 after a failed arm would drop the
 * reply on the floor.
 *
 * Every event of one batch lands in one turn, so a text+photo send gets one
 * reply, armed by whichever event opened the turn.
 */
export async function acceptRelayEvent(
  event: RelayEventReference,
  deps: AcceptDependencies,
): Promise<AcceptOutcome> {
  const existing = deps.lookupEvent(event.eventId);
  if (existing === "completed") return { status: 200, reason: "duplicate" };
  if (existing !== undefined && existing !== "failed") return { status: 202 };
  const turn = deps.record(event);
  if (!turn.needsAlarm) return { status: 202 };
  try {
    await deps.arm(turn.turnId);
  } catch (error) {
    deps.markFailed(turn.turnId, sanitizeFailure(error));
    throw error;
  }
  deps.markCollecting(turn.turnId);
  return { status: 202 };
}

export function sanitizeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

/** A Relay API rejection, carrying the HTTP status so retries can be classified. */
export class RelayRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RelayRequestError";
  }
}

/**
 * Should this failure be retried?
 *
 * A 4xx from Relay is a request Relay will refuse forever: a consumed
 * invocation, a validation error. Retrying it reaches the same rejection every
 * time, so it is terminal. 408 and 429 are the two transient 4xx codes.
 * Everything else (5xx, network failures, model errors) is worth another
 * attempt.
 */
export function isRetryableRelayError(error: unknown): boolean {
  if (!(error instanceof RelayRequestError)) return true;
  return error.status >= 500 || error.status === 408 || error.status === 429;
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
      throw new RelayRequestError(
        `Relay responding failed: ${response.status} ${await response.text()}`,
        response.status,
      );
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
      throw new RelayRequestError(
        `Relay send failed: ${response.status} ${await response.text()}`,
        response.status,
      );
    }
  }

  /**
   * Re-read the turn's inbound messages from Relay at reply time.
   *
   * The ledger stores identifiers only, never anything a user wrote, so the
   * canonical content is fetched here rather than parked in Durable Object
   * storage. One history read covers the whole batch. Returns the messages in
   * the order the ids were given; ids that are gone are skipped.
   */
  async fetchMessages(conversationId: string, messageIds: string[]): Promise<RelayMessage[]> {
    const response = await fetch(
      `${this.origin}/v1/conversations/${encodeURIComponent(conversationId)}/messages?limit=20`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    if (!response.ok) {
      throw new RelayRequestError(
        `Relay history failed: ${response.status} ${await response.text()}`,
        response.status,
      );
    }
    const payload = (await response.json()) as { messages?: RelayMessage[] };
    const byId = new Map((payload.messages ?? []).map((message) => [message.id, message]));
    return messageIds.flatMap((id) => {
      const message = byId.get(id);
      return message ? [message] : [];
    });
  }

  /** The agent's own identity, used to name itself in the reply. */
  async me(): Promise<{ handle: string; display_name: string }> {
    const response = await fetch(`${this.origin}/v1/agents/me`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      throw new RelayRequestError(
        `Relay identity failed: ${response.status} ${await response.text()}`,
        response.status,
      );
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

/** Plain text of a message. Array order is the part order; there is no index field. */
export function messageText(message: RelayMessage): string {
  return (message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * One user send can commit as several messages: Relay splits at ingest, one
 * message per visible non-media part, contiguous media as one message. This
 * flattens a whole turn's messages into what one reply should answer: the text
 * in order, and a count of the media the model cannot read.
 */
export function turnContent(messages: RelayMessage[]): { text: string; mediaCount: number } {
  const text = messages
    .map(messageText)
    .filter((entry) => entry.length > 0)
    .join("\n")
    .trim();
  const mediaCount = messages.reduce(
    (count, message) =>
      count
      + (message.parts ?? []).filter(
        (part) => part.type === "media" || part.type === "voice_memo",
      ).length,
    0,
  );
  return { text, mediaCount };
}
