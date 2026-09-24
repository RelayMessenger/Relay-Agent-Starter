import { describe, expect, it, vi } from "vitest";

import {
  bookingBody,
  cateringAvailability,
  cateringDecision,
  cateringRequestInput,
  NOT_CONFIGURED,
  requestCatering,
  toE164,
  verifyCalSignature,
} from "../src/catering";

const CHAT = "01993d50-ef7b-7b37-886b-23fd80c7ec13";
const CONFIG = { CAL_API_KEY: "cal_test", CAL_EVENT_TYPE_ID: "4242" };
const REQUEST = cateringRequestInput.parse({
  email: "sam@example.com",
  fulfillment: "delivery",
  address: "500 S Washington Ave, Royal Oak, MI",
  headcount: 40,
  menu: "6 large stuffed pizzas, 2 salads",
  name: "Sam Lee",
  phone: "(248) 555-0100",
  start: "2026-10-10T12:00",
  utensils: true,
});

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...signature].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("catering availability", () => {
  it("falls back to the phone when Cal.com is not configured", async () => {
    expect(await cateringAvailability({}, { from: "2026-10-01", to: "2026-10-07" })).toEqual(NOT_CONFIGURED);
  });

  it("rejects reversed or oversized ranges without calling Cal.com", async () => {
    const fetcher = vi.fn();
    expect(await cateringAvailability(CONFIG, { from: "2026-10-07", to: "2026-10-01" }, fetcher))
      .toMatchObject({ status: "invalid_range" });
    expect(await cateringAvailability(CONFIG, { from: "2026-10-01", to: "2026-12-01" }, fetcher))
      .toMatchObject({ status: "invalid_range" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("queries slots in store time and accepts both documented slot shapes", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({
      data: {
        "2026-10-10": [{ start: "2026-10-10T11:00:00.000-04:00" }, "2026-10-10T12:00:00.000-04:00"],
        "2026-10-11": [],
      },
      status: "success",
    }));
    const result = await cateringAvailability(CONFIG, { from: "2026-10-10", to: "2026-10-11" }, fetcher as typeof fetch);
    expect(result).toMatchObject({ openSlots: { "2026-10-10": ["11:00", "12:00"] }, status: "ok" });
    const [url, init] = fetcher.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/v2/slots");
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      end: "2026-10-11",
      eventTypeId: "4242",
      start: "2026-10-10",
      timeZone: "America/Detroit",
    });
    expect(new Headers(init?.headers).get("cal-api-version")).toBe("2024-09-04");
  });
});

describe("catering request", () => {
  it("requires an address for delivery", () => {
    expect(cateringRequestInput.safeParse({ ...REQUEST, address: undefined }).success).toBe(false);
  });

  it("normalizes US phone numbers to E.164", () => {
    expect(toE164("(248) 288-4774")).toBe("+12482884774");
    expect(toE164("1-248-288-4774")).toBe("+12482884774");
    expect(toE164("12")).toBeUndefined();
  });

  it("builds a Cal.com v2 booking in UTC with the Relay chat in metadata", () => {
    expect(bookingBody(CONFIG, REQUEST, CHAT)).toEqual({
      attendee: {
        email: "sam@example.com",
        language: "en",
        name: "Sam Lee",
        phoneNumber: "+12485550100",
        timeZone: "America/Detroit",
      },
      bookingFieldsResponses: {
        address: "500 S Washington Ave, Royal Oak, MI",
        fulfillment: "Delivery",
        headcount: 40,
        menu: "6 large stuffed pizzas, 2 salads",
        phone: "+12485550100",
        utensils: "Yes",
      },
      eventTypeId: 4242,
      metadata: { relay_chat_id: CHAT, source: "relay" },
      start: "2026-10-10T16:00:00.000Z",
    });
  });

  it("files a pending request and never claims confirmation", async () => {
    const fetcher = vi.fn(async () => Response.json({ data: { status: "pending", uid: "bk_1" }, status: "success" }, { status: 201 }));
    const result = await requestCatering(CONFIG, REQUEST, CHAT, undefined, fetcher as typeof fetch);
    expect(result).toMatchObject({ requestId: "bk_1", status: "pending_owner_confirmation" });
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get("cal-api-version")).toBe("2026-02-25");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer cal_test");
  });

  it("reports a calendar rejection without inventing a booking", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "slot taken" }, { status: 400 }));
    expect(await requestCatering(CONFIG, REQUEST, CHAT, undefined, fetcher as typeof fetch))
      .toMatchObject({ status: "rejected_by_calendar" });
  });
});

describe("Cal.com webhooks", () => {
  it("verifies hex HMAC-SHA256 over the raw body", async () => {
    const body = JSON.stringify({ triggerEvent: "BOOKING_CREATED" });
    const signature = await hmacHex("whsec", body);
    expect(await verifyCalSignature("whsec", body, signature)).toBe(true);
    expect(await verifyCalSignature("whsec", `${body} `, signature)).toBe(false);
    expect(await verifyCalSignature("other", body, signature)).toBe(false);
    expect(await verifyCalSignature("whsec", body, null)).toBe(false);
  });

  const event = (triggerEvent: string, extra: Record<string, unknown> = {}) => ({
    createdAt: "2026-10-01T12:00:00Z",
    payload: {
      metadata: { relay_chat_id: CHAT },
      startTime: "2026-10-10T16:00:00.000Z",
      uid: "bk_1",
      ...extra,
    },
    triggerEvent,
  });

  it("tells the customer when the owner confirms", () => {
    const decision = cateringDecision(event("BOOKING_CREATED", { status: "ACCEPTED" }));
    expect(decision).toMatchObject({ bookingUid: "bk_1", chatId: CHAT, status: "accepted" });
    expect(decision!.text).toContain("confirmed your catering for Saturday, October 10, 2026 at 12:00 PM");
  });

  it("passes on the owner's rejection reason", () => {
    const decision = cateringDecision(event("BOOKING_REJECTED", { rejectionReason: "Fully booked that day" }));
    expect(decision).toMatchObject({ status: "rejected" });
    expect(decision!.text).toContain('"Fully booked that day"');
  });

  it("ignores events that need no customer message", () => {
    expect(cateringDecision(event("BOOKING_REQUESTED", { status: "PENDING" }))).toBeNull();
    expect(cateringDecision(event("BOOKING_CREATED", { status: "PENDING" }))).toBeNull();
    expect(cateringDecision({ payload: { uid: "x" }, triggerEvent: "BOOKING_REJECTED" })).toBeNull();
    expect(cateringDecision("nope")).toBeNull();
  });
});
