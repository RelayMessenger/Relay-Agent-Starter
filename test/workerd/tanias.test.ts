import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { searchMenu, SNAPSHOT_MENU } from "../../src/menu";
import { relayReplyIdempotencyKey } from "../../src/reply";
import { FALLBACK_REPLY } from "../../src/agent";
import { MENU_TRIGGER, NO_REPLY_TRIGGER } from "./harness";

const RELAY_SECRET = "test-secret";
const CAL_SECRET = "cal-test-secret";
const AGENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ed01";

let sequence = 0;
function uuid(prefix: string): string {
  sequence += 1;
  return `${prefix}-ef7b-7b37-886b-${String(sequence).padStart(12, "0")}`;
}

function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function hmac(secret: string, body: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
}

async function relayWebhook(input: {
  chatId: string;
  isGroup?: boolean;
  messageId: string;
  senderId: string;
  text: string;
}): Promise<Request> {
  const eventId = uuid("01993d51");
  const body = JSON.stringify({
    agent_id: AGENT_ID,
    api_version: "v1",
    created_at: "2026-09-24T18:00:00.000Z",
    data: {
      chat: {
        id: input.chatId,
        is_group: input.isGroup ?? false,
        owner_handle: {
          avatar_url: null,
          display_name: "Tania's Pizza",
          handle: "taniaspizza",
          id: AGENT_ID,
          joined_at: "2026-09-01T12:00:00.000Z",
          kind: "agent",
          tagline: null,
          verified: false,
        },
      },
      direction: "inbound",
      id: input.messageId,
      parts: [{ type: "text", value: input.text }],
      sender_handle: {
        avatar_url: null,
        display_name: "Customer",
        handle: "customer",
        id: input.senderId,
        joined_at: "2026-09-01T12:00:00.000Z",
        kind: "user",
        tagline: null,
        verified: false,
      },
    },
    event_id: eventId,
    event_type: "message.received",
    trace_id: "tanias-workerd-test",
    webhook_version: "2026-08-30",
  });
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signature = await hmac(RELAY_SECRET, `${eventId}.${timestamp}.${body}`);
  return new Request("https://tanias.example/webhooks/relay", {
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": eventId,
      "webhook-signature": `v1,${base64(signature)}`,
      "webhook-timestamp": timestamp,
    },
    method: "POST",
  });
}

async function calWebhook(event: unknown, secret = CAL_SECRET): Promise<Request> {
  const body = JSON.stringify(event);
  const digest = new Uint8Array(await hmac(secret, body));
  return new Request("https://tanias.example/webhooks/cal", {
    body,
    headers: {
      "content-type": "application/json",
      "x-cal-signature-256": [...digest].map((b) => b.toString(16).padStart(2, "0")).join(""),
    },
    method: "POST",
  });
}

interface RecordedCall {
  body: string;
  headers: Headers;
  method: string;
  pathname: string;
}

function installRelay(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const pathname = new URL(request.url).pathname;
    calls.push({
      body: await request.clone().text(),
      headers: new Headers(request.headers),
      method: request.method,
      pathname,
    });
    if (pathname.endsWith("/read")) return new Response(null, { status: 204 });
    if (pathname.endsWith("/messages")) {
      return Response.json({ message: { id: uuid("01993d52") } }, { status: 202 });
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  }));
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("menu turn", () => {
  it("looks up the menu, then sends one Message with the item's Toast link", async () => {
    const calls = installRelay();
    const chatId = uuid("01993d53");
    const messageId = uuid("01993d54");
    const response = await SELF.fetch(await relayWebhook({
      chatId,
      messageId,
      senderId: uuid("01993d55"),
      text: `${MENU_TRIGGER} can I get a large deluxe?`,
    }));
    expect(response.status).toBe(200);

    const expectedLink = searchMenu(SNAPSHOT_MENU, "14 deluxe pizza")[0]!.orderLink;
    expect(expectedLink).toMatch(/^https:\/\/taniaspizza\.toast\.site\/order\/tanias-pizza\/item-14-deluxe-pizza_/u);
    expect(calls.map((c) => [c.method, c.pathname])).toEqual([
      ["POST", `/v1/chats/${chatId}/read`],
      ["POST", `/v1/chats/${chatId}/messages`],
    ]);
    const send = calls[1]!;
    expect(send.headers.get("idempotency-key")).toBe(relayReplyIdempotencyKey(messageId));
    expect(JSON.parse(send.body)).toEqual({
      message: {
        idempotency_key: relayReplyIdempotencyKey(messageId),
        parts: [{ type: "text", value: `Here you go: ${expectedLink}` }],
      },
    });
  });
});

describe("turn without a reply", () => {
  it("sends one fallback Message under the reply's idempotency key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = installRelay();
    const chatId = uuid("01993d5c");
    const messageId = uuid("01993d5d");
    const response = await SELF.fetch(await relayWebhook({
      chatId,
      messageId,
      senderId: uuid("01993d5e"),
      text: `${NO_REPLY_TRIGGER} hello`,
    }));
    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(calls.filter((c) => c.pathname.endsWith("/messages"))).toHaveLength(1);
    });
    const send = calls.find((c) => c.pathname.endsWith("/messages"))!;
    expect(send.headers.get("idempotency-key")).toBe(relayReplyIdempotencyKey(messageId));
    expect(JSON.parse(send.body).message.parts).toEqual([{ type: "text", value: FALLBACK_REPLY }]);
  });
});

describe("health", () => {
  it("reports which integrations are live without secrets", async () => {
    const response = await SELF.fetch("https://tanias.example/healthz");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      integrations: { catering: "phone", cateringWebhook: true, menu: "snapshot" },
      ok: true,
    });
    expect(body).not.toContain("cal-test-secret");
  });
});

describe("Cal.com catering decisions", () => {
  const decision = (chatId: string, triggerEvent: string, status: string) => ({
    createdAt: "2026-10-01T12:00:00Z",
    payload: {
      metadata: { relay_chat_id: chatId },
      startTime: "2026-10-10T16:00:00.000Z",
      status,
      uid: "bk_workerd",
    },
    triggerEvent,
  });

  it("messages the customer's chat once when Tania's confirms", async () => {
    const calls = installRelay();
    const chatId = uuid("01993d56");
    const response = await SELF.fetch(await calWebhook(decision(chatId, "BOOKING_CREATED", "ACCEPTED")));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ delivered: true, status: "accepted" });
    expect(calls).toHaveLength(1);
    const key = "tanias-pizza-agent:catering:bk_workerd:accepted";
    expect(calls[0]!.pathname).toBe(`/v1/chats/${chatId}/messages`);
    expect(calls[0]!.headers.get("idempotency-key")).toBe(key);
    const text = JSON.parse(calls[0]!.body).message.parts[0].value as string;
    expect(text).toContain("confirmed your catering for Saturday, October 10, 2026 at 12:00 PM");

    // The decision is in the chat's Think history for the next turn.
    const history = await SELF.fetch(`https://tanias.example/__test/history?chatId=${chatId}`);
    const { messages } = await history.json<{ messages: Array<{ role: string; parts: Array<{ text?: string }> }> }>();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "assistant" });
    expect(messages[0]!.parts[0]!.text).toBe(text);
  });

  it("rejects an unsigned or tampered decision", async () => {
    const calls = installRelay();
    const request = await calWebhook(decision(uuid("01993d57"), "BOOKING_CREATED", "ACCEPTED"), "wrong");
    expect((await SELF.fetch(request)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("ignores events that need no customer message", async () => {
    const calls = installRelay();
    const response = await SELF.fetch(await calWebhook(decision(uuid("01993d58"), "BOOKING_REQUESTED", "PENDING")));
    expect(await response.json()).toEqual({ ignored: true });
    expect(calls).toHaveLength(0);
  });
});

describe("per-sender rate limit", () => {
  it("acknowledges but stops routing a person's messages past 20 a minute", async () => {
    // Unmentioned group Messages never start a model turn, so this isolates
    // the Worker's limiter from model behavior. The limiter uses fixed
    // 60-second windows, so a run may straddle one boundary: the first 20
    // always pass, and a rejection must come within two windows' worth.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("no Relay calls expected");
    }));
    const senderId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const bodies: unknown[] = [];
    for (let index = 0; index < 41; index += 1) {
      const response = await SELF.fetch(await relayWebhook({
        chatId,
        isGroup: true,
        messageId: crypto.randomUUID(),
        senderId,
        text: "just chatting",
      }));
      expect(response.status).toBe(200);
      const body = await response.json();
      bodies.push(body);
      if ((body as { ignored?: string }).ignored === "rate_limited") break;
    }
    expect(bodies.slice(0, 20).every((b) => (b as { acknowledged?: boolean }).acknowledged)).toBe(true);
    expect(bodies.at(-1)).toEqual({ ignored: "rate_limited" });
  }, 120_000);
});
