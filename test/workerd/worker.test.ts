import { SELF } from "cloudflare:test";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createRelayMessenger,
  type RelayChatAgent,
} from "../../src/agent";
import { RELAY_MESSENGER_DELIVERY } from "@relaymessenger/think";

import type { Bindings } from "../../src/env";
import { starterModel } from "../../src/model";
import {
  TEST_REPLY_TEXT,
  TEST_SECOND_REPLY_TEXT,
  TEST_TRAILING_TEXT,
  TWO_SENDS_WORD,
} from "./harness";

// @relaymessenger/think's send Action keys each Message by the Relay Message
// it answers and its place in the turn, so a recovered turn replays it
// instead of sending it twice.
function relayReplyIdempotencyKey(messageId: string, number = 1): string {
  return `relay-agent:${messageId}:${number}`;
}

const WEBHOOK_SECRET = "test-secret";
const EVENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec11";
const AGENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec12";
const USER_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec15";
const DIRECT_CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec20";
const DIRECT_MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec21";
const DIRECT_EVENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec22";
const DIRECT_REPLY_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec23";
const GROUP_CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec30";
const GROUP_MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec31";
const GROUP_EVENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec32";
const GROUP_REPLY_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec33";
const QUIET_CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec40";
const QUIET_MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec41";
const QUIET_EVENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec42";
const RECOVERY_CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec50";
const RECOVERY_MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec51";
const RECOVERY_EVENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec52";
const RECOVERY_REPLY_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec53";
const TWO_CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec60";
const TWO_MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec61";
const TWO_EVENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec62";
const TWO_REPLY_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec63";

function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function signedRequest(
  event: Record<string, unknown>,
  tamper = false,
): Promise<Request> {
  const body = JSON.stringify(event);
  const eventId = event.event_id;
  if (typeof eventId !== "string") {
    throw new Error("Signed test event requires event_id");
  }
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${eventId}.${timestamp}.${body}`),
  );
  return new Request("https://starter.example/webhooks/relay", {
    body: tamper ? `${body} ` : body,
    headers: {
      "content-type": "application/json",
      "webhook-id": eventId,
      "webhook-signature": `v1,${base64(signature)}`,
      "webhook-timestamp": timestamp,
    },
    method: "POST",
  });
}

function envelope(
  eventId: string,
  eventType: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    agent_id: AGENT_ID,
    api_version: "v1",
    created_at: "2026-09-01T12:00:00.000Z",
    data,
    event_id: eventId,
    event_type: eventType,
    trace_id: "starter-workerd-test",
    webhook_version: "2026-08-30",
  };
}

function handle(id: string, handleName: string) {
  return {
    avatar_url: null,
    display_name: handleName,
    handle: handleName,
    id,
    joined_at: "2026-09-01T12:00:00.000Z",
    kind: "user",
    tagline: null,
    verified: false,
  };
}

function messageEnvelope(input: {
  chatId: string;
  eventId: string;
  isGroup: boolean;
  mentioned: boolean;
  messageId: string;
  text?: string;
}): Record<string, unknown> {
  const text = input.text ?? "please reply";
  const parts = input.mentioned
    ? [{
        mention: "starter_test",
        mention_range: [0, "starter_test".length],
        type: "text",
        value: `@starter_test ${text}`,
      }]
    : [{ type: "text", value: text }];
  return envelope(input.eventId, "message.received", {
    chat: {
      id: input.chatId,
      is_group: input.isGroup,
      owner_handle: {
        ...handle(AGENT_ID, "starter_test"),
        kind: "agent",
      },
    },
    direction: "inbound",
    id: input.messageId,
    parts,
    sender_handle: handle(USER_ID, "relay_user"),
  });
}

interface RelayRequest {
  body: string;
  headers: Headers;
  method: string;
  pathname: string;
}

interface CommittedRelayMessage {
  body: string;
  messageId: string;
}

function expectedReplyBody(
  messageId: string,
  number = 1,
  text = TEST_REPLY_TEXT,
) {
  const key = relayReplyIdempotencyKey(messageId, number);
  return {
    message: {
      parts: [{ type: "text", value: text }],
      idempotency_key: key,
    },
  };
}

function installRelayBackend(input: {
  chatId: string;
  precommitted?: {
    body: ReturnType<typeof expectedReplyBody>;
    key: string;
    messageId: string;
  };
  replyId: string;
}) {
  const calls: RelayRequest[] = [];
  const committed = new Map<string, CommittedRelayMessage>();
  let newCommits = 0;
  if (input.precommitted) {
    committed.set(input.precommitted.key, {
      body: JSON.stringify(input.precommitted.body),
      messageId: input.precommitted.messageId,
    });
  }

  const fetchMock = vi.fn(async (
    requestInput: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const request = new Request(requestInput, init);
    const body = await request.clone().text();
    const pathname = new URL(request.url).pathname;
    calls.push({
      body,
      headers: new Headers(request.headers),
      method: request.method,
      pathname,
    });

    if (
      pathname === `/v1/chats/${input.chatId}/read`
      && request.method === "POST"
    ) {
      return new Response(null, { status: 204 });
    }
    if (pathname === `/v1/chats/${input.chatId}/typing`) {
      return new Response(null, { status: 204 });
    }
    if (
      pathname === `/v1/chats/${input.chatId}/messages`
      && request.method === "POST"
    ) {
      const key = request.headers.get("idempotency-key");
      if (!key) throw new Error("Relay send omitted Idempotency-Key");
      const previous = committed.get(key);
      if (previous) {
        if (previous.body !== body) {
          return Response.json({
            error: { code: "idempotency_conflict" },
          }, { status: 409 });
        }
        return Response.json({
          chat_id: input.chatId,
          message: { id: previous.messageId },
        }, { status: 202 });
      }
      newCommits += 1;
      const messageId = newCommits === 1
        ? input.replyId
        : `${input.replyId.slice(0, -2)}${String(newCommits).padStart(2, "0")}`;
      committed.set(key, { body, messageId });
      return Response.json({
        chat_id: input.chatId,
        message: { id: messageId },
      }, { status: 202 });
    }
    throw new Error(`Unexpected Relay request: ${request.method} ${pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    committed,
    fetchMock,
    newCommits: () => newCommits,
  };
}

function expectCanonicalTurn(
  calls: RelayRequest[],
  chatId: string,
  messageId: string,
): void {
  // Typing goes up before the model runs and comes down after the one send.
  expect(calls.map(({ method, pathname }) => [method, pathname])).toEqual([
    ["POST", `/v1/chats/${chatId}/typing`],
    ["POST", `/v1/chats/${chatId}/read`],
    ["POST", `/v1/chats/${chatId}/messages`],
    ["DELETE", `/v1/chats/${chatId}/typing`],
  ]);
  const send = calls[2]!;
  const key = relayReplyIdempotencyKey(messageId);
  expect(send.headers.get("authorization")).toBe("Bearer relay-test-token");
  expect(send.headers.get("idempotency-key")).toBe(key);
  expect(JSON.parse(send.body)).toEqual(expectedReplyBody(messageId));
}

function bindings(): Bindings {
  return {
    AI: {} as Ai,
    MODEL_ID: "@cf/openai/gpt-oss-120b",
    RELAY_AGENT_HANDLE: "your_agent_handle",
    RELAY_AGENT_TOKEN: "relay-test-token",
    RELAY_API_ORIGIN: "https://api.staging.relayapp.im",
    RELAY_WEBHOOK_SECRET: "whsec_dGVzdC1zZWNyZXQ=",
    RelayChat: {} as DurableObjectNamespace<RelayChatAgent>,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Relay Think messenger", () => {
  it("uses the Worker-routed root Think conversation", () => {
    const messenger = createRelayMessenger(bindings());
    expect(messenger).toMatchObject({
      adapterName: "relay",
      conversation: "self",
      path: "/webhooks/relay",
      provider: "relay",
      respondTo: ["direct-message", "mention"],
      verifyWebhook: false,
    });
  });

  it("never posts the model's own text: only send calls make Messages", () => {
    const delivery = createRelayMessenger(bindings()).delivery;
    expect(delivery).toBe(RELAY_MESSENGER_DELIVERY);
    expect(delivery).toMatchObject({
      emptyResponseText: "",
      errorResponseText: "",
      interruptedResponseText: "",
      visibleSoftLimit: 0,
    });
    expect(delivery?.splitText?.("must not be posted")).toEqual([]);
  });

  it("keeps the replaceable model seam to one configured model ID", () => {
    expect(starterModel(bindings())).toBe("@cf/openai/gpt-oss-120b");
  });
});

describe("a person's swipe-reply reaches the model", () => {
  const TARGET_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec90";
  const thread = {
    channel: { name: undefined },
    channelId: `relay:${DIRECT_CHAT_ID}`,
    id: `relay:${DIRECT_CHAT_ID}`,
    isDM: true,
  };
  const target = {
    chat_id: DIRECT_CHAT_ID,
    created_at: "2026-09-27T11:00:00.000Z",
    delivery_status: "read",
    from_handle: { ...handle(AGENT_ID, "starter_test"), kind: "agent" },
    id: TARGET_ID,
    is_from_me: true,
    is_system_message: false,
    parts: [
      { type: "text", value: "The flight lands at 6.", reactions: null },
      { type: "text", value: "Take the long way round the lake.", reactions: null },
    ],
    updated_at: "2026-09-27T11:00:00.000Z",
  };

  async function modelText(read: () => Response): Promise<{ text: string; reads: string[] }> {
    const reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      reads.push(`${request.method} ${new URL(request.url).pathname}`);
      return read();
    }));
    const messenger = createRelayMessenger(bindings());
    const message = messenger.adapter.parseMessage({
      chatId: DIRECT_CHAT_ID,
      message: {
        chat: { id: DIRECT_CHAT_ID, is_group: false },
        direction: "inbound",
        id: DIRECT_MESSAGE_ID,
        parts: [{ type: "text", value: "what did you mean by this?" }],
        reply_to: { message_id: TARGET_ID, part_index: 1 },
        sender_handle: handle(USER_ID, "relay_user"),
      },
    } as never);
    const event = await messenger.toEvent({
      eventKind: "direct-message",
      message,
      thread,
    } as never) as { message?: { text: string } };
    return { text: event.message!.text, reads };
  }

  it("reads the Message it answers once and names who sent it and what it says", async () => {
    const { text, reads } = await modelText(() => Response.json(target));
    expect(reads).toEqual([`GET /v1/messages/${TARGET_ID}`]);
    const [words, line] = text.split("\n\n");
    expect(words).toBe("what did you mean by this?");
    expect(JSON.parse(line!.slice(line!.indexOf("{")))).toEqual({
      reply_to: {
        id: TARGET_ID,
        from: "you",
        part_index: 1,
        text: "Take the long way round the lake.",
      },
    });
  });

  it("names the target by id when it cannot be read", async () => {
    const { text } = await modelText(() => Response.json({ error: { code: 1004 } }, { status: 404 }));
    expect(text).toContain(`{"reply_to":{"id":"${TARGET_ID}","unavailable":true}}`);
  });
});

describe("signed messenger turns", () => {
  it("runs typing, Read, model, send Action, and one Message for a direct Chat", async () => {
    const relay = installRelayBackend({
      chatId: DIRECT_CHAT_ID,
      replyId: DIRECT_REPLY_ID,
    });
    const response = await SELF.fetch(
      await signedRequest(messageEnvelope({
        chatId: DIRECT_CHAT_ID,
        eventId: DIRECT_EVENT_ID,
        isGroup: false,
        mentioned: false,
        messageId: DIRECT_MESSAGE_ID,
      })),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      acknowledged: true,
      event_id: DIRECT_EVENT_ID,
      event_type: "message.received",
    });
    expectCanonicalTurn(relay.calls, DIRECT_CHAT_ID, DIRECT_MESSAGE_ID);
    expect(relay.committed.size).toBe(1);
    expect(relay.newCommits()).toBe(1);
  });

  it("runs the same canonical turn for a structured group mention", async () => {
    const relay = installRelayBackend({
      chatId: GROUP_CHAT_ID,
      replyId: GROUP_REPLY_ID,
    });
    const response = await SELF.fetch(
      await signedRequest(messageEnvelope({
        chatId: GROUP_CHAT_ID,
        eventId: GROUP_EVENT_ID,
        isGroup: true,
        mentioned: true,
        messageId: GROUP_MESSAGE_ID,
      })),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      acknowledged: true,
      event_id: GROUP_EVENT_ID,
      event_type: "message.received",
    });
    expectCanonicalTurn(relay.calls, GROUP_CHAT_ID, GROUP_MESSAGE_ID);
    expect(relay.committed.size).toBe(1);
    expect(relay.newCommits()).toBe(1);
  });

  it("makes two Messages when the model sends twice in one turn, and drops its trailing text", async () => {
    const relay = installRelayBackend({
      chatId: TWO_CHAT_ID,
      replyId: TWO_REPLY_ID,
    });
    const response = await SELF.fetch(
      await signedRequest(messageEnvelope({
        chatId: TWO_CHAT_ID,
        eventId: TWO_EVENT_ID,
        isGroup: false,
        mentioned: false,
        messageId: TWO_MESSAGE_ID,
        text: `please reply ${TWO_SENDS_WORD}`,
      })),
    );

    expect(response.status).toBe(200);
    expect(relay.calls.map(({ method, pathname }) => [method, pathname])).toEqual([
      ["POST", `/v1/chats/${TWO_CHAT_ID}/typing`],
      ["POST", `/v1/chats/${TWO_CHAT_ID}/read`],
      ["POST", `/v1/chats/${TWO_CHAT_ID}/messages`],
      ["POST", `/v1/chats/${TWO_CHAT_ID}/messages`],
      ["DELETE", `/v1/chats/${TWO_CHAT_ID}/typing`],
    ]);
    const sends = relay.calls.filter(({ pathname }) => pathname.endsWith("/messages"));
    expect(sends.map(({ headers }) => headers.get("idempotency-key"))).toEqual([
      relayReplyIdempotencyKey(TWO_MESSAGE_ID, 1),
      relayReplyIdempotencyKey(TWO_MESSAGE_ID, 2),
    ]);
    expect(sends.map(({ body }) => JSON.parse(body))).toEqual([
      expectedReplyBody(TWO_MESSAGE_ID, 1, TEST_REPLY_TEXT),
      expectedReplyBody(TWO_MESSAGE_ID, 2, TEST_SECOND_REPLY_TEXT),
    ]);
    expect(relay.newCommits()).toBe(2);
    expect(relay.calls.some(({ body }) => body.includes(TEST_TRAILING_TEXT))).toBe(false);
  });

  it("reclaims a stale Action claim and replays the committed Message", async () => {
    const threadId = `relay:${RECOVERY_CHAT_ID}`;
    const key = relayReplyIdempotencyKey(RECOVERY_MESSAGE_ID);
    const relay = installRelayBackend({
      chatId: RECOVERY_CHAT_ID,
      precommitted: {
        body: expectedReplyBody(RECOVERY_MESSAGE_ID),
        key,
        messageId: RECOVERY_REPLY_ID,
      },
      replyId: RECOVERY_REPLY_ID,
    });
    const seeded = await SELF.fetch(
      new Request("https://starter.example/__test/action-ledger", {
        body: JSON.stringify({
          messageId: RECOVERY_MESSAGE_ID,
          text: TEST_REPLY_TEXT,
          threadId,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(seeded.status).toBe(204);

    const response = await SELF.fetch(
      await signedRequest(messageEnvelope({
        chatId: RECOVERY_CHAT_ID,
        eventId: RECOVERY_EVENT_ID,
        isGroup: false,
        mentioned: false,
        messageId: RECOVERY_MESSAGE_ID,
      })),
    );
    expect(response.status).toBe(200);
    expectCanonicalTurn(relay.calls, RECOVERY_CHAT_ID, RECOVERY_MESSAGE_ID);
    expect(relay.newCommits()).toBe(0);
    expect(relay.committed).toEqual(new Map([
      [key, {
        body: JSON.stringify(expectedReplyBody(RECOVERY_MESSAGE_ID)),
        messageId: RECOVERY_REPLY_ID,
      }],
    ]));

    const ledger = await SELF.fetch(
      `https://starter.example/__test/action-ledger?threadId=${encodeURIComponent(threadId)}`,
    );
    expect(ledger.status).toBe(200);
    expect(await ledger.json()).toMatchObject({
      rows: [{
        key: `action:send:message:${RECOVERY_MESSAGE_ID}:1`,
        status: "settled",
      }],
    });
  });
});

describe("installed Worker", () => {
  it("reports a configured health route without exposing secrets", async () => {
    const response = await SELF.fetch("https://starter.example/healthz");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ ok: true });
    expect(body).not.toContain("relay-test-token");
  });

  it("rejects a body changed after signing", async () => {
    const response = await SELF.fetch(
      await signedRequest(envelope(EVENT_ID, "chat.created", {}), true),
    );
    expect(response.status).toBe(401);
  });

  it("acknowledges a signed current event through the Relay adapter", async () => {
    const response = await SELF.fetch(
      await signedRequest(envelope(EVENT_ID, "chat.created", {})),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      acknowledged: true,
      event_id: EVENT_ID,
      event_type: "chat.created",
    });
  });

  it("acknowledges but does not invoke an unmentioned group Message", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("Unmentioned group Message started a turn");
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await SELF.fetch(
      await signedRequest(messageEnvelope({
        chatId: QUIET_CHAT_ID,
        eventId: QUIET_EVENT_ID,
        isGroup: true,
        mentioned: false,
        messageId: QUIET_MESSAGE_ID,
      })),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      acknowledged: true,
      event_type: "message.received",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
