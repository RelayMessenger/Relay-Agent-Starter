import {
  Think,
  type Action,
  type TurnConfig,
  type TurnContext,
} from "@cloudflare/think";
import {
  chatSdkMessenger,
  defaultChatSdkEvent,
  normalizeMessengers,
  ThinkMessengerStateAgent,
  type ThinkMessengers,
} from "@cloudflare/think/messengers";
import {
  createRelayAdapter,
  decodeRelayThreadId,
} from "@relaymessenger/chat-sdk-adapter";
import {
  createRelayClient,
  startRelayTypingLifecycle,
  withCardReplies,
  withLocationShares,
  withSelectionReplies,
} from "@relaymessenger/think";
import {
  RELAY_TURN_MAX_STEPS,
  relayActions,
  relayTurnSettled,
} from "@relaymessenger/think/actions";

import type { Bindings } from "./env";
import {
  requireRelayAgentHandle,
  requireRelayToken,
  requireRelayWebhookSecret,
} from "./env";
import { starterModel } from "./model";
import { replyTargetLine } from "./reply-target";

export { ThinkMessengerStateAgent };

const RELAY_WEBHOOK_PATH = "/webhooks/relay";
// Relay's downstream Message idempotency key makes immediate reclaim safe.
const ACTION_RETRY_LEASE_MS = 0;

export function createRelayMessenger(env: Bindings) {
  const handle = requireRelayAgentHandle(env);
  // The @relaymessenger/think wrappers add a person's selection, card
  // suggestion, and location share to the text the model reads.
  const adapter = withCardReplies(withLocationShares(withSelectionReplies(
    createRelayAdapter({
      baseUrl: env.RELAY_API_ORIGIN,
      token: requireRelayToken(env),
      // The agent holds the typing indicator for the whole model turn
      // (RelayChatAgent.chatWithMessengerContext).
      typing: false,
      userName: handle,
      webhookSecret: requireRelayWebhookSecret(env),
    }),
  )));
  const relay = chatSdkMessenger({
    adapter,
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
      // Relay output is committed by the Relay Actions. Think's streamed
      // model text must never become a second or partial Message.
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
  // Think's own event, with the Message a swipe-reply answers added to the
  // text the model reads (src/reply-target.ts). `toEvent` is Think's hook for
  // this; the default comes from Think's own normalizer.
  const [normalized] = normalizeMessengers({ relay });
  return {
    ...relay,
    toEvent: async (input: Parameters<NonNullable<typeof relay.toEvent>>[0]) => {
      const event = defaultChatSdkEvent(normalized!, input);
      const line = input.message
        && await replyTargetLine(adapter, input.message as Parameters<typeof replyTargetLine>[1]);
      if (event.message && line) {
        event.message.text = [event.message.text, line].filter(Boolean).join("\n\n");
      }
      return event;
    },
  };
}

export class RelayChatAgent extends Think<Bindings> {
  override actionLedgerPendingRetryLeaseMs = ACTION_RETRY_LEASE_MS;
  override chatRecovery = {
    maxAttempts: 6,
    terminalMessage: "",
  };
  override includeMcpTools = false;
  override maxSteps = RELAY_TURN_MAX_STEPS;
  override sendReasoning = false;
  override workspaceBash = false;

  override getModel() {
    return starterModel(this.env);
  }

  override getSystemPrompt(): string {
    return [
      "You are a helpful agent in Relay Messenger.",
      "Answer through the Relay tools: call send once with your complete answer,",
      "or react, or stay_silent when no answer is needed.",
    ].join(" ");
  }

  override getActions(): Record<string, Action> {
    return relayActions(this, {
      ctx: this.ctx,
      env: this.env,
      // This starter has no voice model to talk on a call, so the model is
      // not offered start_call.
      voice: false,
    });
  }

  override getMessengers(): ThinkMessengers {
    return { relay: createRelayMessenger(this.env) };
  }

  /** Holds Relay's typing indicator for the whole turn, then clears it. */
  override async chatWithMessengerContext(
    ...args: Parameters<Think<Bindings>["chatWithMessengerContext"]>
  ): Promise<void> {
    const providerThreadId = args[2].thread.providerThreadId;
    if (!providerThreadId) return super.chatWithMessengerContext(...args);
    const relay = createRelayClient(this.env);
    const { chatId } = decodeRelayThreadId(providerThreadId);
    const typing = startRelayTypingLifecycle(relay, chatId);
    try {
      await relay.chats.markAsRead(chatId).catch((error: unknown) => {
        console.warn(JSON.stringify({
          event: "relay_read_failed",
          chat_id: chatId,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
      await super.chatWithMessengerContext(...args);
    } finally {
      await (await typing).stop();
    }
  }

  override beforeTurn(context: TurnContext): TurnConfig {
    return {
      activeTools: Object.keys(context.tools),
      // One visible act per turn: relayTurnSettled ends the turn after it,
      // and lets a read (such as a location read) take a step first.
      maxSteps: RELAY_TURN_MAX_STEPS,
      sendReasoning: false,
      stopWhen: relayTurnSettled,
      toolChoice: "required",
    };
  }
}
