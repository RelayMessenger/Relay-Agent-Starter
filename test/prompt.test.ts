import { describe, expect, it } from "vitest";

import { rateLimitedSenderFromSignedPayload } from "../src/events";
import { systemPrompt } from "../src/prompt";

describe("Tania's system prompt", () => {
  const prompt = systemPrompt(new Date("2026-09-24T18:00:00Z"));

  it("grounds the model in store time, hours and contact facts", () => {
    expect(prompt).toContain("Thursday, September 24, 2026");
    expect(prompt).toContain("Open now until 8 PM.");
    expect(prompt).toContain("Sunday: 11 AM–8 PM");
    expect(prompt).toContain("(248) 288-4774");
    expect(prompt).toContain("3204 Crooks Rd, Royal Oak, MI 48073");
  });

  it("carries the ordering, allergy, alcohol and catering guardrails", () => {
    expect(prompt).toContain("you cannot place or pay for orders");
    expect(prompt).toContain("https://taniaspizza.toast.site/order");
    expect(prompt).toContain("never promise something is allergen-free");
    expect(prompt).toContain("Never sell, recommend, link or discuss buying alcohol");
    expect(prompt).not.toContain("in-store only");
    expect(prompt).toContain("Never quote catering prices or confirm a booking yourself");
    expect(prompt).toContain("within about 3 miles");
    expect(prompt).toContain("never say whether a particular town, street or address is inside or outside");
    expect(prompt).toContain("calling reply exactly once");
  });
});

describe("per-sender rate limit key", () => {
  const event = (eventType: string, kind: string) => JSON.stringify({
    data: { sender_handle: { id: "user-1", kind } },
    event_type: eventType,
  });

  it("limits people sending messages", () => {
    expect(rateLimitedSenderFromSignedPayload(event("message.received", "user"))).toBe("user-1");
  });

  it("does not limit agents, other events or bad JSON", () => {
    expect(rateLimitedSenderFromSignedPayload(event("message.received", "agent"))).toBeNull();
    expect(rateLimitedSenderFromSignedPayload(event("chat.updated", "user"))).toBeNull();
    expect(rateLimitedSenderFromSignedPayload("{")).toBeNull();
  });
});

describe("per-step reply policy", async () => {
  const { forcedReplyStep, MAX_STEPS } = await import("../src/limits");
  const reply = { activeTools: ["reply"], toolChoice: "required" };

  it("leaves early steps free", () => {
    expect(forcedReplyStep(0, [])).toBeUndefined();
    expect(forcedReplyStep(2, [{ toolResults: [{ toolName: "search_menu" }] }])).toBeUndefined();
  });

  it("forces the reply only after a catering request is actually filed", () => {
    const filed = { output: { status: "pending_owner_confirmation" }, toolName: "request_catering" };
    expect(forcedReplyStep(2, [{ toolResults: [filed] }])).toEqual(reply);
    // Rejected by validation (no result) or sent back for an address.
    expect(forcedReplyStep(2, [{ toolResults: [] }])).toBeUndefined();
    expect(forcedReplyStep(2, [{
      toolResults: [{ output: { status: "needs_address" }, toolName: "request_catering" }],
    }])).toBeUndefined();
  });

  it("forces the reply on the last allowed step", () => {
    expect(forcedReplyStep(MAX_STEPS - 1, [])).toEqual(reply);
  });
});

describe("degenerate model output", async () => {
  const { customerText, FALLBACK_REPLY, looksDegenerate } = await import("../src/answer");

  it("replaces runs of one character and letterless text with the fallback", () => {
    expect(looksDegenerate("!".repeat(40))).toBe(true);
    expect(looksDegenerate("   ")).toBe(true);
    expect(looksDegenerate("?!?! ... --- !!!")).toBe(true);
    expect(customerText("!".repeat(40))).toBe(FALLBACK_REPLY);
  });

  it("keeps real answers, including menu names with punctuation", () => {
    const answer = 'The 14" Extra! Extra! is $17.99: https://taniaspizza.toast.site/order/tanias-pizza/item-14-extra-extra_234e1dc8';
    expect(looksDegenerate(answer)).toBe(false);
    expect(customerText(`  ${answer}  `)).toBe(answer);
  });
});
