/**
 * One Durable Object per conversation. It owns a small SQLite ledger, an
 * alarm-backed reply, and the model call.
 */
import { Agent } from "agents";

import type { Env } from "./env";
import { requireAgentToken } from "./env";
import {
  acceptRelayEvent,
  messageText,
  RelayClient,
  type RelayEventReference,
  replyIdempotencyKey,
  sanitizeFailure,
} from "./relay";

interface ConversationState {
  lastEventAt: string | null;
  lastReplyAt: string | null;
  /** Cached so the identity call does not repeat on every message. */
  handle: string | null;
}

interface LedgerRow {
  event_id: string;
  status: string;
  attempt_count: number;
  conversation_id: string;
  message_id: string;
  invocation_id: string | null;
  updated_at: string;
}

/** Give up after this many attempts, so one poisoned event cannot loop forever. */
const MAX_ATTEMPTS = 6;

function retryDelaySeconds(attempt: number): number {
  return Math.min(15 * 60, 30 * 2 ** Math.max(0, attempt - 1));
}

export class RelayConversationAgent extends Agent<Env, ConversationState> {
  initialState: ConversationState = { lastEventAt: null, lastReplyAt: null, handle: null };

  async onStart(): Promise<void> {
    await super.onStart();
    // Identifiers only. Nothing a user wrote is stored here.
    this.sql`
      CREATE TABLE IF NOT EXISTS relay_deliveries (
        event_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        invocation_id TEXT,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    this.sql`
      DELETE FROM relay_deliveries
      WHERE status IN ('completed', 'failed')
        AND julianday(updated_at) < julianday('now', '-30 days')
    `;
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
      lookup: (eventId) => {
        const [row] = this.sql<LedgerRow>`
          SELECT status FROM relay_deliveries WHERE event_id = ${eventId} LIMIT 1
        `;
        return row?.status;
      },
      record: (accepted) => {
        const now = new Date().toISOString();
        this.sql`
          INSERT INTO relay_deliveries (
            event_id, conversation_id, message_id, invocation_id,
            status, attempt_count, created_at, updated_at
          ) VALUES (
            ${accepted.eventId}, ${accepted.conversationId}, ${accepted.messageId},
            ${accepted.invocationId ?? null}, 'accepting', 0, ${now}, ${now}
          )
          ON CONFLICT(event_id) DO UPDATE SET
            status = 'accepting', attempt_count = 0, last_error = NULL,
            updated_at = excluded.updated_at
        `;
      },
      // Alarm-backed, never queue(). queue() writes a row and kicks an
      // in-memory flush, so an isolate evicted between the 202 and the flush
      // strands the reply until something else happens to wake this object.
      // schedule() sets a Durable Object alarm, which resurrects an evicted
      // object on its own. A 202 promises a reply, so it has to be an alarm.
      arm: async (accepted) => {
        await this.schedule(0, "processEvent", { event: accepted, attempt: 1 });
      },
      markQueued: (eventId) => {
        this.sql`
          UPDATE relay_deliveries SET status = 'queued', updated_at = ${new Date().toISOString()}
          WHERE event_id = ${eventId}
        `;
      },
      markFailed: (eventId, error) => {
        this.sql`
          UPDATE relay_deliveries
          SET status = 'failed', last_error = ${error}, updated_at = ${new Date().toISOString()}
          WHERE event_id = ${eventId}
        `;
      },
    });
    return new Response(null, { status: outcome.status });
  }

  /** Alarm callback. Named so `schedule` can find it after an isolate restart. */
  async processEvent(task: { event: RelayEventReference; attempt: number }): Promise<void> {
    const { event } = task;
    const [row] = this.sql<LedgerRow>`
      SELECT status, attempt_count FROM relay_deliveries WHERE event_id = ${event.eventId} LIMIT 1
    `;
    if (!row || row.status === "completed") return;

    const attempt = Math.max(row.attempt_count + 1, task.attempt);
    this.sql`
      UPDATE relay_deliveries
      SET status = 'processing', attempt_count = ${attempt}, updated_at = ${new Date().toISOString()}
      WHERE event_id = ${event.eventId}
    `;

    const client = new RelayClient(this.env.RELAY_API_ORIGIN, requireAgentToken(this.env));
    try {
      const message = await client.fetchMessage(event.conversationId, event.messageId);
      if (!message) throw new Error("Relay message is unavailable");

      // Read lands before any model work, so the sender sees Read while they
      // wait. This call also starts the typing signal.
      await client.beginResponding(event.conversationId, event.messageId, event.invocationId);

      let handle = this.state.handle;
      if (!handle) {
        handle = (await client.me()).handle;
        this.setState({ ...this.state, handle });
      }
      const reply = await this.generateReply(messageText(message), handle);

      // The digest of the reply is in the key, so a retry that produces the
      // same words replays instead of conflicting.
      await client.sendText({
        conversationId: event.conversationId,
        text: reply,
        idempotencyKey: await replyIdempotencyKey(event.eventId, 0, [
          { type: "text", text: reply },
        ]),
        invocationId: event.invocationId,
      });

      const completedAt = new Date().toISOString();
      this.setState({ ...this.state, lastReplyAt: completedAt });
      // event_id is recorded as done only here, after the reply landed. A
      // failure before this point leaves the row retryable.
      this.sql`
        UPDATE relay_deliveries
        SET status = 'completed', last_error = NULL, updated_at = ${completedAt}
        WHERE event_id = ${event.eventId}
      `;
    } catch (error) {
      const failure = sanitizeFailure(error);
      if (attempt >= MAX_ATTEMPTS) {
        this.sql`
          UPDATE relay_deliveries
          SET status = 'failed', last_error = ${failure}, updated_at = ${new Date().toISOString()}
          WHERE event_id = ${event.eventId}
        `;
        console.error(JSON.stringify({
          event: "relay_delivery_failed",
          event_id: event.eventId,
          attempt,
          error: failure,
        }));
        return;
      }
      // Arm the retry alarm first. Marking the row 'queued' before the alarm
      // exists would leave a row nothing is coming back for.
      try {
        await this.schedule(retryDelaySeconds(attempt), "processEvent", {
          event,
          attempt: attempt + 1,
        });
      } catch (scheduleError) {
        this.sql`
          UPDATE relay_deliveries
          SET status = 'failed', last_error = ${sanitizeFailure(scheduleError)},
            updated_at = ${new Date().toISOString()}
          WHERE event_id = ${event.eventId}
        `;
        console.error(JSON.stringify({
          event: "relay_retry_schedule_failed",
          event_id: event.eventId,
          attempt,
          error: sanitizeFailure(scheduleError),
        }));
        return;
      }
      this.sql`
        UPDATE relay_deliveries
        SET status = 'queued', last_error = ${failure}, updated_at = ${new Date().toISOString()}
        WHERE event_id = ${event.eventId}
      `;
    } finally {
      await client.stopTyping(event.conversationId, event.invocationId);
    }
  }

  // ---------------------------------------------------------------------------
  // THIS IS WHERE YOUR AGENT GOES.
  //
  // Replace the body with your model call, your tools, your prompt. Everything
  // above is delivery plumbing you should not need to touch.
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
  async generateReply(text: string, handle: string): Promise<string> {
    if (!text) return `@${handle} here. I can only read text right now.`;
    return `@${handle} here. You said: ${text}`;
  }
}
