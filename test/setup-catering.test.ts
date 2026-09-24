import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// @ts-expect-error: plain ESM script without type declarations.
import { eventTypeBody, scheduleBody, STORE_HOURS, webhookBody } from "../scripts/setup-catering.mjs";
import { WEEKLY_HOURS } from "../src/business";
import { bookingBody, cateringRequestInput } from "../src/catering";

const OPTIONS = {
  lengthMinutes: 60,
  maxPerDay: 2,
  minNoticeHours: 48,
  webhookSecret: "0123456789abcdef0123",
  webhookUrl: "https://tanias.example/webhooks/cal",
};

describe("Cal.com catering setup", () => {
  const body = eventTypeBody(OPTIONS) as {
    bookingFields: Array<{ slug: string; field: string; type?: string; options?: string[] }>;
    bookingLimitsCount: unknown;
    confirmationPolicy: unknown;
    minimumBookingNotice: number;
  };

  it("requires owner confirmation, a daily cap and minimum notice", () => {
    expect(body.confirmationPolicy).toEqual({ blockUnconfirmedBookingsInBooker: true, type: "always" });
    expect(body.bookingLimitsCount).toEqual({ day: 2 });
    expect(body.minimumBookingNotice).toBe(48 * 60);
    expect((body as { hidden?: boolean }).hidden).toBe(true);
  });

  it("defines a field for every response the agent sends", () => {
    const request = cateringRequestInput.parse({
      address: "1 Main St",
      budget: "$300",
      dietary: "2 vegan",
      email: "a@b.co",
      fulfillment: "delivery",
      headcount: 20,
      menu: "pizza",
      name: "A B",
      notes: "side door",
      phone: "2482884774",
      start: "2026-10-10T12:00",
      utensils: false,
    });
    const responses = bookingBody({ CAL_EVENT_TYPE_ID: "1" }, request, "chat").bookingFieldsResponses;
    const slugs = new Set(body.bookingFields.map((field) => field.slug));
    for (const key of Object.keys(responses)) expect(slugs, key).toContain(key);
    const select = (slug: string) => body.bookingFields.find((field) => field.slug === slug)?.options;
    expect(select("fulfillment")).toContain(responses.fulfillment);
    expect(select("utensils")).toContain(responses.utensils);
  });

  it("offers catering only during Tania's store hours", () => {
    const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const fromScript: Record<string, { open: string; close: string }> = {};
    for (const block of STORE_HOURS as Array<{ days: string[]; startTime: string; endTime: string }>) {
      for (const day of block.days) fromScript[day] = { close: block.endTime, open: block.startTime };
    }
    for (const [index, hours] of Object.entries(WEEKLY_HOURS)) {
      expect(fromScript[names[Number(index)]!], names[Number(index)]).toEqual(hours);
    }
    expect(scheduleBody()).toMatchObject({ isDefault: false, timeZone: "America/Detroit" });
    expect(eventTypeBody(OPTIONS, 42)).toMatchObject({ scheduleId: 42 });
  });

  it("uses slugs Cal.com accepts", () => {
    for (const field of body.bookingFields) {
      expect(field.slug).toMatch(/^[a-z](?:[a-z0-9]|-(?!-))*$/u);
    }
  });

  it("subscribes the decision webhook to the events the Worker handles", () => {
    expect(webhookBody(OPTIONS)).toMatchObject({
      active: true,
      subscriberUrl: "https://tanias.example/webhooks/cal",
      triggers: expect.arrayContaining(["BOOKING_CREATED", "BOOKING_REJECTED", "BOOKING_CANCELLED"]),
    });
  });

  it("dry-runs by default and never prints the secret", () => {
    const output = execFileSync(process.execPath, [
      "scripts/setup-catering.mjs",
      "--webhook-url", OPTIONS.webhookUrl,
      "--webhook-secret", OPTIONS.webhookSecret,
    ], { encoding: "utf8", env: { ...process.env, CAL_API_KEY: "" } });
    expect(output).toContain("Dry run. Nothing sent.");
    expect(output).not.toContain(OPTIONS.webhookSecret);
  });
});
