import {
  action,
  Think,
  type Action,
  type TurnConfig,
  type TurnContext,
} from "@cloudflare/think";
import {
  chatSdkMessenger,
  ThinkMessengerStateAgent,
  type ThinkMessengers,
} from "@cloudflare/think/messengers";
import {
  createRelayAdapter,
  decodeRelayThreadId,
} from "@relaymessenger/chat-sdk-adapter";

import { hasToolCall, type ToolSet } from "ai";

import { cateringRequestInput, requestCatering } from "./catering";
import type { Bindings } from "./env";
import {
  optionalConfiguration,
  requireRelayAgentHandle,
  requireRelayToken,
  requireRelayWebhookSecret,
} from "./env";
import { MAX_STEPS } from "./limits";
import { SNAPSHOT_MENU } from "./menu";
import { starterModel } from "./model";
import { systemPrompt } from "./prompt";
import { liveMenu } from "./toast";
import { taniasTools } from "./tools";
import {
  createReplyAction,
  markRelayChatRead,
  type RelayTurnIdentity,
} from "./reply";

export { ThinkMessengerStateAgent };

const RELAY_WEBHOOK_PATH = "/webhooks/relay";
// Relay's downstream Message idempotency key makes immediate reclaim safe.
const ACTION_RETRY_LEASE_MS = 0;
export { MAX_STEPS };
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function createRelayMessenger(env: Bindings) {
  const handle = requireRelayAgentHandle(env);
  return chatSdkMessenger({
    adapter: createRelayAdapter({
      baseUrl: env.RELAY_API_ORIGIN,
      token: requireRelayToken(env),
      typing: false,
      userName: handle,
      webhookSecret: requireRelayWebhookSecret(env),
    }),
    adapterName: "relay",
    capabilities: {
      canEditMessages: false,
      canStream: false,
      supportsActions: false,
      supportsAttachments: true,
    },
    // The Worker routes each signed Relay Chat to its own root Think instance.
    conversation: "self",
    delivery: {
      emptyResponseText: "",
      errorResponseText: "",
      interruptedResponseText: "",
      // Relay output is committed once by the native reply Action. Think's
      // streamed model text must never become a second or partial Message.
      splitText: () => [],
      visibleSoftLimit: 0,
    },
    path: RELAY_WEBHOOK_PATH,
    provider: "relay",
    respondTo: ["direct-message", "mention"],
    // The Relay adapter verifies Standard Webhooks over the exact raw body.
    verifyWebhook: false,
    userName: handle,
  });
}

export class RelayChatAgent extends Think<Bindings> {
  override actionLedgerPendingRetryLeaseMs = ACTION_RETRY_LEASE_MS;
  override chatRecovery = {
    maxAttempts: 6,
    terminalMessage: "",
  };
  override includeMcpTools = false;
  override maxSteps = MAX_STEPS;
  override sendReasoning = false;
  override workspaceBash = false;

  override getModel() {
    return starterModel(this.env);
  }

  override getSystemPrompt(): string {
    return systemPrompt(new Date());
  }

  override getTools(): ToolSet {
    const env = optionalConfiguration(this.env);
    return taniasTools({
      env,
      menu: () => liveMenu(env, SNAPSHOT_MENU),
      now: () => new Date(),
    });
  }

  override getActions(): Record<string, Action> {
    return {
      reply: createReplyAction({
        env: this.env,
        turn: () => this.relayTurn(),
      }),
      request_catering: action({
        description:
          "File a catering request on Tania's catering calendar for owner confirmation. "
          + "Use only a start time returned by check_catering_availability, after the customer agreed to the details. "
          + "Call at most once per customer message.",
        inputSchema: cateringRequestInput,
        idempotencyKey: () => `catering:${this.relayTurn().messageId}`,
        execute: (input, context) => requestCatering(
          optionalConfiguration(this.env),
          input,
          this.relayTurn().chatId,
          context.signal,
        ),
      }),
    };
  }

  override getMessengers(): ThinkMessengers {
    return { relay: createRelayMessenger(this.env) };
  }

  override async beforeTurn(context: TurnContext): Promise<TurnConfig> {
    const turn = this.relayTurn();
    try {
      await markRelayChatRead(this.env, turn.chatId);
    } catch (error) {
      console.warn(JSON.stringify({
        event: "relay_read_failed",
        chat_id: turn.chatId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }

    return {
      activeTools: context.tools.reply ? Object.keys(context.tools) : [],
      maxSteps: MAX_STEPS,
      sendReasoning: false,
      // Every step is a tool call; the turn ends when the one reply lands.
      stopWhen: hasToolCall("reply"),
      toolChoice: "required",
    };
  }

  /**
   * Record a Message the Worker sent outside a model turn (a catering
   * decision) so the next turn's history includes it. Never starts a turn.
   */
  async recordAgentNote(id: string, text: string): Promise<void> {
    await this.addMessages([{
      id,
      parts: [{ text, type: "text" }],
      role: "assistant",
    }]);
  }

  private relayTurn(): RelayTurnIdentity {
    const context = this.getMessengerContext();
    const providerThreadId = context?.thread.providerThreadId;
    const messageId =
      context?.message?.providerMessageId ?? context?.message?.id;
    if (!providerThreadId) {
      throw new Error("Relay messenger context is missing a Chat ID");
    }
    const { chatId } = decodeRelayThreadId(providerThreadId);
    if (!messageId || !UUID.test(messageId)) {
      throw new Error("Relay messenger context is missing a Message ID");
    }
    return { chatId, messageId };
  }
}
