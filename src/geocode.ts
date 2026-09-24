import { BUSINESS, STORE_LOCATION } from "./business";
import { milesBetween } from "./interactive";

/**
 * Address → coordinates through the US Census Bureau Geocoder (public, no
 * key: geocoding.geo.census.gov, "Public_AR_Current" benchmark), the same
 * source that placed the shop in business.ts. Then the straight-line
 * distance to the shop against the delivery radius.
 */
const CENSUS_GEOCODER = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

export interface GeocodedAddress {
  matchedAddress: string;
  latitude: number;
  longitude: number;
}

export async function geocodeAddress(
  address: string,
  fetcher: typeof fetch = fetch,
): Promise<GeocodedAddress | null> {
  const url = new URL(CENSUS_GEOCODER);
  url.searchParams.set("address", address);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");
  const response = await fetcher(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Census geocoder failed: ${response.status}`);
  const body = await response.json<{
    result?: { addressMatches?: Array<{ matchedAddress: string; coordinates: { x: number; y: number } }> };
  }>();
  const match = body.result?.addressMatches?.[0];
  if (!match) return null;
  return { latitude: match.coordinates.y, longitude: match.coordinates.x, matchedAddress: match.matchedAddress };
}

export type AddressDistance =
  | {
    status: "ok";
    matchedAddress: string;
    miles: number;
    radiusMiles: number;
    withinDeliveryRadius: boolean;
    note: string;
  }
  | { status: "not_found" | "unavailable"; instruction: string };

export async function deliveryDistanceToAddress(
  address: string,
  fetcher: typeof fetch = fetch,
): Promise<AddressDistance> {
  let place: GeocodedAddress | null;
  try {
    place = await geocodeAddress(address, fetcher);
  } catch (error) {
    console.warn(JSON.stringify({ event: "geocode_failed", error: error instanceof Error ? error.message : String(error) }));
    return {
      instruction: "The address lookup is down right now. Say checkout confirms the address, or they can call the shop.",
      status: "unavailable",
    };
  }
  if (!place) {
    return {
      instruction: "That address couldn't be found. Ask them to check it, including the city (or ZIP code).",
      status: "not_found",
    };
  }
  const miles = Math.round(milesBetween(STORE_LOCATION, place) * 10) / 10;
  const radius = BUSINESS.deliveryRadiusMiles;
  return {
    matchedAddress: place.matchedAddress,
    miles,
    note: Math.abs(miles - radius) <= 0.5
      ? "Right at the edge of the delivery area: say it's probably close and the order page confirms it at checkout."
      : "Straight-line distance from the shop to that address.",
    radiusMiles: radius,
    status: "ok",
    withinDeliveryRadius: miles <= radius,
  };
}
