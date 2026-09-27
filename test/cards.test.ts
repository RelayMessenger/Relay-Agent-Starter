import { describe, expect, it } from "vitest";

import { cardIssues } from "../src/card-check";
import { cardRejection, cardTapContext, cleanComponents } from "../src/cards";
import { systemPrompt } from "../src/prompt";

describe("cards", () => {
  it("the prompt's example card is valid against Relay's catalog", () => {
    const prompt = systemPrompt(new Date("2026-09-24T18:00:00Z"));
    const start = prompt.indexOf('[{"id":"root"');
    const end = prompt.indexOf("}]", start) + 2;
    const example = JSON.parse(prompt.slice(start, end).replace("<that item's orderLink>", "https://taniaspizza.toast.site/order"));
    expect(cardIssues(example)).toEqual([]);
  });

  it("the prompt's flashcard example is valid, and the card that drew its label twice is not", () => {
    const prompt = systemPrompt(new Date("2026-09-24T18:00:00Z"));
    const start = prompt.indexOf("[", prompt.indexOf("Example, a flashcard card"));
    // The list ends at the first "]" that closes a line (the tabs' "]" is mid-line).
    const example = JSON.parse(prompt.slice(start, prompt.indexOf("]\n", start) + 1));
    expect(cardIssues(example)).toEqual([]);
    // Sent on staging 2026-09-27: "Next card" inside the Button and again under it.
    const doubled = example.map((component: { id: string }) =>
      component.id === "body" ? { ...component, children: ["tag", "tabs", "next", "next_label"] } : component);
    expect(cardIssues(doubled)).toEqual([expect.objectContaining({ message: expect.stringContaining('"next_label" is shown by both "body" and "next"') })]);
  });

  it("checks components the way Relay's server does", () => {
    expect(cardIssues([
      { component: "Card", child: "body", id: "root" },
      { component: "Map", id: "body" },
    ])).toEqual([{ message: '"Map" is not a Relay card component.', path: "/components/1/component" }]);
    // An unknown property, a wrong enum and a missing required property.
    expect(cardIssues([{ child: "t", color: "red", component: "Card", id: "root" }, { component: "Text", id: "t", text: "hi" }]))
      .toHaveLength(1);
    expect(cardIssues([{ child: "t", component: "Card", id: "root" }, { component: "Text", id: "t", text: "hi", variant: "huge" }])[0]!.path)
      .toMatch(/^\/components\/1\/variant/u);
    expect(cardIssues([{ child: "t", component: "Card", id: "root" }, { component: "Text", id: "t" }])[0]!.path)
      .toBe("/components/1/text");
  });

  it("sends a long button label back to be shortened", () => {
    const card = (text: string) => [
      { child: "b", component: "Card", id: "root" },
      { component: "Text", id: "l", text },
      { action: { functionCall: { args: { url: "https://x.test" }, call: "openUrl" } }, child: "l", component: "Button", id: "b" },
    ];
    expect(cardIssues(card("Order on Tania's"))).toEqual([]);
    expect(cardIssues(card("Order the 14\" Pepperoni & Mushroom Stuffed, $20.83"))).toEqual([
      expect.objectContaining({ path: "/components/1/text" }),
    ]);
  });

  it("an empty card (no root, or a missing child) never goes out", () => {
    expect(cardIssues([{ component: "Text", id: "t", text: "hi" }])[0]!.message).toContain('"root"');
    expect(cardIssues([{ child: "nope", component: "Card", id: "root" }])[0]!.message).toContain('"nope"');
    expect(cardRejection([{ component: "Text", id: "t", text: "hi" }])).toMatchObject({ status: "card_invalid" });
    expect(cardRejection([{ child: "t", component: "Card", id: "root" }, { component: "Text", id: "t", text: "hi" }])).toBeUndefined();
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

  it("moves a Button's context from beside its event to inside it", () => {
    const button = { action: { context: { number: 3 }, event: { name: "flashcard_next" } }, child: "l", component: "Button", id: "b" };
    expect(cleanComponents([button])[0]!.action).toEqual({ event: { context: { number: 3 }, name: "flashcard_next" } });
    expect(cardRejection([{ child: "b", component: "Card", id: "root" }, { component: "Text", id: "l", text: "Next card" }, button])).toBeUndefined();
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
