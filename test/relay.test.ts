import { Webhook } from "standardwebhooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acceptRelayEvent,
  type AcceptDependencies,
  chatInstanceName,
  type RelayEventEnvelope,
  type RelayEventReference,
  type RelayMessageEvent,
  RelayClient,
  RELAY_OPENAPI_SHA256,
  RELAY_WEBHOOK_EVENT_TYPES,
  RelayRequestError,
  isRetryableRelayError,
  mentionsAgent,
  messageContent,
  needsRecoveryArm,
  replyIdempotencyKey,
  shouldReplyToMessage,
  verifyRelayWebhook,
} from "../src/relay";

const SECRET = "whsec_" + Buffer.from("relay-agent-starter-test-secret").toString("base64");

const OWNER = {
  id: "01993d50-ef7b-7b37-886b-23fd80c7ec10",
  handle: "helper",
  joined_at: "2026-08-29T00:00:00.000Z",
  kind: "agent" as const,
  is_me: true,
};

const SENDER = {
  id: "01993d50-ef7b-7b37-886b-23fd80c7ec11",
  handle: "advait",
  joined_at: "2026-08-29T00:00:00.000Z",
  kind: "user" as const,
};

function message(overrides: Partial<RelayMessageEvent> = {}): RelayMessageEvent {
  return {
    chat: {
      id: "01993d50-ef7b-7b37-886b-23fd80c7ec12",
      is_group: false,
      owner_handle: OWNER,
    },
    id: "01993d50-ef7b-7b37-886b-23fd80c7ec13",
    direction: "inbound",
    sender_handle: SENDER,
    parts: [{ type: "text", value: "Hello" }],
    ...overrides,
  };
}

function envelope(data = message()): RelayEventEnvelope {
  return {
    api_version: "v1",
    webhook_version: "2026-08-30",
    event_id: "01993d50-ef7b-7b37-886b-23fd80c7ec14",
    event_type: "message.received",
    created_at: "2026-08-29T00:00:00.000Z",
    trace_id: "trace-test",
    agent_id: OWNER.id,
    data,
  };
}

function signedRequest(body: string, secret = SECRET): Request {
  const timestamp = new Date();
  const id = "01993d50-ef7b-7b37-886b-23fd80c7ec14";
  return new Request("https://agent.example/webhooks/relay", {
    method: "POST",
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "webhook-signature": new Webhook(secret).sign(id, timestamp, body),
    },
    body,
  });
}

describe("Standard Webhooks", () => {
  it("verifies the exact raw body", async () => {
    const body = JSON.stringify(envelope());
    await expect(verifyRelayWebhook(signedRequest(body), SECRET)).resolves.toBe(body);
  });

  it("rejects tampering and unsigned requests", async () => {
    const signed = signedRequest(JSON.stringify(envelope()));
    const tampered = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: "{}",
    });
    await expect(verifyRelayWebhook(tampered, SECRET)).rejects.toThrow();
    await expect(verifyRelayWebhook(
      new Request(signed.url, { method: "POST", body: "{}" }),
      SECRET,
    )).rejects.toThrow();
  });
});

describe("current MessageEvent shape", () => {
  it("is pinned to the current OpenAPI and all 13 event names", () => {
    expect(RELAY_OPENAPI_SHA256).toBe(
      "8561112386f0fe92e125f2d93ac93c5b70a960722426cc1ee8f23bc260b2c8a5",
    );
    expect(RELAY_WEBHOOK_EVENT_TYPES).toEqual([
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
    ]);
  });

  it("reads text values and counts media", () => {
    expect(messageContent(message({
      parts: [
        { type: "text", value: "one" },
        {
          type: "media",
          id: "01993d50-ef7b-7b37-886b-23fd80c7ec15",
          url: "https://files.example/photo.png",
          filename: "photo.png",
          mime_type: "image/png",
          size_bytes: 12,
        },
        { type: "link", value: "https://relayapp.im" },
        { type: "text", value: "two" },
      ],
    }))).toEqual({
      text: "one\nhttps://relayapp.im\ntwo",
      mediaCount: 1,
    });
  });

  it("uses only structured mentions", () => {
    expect(mentionsAgent(message({
      parts: [{ type: "text", value: "@helper hi", mention: "helper" }],
    }), "helper")).toBe(true);
    expect(mentionsAgent(message({
      parts: [{ type: "text", value: "@helper is useful" }],
    }), "helper")).toBe(false);
  });

  it("answers DMs and mention-gates groups", () => {
    expect(shouldReplyToMessage({ message: message(), policy: "mentions" })).toBe(true);
    expect(shouldReplyToMessage({
      message: message({
        chat: { ...message().chat, is_group: true },
      }),
      policy: "mentions",
    })).toBe(false);
    expect(shouldReplyToMessage({
      message: message({
        chat: { ...message().chat, is_group: true },
        parts: [{ type: "text", value: "@helper help", mention: "helper" }],
      }),
      policy: "mentions",
    })).toBe(true);
  });
});

describe("durable acceptance", () => {
  function ledger() {
    const rows = new Map<string, string>();
    const order: string[] = [];
    let saved: RelayEventReference | undefined;
    const deps: AcceptDependencies = {
      lookup: (id) => rows.get(id),
      record: (event) => {
        order.push("record");
        saved = event;
        rows.set(event.eventId, "accepting");
      },
      arm: async () => { order.push("arm"); },
      markQueued: (id) => {
        order.push("queued");
        rows.set(id, "queued");
      },
      markFailed: (id) => rows.set(id, "failed"),
    };
    return { rows, order, deps, saved: () => saved };
  }

  const event: RelayEventReference = {
    eventId: envelope().event_id,
    chatId: message().chat.id,
    messageId: message().id,
    envelope: envelope(),
  };

  it("saves the complete envelope and arms work before 202", async () => {
    const state = ledger();
    await expect(acceptRelayEvent(event, state.deps)).resolves.toEqual({ status: 202 });
    expect(state.order).toEqual(["record", "arm", "queued"]);
    expect(state.saved()?.envelope.data?.parts[0]).toEqual({ type: "text", value: "Hello" });
  });

  it("does not acknowledge when durable scheduling fails", async () => {
    const state = ledger();
    state.deps.arm = async () => { throw new Error("alarm unavailable"); };
    await expect(acceptRelayEvent(event, state.deps)).rejects.toThrow("alarm unavailable");
    expect(state.rows.get(event.eventId)).toBe("failed");
  });

  it("deduplicates event_id", async () => {
    const state = ledger();
    await acceptRelayEvent(event, state.deps);
    state.rows.set(event.eventId, "completed");
    state.order.length = 0;
    await expect(acceptRelayEvent(event, state.deps)).resolves.toEqual({
      status: 200,
      reason: "duplicate",
    });
    expect(state.order).toEqual([]);
  });
});

describe("current REST request shapes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("marks a Chat Read with no request body", async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await new RelayClient("https://api.relayapp.im", "token").markRead("chat/id");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.relayapp.im/v1/chats/chat%2Fid/read");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
  });

  it("sends through the Chat message route with current part names", async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => Response.json({}, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await new RelayClient("https://api.relayapp.im", "token").sendText({
      chatId: "chat/id",
      text: "hello",
      idempotencyKey: "reply-key",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.relayapp.im/v1/chats/chat%2Fid/messages");
    expect(init?.headers).toMatchObject({ "Idempotency-Key": "reply-key" });
    expect(JSON.parse(String(init?.body))).toEqual({
      message: { parts: [{ type: "text", value: "hello" }] },
    });
  });

  it("starts and stops typing with empty Chat-route requests", async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new RelayClient("https://api.relayapp.im", "token");
    await client.startTyping("chat/id");
    await client.stopTyping("chat/id");
    expect(fetchMock.mock.calls.map(([url, init]) => ({
      url,
      method: init?.method,
      body: init?.body,
      authorization: new Headers(init?.headers).get("Authorization"),
    }))).toEqual([
      {
        url: "https://api.relayapp.im/v1/chats/chat%2Fid/typing",
        method: "POST",
        body: undefined,
        authorization: "Bearer token",
      },
      {
        url: "https://api.relayapp.im/v1/chats/chat%2Fid/typing",
        method: "DELETE",
        body: undefined,
        authorization: "Bearer token",
      },
    ]);
  });
});

describe("small reliability helpers", () => {
  it("derives stable, content-sensitive idempotency keys", async () => {
    const first = await replyIdempotencyKey("event", 0, { value: "one" });
    expect(first).toBe(await replyIdempotencyKey("event", 0, { value: "one" }));
    expect(first).not.toBe(await replyIdempotencyKey("event", 0, { value: "two" }));
  });

  it("uses stable per-Chat Durable Object names", async () => {
    expect(await chatInstanceName("chat")).toBe(await chatInstanceName("chat"));
    expect(await chatInstanceName("chat")).not.toBe(await chatInstanceName("other"));
  });

  it("re-arms only work that could have lost its alarm", () => {
    expect(needsRecoveryArm("accepting")).toBe(true);
    expect(needsRecoveryArm("processing")).toBe(true);
    expect(needsRecoveryArm("queued")).toBe(false);
  });

  it("retries transient Relay failures only", () => {
    expect(isRetryableRelayError(new RelayRequestError("bad", 400))).toBe(false);
    expect(isRetryableRelayError(new RelayRequestError("busy", 429))).toBe(true);
    expect(isRetryableRelayError(new RelayRequestError("down", 503))).toBe(true);
  });
});
