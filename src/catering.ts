import { z } from "zod";

import { BUSINESS, TIME_ZONE } from "./business";
import { localToUtcIso } from "./hours";

/**
 * Catering runs on a Cal.com "Catering request" event type that Tania's owns.
 * Cal.com enforces the rules natively (API v2 event types): every booking
 * requires owner confirmation (confirmationPolicy "always"), a per-day cap
 * (bookingLimitsCount.day), minimum notice (minimumBookingNotice), and the
 * intake questions (bookingFields). The agent only offers open slots, files a
 * pending request, and relays the owner's decision. It never confirms a
 * catering job or quotes a price itself. Pattern: PolyAI / Hostie / Slang
 * collect the lead; staff confirm (Tripleseat "approval on every event").
 */

export interface CateringConfiguration {
  CAL_API_KEY?: string;
  CAL_API_ORIGIN?: string;
  CAL_EVENT_TYPE_ID?: string;
  CAL_WEBHOOK_SECRET?: string;
}

const DEFAULT_CAL_ORIGIN = "https://api.cal.com";
// Header versions from the Cal.com v2 reference, read 2026-09-24.
const SLOTS_API_VERSION = "2024-09-04";
const BOOKINGS_API_VERSION = "2026-02-25";
const MAX_RANGE_DAYS = 31;

export function cateringConfigured(env: CateringConfiguration): boolean {
  return Boolean(env.CAL_API_KEY?.trim() && env.CAL_EVENT_TYPE_ID?.trim());
}

function origin(env: CateringConfiguration): string {
  return (env.CAL_API_ORIGIN?.trim() || DEFAULT_CAL_ORIGIN).replace(/\/$/u, "");
}

function eventTypeId(env: CateringConfiguration): number {
  const id = Number(env.CAL_EVENT_TYPE_ID);
  if (!Number.isInteger(id) || id <= 0) throw new Error("CAL_EVENT_TYPE_ID is invalid");
  return id;
}

export const NOT_CONFIGURED = {
  status: "not_configured",
  instruction:
    `Online catering requests are not set up yet. Ask the customer to call ${BUSINESS.phone} to arrange catering.`,
} as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export const availabilityInput = z.object({
  from: z.string().regex(DATE).describe("First date to check, YYYY-MM-DD, store local time"),
  to: z.string().regex(DATE).describe("Last date to check, YYYY-MM-DD, store local time"),
}).strict();

export type AvailabilityInput = z.infer<typeof availabilityInput>;

export async function cateringAvailability(
  env: CateringConfiguration,
  input: AvailabilityInput,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  if (!cateringConfigured(env)) return NOT_CONFIGURED;
  const days = (Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) / 86_400_000;
  if (!(days >= 0) || days > MAX_RANGE_DAYS) {
    return { status: "invalid_range", instruction: `Check at most ${MAX_RANGE_DAYS} days at a time, with from <= to.` };
  }
  const url = new URL(`${origin(env)}/v2/slots`);
  url.searchParams.set("eventTypeId", String(eventTypeId(env)));
  url.searchParams.set("start", input.from);
  url.searchParams.set("end", input.to);
  url.searchParams.set("timeZone", TIME_ZONE);
  const response = await fetcher(url, {
    headers: {
      authorization: `Bearer ${env.CAL_API_KEY!.trim()}`,
      "cal-api-version": SLOTS_API_VERSION,
    },
  });
  if (!response.ok) {
    return { status: "unavailable", instruction: `The catering calendar could not be read. Offer to take the request by phone at ${BUSINESS.phone}.` };
  }
  const body = await response.json<{
    data?: Record<string, Array<string | { start?: string }>>;
  }>();
  const slots: Record<string, string[]> = {};
  for (const [date, entries] of Object.entries(body.data ?? {})) {
    // The reference documents both plain strings and { start } objects.
    const starts = entries
      .map((entry) => (typeof entry === "string" ? entry : entry.start))
      .filter((start): start is string => typeof start === "string")
      .map((start) => start.slice(11, 16));
    if (starts.length > 0) slots[date] = starts;
  }
  return {
    status: "ok",
    timeZone: TIME_ZONE,
    openSlots: slots,
    note: Object.keys(slots).length === 0
      ? "No open catering slots in this range. Suggest other dates or calling the store."
      : "Times are local start times the kitchen can take. Only offer these.",
  };
}

export const cateringRequestInput = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(7).max(30).describe("Customer phone number"),
  email: z.string().trim().email().max(200),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u)
    .describe("Food-ready time, store local, YYYY-MM-DDTHH:MM, taken from check_catering_availability"),
  headcount: z.number().int().min(1).max(2000),
  fulfillment: z.enum(["pickup", "delivery"]),
  // Required (empty for pickup): small models reliably fill required fields
  // and skip optional ones, and delivery can't be filed without it.
  address: z.string().trim().max(300)
    .describe("Delivery street address from the customer; empty string for pickup"),
  menu: z.string().trim().min(1).max(1500).describe("What they want: pizzas, sides, drinks"),
  dietary: z.string().trim().max(500).optional().describe("Dietary needs and allergies"),
  utensils: z.boolean().optional().describe("Plates, napkins and utensils needed"),
  budget: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict();

export type CateringRequest = z.infer<typeof cateringRequestInput>;

export const PENDING_STATUS = "pending_owner_confirmation";

/**
 * Checks the schema can't express to the model (a conditional field). Returns
 * a tool result telling the model what to fix, or null when the request can
 * be filed. Sent back as a result rather than a validation error so the
 * model reads the instruction and retries in the same turn.
 */
export function cateringRequestProblem(request: CateringRequest): Record<string, unknown> | null {
  if (request.fulfillment === "delivery" && !request.address?.trim()) {
    return {
      status: "needs_address",
      instruction:
        "Delivery needs the street address. Call request_catering again with the address the customer gave, or ask them for it.",
    };
  }
  return null;
}

export function toE164(phone: string): string | undefined {
  const digits = phone.replace(/\D/gu, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return undefined;
}

export function bookingBody(env: CateringConfiguration, request: CateringRequest, chatId: string) {
  const phoneNumber = toE164(request.phone);
  // Slugs and value types match scripts/setup-catering.mjs bookingFields.
  const responses: Record<string, string | number> = {
    fulfillment: request.fulfillment === "delivery" ? "Delivery" : "Pickup",
    headcount: request.headcount,
    menu: request.menu,
    phone: phoneNumber ?? request.phone,
  };
  if (request.fulfillment === "delivery" && request.address) responses.address = request.address;
  if (request.dietary) responses.dietary = request.dietary;
  if (request.utensils !== undefined) responses.utensils = request.utensils ? "Yes" : "No";
  if (request.budget) responses.budget = request.budget;
  if (request.notes) responses.notes = request.notes;
  return {
    attendee: {
      email: request.email,
      language: "en",
      name: request.name,
      ...(phoneNumber ? { phoneNumber } : {}),
      timeZone: TIME_ZONE,
    },
    bookingFieldsResponses: responses,
    eventTypeId: eventTypeId(env),
    metadata: { relay_chat_id: chatId, source: "relay" },
    start: localToUtcIso(request.start),
  };
}

export async function requestCatering(
  env: CateringConfiguration,
  request: CateringRequest,
  chatId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  if (!cateringConfigured(env)) return NOT_CONFIGURED;
  const problem = cateringRequestProblem(request);
  if (problem) return problem;
  const response = await fetcher(`${origin(env)}/v2/bookings`, {
    body: JSON.stringify(bookingBody(env, request, chatId)),
    headers: {
      authorization: `Bearer ${env.CAL_API_KEY!.trim()}`,
      "cal-api-version": BOOKINGS_API_VERSION,
      "content-type": "application/json",
    },
    method: "POST",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.warn(JSON.stringify({ event: "catering_request_failed", status: response.status, detail: detail.slice(0, 300) }));
    return {
      status: "rejected_by_calendar",
      instruction:
        "That time could not be requested (it may have just filled, or is too soon). Check availability again, or offer the store phone number.",
    };
  }
  const body = await response.json<{ data?: { uid?: string; status?: string } }>();
  return {
    status: PENDING_STATUS,
    requestId: body.data?.uid ?? null,
    instruction:
      "Tell the customer the request is in and NOT yet confirmed: Tania's will confirm or follow up with a quote, and you will message them here when they decide.",
  };
}

/** Standard HMAC-SHA256 over the raw body, hex digest, header x-cal-signature-256. */
export async function verifyCalSignature(secret: string, payload: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const given = signature.trim().toLowerCase().replace(/^sha256=/u, "");
  if (given.length !== hex.length) return false;
  let difference = 0;
  for (let index = 0; index < hex.length; index += 1) {
    difference |= hex.charCodeAt(index) ^ given.charCodeAt(index);
  }
  return difference === 0;
}

export interface CateringDecision {
  bookingUid: string;
  chatId: string;
  status: "accepted" | "rejected" | "cancelled";
  text: string;
}

function whenText(startTime: unknown): string {
  if (typeof startTime !== "string") return "your event";
  const date = new Date(startTime);
  if (Number.isNaN(date.getTime())) return "your event";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: TIME_ZONE,
  }).format(date);
}

/**
 * Map a Cal.com webhook to the message the customer should receive, or null
 * when the event needs no customer message (e.g. BOOKING_REQUESTED, which the
 * agent already acknowledged in the chat).
 */
export function cateringDecision(event: unknown): CateringDecision | null {
  if (typeof event !== "object" || event === null) return null;
  const { triggerEvent, payload } = event as { triggerEvent?: unknown; payload?: Record<string, unknown> };
  if (!payload || typeof payload !== "object") return null;
  const metadata = payload.metadata as Record<string, unknown> | undefined;
  const chatId = metadata?.relay_chat_id;
  const bookingUid = payload.uid;
  if (typeof chatId !== "string" || typeof bookingUid !== "string") return null;
  const when = whenText(payload.startTime);

  if (triggerEvent === "BOOKING_CREATED" && payload.status === "ACCEPTED") {
    return {
      bookingUid,
      chatId,
      status: "accepted",
      text: `Good news: Tania's confirmed your catering for ${when}. They'll follow up about the final order and payment. Questions? Call ${BUSINESS.phone}.`,
    };
  }
  if (triggerEvent === "BOOKING_REJECTED") {
    const reason = typeof payload.rejectionReason === "string" && payload.rejectionReason.trim()
      ? ` They said: "${payload.rejectionReason.trim()}"`
      : "";
    return {
      bookingUid,
      chatId,
      status: "rejected",
      text: `Sorry, Tania's can't take the catering request for ${when}.${reason} Want me to check other dates?`,
    };
  }
  if (triggerEvent === "BOOKING_CANCELLED") {
    return {
      bookingUid,
      chatId,
      status: "cancelled",
      text: `Your catering booking for ${when} was cancelled. If that's unexpected, call Tania's at ${BUSINESS.phone}.`,
    };
  }
  return null;
}
