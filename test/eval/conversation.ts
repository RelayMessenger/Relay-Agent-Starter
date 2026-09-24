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

import { MAX_STEPS } from "../../src/limits";
import { cateringRequestInput } from "../../src/catering";
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
  steps: number;
}

function model() {
  const provider = createOpenAICompatible({
    apiKey: process.env.EVAL_API_KEY ?? "none",
    baseURL: process.env.EVAL_BASE_URL!,
    name: "eval",
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
        cateringRequests.push(input);
        return { status: "pending_owner_confirmation", requestId: "eval" };
      },
    }),
  };
  const result = await generateText({
    maxRetries: 1,
    messages: history,
    model: model(),
    stopWhen: [hasToolCall("reply"), stepCountIs(MAX_STEPS)],
    system: systemPrompt(options.now),
    temperature: 0,
    toolChoice: "required",
    tools,
  });
  return {
    cateringRequests,
    reply,
    steps: result.steps.length,
    toolCalls: result.steps.flatMap((step) =>
      step.toolCalls.map((call) => ({ input: call.input, name: call.toolName }))),
  };
}
