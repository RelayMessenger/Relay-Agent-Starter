/**
 * The cutover away from the deleted `/responding` route and the deleted
 * server-side invocation gate.
 *
 * Three things are proven here. The client reaches read and typing through the
 * routes that are actually alive, under either name Relay has for a
 * conversation, so one build serves the server production runs today and the
 * one it is being cut over to. The mention gate answers the question the server
 * used to answer: in a group, is this agent being addressed. And a turn still
 * batches when no event carries an invocation id, which is now every event.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { groupReplyPolicy } from "../src/env";
import type { Env } from "../src/env";
import {
  acceptRelayEvent,
  type AcceptDependencies,
  mentionsAgent,
  RelayClient,
  type RelayEventReference,
  type RelayMessage,
  shouldReplyToTurn,
} from "../src/relay";

/** Which server a probe is answering as. */
type Dialect = "production" | "bridged" | "live";

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

/**
 * A Relay that answers only the routes the named server really has.
 *
 * `production` is the deployed build, which knows `/v1/conversations/...` and
 * nothing else. `live` is the server after the rename, which knows
 * `/v1/chats/...` and nothing else. `bridged` is the compatibility window,
 * which answers both. Anything a server does not have answers 404, exactly as
 * the real one does, so a build that guesses wrong is caught here.
 */
function fakeRelay(dialect: Dialect, options: { isGroup?: boolean } = {}) {
  const seen: Recorded[] = [];
  const knows = (path: string): boolean => {
    if (path.startsWith("/v1/chats/")) return dialect !== "production";
    if (path.startsWith("/v1/conversations/")) return dialect !== "live";
    return true;
  };
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    seen.push({
      method: init?.method ?? "GET",
      path: path + url.search,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (!knows(path)) return new Response("no such route", { status: 404 });
    if (path.endsWith("/typing")) return new Response(null, { status: 204 });
    if (path.endsWith("/read")) return Response.json({ ok: true });
    if (path.endsWith("/messages")) return Response.json({ messages: [] });
    if (path === "/v1/agents/me") {
      return Response.json({ agent: { id: "agt_1", handle: "youragent", display_name: "Your Agent" } });
    }
    return dialect === "production"
      ? Response.json({ conversation: { id: "cnv_1", kind: options.isGroup ? "group" : "direct" } })
      : Response.json({ chat: { id: "cnv_1", is_group: options.isGroup ?? false } });
  });
  vi.stubGlobal("fetch", fetchStub);
  return {
    seen,
    client: new RelayClient("https://api.relayapp.im", "rly_live_test"),
    paths: () => seen.map((request) => request.path),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the deleted responding route", () => {
  it("is never called, on any server", async () => {
    for (const dialect of ["production", "bridged", "live"] as const) {
      const relay = fakeRelay(dialect);
      await relay.client.markRead("cnv_1", "msg_1");
      await relay.client.startTyping("cnv_1");
      expect(relay.paths().some((path) => path.includes("/responding"))).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it("is replaced by a read and a typing call carrying what each route wants", async () => {
    const relay = fakeRelay("live");
    await relay.client.markRead("cnv_1", "msg_1");
    await relay.client.startTyping("cnv_1");
    expect(relay.seen).toEqual([
      { method: "POST", path: "/v1/chats/cnv_1/read", body: { message_id: "msg_1" } },
      { method: "POST", path: "/v1/chats/cnv_1/typing", body: { started: true } },
    ]);
  });
});

describe("route tolerance", () => {
  it("reaches every route on the server production runs today", async () => {
    const relay = fakeRelay("production", { isGroup: true });
    await relay.client.markRead("cnv_1", "msg_1");
    await relay.client.startTyping("cnv_1", "ivk_1");
    await relay.client.fetchMessages("cnv_1", ["msg_1"]);
    expect(await relay.client.isGroup("cnv_1")).toBe(true);
    // Every old-name request is preceded by the live name being tried first,
    // and the fallback is what answers.
    expect(relay.paths()).toEqual([
      "/v1/chats/cnv_1/read",
      "/v1/conversations/cnv_1/read",
      "/v1/chats/cnv_1/typing",
      "/v1/conversations/cnv_1/typing",
      "/v1/chats/cnv_1/messages?limit=20",
      "/v1/conversations/cnv_1/messages?limit=20",
      "/v1/chats/cnv_1",
      "/v1/conversations/cnv_1",
    ]);
  });

  it("reaches every route on the server after the rename, with no fallback spent", async () => {
    const relay = fakeRelay("live", { isGroup: false });
    await relay.client.markRead("cnv_1", "msg_1");
    await relay.client.stopTyping("cnv_1");
    await relay.client.fetchMessages("cnv_1", ["msg_1"]);
    expect(await relay.client.isGroup("cnv_1")).toBe(false);
    expect(relay.paths()).toEqual([
      "/v1/chats/cnv_1/read",
      "/v1/chats/cnv_1/typing",
      "/v1/chats/cnv_1/messages?limit=20",
      "/v1/chats/cnv_1",
    ]);
  });

  it("takes the live name on the bridged server, which answers to both", async () => {
    const relay = fakeRelay("bridged", { isGroup: true });
    await relay.client.markRead("cnv_1", "msg_1");
    expect(relay.paths()).toEqual(["/v1/chats/cnv_1/read"]);
  });

  it("reads the group flag under either name", async () => {
    const production = fakeRelay("production", { isGroup: true });
    expect(await production.client.isGroup("cnv_1")).toBe(true);
    vi.unstubAllGlobals();
    const live = fakeRelay("live", { isGroup: true });
    expect(await live.client.isGroup("cnv_1")).toBe(true);
  });

  it("forwards an invocation id to typing only when the event carried one", async () => {
    const relay = fakeRelay("production");
    await relay.client.startTyping("cnv_1", "ivk_1");
    await relay.client.stopTyping("cnv_1");
    const bodies = relay.seen
      .filter((request) => request.path.startsWith("/v1/conversations"))
      .map((request) => request.body);
    expect(bodies).toEqual([{ started: true, invocation_id: "ivk_1" }, { started: false }]);
  });

  it("never fails a turn over a receipt the server refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new RelayClient("https://api.relayapp.im", "rly_live_test");
    // A missing "Read" is a smaller loss than a reply that never arrives
    // because a courtesy call burned the turn's last retry. The refusal is
    // reported with the status that caused it, which is also what separates
    // this branch from a request that never reached Relay at all.
    await expect(client.markRead("cnv_1", "msg_1")).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(JSON.stringify({
      event: "relay_read_receipt_failed",
      status: 500,
      conversation_id: "cnv_1",
    }));
    error.mockRestore();
  });

  it("never fails a turn over a receipt that never reached Relay", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network down"); }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new RelayClient("https://api.relayapp.im", "rly_live_test");
    await expect(client.markRead("cnv_1", "msg_1")).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(JSON.stringify({
      event: "relay_read_receipt_failed",
      error: "network down",
      conversation_id: "cnv_1",
    }));
    error.mockRestore();
  });
});

/** A group message that names @youragent, in the live vocabulary. */
const mentionedLive: RelayMessage = {
  id: "msg_1",
  conversation_id: "cnv_1",
  parts: [{
    type: "text",
    text: "@youragent can you take this one?",
    mention: "youragent",
    mention_range: [0, 10],
  }],
};

/** The same message in the vocabulary the deployed server still speaks. */
const mentionedProduction: RelayMessage = {
  id: "msg_1",
  conversation_id: "cnv_1",
  invoked_agents: ["agt_1"],
  parts: [{
    type: "text",
    text: "@youragent can you take this one?",
    mentions: [{ start: 0, length: 10, participant_id: "agt_1" }],
  }],
};

const notMentioned: RelayMessage = {
  id: "msg_2",
  conversation_id: "cnv_1",
  parts: [{ type: "text", text: "anyone up for lunch" }],
};

/** The photo half of a split "@youragent [photo]" send: no mention of its own. */
const bareMedia: RelayMessage = {
  id: "msg_3",
  conversation_id: "cnv_1",
  parts: [{ type: "media", url: "https://cdn.example/photo.jpg" }],
};

const IDENTITY = { handle: "youragent", id: "agt_1" };

describe("the mention gate", () => {
  it("sees a mention in the live vocabulary", () => {
    expect(mentionsAgent(mentionedLive, IDENTITY)).toBe(true);
  });

  it("sees a mention in the deployed server's vocabulary", () => {
    expect(mentionsAgent(mentionedProduction, IDENTITY)).toBe(true);
  });

  it("sees no mention in a message that names nobody", () => {
    expect(mentionsAgent(notMentioned, IDENTITY)).toBe(false);
  });

  it("sees no mention in a message that names another agent", () => {
    const other: RelayMessage = {
      id: "msg_4",
      conversation_id: "cnv_1",
      invoked_agents: ["agt_someone_else"],
      parts: [{ type: "text", text: "@scheduler move standup", mention: "scheduler" }],
    };
    expect(mentionsAgent(other, IDENTITY)).toBe(false);
  });

  it("matches the handle however a client cased it, and with or without the @", () => {
    const shouted: RelayMessage = {
      id: "msg_5",
      conversation_id: "cnv_1",
      parts: [{ type: "text", text: "@YourAgent hi", mention: "@YourAgent" }],
    };
    expect(mentionsAgent(shouted, IDENTITY)).toBe(true);
  });

  it("does not treat the words as authority", () => {
    // Relay's own rule: "Structured group targets. Text mentions are
    // presentation, never authority." A handle typed into a message that
    // carries no mention is talk about the agent, not to it — and reading it
    // as a summons is how an agent starts answering a conversation about it.
    const talkedAbout: RelayMessage = {
      id: "msg_6",
      conversation_id: "cnv_1",
      parts: [{ type: "text", text: "@youragent is pretty good tbh" }],
    };
    expect(mentionsAgent(talkedAbout, IDENTITY)).toBe(false);
  });

  it("sees nothing when the agent's identity is unknown, rather than guessing", () => {
    expect(mentionsAgent(mentionedLive, {})).toBe(false);
  });

  it("ignores a mention hung on a part that is not text", () => {
    const onMedia: RelayMessage = {
      id: "msg_7",
      conversation_id: "cnv_1",
      parts: [{ type: "media", mention: "youragent" }],
    };
    expect(mentionsAgent(onMedia, IDENTITY)).toBe(false);
  });
});

describe("shouldReplyToTurn", () => {
  const turn = (messages: RelayMessage[], isGroup: boolean, policy: "mentions" | "all" = "mentions") =>
    shouldReplyToTurn({ isGroup, messages, agent: IDENTITY, policy });

  it("answers a direct message whether or not it carries a mention", () => {
    expect(turn([notMentioned], false)).toBe(true);
    expect(turn([mentionedLive], false)).toBe(true);
  });

  it("stays silent on a group message the agent was not named in", () => {
    expect(turn([notMentioned], true)).toBe(false);
  });

  it("answers a group message the agent was named in, in either vocabulary", () => {
    expect(turn([mentionedLive], true)).toBe(true);
    expect(turn([mentionedProduction], true)).toBe(true);
  });

  it("answers a split send whose mention rode only the text half", () => {
    // "@youragent [photo]" commits as two messages and only the text one
    // carries the mention. Asking the whole turn is what keeps the photo from
    // silencing a reply the person clearly asked for.
    expect(turn([mentionedLive, bareMedia], true)).toBe(true);
  });

  it("stays silent on a whole turn of group messages that name nobody", () => {
    expect(turn([notMentioned, bareMedia], true)).toBe(false);
  });

  it("answers every group message under the 'all' policy", () => {
    expect(turn([notMentioned], true, "all")).toBe(true);
  });

  it("stays silent on an empty turn rather than answering nothing", () => {
    expect(turn([], true)).toBe(false);
    expect(turn([], false)).toBe(true);
  });
});

describe("groupReplyPolicy", () => {
  const env = (value?: string) => ({ RELAY_GROUP_REPLY_POLICY: value } as Env);

  it("defaults to mentions when the var is unset", () => {
    expect(groupReplyPolicy(env())).toBe("mentions");
  });

  it("reads 'all' when it is set exactly", () => {
    expect(groupReplyPolicy(env("all"))).toBe("all");
  });

  it("reads anything else as mentions, so a typo cannot open the floodgate", () => {
    for (const typo of ["ALL", "every", "true", "", "mentions"]) {
      expect(groupReplyPolicy(env(typo))).toBe("mentions");
    }
  });
});

/**
 * The turn ledger with no invocation ids anywhere, which is now every event.
 * Mirrors recordEvent in src/agent.ts: an event joins the turn still collecting
 * its batch, otherwise a new turn opens.
 */
function windowedLedger() {
  const turns = new Map<string, { status: string; invocationId?: string }>();
  const eventToTurn = new Map<string, string>();
  const armed: string[] = [];
  const deps: AcceptDependencies = {
    lookupEvent: (eventId) => {
      const turnId = eventToTurn.get(eventId);
      return turnId ? turns.get(turnId)?.status : undefined;
    },
    record: (event) => {
      const known = eventToTurn.get(event.eventId);
      if (known) return { turnId: known, needsAlarm: true };
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
    arm: async (turnId) => { armed.push(turnId); },
    markCollecting: (turnId) => {
      const turn = turns.get(turnId);
      if (turn) turn.status = "collecting";
    },
    markFailed: (turnId) => {
      const turn = turns.get(turnId);
      if (turn) turn.status = "failed";
    },
  };
  return { turns, armed, deps };
}

describe("batching with no invocation id, which is now every event", () => {
  const event = (id: string, messageId: string): RelayEventReference =>
    ({ eventId: id, conversationId: "cnv_1", messageId });

  it("still collects a split send into one turn with one alarm", async () => {
    // This used to be the fallback branch, taken only by a DM. It is now the
    // only branch, and it has to hold a group send together on its own.
    const { turns, armed, deps } = windowedLedger();
    await expect(acceptRelayEvent(event("evt_1", "msg_1"), deps)).resolves.toEqual({ status: 202 });
    await expect(acceptRelayEvent(event("evt_2", "msg_2"), deps)).resolves.toEqual({ status: 202 });
    expect(armed).toEqual(["evt_1"]);
    expect(turns.size).toBe(1);
  });

  it("opens a new turn once the first one has closed", async () => {
    const { turns, armed, deps } = windowedLedger();
    await acceptRelayEvent(event("evt_1", "msg_1"), deps);
    // The alarm fired and the turn left the joinable states.
    turns.get("evt_1")!.status = "processing";
    await acceptRelayEvent(event("evt_2", "msg_2"), deps);
    expect(armed).toEqual(["evt_1", "evt_2"]);
    expect(turns.size).toBe(2);
  });

  it("does not merge a turn into one that is already replying", async () => {
    const { turns, deps } = windowedLedger();
    await acceptRelayEvent(event("evt_1", "msg_1"), deps);
    turns.get("evt_1")!.status = "processing";
    await acceptRelayEvent(event("evt_2", "msg_2"), deps);
    // Adding a message to a turn mid-send would change the reply digest under
    // an in-flight request.
    expect([...turns.keys()]).toEqual(["evt_1", "evt_2"]);
  });
});
