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

// @relaymessenger/think keys the first send of a turn `message:<id>:1`.
function sendActionKey(messageId: string): string {
  return `action:send:message:${messageId}:1`;
}

export const TEST_SECOND_REPLY_TEXT = "A second test reply.";
// A person's Message containing this word gets two sends in one turn.
export const TWO_SENDS_WORD = "twice";
// The model's own words after its sends. RELAY_MESSENGER_DELIVERY must keep
// Think from posting them as a Message.
export const TEST_TRAILING_TEXT = "Trailing model text that is not a Message.";

const USAGE = {
  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 8, total: 8 },
  outputTokens: { reasoning: 0, text: 8, total: 8 },
};

type Prompt = Parameters<MockLanguageModelV3["doStream"]>[0]["prompt"];

/** Sends made since the person's last Message, and that Message's words. */
function turnSoFar(prompt: Prompt): { sends: number; userText: string } {
  let lastUser = prompt.length - 1;
  while (lastUser >= 0 && prompt[lastUser]!.role !== "user") lastUser -= 1;
  const user = prompt[lastUser];
  const userText = user && Array.isArray(user.content)
    ? user.content.map((part) => (part.type === "text" ? part.text : "")).join(" ")
    : "";
  let sends = 0;
  for (const message of prompt.slice(lastUser + 1)) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "tool-call" && part.toolName === "send") sends += 1;
    }
  }
  return { sends, userText };
}

// Each step sends the next scripted Message; once the script is done the
// model answers with plain text and no tool, which ends the turn.
function testModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const { sends, userText } = turnSoFar(prompt);
      const script = userText.includes(TWO_SENDS_WORD)
        ? [TEST_REPLY_TEXT, TEST_SECOND_REPLY_TEXT]
        : [TEST_REPLY_TEXT];
      const next = script[sends];
      const body = next === undefined
        ? [
            { id: "trailing", type: "text-start" as const },
            { delta: TEST_TRAILING_TEXT, id: "trailing", type: "text-delta" as const },
            { id: "trailing", type: "text-end" as const },
          ]
        : [{
            input: JSON.stringify({ kind: "text", text: next }),
            toolCallId: crypto.randomUUID(),
            toolName: "send",
            type: "tool-call" as const,
          }];
      return {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            ...body,
            {
              finishReason: next === undefined
                ? { raw: "stop", unified: "stop" as const }
                : { raw: "tool_calls", unified: "tool-calls" as const },
              type: "finish" as const,
              usage: USAGE,
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
    const key = sendActionKey(messageId);
    const inputHash = stableHash({ kind: "text", text });
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
        ${key}, ${"send"}, ${"stale-request"}, ${"stale-tool"},
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
      WHERE action_name = ${"send"}
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
