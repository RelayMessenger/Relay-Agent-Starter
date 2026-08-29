import { Agent } from "agents";

import type { Env } from "./env";
import { groupReplyPolicy, requireAgentToken } from "./env";
import {
  acceptRelayEvent,
  isRetryableRelayError,
  messageContent,
  needsRecoveryArm,
  type RelayEventReference,
  RelayClient,
  replyIdempotencyKey,
  sanitizeFailure,
  shouldReplyToMessage,
} from "./relay";

interface ChatState {
  lastEventAt: string | null;
  lastReplyAt: string | null;
}

interface EventRow {
  event_id: string;
  envelope_json: string;
  reply_text: string | null;
  status: string;
  attempt_count: number;
}

const MAX_ATTEMPTS = 6;

function retryDelaySeconds(attempt: number): number {
  return Math.min(15 * 60, 30 * 2 ** Math.max(0, attempt - 1));
}

export class RelayChatAgent extends Agent<Env, ChatState> {
  initialState: ChatState = {
    lastEventAt: null,
    lastReplyAt: null,
  };

  async onStart(): Promise<void> {
    await super.onStart();
    this.sql`
      CREATE TABLE IF NOT EXISTS relay_events (
        event_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        reply_text TEXT,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    const columns = this.sql<{ name: string }>`
      PRAGMA table_info(relay_events)
    `;
    if (!columns.some((column) => column.name === "reply_text")) {
      this.sql`ALTER TABLE relay_events ADD COLUMN reply_text TEXT`;
    }
    this.sql`
      DELETE FROM relay_events
      WHERE status IN ('completed', 'failed', 'ignored')
        AND julianday(updated_at) < julianday('now', '-30 days')
    `;
    const rows = this.sql<EventRow>`
      SELECT event_id, envelope_json, reply_text, status, attempt_count
      FROM relay_events
    `;
    for (const row of rows.filter((entry) => needsRecoveryArm(entry.status))) {
      await this.schedule(0, "processEvent", {
        eventId: row.event_id,
        attempt: row.attempt_count + 1,
      });
    }
  }

  override async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const event = (await request.json()) as RelayEventReference;
    this.setState({ ...this.state, lastEventAt: new Date().toISOString() });

    const outcome = await acceptRelayEvent(event, {
      lookup: (eventId) => {
        const [row] = this.sql<{ status: string }>`
          SELECT status FROM relay_events WHERE event_id = ${eventId} LIMIT 1
        `;
        return row?.status;
      },
      record: (accepted) => {
        const now = new Date().toISOString();
        this.sql`
          INSERT INTO relay_events (
            event_id, chat_id, message_id, envelope_json, status,
            attempt_count, created_at, updated_at
          ) VALUES (
            ${accepted.eventId}, ${accepted.chatId}, ${accepted.messageId},
            ${JSON.stringify(accepted.envelope)}, 'accepting', 0, ${now}, ${now}
          )
          ON CONFLICT(event_id) DO UPDATE SET
            chat_id = excluded.chat_id,
            message_id = excluded.message_id,
            envelope_json = excluded.envelope_json,
            status = 'accepting',
            attempt_count = 0,
            last_error = NULL,
            updated_at = excluded.updated_at
        `;
      },
      arm: async (eventId) => {
        await this.schedule(0, "processEvent", { eventId, attempt: 1 });
      },
      markQueued: (eventId) => {
        this.sql`
          UPDATE relay_events SET status = 'queued', updated_at = ${new Date().toISOString()}
          WHERE event_id = ${eventId}
        `;
      },
      markFailed: (eventId, error) => {
        this.sql`
          UPDATE relay_events
          SET status = 'failed', last_error = ${error}, updated_at = ${new Date().toISOString()}
          WHERE event_id = ${eventId}
        `;
      },
    });
    return new Response(null, { status: outcome.status });
  }

  async processEvent(task: { eventId: string; attempt: number }): Promise<void> {
    const [row] = this.sql<EventRow>`
      SELECT event_id, envelope_json, reply_text, status, attempt_count
      FROM relay_events WHERE event_id = ${task.eventId} LIMIT 1
    `;
    if (!row || ["completed", "failed", "ignored"].includes(row.status)) return;

    const attempt = Math.max(row.attempt_count + 1, task.attempt);
    this.sql`
      UPDATE relay_events
      SET status = 'processing', attempt_count = ${attempt}, updated_at = ${new Date().toISOString()}
      WHERE event_id = ${row.event_id}
    `;

    const event = JSON.parse(row.envelope_json) as RelayEventReference["envelope"];
    const message = event.data;
    if (!message) {
      this.sql`
        UPDATE relay_events SET status = 'failed', last_error = 'missing event data',
          updated_at = ${new Date().toISOString()}
        WHERE event_id = ${row.event_id}
      `;
      return;
    }

    const client = new RelayClient(
      this.env.RELAY_API_ORIGIN,
      requireAgentToken(this.env),
    );
    try {
      if (!shouldReplyToMessage({
        message,
        policy: groupReplyPolicy(this.env),
      })) {
        this.sql`
          UPDATE relay_events SET status = 'ignored', last_error = NULL,
            updated_at = ${new Date().toISOString()}
          WHERE event_id = ${row.event_id}
        `;
        return;
      }

      await client.markRead(message.chat.id);
      const content = messageContent(message);
      const handle = message.chat.owner_handle?.handle ?? "agent";
      let reply = row.reply_text;
      if (reply === null) {
        reply = await this.generateReply(
          content.text,
          content.mediaCount,
          handle,
        );
        if (!reply.trim()) throw new Error("Relay reply contained no text");
        this.sql`
          UPDATE relay_events SET reply_text = ${reply},
            updated_at = ${new Date().toISOString()}
          WHERE event_id = ${row.event_id} AND reply_text IS NULL
        `;
        const [persisted] = this.sql<{ reply_text: string }>`
          SELECT reply_text FROM relay_events
          WHERE event_id = ${row.event_id} LIMIT 1
        `;
        if (!persisted?.reply_text) {
          throw new Error("Relay could not persist the reply");
        }
        reply = persisted.reply_text;
      }
      await client.sendText({
        chatId: message.chat.id,
        text: reply,
        idempotencyKey: await replyIdempotencyKey(event.event_id, 0, {
          message: { parts: [{ type: "text", value: reply }] },
        }),
      });

      const completedAt = new Date().toISOString();
      this.setState({ ...this.state, lastReplyAt: completedAt });
      this.sql`
        UPDATE relay_events SET status = 'completed', last_error = NULL,
          updated_at = ${completedAt}
        WHERE event_id = ${row.event_id}
      `;
    } catch (error) {
      const failure = sanitizeFailure(error);
      if (!isRetryableRelayError(error) || attempt >= MAX_ATTEMPTS) {
        this.sql`
          UPDATE relay_events SET status = 'failed', last_error = ${failure},
            updated_at = ${new Date().toISOString()}
          WHERE event_id = ${row.event_id}
        `;
        return;
      }
      try {
        await this.schedule(retryDelaySeconds(attempt), "processEvent", {
          eventId: row.event_id,
          attempt: attempt + 1,
        });
        this.sql`
          UPDATE relay_events SET status = 'queued', last_error = ${failure},
            updated_at = ${new Date().toISOString()}
          WHERE event_id = ${row.event_id}
        `;
      } catch (scheduleError) {
        this.sql`
          UPDATE relay_events SET status = 'failed',
            last_error = ${sanitizeFailure(scheduleError)},
            updated_at = ${new Date().toISOString()}
          WHERE event_id = ${row.event_id}
        `;
      }
    }
  }

  async generateReply(
    text: string,
    mediaCount: number,
    handle: string,
  ): Promise<string> {
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
