import { describe, expect, it } from "vitest";

import { starterModel } from "../src/model";

describe("model seam", () => {
  it("returns the configured Workers AI model ID", () => {
    expect(starterModel({
      AI: {} as Ai,
      MODEL_ID: "@cf/openai/gpt-oss-120b",
    })).toBe("@cf/openai/gpt-oss-120b");
  });
});
