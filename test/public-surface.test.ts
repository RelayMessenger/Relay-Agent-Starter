// A developer who clones this starter builds against production: the App Store
// app only reaches production agents. On 2026-10-03 a MHacks student followed
// "a staging agent" here and built an agent the app could never reach.
// Maintainer notes that must name staging live in CONTRIBUTING.md.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const publicFiles = ["README.md", "wrangler.jsonc", ".dev.vars.example"];

describe("public surface", () => {
  for (const path of publicFiles) {
    it(`${path} never names staging`, () => {
      const lines = readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          /staging/iu.test(line) ? [`${index + 1}: ${line.trim()}`] : []);
      expect(lines).toEqual([]);
    });
  }
});
