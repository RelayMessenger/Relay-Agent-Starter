import {
  BUTTONS_GUIDANCE,
  LINK_LINE_INSTRUCTION,
  SELECTION_GUIDANCE,
} from "@relaymessenger/sdk";
import { z } from "zod";

import { cardInputSchema, type CardInput } from "./cards";

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
  // A card's fields sit at the top level, not in a nested "card" object:
  // glm-5.3 on Workers AI garbled nested tool arguments into keys like
  // "card<arg_key>components", and the card was silently dropped (2026-09-27).
  card_components: cardInputSchema.shape.components.optional().describe(
    "A Relay card (A2UI) sent right after your words: every component, flat, each with a unique id; one has id "
    + "\"root\" (a Card). For an order summary, a receipt, a location, a catering form, a flashcard. See the card rules.",
  ),
  card_surface_id: cardInputSchema.shape.surface_id,
  card_data_model: cardInputSchema.shape.data_model,
  card_send_data_model: cardInputSchema.shape.send_data_model,
  selection: z.array(z.object({
    value: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
    label: z.string().trim().min(1).max(80),
  }).strict()).min(1).max(25).optional().describe(
    "1 to 25 options the customer checks and submits once, with your question in text. Never with buttons. "
    + SELECTION_GUIDANCE,
  ),
}).strict();

export type ReplyInput = z.infer<typeof replyInputSchema>;

/** The card a reply carries, from its card_* fields (or undefined). */
export function replyCard(input: ReplyInput): CardInput | undefined {
  if (!input.card_components) return undefined;
  return {
    components: input.card_components,
    ...(input.card_surface_id ? { surface_id: input.card_surface_id } : {}),
    ...(input.card_data_model ? { data_model: input.card_data_model } : {}),
    ...(input.card_send_data_model ? { send_data_model: input.card_send_data_model } : {}),
  };
}

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
  "Ask the customer to share their phone's current location (Relay shows a Share Location prompt). Only when they "
  + "want delivery to where they are right now and haven't given an address. Never after they've given an address: "
  + "use check_delivery_address for that.";

export const requestLocationInputSchema = z.object({}).strict();

export const REQUEST_CATERING_DESCRIPTION =
  "File a catering request on Tania's catering calendar for owner confirmation. "
  + "Use only a start time returned by check_catering_availability, after the customer agreed to the details. "
  + "Call at most once per customer message.";

export const UPDATE_CARD_DESCRIPTION =
  "Change a card you already sent, in place (no new message): replace components by id, or set a value in its data "
  + "model. Use it after a tap, e.g. to show the confirmed state or a review step.";

export const DELETE_CARD_DESCRIPTION = "Remove a card you sent, for everyone in the chat.";
