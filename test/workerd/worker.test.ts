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

const WEBHOOK_SECRET = "test-secret";
const EVENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec11";
const AGENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec12";
const CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec13";
const MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec14";
const USER_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec15";
const REPLY_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec16";

function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function signedRequest(
  event: Record<string, unknown>,
  tamper = false,
): Promise<Request> {
  const body = JSON.stringify(event);
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
    new TextEncoder().encode(`${EVENT_ID}.${timestamp}.${body}`),
  );
  return new Request("https://starter.example/webhooks/relay", {
    body: tamper ? `${body} ` : body,
    headers: {
      "content-type": "application/json",
      "webhook-id": EVENT_ID,
      "webhook-signature": `v1,${base64(signature)}`,
      "webhook-timestamp": timestamp,
    },
    method: "POST",
  });
}

function envelope(
  eventType: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    agent_id: AGENT_ID,
    api_version: "v1",
    created_at: "2026-09-01T12:00:00.000Z",
    data,
    event_id: EVENT_ID,
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
  it("maps one Relay Chat to one Think thread conversation", () => {
    const messenger = createRelayMessenger(bindings());
    expect(messenger).toMatchObject({
      adapterName: "relay",
      conversation: "thread",
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
      await signedRequest(envelope("chat.created", {}), true),
    );
    expect(response.status).toBe(401);
  });

  it("acknowledges a signed current event through the Relay adapter", async () => {
    const response = await SELF.fetch(
      await signedRequest(envelope("chat.created", {})),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      acknowledged: true,
      event_id: EVENT_ID,
      event_type: "chat.created",
    });
  });

  it("acknowledges but does not invoke an unmentioned group Message", async () => {
    const response = await SELF.fetch(
      await signedRequest(envelope("message.received", {
        chat: {
          id: CHAT_ID,
          is_group: true,
          owner_handle: {
            ...handle(AGENT_ID, "starter_test"),
            kind: "agent",
          },
        },
        direction: "inbound",
        id: MESSAGE_ID,
        parts: [{ type: "text", value: "hello group" }],
        sender_handle: handle(USER_ID, "relay_user"),
      })),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      acknowledged: true,
      event_type: "message.received",
    });
  });
});
