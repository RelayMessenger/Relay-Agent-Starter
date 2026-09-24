import { BUSINESS } from "./business";

export const FALLBACK_REPLY =
  `Sorry, I got tangled up there. You can order at ${BUSINESS.orderUrl} `
  + `or call Tania's at ${BUSINESS.phone}.`;

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

/** What the customer receives: the model's text, or the fallback when it isn't an answer. */
export function customerText(text: string): string {
  return looksDegenerate(text) ? FALLBACK_REPLY : text.trim();
}
