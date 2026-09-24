import { describe, expect, it } from "vitest";

import { SNAPSHOT_MENU } from "../src/menu";
import { taniasTools } from "../src/tools";

const tools = taniasTools({
  env: {},
  menu: async () => SNAPSHOT_MENU,
  now: () => new Date("2026-09-24T18:00:00Z"),
});

async function run(name: string, input: unknown): Promise<any> {
  const execute = tools[name]!.execute!;
  return execute(input as never, { messages: [], toolCallId: "t" } as never);
}

describe("batched menu tools", () => {
  it("answers a whole multi-item order in one search_menu call", async () => {
    const result = await run("search_menu", {
      queries: ["14 inch build your own", "12 veggie pizza", "bone-in wings", "greek salad"],
    });
    expect(result.results).toHaveLength(4);
    for (const entry of result.results) {
      expect(entry.matches.length, entry.query).toBeGreaterThan(0);
      expect(entry.matches.length, entry.query).toBeLessThanOrEqual(4);
      expect(entry.matches[0].orderLink).toMatch(/^https:\/\/taniaspizza\.toast\.site\/order\//u);
    }
  });

  it("keeps up to 8 matches when only a few items are asked about", async () => {
    const result = await run("search_menu", { queries: ["pizza"] });
    expect(result.results[0].matches).toHaveLength(8);
  });

  it("returns options for several items in one get_item_options call", async () => {
    const result = await run("get_item_options", {
      items: ["10 inch build your own", "14 inch build your own", "no such thing zzz"],
    });
    expect(result.results.map((r: { item: string }) => r.item)).toEqual([
      '10" Build Your Own Pizza',
      '14" Build Your Own Pizza',
      "no such thing zzz",
    ]);
    expect(result.results[2].optionGroups).toEqual([]);
  });
});
