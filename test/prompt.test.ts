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
    expect(prompt).toContain("Never sell, recommend or discuss buying alcohol");
    expect(prompt).toContain("Never quote catering prices or confirm a booking yourself");
    expect(prompt).toContain("within about 3 miles");
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
