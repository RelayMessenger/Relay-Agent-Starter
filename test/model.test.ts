import { describe, expect, it } from "vitest";

import { starterModel } from "../src/model";

describe("model seam", () => {
  it("returns the configured Workers AI model ID", () => {
    expect(starterModel({
      AI: {} as Ai,
      MODEL_ID: "@cf/zai-org/glm-5.3-flash",
    })).toBe("@cf/zai-org/glm-5.3-flash");
  });
});
