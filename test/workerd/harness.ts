import { getAgentByName } from "agents";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import worker, {
  RelayChatAgent as StarterRelayChatAgent,
} from "../../src/index";
import type { Bindings } from "../../src/env";

export { ThinkMessengerStateAgent } from "../../src/index";

export const TEST_REPLY_TEXT = "A complete test reply.";

const TEST_ACTION_RETRY_LEASE_MS = 0;

interface ActionLedgerRow {
  key: string;
  result_json: string | null;
  status: string;
  updated_at: number;
}

interface LedgerTestRpc {
  readLocalReplyClaims(): Promise<ActionLedgerRow[]>;
  seedLocalStaleReplyClaim(
    messageId: string,
    text: string,
  ): Promise<void> | void;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return `${value.toString()}n`;
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function stableHash(value: unknown): string {
  const input = stableStringify(value);
  let h1 = 1_779_033_703;
  let h2 = 3_144_134_277;
  let h3 = 1_013_904_242;
  let h4 = 2_773_480_762;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597_399_067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2_869_860_233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951_274_213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2_716_044_179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597_399_067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2_869_860_233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951_274_213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2_716_044_179);
  return [h1, h2, h3, h4]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

function chatIdFromThreadId(threadId: string): string {
  if (!threadId.startsWith("relay:")) {
    throw new Error("Test thread ID must start with relay:");
  }
  return threadId.slice("relay:".length);
}

function replyActionKey(messageId: string): string {
  return `action:reply:message:${messageId}`;
}

function testModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => {
      const toolCallId = crypto.randomUUID();
      return {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            {
              type: "stream-start" as const,
              warnings: [],
            },
            {
              input: JSON.stringify({ text: TEST_REPLY_TEXT }),
              toolCallId,
              toolName: "reply",
              type: "tool-call" as const,
            },
            {
              finishReason: {
                raw: "tool_calls",
                unified: "tool-calls" as const,
              },
              type: "finish" as const,
              usage: {
                inputTokens: {
                  cacheRead: undefined,
                  cacheWrite: undefined,
                  noCache: 8,
                  total: 8,
                },
                outputTokens: {
                  reasoning: 0,
                  text: 8,
                  total: 8,
                },
              },
            },
          ],
          initialDelayInMs: null,
        }),
      };
    },
  });
}

export class RelayChatAgent extends StarterRelayChatAgent {
  override actionLedgerPendingRetryLeaseMs = TEST_ACTION_RETRY_LEASE_MS;

  override getModel() {
    return testModel();
  }

  seedLocalStaleReplyClaim(messageId: string, text: string): void {
    const now = Date.now();
    const updatedAt = now - TEST_ACTION_RETRY_LEASE_MS - 1_000;
    const key = replyActionKey(messageId);
    const inputHash = stableHash({ text });
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_think_action_ledger (
        key TEXT PRIMARY KEY,
        action_name TEXT NOT NULL,
        request_id TEXT,
        tool_call_id TEXT,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    this.sql`
      INSERT INTO cf_think_action_ledger (
        key, action_name, request_id, tool_call_id, input_hash, status,
        result_json, created_at, updated_at
      ) VALUES (
        ${key}, ${"reply"}, ${"stale-request"}, ${"stale-tool"},
        ${inputHash}, ${"pending"}, ${null}, ${updatedAt}, ${updatedAt}
      )
      ON CONFLICT(key) DO UPDATE SET
        action_name = excluded.action_name,
        request_id = excluded.request_id,
        tool_call_id = excluded.tool_call_id,
        input_hash = excluded.input_hash,
        status = excluded.status,
        result_json = excluded.result_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `;
  }

  readLocalReplyClaims(): ActionLedgerRow[] {
    return this.sql<ActionLedgerRow>`
      SELECT key, result_json, status, updated_at
      FROM cf_think_action_ledger
      WHERE action_name = ${"reply"}
      ORDER BY key ASC
    `;
  }
}

const TEST_LEDGER_PATH = "/__test/action-ledger";

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === TEST_LEDGER_PATH) {
      if (request.method === "POST") {
        const input = await request.json<{
          messageId: string;
          text: string;
          threadId: string;
        }>();
        const root = await getAgentByName<Bindings, StarterRelayChatAgent>(
          env.RelayChat,
          chatIdFromThreadId(input.threadId),
        );
        const testRoot = root as typeof root & LedgerTestRpc;
        await testRoot.seedLocalStaleReplyClaim(
          input.messageId,
          input.text,
        );
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET") {
        const threadId = url.searchParams.get("threadId");
        if (!threadId) {
          return Response.json({ error: "threadId is required" }, {
            status: 400,
          });
        }
        const root = await getAgentByName<Bindings, StarterRelayChatAgent>(
          env.RelayChat,
          chatIdFromThreadId(threadId),
        );
        const testRoot = root as typeof root & LedgerTestRpc;
        return Response.json({
          rows: await testRoot.readLocalReplyClaims(),
        });
      }
      return new Response("Method not allowed", { status: 405 });
    }
    return worker.fetch(request, env);
  },
} satisfies ExportedHandler<Bindings>;
