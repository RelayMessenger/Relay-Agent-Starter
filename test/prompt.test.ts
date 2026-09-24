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
    expect(prompt).toContain("You cannot place, change or pay for orders");
    expect(prompt).toContain("https://taniaspizza.toast.site/order");
    expect(prompt).toContain("never promise something is allergen-free");
    expect(prompt).toContain("Never sell, recommend, link or discuss buying alcohol");
    expect(prompt).not.toContain("in-store only");
    expect(prompt).toContain("Never quote catering prices, create payments or confirm a booking yourself");
    expect(prompt).toContain("within about 3 miles");
    expect(prompt).toContain("call check_delivery_address with it right away");
    expect(prompt).toContain("Never ask for their location after they've given an address");
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
  const reply = { activeTools: ["reply"], toolChoice: "auto" };

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

describe("Relay message rules in the prompt", () => {
  const prompt = systemPrompt(new Date("2026-09-24T18:00:00Z"));

  it("carries the SDK's own component and link instructions", async () => {
    const sdk = await import("@relaymessenger/sdk");
    for (const rule of [
      sdk.BUTTONS_GUIDANCE,
      sdk.SELECTION_GUIDANCE,
      sdk.LINK_LINE_INSTRUCTION,
    ]) {
      expect(prompt).toContain(rule);
    }
  });

  it("states Relay's formatting and asks for components in the ordering flow", () => {
    expect(prompt).toContain('write a list as short lines that start with "• "');
    expect(prompt).toContain("Never put a URL in a sentence.");
    expect(prompt).toContain("Crust as buttons from get_item_options");
    expect(prompt).toContain("Toppings as a selection");
    expect(prompt).toContain("offer request_location if they'd rather share their location");
    expect(prompt).toContain("never ask for it again");
    expect(prompt).toContain("Never make up facts");
    expect(prompt).toContain('"What AI do you run up?" then "On" means "What AI do you run on?"');
  });
});
