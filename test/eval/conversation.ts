import { appendFileSync } from "node:fs";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  generateText,
  hasToolCall,
  stepCountIs,
  tool,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import type { MessagePart } from "@relaymessenger/sdk";

import { forcedReplyStep, MAX_OUTPUT_TOKENS, MAX_STEPS } from "../../src/limits";
import { cateringRequestInput, cateringRequestProblem, PENDING_STATUS } from "../../src/catering";
import {
  composeAnswer,
  REPLY_DESCRIPTION,
  REQUEST_CATERING_DESCRIPTION,
  REQUEST_LOCATION_DESCRIPTION,
  replyInputSchema,
  requestLocationInputSchema,
} from "../../src/action-specs";
import { answerToMessages, FALLBACK_REPLY } from "../../src/answer";
import type { DeliveryDistance } from "../../src/interactive";
import { SNAPSHOT_MENU } from "../../src/menu";
import { systemPrompt } from "../../src/prompt";
import { taniasTools } from "../../src/tools";

/**
 * Runs the production prompt, tools and turn policy (tool calls only, stop
 * on the one reply, at most MAX_STEPS) against a live OpenAI-compatible
 * endpoint. Works with Workers AI's OpenAI-compatible API, a local MLX or
 * llama.cpp server, OpenRouter, or Gemini's compatibility endpoint:
 *
 *   EVAL_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1 \
 *   EVAL_API_KEY=<token> EVAL_MODEL=@cf/openai/gpt-oss-120b npm run eval
 */
export const EVAL_CONFIGURED = Boolean(process.env.EVAL_BASE_URL && process.env.EVAL_MODEL);

export interface TurnResult {
  /**
   * Everything the customer would see, flattened for assertions: text parts,
   * button labels and urls, selection labels, link card URLs.
   */
  reply: string | null;
  /** The Relay Messages the answer becomes (answerToMessages), in order. */
  messages: MessagePart[][];
  /** The raw answer the model produced (reply text or plain text). */
  answer: string | null;
  locationRequested: boolean;
  /** Wall-clock time for the whole turn, model and tools. */
  durationMs: number;
  toolCalls: Array<{ name: string; input: unknown }>;
  cateringRequests: unknown[];
  /** The model answered in plain text instead of calling reply. */
  repliedInText: boolean;
  steps: number;
}

function model() {
  const provider = createOpenAICompatible({
    apiKey: process.env.EVAL_API_KEY ?? "none",
    baseURL: process.env.EVAL_BASE_URL!,
    name: "eval",
    fetch: async (input, init) => {
      // Workers AI's OpenAI-compatible endpoint rejects an assistant
      // tool-call message whose content is null; it requires a string.
      let body = init?.body;
      if (typeof body === "string") {
        const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
        for (const message of parsed.messages ?? []) {
          if (message.content === null) message.content = "";
        }
        body = JSON.stringify(parsed);
      }
      const response = await fetch(input, { ...init, body });
      // EVAL_DEBUG=1 prints each failing request and response body.
      if (process.env.EVAL_DEBUG === "all" || (!response.ok && process.env.EVAL_DEBUG)) {
        console.error("EVAL_DEBUG request", String(body).slice(0, 4000));
        console.error("EVAL_DEBUG response", response.status, await response.clone().text());
      }
      return response;
    },
  });
  // Same LanguageModelV4 spec; the provider package pins a newer patch of
  // @ai-sdk/provider than `ai` does, so the nominal types differ.
  return provider.chatModel(process.env.EVAL_MODEL!) as unknown as LanguageModel;
}

export function flatten(messages: MessagePart[][]): string {
  return messages.flat().map((part) => {
    if (part.type === "text") return part.value;
    if (part.type === "link") return part.value;
    if (part.type === "buttons") return part.items.map((item) => [item.label, item.url].filter(Boolean).join(" ")).join("\n");
    if (part.type === "selection") return part.options.map((option) => option.label).join("\n");
    return "";
  }).join("\n");
}

export async function runTurn(
  history: ModelMessage[],
  options: {
    now: Date;
    cateringEnv?: Record<string, string>;
    fetcher?: typeof fetch;
    distance?: DeliveryDistance;
    interactive?: boolean;
  },
): Promise<TurnResult> {
  let reply: string | null = null;
  let locationRequested = false;
  const cateringRequests: unknown[] = [];
  const tools = {
    ...taniasTools({
      deliveryDistance: async () => options.distance
        ?? { instruction: "They aren't sharing a location.", status: "not_sharing" as const },
      env: options.cateringEnv ?? {},
      fetcher: options.fetcher,
      menu: async () => SNAPSHOT_MENU,
      now: () => options.now,
      web: { TAVILY_API_KEY: process.env.TAVILY_API_KEY },
    }),
    reply: tool({
      description: REPLY_DESCRIPTION,
      inputSchema: replyInputSchema,
      execute: async (input) => {
        reply = composeAnswer(input);
        return { status: "sent" };
      },
    }),
    request_location: tool({
      description: REQUEST_LOCATION_DESCRIPTION,
      inputSchema: requestLocationInputSchema,
      execute: async () => {
        locationRequested = true;
        return {
          instruction: "Relay showed them a Share Location prompt. Tell them you'll check the distance once they share.",
          status: "requested",
        };
      },
    }),
    request_catering: tool({
      description: REQUEST_CATERING_DESCRIPTION,
      inputSchema: cateringRequestInput,
      execute: async (input) => {
        const problem = cateringRequestProblem(input);
        if (problem) return problem;
        cateringRequests.push(input);
        return { requestId: "eval", status: PENDING_STATUS };
      },
    }),
  };
  const started = Date.now();
  const result = await generateText({
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRetries: 1,
    messages: history,
    model: model(),
    prepareStep: ({ stepNumber, steps }) => forcedReplyStep(stepNumber, steps),
    stopWhen: [hasToolCall("reply"), stepCountIs(MAX_STEPS)],
    system: systemPrompt(options.now),
    temperature: 0,
    toolChoice: "auto",
    tools,
  });
  // Mirror the agent's onChatResponse: a plain-text answer is the reply.
  const repliedInText = reply === null && result.text.trim().length > 0;
  const answer = reply ?? (repliedInText ? result.text : null);
  const plan = answerToMessages(answer ?? FALLBACK_REPLY, { interactive: options.interactive ?? true });
  const durationMs = Date.now() - started;
  if (process.env.EVAL_TIMINGS) {
    appendFileSync(process.env.EVAL_TIMINGS, `${durationMs}\t${result.steps.length}\n`);
  }
  return {
    answer,
    durationMs,
    cateringRequests,
    locationRequested,
    messages: plan.messages,
    repliedInText,
    reply: answer === null ? null : flatten(plan.messages),
    steps: result.steps.length,
    toolCalls: result.steps.flatMap((step) =>
      step.toolCalls.map((call) => ({ input: call.input, name: call.toolName }))),
  };
}
