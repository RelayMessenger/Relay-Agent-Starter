import { answerMessages, type MessagePart } from "@relaymessenger/sdk";

import { BUSINESS } from "./business";

/**
 * The answer contract is the SDK's text-only one (answerMessages): the model
 * writes words, a URL alone on a line becomes a link card, a ```buttons or
 * ```selection block becomes the component. It holds whether the model
 * calls reply or, as Workers AI gpt-oss does after a tool result, answers in
 * plain text, so every path yields the same parts.
 */

export const FALLBACK_REPLY = [
  `Sorry, I got tangled up there. You can order online, or call Tania's at ${BUSINESS.phone}.`,
  "```buttons",
  JSON.stringify([{ label: "Order online", url: BUSINESS.orderUrl }]),
  "```",
].join("\n");

/**
 * True for model output that is not an answer: a run of one repeated
 * character (Workers AI gpt-oss once returned only "!!!!…", 2026-09-24) or
 * text with almost no letters or digits.
 */
export function looksDegenerate(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/(.)\1{15,}/u.test(trimmed)) return true;
  const alphanumeric = trimmed.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return alphanumeric / trimmed.length < 0.3;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?]/gu;
const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gu;

/**
 * Relay's renderer draws **bold**, *italic*, ~~strike~~, `code` and <u>…</u>
 * but has no list or heading syntax, and a URL inside a sentence stays plain
 * words (docs.relayapp.im/messages/send#markdown, /messages/parts). Rewrite
 * what models habitually write into what Relay shows: list markers become
 * "•", headings lose their hashes, and every URL moves onto a line of its
 * own so it goes out as a link card. Fenced component blocks are untouched.
 */
export function normalizeAnswer(answer: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const raw of answer.replace(/\r\n?/gu, "\n").split("\n")) {
    if (/^\s*```/u.test(raw)) {
      fenced = !fenced;
      out.push(raw.trim());
      continue;
    }
    if (fenced) {
      out.push(raw);
      continue;
    }
    let line = raw
      .replace(/^(\s*)[*+-]\s+/u, "$1• ")
      .replace(/^\s*#{1,6}\s+/u, "")
      .replace(MARKDOWN_LINK, (_, label: string, url: string) => `${label} ${url}`);
    const trimmed = line.trim();
    if (/^https?:\/\/\S+$/u.test(trimmed)) {
      out.push(trimmed);
      continue;
    }
    const urls = line.match(URL_IN_TEXT) ?? [];
    if (urls.length > 0) {
      for (const url of urls) line = line.replace(url, "");
      line = line.replace(/\s+([:,.;!?])/gu, "$1").replace(/[ \t]{2,}/gu, " ").replace(/[:\s]+$/u, "");
      if (line.trim()) out.push(line.trimEnd());
      for (const url of urls) out.push(url);
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

export interface AnswerOptions {
  /**
   * Whether this Relay server takes buttons and selection parts. Staging
   * does; production's contract does not yet, so there they degrade to words.
   */
  interactive: boolean;
}

export interface AnswerPlan {
  messages: MessagePart[][];
  /** Why part of the answer could not be used, for the logs. */
  notes: string[];
}

function textOnly(messages: MessagePart[][]): MessagePart[][] {
  return messages.flatMap((parts) => {
    const words: string[] = [];
    const links: MessagePart[][] = [];
    for (const part of parts) {
      if (part.type === "text") words.push(part.value);
      else if (part.type === "buttons") {
        const plain = part.items.filter((item) => !item.url).map((item) => item.label);
        if (plain.length > 0) words.push(`Reply with: ${plain.join(", ")}`);
        for (const item of part.items) {
          if (item.url) links.push([{ type: "link", value: item.url }]);
        }
      } else if (part.type === "selection") {
        words.push(part.options.map((option) => `• ${option.label}`).join("\n"));
      } else {
        links.push([part]);
      }
    }
    const text = words.join("\n\n").trim();
    return [...(text ? [[{ type: "text" as const, value: text }]] : []), ...links];
  });
}

/** The Relay Messages one answer becomes, in order. Never empty. */
export function answerToMessages(answer: string, options: AnswerOptions): AnswerPlan {
  const notes: string[] = [];
  const planned = answerMessages(normalizeAnswer(answer));
  if (planned.error) notes.push(`component_block_unusable: ${planned.error}`);
  // Payments are sent by the Worker (catering deposits), never by the model.
  if (planned.payment) notes.push("model_payment_block_ignored");
  let messages = planned.messages
    .map((parts) => parts.filter((part) => part.type !== "text" || !looksDegenerate(part.value)))
    .filter((parts) => parts.length > 0 && parts.some((part) => part.type !== "text" || part.value.trim()));
  if (!options.interactive) messages = textOnly(messages);
  if (messages.length === 0) {
    notes.push("no_usable_answer");
    return { messages: answerToMessages(FALLBACK_REPLY, options).messages, notes };
  }
  return { messages, notes };
}
