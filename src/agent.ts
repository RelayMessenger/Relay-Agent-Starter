/**
 * One Durable Object per conversation. It owns a small SQLite ledger, an
 * alarm-backed reply, and the model call.
 *
 * The unit of work is a TURN, not an event. Relay splits one user send into
 * one message per visible non-media part (contiguous media commit as one
 * message), and delivers one message.received event per committed message. A
 * text+photo send is two events, and the right behavior is one reply that saw
 * both — not two replies, one of them an apology about the photo. So events
 * are collected into a turn, a short alarm window lets the rest of the batch
 * arrive, and the turn is what gets processed, retried, and completed.
 */
import { Agent } from "agents";

import type { Env } from "./env";
import { groupReplyPolicy, requireAgentToken } from "./env";
import {
  acceptRelayEvent,
  isRetryableRelayError,
  needsRecoveryArm,
  RelayClient,
  type RelayEventReference,
  replyIdempotencyKey,
  sanitizeFailure,
  shouldReplyToTurn,
  turnContent,
} from "./relay";

interface ConversationState {
  lastEventAt: string | null;
  lastReplyAt: string | null;
  /** Cached so the identity call does not repeat on every message. */
  handle: string | null;
  /** Cached beside the handle, for the same reason. */
  agentId: string | null;
  /** Cached because a thread never changes kind. */
  isGroup: boolean | null;
}

interface TurnRow {
  turn_id: string;
  conversation_id: string;
  /** HISTORICAL, kept only because an event may still carry one to forward. */
  invocation_id: string | null;
  status: string;
  attempt_count: number;
  updated_at: string;
}

interface EventRow {
  event_id: string;
  turn_id: string;
  message_id: string;
}

/** Give up after this many attempts, so one poisoned turn cannot loop forever. */
const MAX_ATTEMPTS = 6;

/**
 * How long a turn waits for the rest of its batch before replying. The split
 * events of one send leave Relay back to back, so a couple of seconds is
 * plenty. An event that arrives after its turn closed opens a new turn.
 *
 * This window used to be the fallback branch: a group batch was grouped by the
 * `invocation_id` every event of one send shared, and only a DM fell back to
 * the window. The server no longer mints an invocation, so the window is now
 * the only branch, and it groups a group send the same way it always grouped a
 * DM send — by arrival inside two seconds. A straggler that misses the window
 * opens its own turn; in a group the mention gate is what keeps that from
 * becoming a second reply, since the fragment carrying the `@` is the one that
 * already landed.
 */
const COALESCE_WINDOW_SECONDS = 2;

function retryDelaySeconds(attempt: number): number {
  return Math.min(15 * 60, 30 * 2 ** Math.max(0, attempt - 1));
}

export class RelayConversationAgent extends Agent<Env, ConversationState> {
  initialState: ConversationState = {
    lastEventAt: null,
    lastReplyAt: null,
    handle: null,
    agentId: null,
    isGroup: null,
  };

  async onStart(): Promise<void> {
    await super.onStart();
    // Identifiers only. Nothing a user wrote is stored here.
    this.sql`
      CREATE TABLE IF NOT EXISTS relay_turns (
        turn_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        invocation_id TEXT,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS relay_events (
        event_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;
    this.sql`
      DELETE FROM relay_turns
      WHERE status IN ('completed', 'failed', 'ignored')
        AND julianday(updated_at) < julianday('now', '-30 days')
    `;
    this.sql`
      DELETE FROM relay_events
      WHERE turn_id NOT IN (SELECT turn_id FROM relay_turns)
    `;
    // Recovery: re-arm turns whose alarm did not survive eviction (see
    // needsRecoveryArm). Re-arming twice is harmless — processTurn no-ops on
    // finished turns and the content-digested reply key makes a resend replay.
    const turns = this.sql<TurnRow>`
      SELECT turn_id, status, attempt_count FROM relay_turns
    `;
    for (const turn of turns.filter((row) => needsRecoveryArm(row.status))) {
      await this.schedule(COALESCE_WINDOW_SECONDS, "processTurn", {
        turnId: turn.turn_id,
        attempt: turn.attempt_count + 1,
      });
    }
  }

  /**
   * Internal entry point. The Worker has already verified the signature and
   * parsed the envelope, so this receives identifiers only. Nothing routes to
   * this object from the public internet except through src/index.ts.
   */
  override async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const event = (await request.json()) as RelayEventReference;
    this.setState({ ...this.state, lastEventAt: new Date().toISOString() });

    const outcome = await acceptRelayEvent(event, {
      lookupEvent: (eventId) => {
        const [row] = this.sql<{ status: string }>`
          SELECT relay_turns.status AS status
          FROM relay_events JOIN relay_turns ON relay_turns.turn_id = relay_events.turn_id
          WHERE relay_events.event_id = ${eventId} LIMIT 1
        `;
        return row?.status;
      },
      record: (accepted) => this.recordEvent(accepted),
      // Alarm-backed, never queue(). queue() writes a row and kicks an
      // in-memory flush, so an isolate evicted between the 202 and the flush
      // strands the reply until something else happens to wake this object.
      // schedule() sets a Durable Object alarm, which resurrects an evicted
      // object on its own. A 202 promises a reply, so it has to be an alarm.
      arm: async (turnId) => {
        await this.schedule(COALESCE_WINDOW_SECONDS, "processTurn", { turnId, attempt: 1 });
      },
      markCollecting: (turnId) => {
        this.sql`
          UPDATE relay_turns SET status = 'collecting', updated_at = ${new Date().toISOString()}
          WHERE turn_id = ${turnId}
        `;
      },
      markFailed: (turnId, error) => {
        this.sql`
          UPDATE relay_turns
          SET status = 'failed', last_error = ${error}, updated_at = ${new Date().toISOString()}
          WHERE turn_id = ${turnId}
        `;
      },
    });
    return new Response(null, { status: outcome.status });
  }

  /**
   * Put one event in a turn. Three cases:
   *
   * - The event was delivered before and its turn failed: reset that turn so
   *   the redelivery gets a fresh run.
   * - A turn is still collecting this send's batch: join it. Its alarm already
   *   exists. An event that still carries an invocation_id joins the turn with
   *   the same one; every other event joins the open window, which is now the
   *   ordinary case in a group as well as a DM.
   * - Otherwise open a new turn, keyed on the invocation_id when there is one
   *   and on this first event's id when there is not.
   *
   * Invariant: status checking lives in acceptRelayEvent; this must only be
   * reached through it, so the event is already known to be new or failed.
   */
  private recordEvent(event: RelayEventReference): { turnId: string; needsAlarm: boolean } {
    const now = new Date().toISOString();

    const [known] = this.sql<EventRow>`
      SELECT turn_id FROM relay_events WHERE event_id = ${event.eventId} LIMIT 1
    `;
    if (known) {
      this.sql`
        UPDATE relay_turns
        SET status = 'accepting', attempt_count = 0, last_error = NULL, updated_at = ${now}
        WHERE turn_id = ${known.turn_id}
      `;
      return { turnId: known.turn_id, needsAlarm: true };
    }

    // 'accepting' and 'collecting' are the only joinable states. A turn that
    // reached 'processing' may already have replied, and adding a message to a
    // 'queued' retry would change the reply digest under an in-flight send.
    const [open] = event.invocationId
      ? this.sql<TurnRow>`
          SELECT turn_id FROM relay_turns
          WHERE invocation_id = ${event.invocationId} AND status IN ('accepting', 'collecting')
          LIMIT 1
        `
      : this.sql<TurnRow>`
          SELECT turn_id FROM relay_turns
          WHERE invocation_id IS NULL AND status IN ('accepting', 'collecting')
          ORDER BY created_at DESC LIMIT 1
        `;
    if (open) {
      this.sql`
        INSERT INTO relay_events (event_id, turn_id, message_id, created_at)
        VALUES (${event.eventId}, ${open.turn_id}, ${event.messageId}, ${now})
      `;
      return { turnId: open.turn_id, needsAlarm: false };
    }

    // A straggler whose turn already closed cannot reuse that turn's id; it
    // gets its own. Relay used to refuse its send as a consumed invocation,
    // which is what kept it from becoming a second reply; in a group that job
    // now belongs to the mention gate, and in a DM a straggler has always been
    // answered on its own.
    let turnId = event.eventId;
    if (event.invocationId) {
      const [taken] = this.sql<TurnRow>`
        SELECT turn_id FROM relay_turns WHERE turn_id = ${event.invocationId} LIMIT 1
      `;
      if (!taken) turnId = event.invocationId;
    }
    this.sql`
      INSERT INTO relay_turns (
        turn_id, conversation_id, invocation_id, status, attempt_count, created_at, updated_at
      ) VALUES (
        ${turnId}, ${event.conversationId}, ${event.invocationId ?? null},
        'accepting', 0, ${now}, ${now}
      )
    `;
    this.sql`
      INSERT INTO relay_events (event_id, turn_id, message_id, created_at)
      VALUES (${event.eventId}, ${turnId}, ${event.messageId}, ${now})
    `;
    return { turnId, needsAlarm: true };
  }

  /** Alarm callback. Named so `schedule` can find it after an isolate restart. */
  async processTurn(task: { turnId: string; attempt: number }): Promise<void> {
    const [turn] = this.sql<TurnRow>`
      SELECT turn_id, conversation_id, invocation_id, status, attempt_count
      FROM relay_turns WHERE turn_id = ${task.turnId} LIMIT 1
    `;
    if (!turn || turn.status === "completed" || turn.status === "failed"
      || turn.status === "ignored") return;

    const attempt = Math.max(turn.attempt_count + 1, task.attempt);
    this.sql`
      UPDATE relay_turns
      SET status = 'processing', attempt_count = ${attempt}, updated_at = ${new Date().toISOString()}
      WHERE turn_id = ${turn.turn_id}
    `;

    // Insertion order is delivery order, which is the order the messages
    // committed in.
    const events = this.sql<EventRow>`
      SELECT event_id, turn_id, message_id FROM relay_events
      WHERE turn_id = ${turn.turn_id} ORDER BY rowid
    `;
    const messageIds = events.map((row) => row.message_id);
    const invocationId = turn.invocation_id ?? undefined;

    const client = new RelayClient(this.env.RELAY_API_ORIGIN, requireAgentToken(this.env));
    let typingStarted = false;
    try {
      const messages = await client.fetchMessages(turn.conversation_id, messageIds);
      if (messages.length === 0) throw new Error("Relay messages are unavailable");

      let handle = this.state.handle;
      let agentId = this.state.agentId;
      if (!handle) {
        const me = await client.me();
        handle = me.handle;
        agentId = me.id;
        this.setState({ ...this.state, handle, agentId });
      }

      // Relay used to answer this itself: a group agent was only delivered a
      // message it had been invoked on. Nothing gates that now, so every group
      // message arrives here and the agent decides whether it was addressed.
      // Both reads are cached; neither answer changes for this conversation.
      let isGroup = this.state.isGroup;
      if (isGroup === null) {
        isGroup = await client.isGroup(turn.conversation_id);
        this.setState({ ...this.state, isGroup });
      }
      const replying = shouldReplyToTurn({
        isGroup,
        messages,
        // `||`, not `??`: an identity read that answered without an id leaves
        // an empty string, and the envelope's own agent_id beats that.
        agent: { handle, id: agentId || undefined },
        policy: groupReplyPolicy(this.env),
      });
      if (!replying) {
        // Silence is the answer, and it is recorded as one. 'ignored' is
        // terminal, so a redelivery of any event in this turn does not spend
        // another history read arriving at the same silence.
        this.sql`
          UPDATE relay_turns
          SET status = 'ignored', last_error = NULL, updated_at = ${new Date().toISOString()}
          WHERE turn_id = ${turn.turn_id}
        `;
        return;
      }

      // Read lands before any model work, so the sender sees Read while they
      // wait, and the typist goes up beside it. Reading the newest message of
      // the batch covers the whole turn. These were one `/responding` call
      // until that route was deleted.
      await client.markRead(turn.conversation_id, messageIds[messageIds.length - 1]);
      await client.startTyping(turn.conversation_id, invocationId);
      typingStarted = true;

      const content = turnContent(messages);
      const reply = await this.generateReply(content.text, content.mediaCount, handle);

      // One reply today, but the ordinal is its real position, so a fork that
      // splits a long answer into several sends keys each one correctly. The
      // digest of the reply is in the key, so a retry that produces the same
      // words replays instead of conflicting.
      const replies = [reply];
      for (const [ordinal, text] of replies.entries()) {
        await client.sendText({
          conversationId: turn.conversation_id,
          text,
          idempotencyKey: await replyIdempotencyKey(turn.turn_id, ordinal, [
            { type: "text", text },
          ]),
          invocationId,
        });
      }

      const completedAt = new Date().toISOString();
      this.setState({ ...this.state, lastReplyAt: completedAt });
      // The turn is recorded as done only here, after the reply landed. A
      // failure before this point leaves the row retryable.
      this.sql`
        UPDATE relay_turns
        SET status = 'completed', last_error = NULL, updated_at = ${completedAt}
        WHERE turn_id = ${turn.turn_id}
      `;
    } catch (error) {
      const failure = sanitizeFailure(error);
      // A 4xx from Relay cannot succeed on retry: the request itself is
      // invalid, or this agent is not in that chat. Retrying it would reach
      // the same rejection MAX_ATTEMPTS times.
      if (!isRetryableRelayError(error) || attempt >= MAX_ATTEMPTS) {
        this.sql`
          UPDATE relay_turns
          SET status = 'failed', last_error = ${failure}, updated_at = ${new Date().toISOString()}
          WHERE turn_id = ${turn.turn_id}
        `;
        console.error(JSON.stringify({
          event: "relay_turn_failed",
          turn_id: turn.turn_id,
          attempt,
          terminal: !isRetryableRelayError(error),
          error: failure,
        }));
        return;
      }
      // Arm the retry alarm first. Marking the row 'queued' before the alarm
      // exists would leave a row nothing is coming back for.
      try {
        await this.schedule(retryDelaySeconds(attempt), "processTurn", {
          turnId: turn.turn_id,
          attempt: attempt + 1,
        });
      } catch (scheduleError) {
        this.sql`
          UPDATE relay_turns
          SET status = 'failed', last_error = ${sanitizeFailure(scheduleError)},
            updated_at = ${new Date().toISOString()}
          WHERE turn_id = ${turn.turn_id}
        `;
        console.error(JSON.stringify({
          event: "relay_retry_schedule_failed",
          turn_id: turn.turn_id,
          attempt,
          error: sanitizeFailure(scheduleError),
        }));
        return;
      }
      this.sql`
        UPDATE relay_turns
        SET status = 'queued', last_error = ${failure}, updated_at = ${new Date().toISOString()}
        WHERE turn_id = ${turn.turn_id}
      `;
    } finally {
      // Only clear a typist this turn actually raised. A turn the agent stayed
      // out of never showed one.
      if (typingStarted) {
        await client.stopTyping(turn.conversation_id, invocationId);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // THIS IS WHERE YOUR AGENT GOES.
  //
  // Replace the body with your model call, your tools, your prompt. Everything
  // above is delivery plumbing you should not need to touch.
  //
  // `text` is the whole user turn: one send can commit as several messages
  // (text and photos split at ingest), and they arrive here joined in order.
  // `mediaCount` is how many media parts came with it, for a model that cannot
  // see them yet — never answer media with a bare apology when there was text.
  //
  // Workers AI example. Add `"ai": { "binding": "AI" }` to wrangler.jsonc and
  // uncomment `AI` in src/env.ts first, then swap the return below for:
  //
  //   const result = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
  //     messages: [
  //       { role: "system", content: `You are @${handle}, a helpful assistant.` },
  //       { role: "user", content: text },
  //     ],
  //   });
  //   return result.response ?? "I got that, but I could not draft a reply.";
  //
  // Any HTTPS model API works the same way. Keep it under the Worker's CPU
  // budget, or move the long work behind another schedule() call.
  // ---------------------------------------------------------------------------
  async generateReply(text: string, mediaCount: number, handle: string): Promise<string> {
    const media = mediaCount === 1 ? "1 attachment" : `${mediaCount} attachments`;
    if (!text) {
      return mediaCount > 0
        ? `@${handle} here. You sent ${media}, but I can only read text right now.`
        : `@${handle} here. I can only read text right now.`;
    }
    if (mediaCount > 0) {
      return `@${handle} here. You said: ${text} (plus ${media} I cannot open yet)`;
    }
    return `@${handle} here. You said: ${text}`;
  }
}
