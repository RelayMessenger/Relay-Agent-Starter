import { action, type Action } from "@cloudflare/think";
import Relay, { indexedIdempotencyKey, type RequestOptions } from "@relaymessenger/sdk";

import { composeAnswer, REPLY_DESCRIPTION, replyInputSchema } from "./action-specs";
import { answerToMessages } from "./answer";
import type { Bindings, RelayConfiguration } from "./env";
import { requireRelayToken } from "./env";


export interface RelayTurnIdentity {
  chatId: string;
  messageId: string;
}

interface ReplyDependencies {
  env: Bindings;
  /** True when a newer customer Message arrived; its turn will answer. */
  superseded(turn: RelayTurnIdentity): Promise<boolean>;
  turn(): RelayTurnIdentity;
}

export type RelaySdkEnvironment = Required<
  Pick<RelayConfiguration, "RELAY_AGENT_TOKEN" | "RELAY_API_ORIGIN">
> & { RELAY_INTERACTIVE_PARTS?: string };

export function relayClient(env: RelaySdkEnvironment): Relay {
  return new Relay({
    apiKey: requireRelayToken(env),
    baseURL: env.RELAY_API_ORIGIN,
    maxRetries: 2,
    timeout: 30_000,
  });
}

function requestOptions(signal?: AbortSignal): RequestOptions {
  return signal ? { signal } : {};
}

/** Buttons and selection parts are on for this server ("true" in wrangler.jsonc). */
export function interactiveParts(env: { RELAY_INTERACTIVE_PARTS?: string }): boolean {
  return env.RELAY_INTERACTIVE_PARTS?.trim() === "true";
}

export function relayReplyIdempotencyKey(messageId: string): string {
  return `tanias-pizza-agent:${messageId}`;
}

export async function markRelayChatRead(
  env: RelaySdkEnvironment,
  chatId: string,
): Promise<void> {
  await relayClient(env).chats.markAsRead(chatId);
}

/**
 * Sends one answer as the Relay Messages it becomes (words with buttons or a
 * selection, link cards on their own), in order. The first Message uses the
 * answer's key and the rest the SDK's indexed keys, so a retried Action or
 * Worker replays the same Messages instead of adding new ones.
 */
export async function sendRelayAnswer(
  env: RelaySdkEnvironment,
  chatId: string,
  answer: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<{ messageId: string; messageIds: string[]; status: "sent" }> {
  const plan = answerToMessages(answer, { interactive: interactiveParts(env) });
  if (plan.notes.length > 0) {
    console.warn(JSON.stringify({ chat_id: chatId, event: "answer_adjusted", notes: plan.notes }));
  }
  const relay = relayClient(env);
  const messageIds: string[] = [];
  for (const [index, parts] of plan.messages.entries()) {
    const key = indexedIdempotencyKey(idempotencyKey, index);
    const result = await relay.chats.messages.send(
      chatId,
      { message: { idempotency_key: key, parts } },
      requestOptions(signal),
    );
    messageIds.push(result.message.id);
  }
  // The answer is out: clear the typing indicator the turn started.
  await relay.chats.stopTyping(chatId).catch(() => {});
  return { messageId: messageIds[0]!, messageIds, status: "sent" };
}

export async function sendRelayReply(
  env: RelaySdkEnvironment,
  turn: RelayTurnIdentity,
  answer: string,
  signal?: AbortSignal,
) {
  return sendRelayAnswer(env, turn.chatId, answer, relayReplyIdempotencyKey(turn.messageId), signal);
}

export function createReplyAction(deps: ReplyDependencies): Action {
  return action({
    description: REPLY_DESCRIPTION,
    inputSchema: replyInputSchema,
    idempotencyKey: () => `message:${deps.turn().messageId}`,
    execute: async (input, context) => {
      const turn = deps.turn();
      if (await deps.superseded(turn)) {
        console.warn(JSON.stringify({ chat_id: turn.chatId, event: "reply_superseded" }));
        return { status: "superseded" };
      }
      return sendRelayReply(deps.env, turn, composeAnswer(input), context.signal);
    },
  });
}
