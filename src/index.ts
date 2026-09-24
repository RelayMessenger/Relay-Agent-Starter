import { verifyWebhookSignature } from "@relaymessenger/chat-sdk-adapter";
import { getAgentByName } from "agents";

import { RelayChatAgent } from "./agent";
import { cateringDecision, verifyCalSignature } from "./catering";
import type { Bindings } from "./env";
import {
  configurationErrors,
  integrationStatus,
  optionalConfiguration,
  requireRelayWebhookSecret,
} from "./env";
import {
  rateLimitedSenderFromSignedPayload,
  relayChatIdFromSignedPayload,
} from "./events";
import { createPaymentPart, RelayAPIError } from "@relaymessenger/sdk";

import { interactiveParts, relayClient, sendRelayAnswer } from "./reply";

export { RelayChatAgent, ThinkMessengerStateAgent } from "./agent";
export {
  rateLimitedSenderFromSignedPayload,
  relayChatIdFromSignedPayload,
} from "./events";

const RELAY_WEBHOOK_PATH = "/webhooks/relay";
const CAL_WEBHOOK_PATH = "/webhooks/cal";
const RELAY_EVENT_AGENT_NAME = "relay-events";
const MAX_RELAY_WEBHOOK_BYTES = 8 * 1_048_576;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readWebhookBody(request: Request): Promise<string> {
  const contentLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(contentLength)
    && contentLength > MAX_RELAY_WEBHOOK_BYTES
  ) {
    throw new RangeError("Relay webhook body exceeds 8 MiB");
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RELAY_WEBHOOK_BYTES) {
      await reader.cancel();
      throw new RangeError("Relay webhook body exceeds 8 MiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function routeRelayWebhook(
  request: Request,
  env: Bindings,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({
      error: { code: "method_not_allowed" },
    }, { status: 405 });
  }

  let payload: string;
  try {
    payload = await readWebhookBody(request);
  } catch (error) {
    return Response.json({
      error: {
        code: error instanceof RangeError
          ? "payload_too_large"
          : "invalid_utf8",
      },
    }, { status: error instanceof RangeError ? 413 : 400 });
  }

  try {
    await verifyWebhookSignature({
      headers: request.headers,
      payload,
      secret: requireRelayWebhookSecret(env),
    });
  } catch {
    return Response.json({
      error: { code: "invalid_signature" },
    }, { status: 401 });
  }

  // Tania's pays for inference, so one person cannot run up the bill.
  // Over the limit, the event is acknowledged and not answered.
  const sender = rateLimitedSenderFromSignedPayload(payload);
  if (sender && env.SENDER_LIMITER) {
    const { success } = await env.SENDER_LIMITER.limit({ key: sender });
    if (!success) {
      console.warn(JSON.stringify({ event: "sender_rate_limited", sender }));
      return Response.json({ ignored: "rate_limited" }, { status: 200 });
    }
  }

  const name =
    relayChatIdFromSignedPayload(payload) ?? RELAY_EVENT_AGENT_NAME;
  const agent = await getAgentByName(env.RelayChat, name);
  return agent.fetch(new Request(request.url, {
    body: payload,
    headers: request.headers,
    method: request.method,
  }));
}

async function routeCalWebhook(
  request: Request,
  env: Bindings,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: { code: "method_not_allowed" } }, { status: 405 });
  }
  const secret = optionalConfiguration(env).CAL_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return Response.json({ error: { code: "not_configured" } }, { status: 404 });
  }
  let payload: string;
  try {
    payload = await readWebhookBody(request);
  } catch (error) {
    return Response.json({
      error: { code: error instanceof RangeError ? "payload_too_large" : "invalid_utf8" },
    }, { status: error instanceof RangeError ? 413 : 400 });
  }
  if (!await verifyCalSignature(secret, payload, request.headers.get("x-cal-signature-256"))) {
    return Response.json({ error: { code: "invalid_signature" } }, { status: 401 });
  }
  let event: unknown;
  try {
    event = JSON.parse(payload) as unknown;
  } catch {
    return Response.json({ error: { code: "invalid_json" } }, { status: 400 });
  }
  const decision = cateringDecision(event);
  if (!decision || !UUID.test(decision.chatId)) {
    return Response.json({ ignored: true });
  }
  const key = `tanias-pizza-agent:catering:${decision.bookingUid}:${decision.status}`;
  // Relay's idempotency key makes Cal.com's retries safe.
  const sent = await sendRelayAnswer(env, decision.chatId, decision.text, key);
  const deposit = decision.status === "accepted" ? await sendCateringDeposit(env, decision) : "not_applicable";
  try {
    const agent = await getAgentByName(env.RelayChat, decision.chatId);
    await (agent as unknown as {
      recordAgentNote(id: string, text: string): Promise<void>;
    }).recordAgentNote(sent.messageId, decision.text);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "catering_note_not_recorded",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return Response.json({ delivered: true, deposit, status: decision.status });
}

/**
 * When Tania's confirms a catering job and has set CATERING_DEPOSIT_CENTS,
 * the customer gets a Relay payment card for the deposit (a direct charge on
 * Tania's own connected Stripe account; Relay takes no fee). The Worker, not
 * the model, sends it, so an amount is never invented. Until Stripe is
 * connected in Relay Console the request is refused (403) and nothing is
 * sent.
 */
async function sendCateringDeposit(
  env: Bindings,
  decision: { bookingUid: string; chatId: string },
): Promise<string> {
  const cents = Number(optionalConfiguration(env).CATERING_DEPOSIT_CENTS);
  if (!Number.isInteger(cents) || cents <= 0) return "not_configured";
  if (!interactiveParts(env)) return "not_supported_on_this_server";
  const key = `tanias-pizza-agent:deposit:${decision.bookingUid}`;
  const relay = relayClient(env);
  try {
    const payment = await createPaymentPart(relay, {
      amount: cents,
      category: "physical_goods",
      currency: "usd",
      description: "Catering deposit",
      metadata: { cal_booking_uid: decision.bookingUid },
    }, key);
    await relay.chats.messages.send(decision.chatId, {
      message: { idempotency_key: key, parts: [payment] },
    });
    return "sent";
  } catch (error) {
    if (error instanceof RelayAPIError && (error.status === 403 || error.status === 503)) {
      console.warn(JSON.stringify({ event: "catering_deposit_unavailable", status: error.status, error: error.message }));
      return "payments_unavailable";
    }
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz" && request.method === "GET") {
      const errors = configurationErrors(env);
      return errors.length === 0
        ? Response.json({ ok: true, integrations: integrationStatus(env) })
        : Response.json(
            { ok: false, error: "misconfigured", details: errors },
            { status: 503 },
          );
    }

    if (url.pathname === RELAY_WEBHOOK_PATH) {
      return routeRelayWebhook(request, env);
    }

    if (url.pathname === CAL_WEBHOOK_PATH) {
      return routeCalWebhook(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Bindings>;
