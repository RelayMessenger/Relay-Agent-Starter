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
  /**
   * A mention on a text part, as Relay carries it today: the target's handle,
   * lowercase and without the leading `@`, plus the [start, end) UTF-16 range
   * it occupies in `text`. One mention per text part.
   */
  mention?: string;
  mention_range?: [number, number];
  /**
   * The same idea in the vocabulary the deployed server still speaks: a list of
   * ranges naming a participant id. Read for as long as it answers in it.
   */
  mentions?: { start: number; length: number; participant_id: string }[];
}

export interface RelayMessage {
  id: string;
  conversation_id: string;
  sequence?: number;
  sender?: { kind?: "user" | "agent" | "system"; id?: string };
  fallback_text?: string;
  parts?: RelayPart[];
  /**
   * The deployed server's structured group targets: the agent ids a group
   * message was aimed at. Relay's rule was that these, not the words in the
   * text, were authority.
   */
  invoked_agents?: string[];
}

export interface RelayEventEnvelope {
  event_id: string;
  event_type: string;
  /** The agent this event was delivered to. Its own id, free of a lookup. */
  agent_id?: string;
  created_at?: string;
  data?: {
    message?: RelayMessage;
    /**
     * HISTORICAL. Relay minted an invocation for every group delivery and made
     * it the permission to speak: the reply, the read call and the typing call
     * all had to carry it. The server no longer mints one and no longer checks
     * one. Nothing here depends on its presence — it is forwarded when an event
     * still carries one, so a group reply and a group typing signal keep
     * working against the server production has not been cut over from yet.
     */
    invocation_id?: string;
  };
}

/** Just enough of an event to drive a reply, and nothing a user wrote. */
export interface RelayEventReference {
  eventId: string;
  conversationId: string;
  messageId: string;
  /** HISTORICAL, forwarded only. See RelayEventEnvelope.data.invocation_id. */
  invocationId?: string;
}

/**
 * True when this message names this agent.
 *
 * The rule is Relay's own, copied from the server rather than designed here:
 * a mention is the STRUCTURED field a client attaches, matched against the
 * agent's handle — Relay's own push path decides a group notification exactly
 * this way — and the words in the text carry no authority ("Structured group
 * targets. Text mentions are presentation, never authority"). So `@youragent`
 * typed into a message that carries no mention is people talking ABOUT the
 * agent, and it stays out of it.
 *
 * Both vocabularies are read, because one build has to serve the server
 * production runs today and the one it is being cut over to:
 *  - `part.mention` is the live shape, and names a handle;
 *  - `invoked_agents` and `part.mentions[].participant_id` are the deployed
 *    server's, and name an agent id.
 */
export function mentionsAgent(
  message: RelayMessage,
  agent: { handle?: string; id?: string },
): boolean {
  const handle = agent.handle?.replace(/^@/, "").toLowerCase();
  if (handle) {
    const named = (message.parts ?? []).some((part) =>
      part.type === "text"
      && typeof part.mention === "string"
      && part.mention.replace(/^@/, "").toLowerCase() === handle);
    if (named) return true;
  }
  if (agent.id) {
    if ((message.invoked_agents ?? []).includes(agent.id)) return true;
    const targeted = (message.parts ?? []).some((part) =>
      part.type === "text"
      && (part.mentions ?? []).some((mention) => mention.participant_id === agent.id));
    if (targeted) return true;
  }
  return false;
}

/** What an agent does with a group message it was not named in. */
export type GroupReplyPolicy = "mentions" | "all";

/**
 * Should this turn get a reply?
 *
 * Relay used to answer this for the agent: a group agent was only ever
 * delivered a message it had been invoked on. The server no longer gates that,
 * so a group agent now hears everything and decides for itself.
 *
 * A direct message is always answered. A group message is answered when the
 * agent is named in ANY message of the turn — one user send can commit as
 * several messages and only the fragment holding the `@` carries the mention,
 * so asking the whole turn is what keeps "@agent [photo]" working.
 *
 * `policy: "all"` is for an agent whose job really is to read the whole room —
 * a transcriber, a moderator. It is not the default, because an agent that
 * answers every message in a group is the thing the invocation existed to
 * prevent.
 */
export function shouldReplyToTurn(input: {
  isGroup: boolean;
  messages: RelayMessage[];
  agent: { handle?: string; id?: string };
  policy: GroupReplyPolicy;
}): boolean {
  if (!input.isGroup) return true;
  if (input.policy === "all") return true;
  return input.messages.some((message) => mentionsAgent(message, input.agent));
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

/**
 * Which turns a cold start must re-arm. A schedule() task is consumed when its
 * callback starts, so an isolate evicted mid-processTurn leaves a 'processing'
 * turn with no alarm coming back for it — and redeliveries of its events
 * answer 202 without arming one. 'accepting' and 'collecting' rows can predate
 * a confirmed alarm the same way. 'queued' retries were armed by a fresh
 * schedule() write that survives eviction, and terminal turns are done.
 */
export function needsRecoveryArm(status: string): boolean {
  return status === "accepting" || status === "collecting" || status === "processing";
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
 * A 4xx from Relay is a request Relay will refuse forever: a validation error,
 * a chat this agent is not in. Retrying it reaches the same rejection every
 * time, so it is terminal. 408 and 429 are the two transient 4xx codes.
 * Everything else (5xx, network failures, model errors) is worth another
 * attempt.
 *
 * A consumed invocation used to be the common case here. It no longer exists.
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
   * One request against a route that hangs off a single conversation, tried
   * under both names Relay has for that collection.
   *
   * `/v1/chats/...` is the live name. `/v1/conversations/...` is the name the
   * deployed server still answers to, and the one its compatibility bridge
   * keeps alive through the cutover. Only a 404 falls through to the second
   * spelling, so a server that speaks either one is served by this same build
   * and no other status is retried.
   */
  private async conversationScoped(
    conversationId: string,
    suffix: string,
    init: RequestInit,
  ): Promise<Response> {
    const id = encodeURIComponent(conversationId);
    const live = await fetch(`${this.origin}/v1/chats/${id}${suffix}`, init);
    if (live.status !== 404) return live;
    return fetch(`${this.origin}/v1/conversations/${id}${suffix}`, init);
  }

  /**
   * Mark the inbound message Read. Do this before model work, so the sender
   * sees Read while they wait.
   *
   * This and `startTyping` are what the old combined `/responding` call did in
   * one round trip. That route is gone, and neither half is worth failing a
   * turn over: a receipt that did not land is a missing "Read", while a thrown
   * error here would burn a retry and eventually drop a reply the person is
   * waiting on. So the failure is logged and the turn continues.
   */
  async markRead(conversationId: string, messageId: string): Promise<void> {
    try {
      const response = await this.conversationScoped(conversationId, "/read", {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ message_id: messageId }),
      });
      if (!response.ok) {
        console.error(JSON.stringify({
          event: "relay_read_receipt_failed",
          status: response.status,
          conversation_id: conversationId,
        }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "relay_read_receipt_failed",
        error: sanitizeFailure(error),
        conversation_id: conversationId,
      }));
    }
  }

  /**
   * Start or stop typing. Best effort in both directions: never fail a reply
   * that is already composed over the typist.
   *
   * `invocationId` is forwarded when an event still carries one. The live
   * server ignores the field; the deployed one refuses group typing without it,
   * so forwarding what arrived is what keeps the typist visible in a group
   * until the cutover lands.
   */
  private async sendTyping(
    conversationId: string,
    started: boolean,
    invocationId?: string,
  ): Promise<void> {
    await this.conversationScoped(conversationId, "/typing", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        started,
        ...(invocationId ? { invocation_id: invocationId } : {}),
      }),
    }).catch(() => {});
  }

  /** Start typing, beside the Read receipt, before any model work. */
  async startTyping(conversationId: string, invocationId?: string): Promise<void> {
    await this.sendTyping(conversationId, true, invocationId);
  }

  /** Stop typing. Best effort: never fail a delivered reply over this. */
  async stopTyping(conversationId: string, invocationId?: string): Promise<void> {
    await this.sendTyping(conversationId, false, invocationId);
  }

  /**
   * Is this conversation a group? Read once per conversation and cached by the
   * caller: a thread does not change kind.
   *
   * `is_group` is the live field and `kind` is the deployed server's; either
   * answers, under either name for the chat itself.
   */
  async isGroup(conversationId: string): Promise<boolean> {
    const response = await this.conversationScoped(conversationId, "", {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      throw new RelayRequestError(
        `Relay chat lookup failed: ${response.status} ${await response.text()}`,
        response.status,
      );
    }
    const payload = (await response.json()) as {
      chat?: { is_group?: boolean; kind?: string };
      conversation?: { is_group?: boolean; kind?: string };
    };
    const chat = payload.chat ?? payload.conversation;
    if (chat?.is_group !== undefined) return chat.is_group;
    return chat?.kind === "group";
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
    const response = await this.conversationScoped(conversationId, "/messages?limit=20", {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}` },
    });
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

  /**
   * The agent's own identity: how it names itself in a reply, and the handle a
   * mention has to match. `/v1/agents/me` kept its name and its shape through
   * the rename, so it needs no fallback.
   */
  async me(): Promise<{ id: string; handle: string; display_name: string }> {
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
      agent?: { id?: string; handle?: string; display_name?: string };
    };
    return {
      id: payload.agent?.id ?? "",
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
