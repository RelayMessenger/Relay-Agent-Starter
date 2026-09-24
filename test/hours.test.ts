import { describe, expect, it } from "vitest";

import { formatTime, localClock, localToUtcIso, storeStatus, weeklyHoursText } from "../src/hours";

// 2026-09-24 is a Thursday; Detroit is UTC-4 (EDT) until 2026-11-01.
const at = (iso: string) => new Date(iso);

describe("store hours (America/Detroit)", () => {
  it("reads the local clock across the UTC date line", () => {
    const clock = localClock(at("2026-09-25T02:30:00Z")); // Thu 22:30 EDT
    expect(clock).toMatchObject({ date: "2026-09-24", day: 4, minutes: 22 * 60 + 30 });
  });

  it("is open inside Thursday hours and names the closing time", () => {
    expect(storeStatus(at("2026-09-24T18:00:00Z"))).toMatchObject({
      isOpen: true,
      summary: "Open now until 8 PM.",
    });
  });

  it("is closed before opening and says when it opens today", () => {
    expect(storeStatus(at("2026-09-24T13:30:00Z")).summary)
      .toBe("Closed right now. Opens today at 10 AM.");
  });

  it("closes exactly at closing time and points to tomorrow", () => {
    // Thu 20:00 EDT: closed, Friday opens 10 AM.
    expect(storeStatus(at("2026-09-25T00:00:00Z")).summary)
      .toBe("Closed for the day. Opens tomorrow (Friday) at 10 AM.");
    // Sat 21:30 EDT: Sunday opens at 11 AM.
    expect(storeStatus(at("2026-09-27T01:30:00Z")).summary)
      .toBe("Closed for the day. Opens tomorrow (Sunday) at 11 AM.");
  });

  it("uses Friday's later close", () => {
    expect(storeStatus(at("2026-09-26T00:30:00Z")).summary).toBe("Open now until 9 PM.");
  });

  it("uses the owner-confirmed weekly hours", () => {
    expect(weeklyHoursText()).toBe([
      "Monday: 10 AM–8 PM",
      "Tuesday: 10 AM–8 PM",
      "Wednesday: 10 AM–8 PM",
      "Thursday: 10 AM–8 PM",
      "Friday: 10 AM–9 PM",
      "Saturday: 10 AM–9 PM",
      "Sunday: 11 AM–8 PM",
    ].join("\n"));
  });

  it("formats times", () => {
    expect(formatTime("00:00")).toBe("12 AM");
    expect(formatTime("12:30")).toBe("12:30 PM");
  });
});

describe("local to UTC", () => {
  it("applies EDT and EST offsets", () => {
    expect(localToUtcIso("2026-10-10T12:00")).toBe("2026-10-10T16:00:00.000Z");
    expect(localToUtcIso("2026-12-05T12:00")).toBe("2026-12-05T17:00:00.000Z");
  });

  it("handles the DST change day", () => {
    // 2026-11-01: clocks fall back at 2 AM; noon is EST.
    expect(localToUtcIso("2026-11-01T12:00")).toBe("2026-11-01T17:00:00.000Z");
  });

  it("rejects malformed input", () => {
    expect(() => localToUtcIso("2026-10-10 12:00")).toThrow(RangeError);
  });
});
