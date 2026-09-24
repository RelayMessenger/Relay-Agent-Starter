// Enough for a few menu/catering lookups before the single reply; also the
// hard bound on model calls (and therefore inference cost) per inbound Message.
export const MAX_STEPS = 6;

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
): { activeTools: Array<"reply">; toolChoice: "required" } | undefined {
  const filed = steps.some((step) =>
    step.toolResults.some((result) =>
      result.toolName === "request_catering"
      && (result.output as { status?: unknown } | undefined)?.status === FILED));
  if (filed || stepNumber >= maxSteps - 1) {
    // "required" with reply as the only active tool, rather than a named
    // tool choice: OpenAI-compatible servers (llama.cpp, and possibly Workers
    // AI) accept only the string forms of tool_choice.
    return { activeTools: ["reply"], toolChoice: "required" };
  }
  return undefined;
}
