import {
  BUTTONS_GUIDANCE,
  LINK_LINE_INSTRUCTION,
  SELECTION_GUIDANCE,
} from "@relaymessenger/sdk";
import { z } from "zod";

/**
 * The model-facing contract of the agent's Actions, shared by the Worker
 * (agent.ts, reply.ts) and the live eval harness so they can never drift.
 */

export const REPLY_DESCRIPTION =
  "Send your complete answer to the customer: your words in text, plus buttons or a selection when they "
  + "should pick instead of type. Call this exactly once.";

// One object schema, as Relay-Agent's send Action (Vertex and Workers AI take
// an object root, not a union). Limits are the server's: buttons 1..5,
// label 1..80, url https; selection 1..25, value token 1..100, label 1..80.
export const replyInputSchema = z.object({
  text: z.string().trim().min(1).max(10_000).describe(
    "Your words. No URLs inside sentences. " + LINK_LINE_INSTRUCTION,
  ),
  buttons: z.array(z.object({
    label: z.string().trim().min(1).max(80),
    url: z.string().trim().max(2_048).regex(/^https:\/\/\S+$/u).optional(),
  }).strict()).min(1).max(5).optional().describe(
    "1 to 5 buttons under your words. A url button opens that page (use for ordering an item, gift cards, "
    + "Rewards); a plain button sends its label back as the customer's answer. " + BUTTONS_GUIDANCE,
  ),
  selection: z.array(z.object({
    value: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
    label: z.string().trim().min(1).max(80),
  }).strict()).min(1).max(25).optional().describe(
    "1 to 25 options the customer checks and submits once, with your question in text. Never with buttons. "
    + SELECTION_GUIDANCE,
  ),
}).strict();

export type ReplyInput = z.infer<typeof replyInputSchema>;

/**
 * The reply as one answer in the SDK's text contract (answerMessages), so
 * structured fields and fenced blocks written into text take the same path.
 * With both components, the selection wins and url buttons become link lines.
 */
export function composeAnswer(input: ReplyInput): string {
  const lines = [input.text.trim()];
  if (input.selection?.length) {
    for (const button of input.buttons ?? []) if (button.url) lines.push(button.url);
    lines.push("```selection", JSON.stringify(input.selection), "```");
  } else if (input.buttons?.length) {
    lines.push("```buttons", JSON.stringify(input.buttons), "```");
  }
  return lines.join("\n");
}

export const REQUEST_LOCATION_DESCRIPTION =
  "Ask the customer to share their location, so check_delivery_distance can tell whether they're within "
  + "Tania's delivery area. Relay shows them a Share Location prompt. Use it when delivery to them comes up.";

export const requestLocationInputSchema = z.object({}).strict();

export const REQUEST_CATERING_DESCRIPTION =
  "File a catering request on Tania's catering calendar for owner confirmation. "
  + "Use only a start time returned by check_catering_availability, after the customer agreed to the details. "
  + "Call at most once per customer message.";
