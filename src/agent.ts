import {
  action,
  Think,
  type Action,
  type ChatResponseResult,
  type PrepareStepContext,
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
import {
  REQUEST_CATERING_DESCRIPTION,
  REQUEST_LOCATION_DESCRIPTION,
  requestLocationInputSchema,
} from "./action-specs";
import { FALLBACK_REPLY } from "./answer";
import { deliveryDistance, requestRelayLocation, withComponentContext } from "./interactive";
import { forcedReplyStep, MAX_OUTPUT_TOKENS, MAX_STEPS } from "./limits";
import { SNAPSHOT_MENU } from "./menu";
import { starterModel } from "./model";
import { systemPrompt } from "./prompt";
import { liveMenu } from "./toast";
import { taniasTools } from "./tools";
import {
  createReplyAction,
  markRelayChatRead,
  relayClient,
  relayReplyIdempotencyKey,
  sendRelayAnswer,
  type RelayTurnIdentity,
} from "./reply";

export { ThinkMessengerStateAgent };

const RELAY_WEBHOOK_PATH = "/webhooks/relay";
const LATEST_INBOUND_KEY = "tanias:latest-inbound-message";
// Relay's downstream Message idempotency key makes immediate reclaim safe.
const ACTION_RETRY_LEASE_MS = 0;
export { MAX_STEPS };

export { FALLBACK_REPLY };

/** True when the turn's assistant message holds a completed reply Action. */
/**
 * The model's plain answer text for the turn, when it answered in text
 * instead of calling reply. Workers AI's gpt-oss-120b does this after a tool
 * result even under toolChoice "required" (observed 2026-09-24).
 */
export function turnText(message: { parts?: ReadonlyArray<unknown> } | undefined): string {
  return (message?.parts ?? [])
    .filter((part) => (part as { type?: unknown }).type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .join("")
    .trim();
}

export function turnReplied(message: { parts?: ReadonlyArray<unknown> } | undefined): boolean {
  return (message?.parts ?? []).some((part) => {
    const candidate = part as { type?: unknown; state?: unknown };
    return candidate.type === "tool-reply" && candidate.state === "output-available";
  });
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function createRelayMessenger(env: Bindings) {
  const handle = requireRelayAgentHandle(env);
  return chatSdkMessenger({
    // Selection answers, location cards and payment receipts reach the
    // turn as data (see interactive.ts).
    adapter: withComponentContext(createRelayAdapter({
      baseUrl: env.RELAY_API_ORIGIN,
      token: requireRelayToken(env),
      typing: false,
      userName: handle,
      webhookSecret: requireRelayWebhookSecret(env),
    })),
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
      deliveryDistance: () => deliveryDistance(relayClient(this.env), this.relayTurn().chatId),
      env,
      menu: () => liveMenu(env, SNAPSHOT_MENU),
      now: () => new Date(),
    });
  }

  override getActions(): Record<string, Action> {
    return {
      reply: createReplyAction({
        env: this.env,
        superseded: (turn) => this.superseded(turn),
        turn: () => this.relayTurn(),
      }),
      request_location: action({
        description: REQUEST_LOCATION_DESCRIPTION,
        inputSchema: requestLocationInputSchema,
        idempotencyKey: () => `location:${this.relayTurn().messageId}`,
        execute: (_input, context) => requestRelayLocation(
          relayClient(this.env),
          this.relayTurn().chatId,
          context.signal ? { signal: context.signal } : {},
        ),
      }),
      request_catering: action({
        description: REQUEST_CATERING_DESCRIPTION,
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

  /**
   * Turns in one Chat run serially, but Think releases the turn lock before
   * onChatResponse, so the next turn's beforeTurn can run first. Pair them
   * first-in, first-out.
   */
  private readonly pendingTurns: Array<RelayTurnIdentity | null> = [];

  override async beforeTurn(context: TurnContext): Promise<TurnConfig> {
    let turn: RelayTurnIdentity;
    try {
      turn = this.relayTurn();
    } catch (error) {
      this.pendingTurns.push(null);
      throw error;
    }
    this.pendingTurns.push(turn);
    // Relay's typing indicator for the whole turn (best effort; stopped in
    // onChatResponse), so a customer sees the agent is working.
    void relayClient(this.env).chats.startTyping(turn.chatId).catch(() => {});
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
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxSteps: MAX_STEPS,
      sendReasoning: false,
      // Every step is a tool call; the turn ends when the one reply lands.
      stopWhen: hasToolCall("reply"),
      // "auto", not "required": ai 7.0.107 throws ToolChoiceViolationError
      // when a model answers in text under "required", and Workers AI
      // gpt-oss does after a tool result. A text answer is the reply
      // (onChatResponse), through the same answer contract as the Action.
      toolChoice: "auto",
    };
  }

  override beforeStep(context: PrepareStepContext) {
    return forcedReplyStep(context.stepNumber, context.steps);
  }

  /**
   * A completed turn that never called reply would leave the customer with
   * silence. If the model answered in plain text, send that text; if it
   * produced nothing (e.g. the step cap), send a short fallback. Both use
   * the reply's own idempotency key: if a reply was in fact committed, Relay
   * rejects the different body instead of sending a second Message.
   */
  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    const turn = this.pendingTurns.shift();
    if (turn) await relayClient(this.env).chats.stopTyping(turn.chatId).catch(() => {});
    if (!turn || result.status !== "completed" || turnReplied(result.message)) return;
    if (await this.superseded(turn)) {
      console.warn(JSON.stringify({ chat_id: turn.chatId, event: "reply_superseded" }));
      return;
    }
    // The model answered in plain text: that text is the reply. Only a turn
    // with no answer at all gets the fallback.
    const text = turnText(result.message).slice(0, 20_000);
    console.warn(JSON.stringify({
      chat_id: turn.chatId,
      event: text ? "reply_from_text" : "turn_without_reply",
    }));
    try {
      await sendRelayAnswer(
        this.env,
        turn.chatId,
        text || FALLBACK_REPLY,
        relayReplyIdempotencyKey(turn.messageId),
      );
    } catch (error) {
      console.warn(JSON.stringify({
        event: "reply_send_failed",
        chat_id: turn.chatId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  /**
   * The Worker records each person's newest Message in this Chat as it
   * arrives (noteInbound), before the turns run one by one. A turn whose
   * Message is no longer the newest stays silent: the newer turn sees every
   * Message in history and answers them together, so a customer who sends a
   * follow-up while the agent is thinking gets one answer, not one per
   * Message (Relay-Agent's chronological admission, simplified).
   */
  async noteInbound(messageId: string): Promise<void> {
    await this.ctx.storage.put(LATEST_INBOUND_KEY, messageId);
  }

  private async superseded(turn: RelayTurnIdentity): Promise<boolean> {
    const latest = await this.ctx.storage.get<string>(LATEST_INBOUND_KEY);
    return Boolean(latest && latest !== turn.messageId);
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
