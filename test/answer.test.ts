import { describe, expect, it } from "vitest";

import { answerToMessages, FALLBACK_REPLY, looksDegenerate, normalizeAnswer } from "../src/answer";

const ITEM = "https://taniaspizza.toast.site/order/tanias-pizza/item-14-build-your-own-pizza_2b41da43-5b39-4954-b1d1-6191a6c49e5b";
const interactive = { interactive: true };

describe("normalizeAnswer: what models write, as Relay shows it", () => {
  it("turns * and - list markers into bullets and drops headings", () => {
    expect(normalizeAnswer("## Your pizza\n* **Crust:** Stuffed\n- Toppings: Pepperoni")).toBe(
      "Your pizza\n• **Crust:** Stuffed\n• Toppings: Pepperoni",
    );
  });

  it("moves a URL out of a sentence onto its own line", () => {
    expect(normalizeAnswer(`Here's the link for a large pizza: ${ITEM}\n\nEnjoy!`)).toBe(
      `Here's the link for a large pizza\n${ITEM}\n\nEnjoy!`,
    );
  });

  it("turns a markdown link into words plus a link line", () => {
    expect(normalizeAnswer(`[Order here](${ITEM}) when ready.`)).toBe(`Order here when ready.\n${ITEM}`);
  });

  it("leaves fenced component blocks untouched", () => {
    const block = '```buttons\n[{"label": "- Thin"}]\n```';
    expect(normalizeAnswer(`Which crust?\n${block}`)).toBe(`Which crust?\n${block}`);
  });
});

describe("answerToMessages", () => {
  it("sends the screenshot answer as bullets plus a separate link card", () => {
    const { messages } = answerToMessages(
      `Here's the link for a **large (14") Build-Your-Own pizza**: ${ITEM}\n\nWhen you open it, pick:\n\n* **Crust:** Stuffed (+$2.99)\n* **Toppings:** Pepperoni ($2.25)`,
      interactive,
    );
    expect(messages).toEqual([
      [{ type: "text", value: "Here's the link for a **large (14\") Build-Your-Own pizza**" }],
      [{ type: "link", value: ITEM }],
      [{ type: "text", value: "When you open it, pick:\n\n• **Crust:** Stuffed (+$2.99)\n• **Toppings:** Pepperoni ($2.25)" }],
    ]);
    for (const parts of messages) {
      for (const part of parts) if (part.type === "text") expect(part.value).not.toMatch(/https?:\/\//u);
    }
  });

  it("puts buttons under the question", () => {
    const { messages } = answerToMessages(
      'Which crust?\n```buttons\n[{"label": "Hand tossed"}, {"label": "Stuffed (+$2.99)"}]\n```',
      interactive,
    );
    expect(messages).toEqual([[
      { type: "text", value: "Which crust?" },
      { items: [{ label: "Hand tossed" }, { label: "Stuffed (+$2.99)" }], type: "buttons" },
    ]]);
  });

  it("sends an order url button", () => {
    const { messages } = answerToMessages(
      `The 14" Deluxe is $17.99.\n\`\`\`buttons\n[{"label": "Order the 14\\" Deluxe", "url": "${ITEM}"}]\n\`\`\``,
      interactive,
    );
    expect(messages[0]![1]).toEqual({ items: [{ label: 'Order the 14" Deluxe', url: ITEM }], type: "buttons" });
  });

  it("sends a selection with its question", () => {
    const { messages } = answerToMessages(
      'Which toppings?\n```selection\n[{"value": "pepperoni", "label": "Pepperoni (+$2.25)"}, {"value": "mushrooms", "label": "Mushrooms (+$2.25)"}]\n```',
      interactive,
    );
    expect(messages[0]).toEqual([
      { type: "text", value: "Which toppings?" },
      {
        options: [{ label: "Pepperoni (+$2.25)", value: "pepperoni" }, { label: "Mushrooms (+$2.25)", value: "mushrooms" }],
        type: "selection",
      },
    ]);
  });

  it("never lets the model create a payment", () => {
    const plan = answerToMessages(
      'Pay here.\n```payment\n{"description": "Pizza", "category": "physical_goods", "amount": 1799, "currency": "usd"}\n```',
      interactive,
    );
    expect(plan.notes).toContain("model_payment_block_ignored");
    expect(plan.messages.flat().some((part) => part.type === "payment")).toBe(false);
  });

  it("degrades components to words and link cards where the server has none", () => {
    const { messages } = answerToMessages(
      `Which crust?\n\`\`\`buttons\n[{"label": "Thin"}, {"label": "Order", "url": "${ITEM}"}]\n\`\`\``,
      { interactive: false },
    );
    expect(messages).toEqual([
      [{ type: "text", value: "Which crust?\n\nReply with: Thin" }],
      [{ type: "link", value: ITEM }],
    ]);
  });

  it("replaces a degenerate answer with the fallback", () => {
    expect(looksDegenerate("!".repeat(40))).toBe(true);
    const plan = answerToMessages("!".repeat(40), interactive);
    expect(plan.notes).toContain("no_usable_answer");
    expect(plan.messages).toEqual(answerToMessages(FALLBACK_REPLY, interactive).messages);
    expect(plan.messages[0]![1]).toMatchObject({ type: "buttons" });
  });
});

describe("clean text: dashes and bullets", () => {
  it("replaces pause dashes with commas and range dashes with hyphens", () => {
    expect(normalizeAnswer("Same toppings on every size—only the prices scale.")).toBe(
      "Same toppings on every size, only the prices scale.",
    );
    expect(normalizeAnswer("Choose WHOLE for the whole pizza – $2.25")).toBe("Choose WHOLE for the whole pizza, $2.25");
    expect(normalizeAnswer("Open 10–8 on weekdays")).toBe("Open 10-8 on weekdays");
    expect(normalizeAnswer("Thanks for sharing — unfortunately you're far.")).toBe("Thanks for sharing, unfortunately you're far.");
  });

  it("puts each bullet on its own line", () => {
    expect(normalizeAnswer("• Anchovies (+$2.25) • Bacon (+$2.30) • Basil (+$1.60)")).toBe(
      "• Anchovies (+$2.25)\n• Bacon (+$2.30)\n• Basil (+$1.60)",
    );
    expect(normalizeAnswer("Toppings: Pepperoni • Mushrooms")).toBe("Toppings: Pepperoni\n• Mushrooms");
    expect(normalizeAnswer("• Stuffed crust: 10\" +$1.99, 12\" +$2.49")).toBe("• Stuffed crust: 10\" +$1.99, 12\" +$2.49");
  });

  it("fixes the 4:38 PM screenshot answer", () => {
    const answer = "Here's the full lineup:\n\n• Anchovies (+$2.25) • Bacon (+$2.30) • Banana Peppers (+$1.60)\n• Black Olives (+$1.60) • Chicken (+$3.00)";
    const text = normalizeAnswer(answer);
    for (const line of text.split("\n").filter((l) => l.startsWith("•"))) {
      expect(line.match(/•/gu)).toHaveLength(1);
    }
    expect(text).not.toMatch(/[—–]/u);
  });
});
