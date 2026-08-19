import { Webhook } from "standardwebhooks";
import { describe, expect, it, vi } from "vitest";

import {
  acceptRelayEvent,
  type AcceptDependencies,
  conversationInstanceName,
  isRetryableRelayError,
  messageText,
  type RelayEventReference,
  RelayRequestError,
  replyIdempotencyKey,
  turnContent,
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
  it("joins text parts in array order and skips other types", () => {
    expect(messageText({
      id: "msg_1",
      conversation_id: "cnv_1",
      parts: [
        { type: "text", text: "hello" },
        { type: "media", url: "https://example/x.png" },
        { type: "text", text: "world" },
      ],
    })).toBe("hello\nworld");
  });

  it("returns an empty string when nothing is text", () => {
    expect(messageText({ id: "m", conversation_id: "c", parts: [] })).toBe("");
  });
});

describe("turnContent", () => {
  it("flattens a text+media batch into one reply's worth of content", () => {
    // One user send of text + a photo commits as two messages. The reply must
    // come from both: the text in order, plus the media it cannot read.
    const { text, mediaCount } = turnContent([
      { id: "msg_1", conversation_id: "cnv_1", parts: [{ type: "text", text: "look at this" }] },
      { id: "msg_2", conversation_id: "cnv_1", parts: [{ type: "media", attachment_id: "att_1" }] },
    ]);
    expect(text).toBe("look at this");
    expect(mediaCount).toBe(1);
  });

  it("joins the text of several messages in order and counts voice memos as media", () => {
    const { text, mediaCount } = turnContent([
      { id: "msg_1", conversation_id: "cnv_1", parts: [{ type: "text", text: "first" }] },
      { id: "msg_2", conversation_id: "cnv_1", parts: [{ type: "voice_memo", attachment_id: "att_1" }] },
      { id: "msg_3", conversation_id: "cnv_1", parts: [{ type: "text", text: "second" }] },
    ]);
    expect(text).toBe("first\nsecond");
    expect(mediaCount).toBe(1);
  });
});

describe("isRetryableRelayError", () => {
  it("treats a 4xx rejection as terminal", () => {
    // The consumed-invocation case: the second fragment of a group batch can
    // never send. Retrying it six times with backoff is the storm this guards.
    expect(isRetryableRelayError(new RelayRequestError("Relay send failed: 409", 409))).toBe(false);
    expect(isRetryableRelayError(new RelayRequestError("Relay send failed: 422", 422))).toBe(false);
  });

  it("keeps 5xx, transient 4xx, and non-HTTP failures retryable", () => {
    expect(isRetryableRelayError(new RelayRequestError("Relay send failed: 503", 503))).toBe(true);
    expect(isRetryableRelayError(new RelayRequestError("Relay send failed: 429", 429))).toBe(true);
    expect(isRetryableRelayError(new RelayRequestError("Relay send failed: 408", 408))).toBe(true);
    expect(isRetryableRelayError(new Error("network reset"))).toBe(true);
  });
});

/**
 * In-memory version of the Durable Object's turn ledger, mirroring
 * recordEvent in src/agent.ts: events join the turn still collecting their
 * batch (matched on invocation_id, or the open DM window), otherwise a new
 * turn opens.
 */
function ledger() {
  const turns = new Map<string, { status: string; invocationId?: string }>();
  const eventToTurn = new Map<string, string>();
  const order: string[] = [];
  const deps: AcceptDependencies = {
    lookupEvent: (eventId) => {
      const turnId = eventToTurn.get(eventId);
      return turnId ? turns.get(turnId)?.status : undefined;
    },
    record: (event) => {
      order.push("record");
      const known = eventToTurn.get(event.eventId);
      if (known) {
        turns.set(known, { status: "accepting", invocationId: event.invocationId });
        return { turnId: known, needsAlarm: true };
      }
      for (const [turnId, turn] of turns) {
        const joinable = turn.status === "accepting" || turn.status === "collecting";
        if (joinable && turn.invocationId === event.invocationId) {
          eventToTurn.set(event.eventId, turnId);
          return { turnId, needsAlarm: false };
        }
      }
      const turnId = event.invocationId ?? event.eventId;
      turns.set(turnId, { status: "accepting", invocationId: event.invocationId });
      eventToTurn.set(event.eventId, turnId);
      return { turnId, needsAlarm: true };
    },
    arm: async (turnId) => {
      order.push(`arm:${turnId}`);
    },
    markCollecting: (turnId) => {
      order.push("markCollecting");
      const turn = turns.get(turnId);
      if (turn) turn.status = "collecting";
    },
    markFailed: (turnId, error) => {
      order.push(`markFailed:${error}`);
      const turn = turns.get(turnId);
      if (turn) turn.status = "failed";
    },
  };
  return { turns, order, deps };
}

const EVENT: RelayEventReference = {
  eventId: "evt_1",
  conversationId: "cnv_1",
  messageId: "msg_1",
};

describe("acceptRelayEvent", () => {
  it("writes the turn before arming the alarm, then acks 202", async () => {
    const { turns, order, deps } = ledger();
    await expect(acceptRelayEvent(EVENT, deps)).resolves.toEqual({ status: 202 });
    expect(order).toEqual(["record", "arm:evt_1", "markCollecting"]);
    expect(turns.get("evt_1")?.status).toBe("collecting");
  });

  it("collects both events of one split send into one turn with one alarm", async () => {
    // A text+photo group send: two events, one invocation_id. One turn, armed
    // once, is what makes the agent reply once instead of once per fragment.
    const { turns, order, deps } = ledger();
    const first: RelayEventReference = { ...EVENT, invocationId: "inv_1" };
    const second: RelayEventReference = {
      eventId: "evt_2",
      conversationId: "cnv_1",
      messageId: "msg_2",
      invocationId: "inv_1",
    };
    await expect(acceptRelayEvent(first, deps)).resolves.toEqual({ status: 202 });
    await expect(acceptRelayEvent(second, deps)).resolves.toEqual({ status: 202 });
    expect(order.filter((step) => step.startsWith("arm:"))).toEqual(["arm:inv_1"]);
    expect(turns.size).toBe(1);
  });

  it("collects a DM split send into the still-open turn", async () => {
    // No invocation_id in a DM. The second event lands inside the first
    // event's collect window, so it joins that turn instead of opening one.
    const { turns, order, deps } = ledger();
    await acceptRelayEvent(EVENT, deps);
    await expect(acceptRelayEvent(
      { eventId: "evt_2", conversationId: "cnv_1", messageId: "msg_2" },
      deps,
    )).resolves.toEqual({ status: 202 });
    expect(order.filter((step) => step.startsWith("arm:"))).toEqual(["arm:evt_1"]);
    expect(turns.size).toBe(1);
  });

  it("throws instead of acking when arming fails, so Relay redelivers", async () => {
    const { turns, order, deps } = ledger();
    deps.arm = vi.fn(async (turnId: string) => {
      order.push(`arm:${turnId}`);
      throw new Error("alarm storage unavailable");
    });
    await expect(acceptRelayEvent(EVENT, deps)).rejects.toThrow("alarm storage unavailable");
    expect(order).toEqual(["record", "arm:evt_1", "markFailed:alarm storage unavailable"]);
    expect(turns.get("evt_1")?.status).toBe("failed");
    expect(order).not.toContain("markCollecting");
  });

  it("deduplicates a redelivered event whose turn already completed", async () => {
    const { turns, order, deps } = ledger();
    await acceptRelayEvent(EVENT, deps);
    turns.get("evt_1")!.status = "completed";
    order.length = 0;
    await expect(acceptRelayEvent(EVENT, deps)).resolves.toEqual({
      status: 200,
      reason: "duplicate",
    });
    expect(order).toEqual([]);
  });

  it("acks an in-flight redelivery without arming a second alarm", async () => {
    for (const status of ["accepting", "collecting", "queued", "processing"]) {
      const { turns, order, deps } = ledger();
      await acceptRelayEvent(EVENT, deps);
      turns.get("evt_1")!.status = status;
      order.length = 0;
      await expect(acceptRelayEvent(EVENT, deps)).resolves.toEqual({ status: 202 });
      expect(order).toEqual([]);
    }
  });

  it("re-accepts a redelivered event whose turn failed", async () => {
    const { turns, order, deps } = ledger();
    await acceptRelayEvent(EVENT, deps);
    turns.get("evt_1")!.status = "failed";
    order.length = 0;
    await expect(acceptRelayEvent(EVENT, deps)).resolves.toEqual({ status: 202 });
    expect(order).toEqual(["record", "arm:evt_1", "markCollecting"]);
    expect(turns.get("evt_1")?.status).toBe("collecting");
  });
});
