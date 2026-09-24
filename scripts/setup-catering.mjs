#!/usr/bin/env node
/**
 * Create Tania's "Catering request" event type and its decision webhook in
 * Tania's own Cal.com account (Cal.com API v2).
 *
 *   CAL_API_KEY=cal_live_... node scripts/setup-catering.mjs \
 *     --webhook-url https://<worker-host>/webhooks/cal \
 *     --webhook-secret <random> [--min-notice-hours 48] [--max-per-day 2] \
 *     [--length-minutes 60] [--apply]
 *
 * Without --apply it prints both requests and sends nothing. With --apply it
 * prints the new event type ID: set it as CAL_EVENT_TYPE_ID, and the webhook
 * secret as the CAL_WEBHOOK_SECRET Worker secret.
 *
 * The event type enforces, natively in Cal.com: owner confirmation on every
 * request, a per-day cap, minimum notice, and the intake questions. Field
 * slugs and types must match bookingBody() in src/catering.ts.
 * Header versions per the Cal.com v2 reference, read 2026-09-24.
 */

const API = process.env.CAL_API_ORIGIN ?? "https://api.cal.com";
const EVENT_TYPES_VERSION = "2026-06-12";

function parseArgs(argv) {
  const options = {
    apply: false,
    lengthMinutes: 60,
    maxPerDay: 2,
    minNoticeHours: 48,
    webhookSecret: undefined,
    webhookUrl: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === "--apply") options.apply = true;
    else if (flag === "--webhook-url") options.webhookUrl = value();
    else if (flag === "--webhook-secret") options.webhookSecret = value();
    else if (flag === "--min-notice-hours") options.minNoticeHours = Number(value());
    else if (flag === "--max-per-day") options.maxPerDay = Number(value());
    else if (flag === "--length-minutes") options.lengthMinutes = Number(value());
    else throw new Error(`Unknown option ${flag}`);
  }
  for (const [name, number] of Object.entries({
    lengthMinutes: options.lengthMinutes,
    maxPerDay: options.maxPerDay,
    minNoticeHours: options.minNoticeHours,
  })) {
    if (!Number.isInteger(number) || number < (name === "minNoticeHours" ? 0 : 1)) {
      throw new Error(`${name} must be a whole number`);
    }
  }
  if (!options.webhookUrl?.startsWith("https://")) {
    throw new Error("--webhook-url must be the Worker's https://…/webhooks/cal URL");
  }
  if (!options.webhookSecret || options.webhookSecret.length < 16) {
    throw new Error("--webhook-secret must be at least 16 characters");
  }
  return options;
}

export function eventTypeBody(options) {
  return {
    bookingFields: [
      { field: "name", label: "Your name", slug: "name", variant: "fullName" },
      { field: "email", label: "Email", required: true, slug: "email" },
      { field: "custom", label: "Phone", required: true, slug: "phone", type: "phone" },
      { field: "custom", label: "Headcount", required: true, slug: "headcount", type: "number" },
      { field: "custom", label: "Pickup or delivery", options: ["Pickup", "Delivery"], required: true, slug: "fulfillment", type: "select" },
      { field: "custom", label: "Delivery address", required: false, slug: "address", type: "address" },
      { field: "custom", label: "What would you like?", required: true, slug: "menu", type: "longText" },
      { field: "custom", label: "Dietary needs or allergies", required: false, slug: "dietary", type: "longText" },
      { field: "custom", label: "Plates, napkins and utensils?", options: ["Yes", "No"], required: false, slug: "utensils", type: "select" },
      { field: "custom", label: "Budget", required: false, slug: "budget", type: "shortText" },
      { field: "notes", label: "Anything else", required: false, slug: "notes" },
    ],
    bookingLimitsCount: { day: options.maxPerDay },
    confirmationPolicy: { blockUnconfirmedBookingsInBooker: true, type: "always" },
    description:
      "Catering request for Tania's Pizza. Tania's confirms every request and follows up with a quote.",
    // Booked only by the Relay agent, not listed on the public Cal.com page.
    hidden: true,
    lengthInMinutes: options.lengthMinutes,
    minimumBookingNotice: options.minNoticeHours * 60,
    slug: "catering",
    title: "Catering request",
  };
}

export function webhookBody(options) {
  return {
    active: true,
    secret: options.webhookSecret,
    subscriberUrl: options.webhookUrl,
    triggers: ["BOOKING_CREATED", "BOOKING_REJECTED", "BOOKING_CANCELLED", "BOOKING_REQUESTED"],
  };
}

async function call(path, body, headers) {
  const response = await fetch(`${API}${path}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${process.env.CAL_API_KEY}`,
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const eventType = eventTypeBody(options);
  const webhook = webhookBody(options);
  if (!options.apply) {
    console.log("Dry run. Nothing sent. Re-run with --apply to create:\n");
    console.log(`POST ${API}/v2/event-types  (cal-api-version: ${EVENT_TYPES_VERSION})`);
    console.log(JSON.stringify(eventType, null, 2));
    console.log(`\nPOST ${API}/v2/event-types/<new id>/webhooks`);
    console.log(JSON.stringify({ ...webhook, secret: "<redacted>" }, null, 2));
    return;
  }
  if (!process.env.CAL_API_KEY?.startsWith("cal_")) {
    throw new Error("Set CAL_API_KEY to Tania's Cal.com API key (starts with cal_).");
  }
  const created = await call("/v2/event-types", eventType, { "cal-api-version": EVENT_TYPES_VERSION });
  const id = created?.data?.id;
  if (!Number.isInteger(id)) throw new Error("Cal.com returned no event type id");
  await call(`/v2/event-types/${id}/webhooks`, webhook, {});
  console.log(`Created event type ${id} and its webhook.`);
  console.log(`Set CAL_EVENT_TYPE_ID=${id} in wrangler.jsonc, then:`);
  console.log("  npx wrangler secret put CAL_API_KEY --env <env>");
  console.log("  npx wrangler secret put CAL_WEBHOOK_SECRET --env <env>   # the --webhook-secret value");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
