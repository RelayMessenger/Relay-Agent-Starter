import { action, type Action } from "@cloudflare/think";
import Relay, { indexedIdempotencyKey, type RequestOptions } from "@relaymessenger/sdk";

import { composeAnswer, REPLY_DESCRIPTION, replyInputSchema } from "./action-specs";
import { cardRejection, sendCard } from "./cards";
import { answerToMessages } from "./answer";
import type { Bindings, RelayConfiguration } from "./env";
import { requireRelayToken } from "./env";


export interface RelayTurnIdentity {
  chatId: string;
  messageId: string;
  /** The Relay handle ID of the person whose Message started the turn. */
  senderId?: string;
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

/** A short, stable id for an input (FNV-1a). */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function createReplyAction(deps: ReplyDependencies): Action {
  // Bad cards per customer Message, within this Agent instance.
  const rejectedCards = new Map<string, number>();
  return action({
    description: REPLY_DESCRIPTION,
    inputSchema: replyInputSchema,
    // A reply turned back for a bad card sent nothing, so a retry with a
    // different card is a different call; Relay's key still guards the send.
    idempotencyKey: ({ input }) =>
      `message:${deps.turn().messageId}${input.card ? `:${fingerprint(JSON.stringify(input.card))}` : ""}`,
    execute: async (input, context) => {
      const turn = deps.turn();
      if (await deps.superseded(turn)) {
        console.warn(JSON.stringify({ chat_id: turn.chatId, event: "reply_superseded" }));
        return { status: "superseded" };
      }
      const cards = interactiveParts(deps.env) && input.card !== undefined;
      const rejection = cards ? cardRejection(input.card!.components) : undefined;
      if (rejection) {
        if (rejectedCards.size > 100) rejectedCards.clear();
        rejectedCards.set(turn.messageId, (rejectedCards.get(turn.messageId) ?? 0) + 1);
        console.warn(JSON.stringify({ event: "card_invalid", issues: rejection.issues.slice(0, 5) }));
        // Once is a fix; twice, the words go out alone so the customer is answered.
        if (rejectedCards.get(turn.messageId)! < 2) return rejection;
        const sent = await sendRelayReply(deps.env, turn, composeAnswer(input), context.signal);
        return { ...sent, card: { issues: rejection.issues, status: "not_sent" } };
      }
      const sent = await sendRelayReply(deps.env, turn, composeAnswer(input), context.signal);
      if (!input.card) return sent;
      if (!cards) return { ...sent, card: { status: "not_available_on_this_server" } };
      // The card follows the words as its own Message, with its own key.
      const card = await sendCard(relayClient(deps.env), turn.chatId, {
        ...input.card,
        surface_id: input.card.surface_id ?? `card-${turn.messageId.slice(-12)}`,
      }, `${relayReplyIdempotencyKey(turn.messageId)}:card`);
      return { ...sent, card };
    },
  });
}
