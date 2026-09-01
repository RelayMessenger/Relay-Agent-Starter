import type { ThinkModel } from "@cloudflare/think";

import type { Bindings } from "./env";

/**
 * Replace this function to use another AI SDK model or provider.
 * A model ID string is resolved by Think through the Worker's AI binding.
 */
export function starterModel(
  env: Pick<Bindings, "AI" | "MODEL_ID">,
): ThinkModel {
  return env.MODEL_ID;
}
