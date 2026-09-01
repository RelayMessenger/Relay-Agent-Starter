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
import type { Bindings } from "../../src/env";
import { starterModel } from "../../src/model";
import {
  markRelayChatRead,
  relayReplyIdempotencyKey,
  sendRelayReply,
} from "../../src/reply";
import { TEST_REPLY_TEXT } from "./harness";

const WEBHOOK_SECRET = "test-secret";
const EVENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec11";
const AGENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec12";
const CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec13";
const MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec14";
const USER_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec15";
const REPLY_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec16";
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
}): Record<string, unknown> {
  const parts = input.mentioned
    ? [{
        mention: "starter_test",
        mention_range: [0, "starter_test".length],
        type: "text",
        value: "@starter_test please reply",
      }]
    : [{ type: "text", value: "please reply" }];
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

function expectedReplyBody(messageId: string) {
  const key = relayReplyIdempotencyKey(messageId);
  return {
    message: {
      idempotency_key: key,
      parts: [{ type: "text", value: TEST_REPLY_TEXT }],
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
      committed.set(key, { body, messageId: input.replyId });
      return Response.json({
        chat_id: input.chatId,
        message: { id: input.replyId },
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
  expect(calls.map(({ method, pathname }) => [method, pathname])).toEqual([
    ["POST", `/v1/chats/${chatId}/read`],
    ["POST", `/v1/chats/${chatId}/messages`],
  ]);
  const send = calls[1]!;
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

  it("buffers visible output and leaves one canonical send to the reply Action", () => {
    const delivery = createRelayMessenger(bindings()).delivery;
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

describe("canonical Relay delivery", () => {
  it("marks the Relay Chat Read through the current SDK route", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push([input, init]);
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await markRelayChatRead(bindings(), CHAT_ID);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = calls[0]!;
    expect(String(url)).toBe(
      `https://api.staging.relayapp.im/v1/chats/${CHAT_ID}/read`,
    );
    expect(init?.method).toBe("POST");
  });

  it("commits one Message with a recovery-stable idempotency key", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push([input, init]);
      return Response.json({
        chat_id: CHAT_ID,
        message: { id: REPLY_ID },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendRelayReply(
      bindings(),
      { chatId: CHAT_ID, messageId: MESSAGE_ID },
      "one complete answer",
    )).resolves.toEqual({
      messageId: REPLY_ID,
      status: "sent",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = calls[0]!;
    const key = relayReplyIdempotencyKey(MESSAGE_ID);
    expect(String(url)).toBe(
      `https://api.staging.relayapp.im/v1/chats/${CHAT_ID}/messages`,
    );
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization"))
      .toBe("Bearer relay-test-token");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(key);
    expect(JSON.parse(String(init?.body))).toEqual({
      message: {
        idempotency_key: key,
        parts: [{ type: "text", value: "one complete answer" }],
      },
    });
  });
});

describe("signed messenger turns", () => {
  it("runs Read, model, reply Action, and one Message for a direct Chat", async () => {
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
        key: `action:reply:message:${RECOVERY_MESSAGE_ID}`,
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
