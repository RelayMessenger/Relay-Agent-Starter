// A ceiling, not a budget: typical turns use 1-3 steps, since search_menu and
// get_item_options take several items per call. 10 leaves room for retries,
// multi-date catering and several questions in one message, and still bounds
// model calls (and therefore Tania's inference cost) per inbound Message.
export const MAX_STEPS = 10;

// Per model call. gpt-oss spends hidden reasoning tokens before its answer,
// and Workers AI's small default cut replies off mid-sentence (observed
// 2026-09-24). Replies are short, so this is headroom, not a typical spend.
export const MAX_OUTPUT_TOKENS = 2_048;

interface StepView {
  toolResults: ReadonlyArray<{ toolName: string; output?: unknown }>;
}

// Mirrors PENDING_STATUS in catering.ts; kept here so this module stays
// dependency-free for the workerd and Node test harnesses.
const FILED = "pending_owner_confirmation";

/**
 * Per-step policy (AI SDK prepareStep). Force the reply once a catering
 * request has actually been filed (Cal.com accepted it as pending, not a
 * call that failed validation or needs an address), since a filed request needs no further lookups and
 * models otherwise re-file it until the step cap; and force it on the last
 * allowed step, so a turn always ends in one reply instead of the fallback.
 */
export function forcedReplyStep(
  stepNumber: number,
  steps: ReadonlyArray<StepView>,
  maxSteps = MAX_STEPS,
): { activeTools: Array<"reply">; toolChoice: "auto" } | undefined {
  const filed = steps.some((step) =>
    step.toolResults.some((result) =>
      result.toolName === "request_catering"
      && (result.output as { status?: unknown } | undefined)?.status === FILED));
  if (filed || stepNumber >= maxSteps - 1) {
    // Only reply stays active. "auto" rather than "required": ai 7.0.107
    // throws when a model answers in text under "required", and a text
    // answer is delivered the same way as the reply Action.
    return { activeTools: ["reply"], toolChoice: "auto" };
  }
  return undefined;
}
