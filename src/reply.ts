import { action, type Action } from "@cloudflare/think";
import Relay, { type RequestOptions } from "@relaymessenger/sdk";
import { z } from "zod";

import type { Bindings, RelayConfiguration } from "./env";
import { requireRelayToken } from "./env";

const replySchema = z.object({
  text: z.string().trim().min(1).max(10_000),
}).strict();

export interface RelayTurnIdentity {
  chatId: string;
  messageId: string;
}

interface ReplyDependencies {
  env: Bindings;
  turn(): RelayTurnIdentity;
}

type RelaySdkEnvironment = Required<
  Pick<RelayConfiguration, "RELAY_AGENT_TOKEN" | "RELAY_API_ORIGIN">
>;

function relayClient(env: RelaySdkEnvironment): Relay {
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

export function relayReplyIdempotencyKey(messageId: string): string {
  return `relay-agent-starter:${messageId}`;
}

export async function markRelayChatRead(
  env: RelaySdkEnvironment,
  chatId: string,
): Promise<void> {
  await relayClient(env).chats.markAsRead(chatId);
}

export async function sendRelayReply(
  env: RelaySdkEnvironment,
  turn: RelayTurnIdentity,
  text: string,
  signal?: AbortSignal,
): Promise<{ messageId: string; status: "sent" }> {
  const idempotencyKey = relayReplyIdempotencyKey(turn.messageId);
  const result = await relayClient(env).chats.messages.send(
    turn.chatId,
    {
      message: {
        idempotency_key: idempotencyKey,
        parts: [{ type: "text", value: text }],
      },
    },
    requestOptions(signal),
  );
  return {
    messageId: result.message.id,
    status: "sent",
  };
}

export function createReplyAction(deps: ReplyDependencies): Action {
  return action({
    description:
      "Send the complete response as one canonical Relay Message. "
      + "Call this exactly once.",
    inputSchema: replySchema,
    idempotencyKey: () => `message:${deps.turn().messageId}`,
    execute: ({ text }, context) =>
      sendRelayReply(deps.env, deps.turn(), text, context.signal),
  });
}
