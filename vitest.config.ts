import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["test/workerd/**"],
    include: ["test/**/*.test.ts"],
  },
});
