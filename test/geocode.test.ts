import { describe, expect, it, vi } from "vitest";

import { deliveryDistanceToAddress } from "../src/geocode";

const census = (x: number, y: number, matched: string) => vi.fn(async () =>
  Response.json({ result: { addressMatches: [{ coordinates: { x, y }, matchedAddress: matched }] } }));

describe("delivery distance to a typed address", () => {
  it("measures a far address and says it's outside the area", async () => {
    // 8319 Pamela St, Shelby Twp (US Census Geocoder, 2026-09-24).
    const fetcher = census(-83.032565154545, 42.689100108402, "8319 PAMELA ST, SHELBY TWP, MI, 48316");
    const result = await deliveryDistanceToAddress("8319 Pamela St Shelby Twp MI 48316", fetcher as unknown as typeof fetch);
    expect(result).toMatchObject({ matchedAddress: "8319 PAMELA ST, SHELBY TWP, MI, 48316", status: "ok", withinDeliveryRadius: false });
    expect((result as { miles: number }).miles).toBeGreaterThan(12);
    const url = new URL(String((fetcher.mock.calls[0] as unknown[])[0]));
    expect(url.hostname).toBe("geocoding.geo.census.gov");
    expect(url.searchParams.get("address")).toBe("8319 Pamela St Shelby Twp MI 48316");
  });

  it("puts a nearby address inside the area", async () => {
    // About a mile from 3204 Crooks Rd.
    const fetcher = census(-83.15, 42.525, "NEARBY");
    const result = await deliveryDistanceToAddress("near the shop", fetcher as unknown as typeof fetch);
    expect(result).toMatchObject({ status: "ok", withinDeliveryRadius: true });
  });

  it("asks for a better address when nothing matches", async () => {
    const fetcher = vi.fn(async () => Response.json({ result: { addressMatches: [] } }));
    expect(await deliveryDistanceToAddress("nowhere", fetcher as unknown as typeof fetch)).toMatchObject({ status: "not_found" });
  });

  it("degrades when the geocoder is down", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn(async () => new Response("down", { status: 503 }));
    expect(await deliveryDistanceToAddress("x y z", fetcher as unknown as typeof fetch)).toMatchObject({ status: "unavailable" });
  });
});
