import { Webhook } from "standardwebhooks";
import { describe, expect, it, vi } from "vitest";

import {
  acceptRelayEvent,
  type AcceptDependencies,
  conversationInstanceName,
  messageText,
  type RelayEventReference,
  replyIdempotencyKey,
  verifyRelayWebhook,
} from "../src/relay";

const SECRET = "whsec_" + Buffer.from("relay-agent-starter-test-secret").toString("base64");

function signedRequest(body: string, secret = SECRET, id = "msg_test"): Request {
  const timestamp = new Date();
  const signature = new Webhook(secret).sign(id, timestamp, body);
  return new Request("https://agent.example/webhooks/relay", {
    method: "POST",
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "webhook-signature": signature,
      "Content-Type": "application/json",
    },
    body,
  });
}

describe("verifyRelayWebhook", () => {
  it("returns the exact raw body for a valid signature", async () => {
    const body = JSON.stringify({ event_id: "evt_1", event_type: "message.received" });
    await expect(verifyRelayWebhook(signedRequest(body), SECRET)).resolves.toBe(body);
  });

  it("rejects a body that changed after signing", async () => {
    const request = signedRequest(JSON.stringify({ event_id: "evt_1" }));
    const tampered = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({ event_id: "evt_2" }),
    });
    await expect(verifyRelayWebhook(tampered, SECRET)).rejects.toThrow();
  });

  it("rejects a signature made with another secret", async () => {
    const other = "whsec_" + Buffer.from("a-completely-different-secret").toString("base64");
    const request = signedRequest(JSON.stringify({ event_id: "evt_1" }), other);
    await expect(verifyRelayWebhook(request, SECRET)).rejects.toThrow();
  });

  it("rejects a request carrying no signature headers", async () => {
    const unsigned = new Request("https://agent.example/webhooks/relay", {
      method: "POST",
      body: "{}",
    });
    await expect(verifyRelayWebhook(unsigned, SECRET)).rejects.toThrow();
  });
});

describe("replyIdempotencyKey", () => {
  const content = [{ type: "text", text: "Tomorrow at 2:00 PM works." }];

  it("is stable for the same event, position, and content", async () => {
    const first = await replyIdempotencyKey("evt_1", 0, content);
    const second = await replyIdempotencyKey("evt_1", 0, content);
    expect(first).toBe(second);
  });

  it("changes when the content changes at the same position", async () => {
    // This is the whole point of the digest term. Position-only keys make a
    // retry with different words collide as 409 idempotency_conflict.
    const first = await replyIdempotencyKey("evt_1", 0, content);
    const second = await replyIdempotencyKey("evt_1", 0, [
      { type: "text", text: "Thursday at 2:00 PM works." },
    ]);
    expect(first).not.toBe(second);
  });

  it("ignores key order in the content", async () => {
    const first = await replyIdempotencyKey("evt_1", 0, { type: "text", text: "hi" });
    const second = await replyIdempotencyKey("evt_1", 0, { text: "hi", type: "text" });
    expect(first).toBe(second);
  });

  it("separates positions and events", async () => {
    expect(await replyIdempotencyKey("evt_1", 0, content))
      .not.toBe(await replyIdempotencyKey("evt_1", 1, content));
    expect(await replyIdempotencyKey("evt_1", 0, content))
      .not.toBe(await replyIdempotencyKey("evt_2", 0, content));
  });
});

describe("conversationInstanceName", () => {
  it("is stable per conversation and distinct across conversations", async () => {
    const a = await conversationInstanceName("cnv_01JZC7K4RQ");
    expect(a).toBe(await conversationInstanceName("cnv_01JZC7K4RQ"));
    expect(a).not.toBe(await conversationInstanceName("cnv_OTHER"));
    expect(a.startsWith("conversation-")).toBe(true);
  });
});

describe("messageText", () => {
  it("joins text parts in part_index order and skips other types", () => {
    expect(messageText({
      id: "msg_1",
      conversation_id: "cnv_1",
      parts: [
        { part_index: 1, type: "text", text: "world" },
        { part_index: 0, type: "text", text: "hello" },
        { part_index: 2, type: "media", url: "https://example/x.png" },
      ],
    })).toBe("hello\nworld");
  });

  it("returns an empty string when nothing is text", () => {
    expect(messageText({ id: "m", conversation_id: "c", parts: [] })).toBe("");
  });
});

function ledger() {
  const rows = new Map<string, string>();
  const order: string[] = [];
  const deps: AcceptDependencies = {
    lookup: (id) => rows.get(id),
    record: (event) => {
      order.push("record");
      rows.set(event.eventId, "accepting");
    },
    arm: async () => {
      order.push("arm");
    },
    markQueued: (id) => {
      order.push("markQueued");
      rows.set(id, "queued");
    },
    markFailed: (id, error) => {
      order.push(`markFailed:${error}`);
      rows.set(id, "failed");
    },
  };
  return { rows, order, deps };
}

const EVENT: RelayEventReference = {
  eventId: "evt_1",
  conversationId: "cnv_1",
  messageId: "msg_1",
};

describe("acceptRelayEvent", () => {
  it("writes the ledger row before arming the alarm, then acks 202", async () => {
    const { rows, order, deps } = ledger();
    await expect(acceptRelayEvent(EVENT, deps)).resolves.toEqual({ status: 202 });
    expect(order).toEqual(["record", "arm", "markQueued"]);
    expect(rows.get("evt_1")).toBe("queued");
  });

  it("throws instead of acking when arming fails, so Relay redelivers", async () => {
    const { rows, order, deps } = ledger();
    deps.arm = vi.fn(async () => {
      order.push("arm");
      throw new Error("alarm storage unavailable");
    });
    await expect(acceptRelayEvent(EVENT, deps)).rejects.toThrow("alarm storage unavailable");
    expect(order).toEqual(["record", "arm", "markFailed:alarm storage unavailable"]);
    expect(rows.get("evt_1")).toBe("failed");
    expect(order).not.toContain("markQueued");
  });

  it("deduplicates a redelivered event that already completed", async () => {
    const { order, deps } = ledger();
    deps.lookup = () => "completed";
    await expect(acceptRelayEvent(EVENT, deps)).resolves.toEqual({
      status: 200,
      reason: "duplicate",
    });
    expect(order).toEqual([]);
  });

  it("acks an in-flight redelivery without arming a second alarm", async () => {
    for (const status of ["accepting", "queued", "processing"]) {
      const { order, deps } = ledger();
      deps.lookup = () => status;
      await expect(acceptRelayEvent(EVENT, deps)).resolves.toEqual({ status: 202 });
      expect(order).toEqual([]);
    }
  });

  it("re-accepts an event whose earlier attempt failed", async () => {
    const { order, deps } = ledger();
    deps.lookup = () => "failed";
    await expect(acceptRelayEvent(EVENT, deps)).resolves.toEqual({ status: 202 });
    expect(order).toEqual(["record", "arm", "markQueued"]);
  });
});
