import { defineConfig } from "vitest/config";

// Live-model conversation evals. Skipped unless EVAL_BASE_URL and EVAL_MODEL
// are set; see test/eval/conversation.ts.
export default defineConfig({
  test: {
    include: ["test/eval/**/*.eval.ts"],
    maxWorkers: 1,
    testTimeout: 180_000,
  },
});
