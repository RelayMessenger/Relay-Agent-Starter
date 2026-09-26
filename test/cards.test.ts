import { describe, expect, it } from "vitest";

import { cardTapContext, cleanComponents } from "../src/cards";
import { systemPrompt } from "../src/prompt";
import { checkCard } from "./a2ui-check";

describe("cards", () => {
  it("the prompt's example card is valid against Relay's catalog", () => {
    const prompt = systemPrompt(new Date("2026-09-24T18:00:00Z"));
    const start = prompt.indexOf('[{"id":"root"');
    const end = prompt.indexOf("}]", start) + 2;
    const example = JSON.parse(prompt.slice(start, end).replace("<that item's orderLink>", "https://taniaspizza.toast.site/order"));
    expect(checkCard(example)).toEqual([]);
  });

  it("the checker catches an unknown component, a bad property and a missing child", () => {
    expect(checkCard([
      { component: "Card", child: "body", id: "root" },
      { component: "Map", id: "body" },
    ])).toContain("body: unknown component Map");
    expect(checkCard([{ child: "nope", component: "Card", id: "root", color: "red" }])).toEqual([
      "root: Card has no property color",
      "root: child nope does not exist",
    ]);
  });

  it("keeps dashes out of card text but leaves URLs and ids alone", () => {
    expect(cleanComponents([
      { component: "Text", id: "t—1", text: "Stuffed crust—our specialty" },
      { component: "Image", id: "img", url: "https://example.com/a–b.jpg" },
    ])).toEqual([
      { component: "Text", id: "t—1", text: "Stuffed crust, our specialty" },
      { component: "Image", id: "img", url: "https://example.com/a–b.jpg" },
    ]);
  });

  it("turns a tap into data the model can read", () => {
    const context = cardTapContext([{
      data: [{ action: { context: { item: "14-deluxe" }, name: "confirm_order", surfaceId: "order-1" }, version: "v0.9.1" }],
      media_type: "application/a2ui+json",
      type: "data",
    }], { a2uiClientDataModel: { headcount: 30 } });
    expect(context).toContain('"action":"confirm_order"');
    expect(context).toContain('"surface_id":"order-1"');
    expect(context).toContain('"card_values":{"headcount":30}');
    expect(cardTapContext([{ type: "text", value: "hi" }])).toBeUndefined();
  });
});
