import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  generateText,
  hasToolCall,
  stepCountIs,
  tool,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { z } from "zod";

import { forcedReplyStep, MAX_OUTPUT_TOKENS, MAX_STEPS } from "../../src/limits";
import { cateringRequestInput, cateringRequestProblem, PENDING_STATUS } from "../../src/catering";
import { customerText } from "../../src/answer";
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
  reply: string | null;
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

export async function runTurn(
  history: ModelMessage[],
  options: { now: Date; cateringEnv?: Record<string, string>; fetcher?: typeof fetch },
): Promise<TurnResult> {
  let reply: string | null = null;
  const cateringRequests: unknown[] = [];
  const tools = {
    ...taniasTools({
      env: options.cateringEnv ?? {},
      fetcher: options.fetcher,
      menu: async () => SNAPSHOT_MENU,
      now: () => options.now,
    }),
    reply: tool({
      description: "Send the complete response as one canonical Relay Message. Call this exactly once.",
      inputSchema: z.object({ text: z.string().trim().min(1).max(10_000) }).strict(),
      execute: async ({ text }) => {
        reply = text;
        return { status: "sent" };
      },
    }),
    request_catering: tool({
      description:
        "File a catering request on Tania's catering calendar for owner confirmation. "
        + "Use only a start time returned by check_catering_availability, after the customer agreed to the details.",
      inputSchema: cateringRequestInput,
      execute: async (input) => {
        const problem = cateringRequestProblem(input);
        if (problem) return problem;
        cateringRequests.push(input);
        return { requestId: "eval", status: PENDING_STATUS };
      },
    }),
  };
  const result = await generateText({
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRetries: 1,
    messages: history,
    model: model(),
    prepareStep: ({ stepNumber, steps }) => forcedReplyStep(stepNumber, steps),
    stopWhen: [hasToolCall("reply"), stepCountIs(MAX_STEPS)],
    system: systemPrompt(options.now),
    temperature: 0,
    toolChoice: "required",
    tools,
  });
  // Mirror the agent's onChatResponse: a plain-text answer is the reply.
  const repliedInText = reply === null && result.text.trim().length > 0;
  return {
    cateringRequests,
    repliedInText,
    // What the customer would actually receive (degenerate text -> fallback).
    reply: reply !== null ? customerText(reply) : (repliedInText ? customerText(result.text) : null),
    steps: result.steps.length,
    toolCalls: result.steps.flatMap((step) =>
      step.toolCalls.map((call) => ({ input: call.input, name: call.toolName }))),
  };
}
