import { verifyWebhookSignature } from "@relaymessenger/chat-sdk-adapter";
import { getAgentByName } from "agents";

import { RelayChatAgent } from "./agent";
import type { Bindings } from "./env";
import {
  configurationErrors,
  requireRelayWebhookSecret,
} from "./env";

export { RelayChatAgent, ThinkMessengerStateAgent } from "./agent";

const RELAY_WEBHOOK_PATH = "/webhooks/relay";
const RELAY_EVENT_AGENT_NAME = "relay-events";
const MAX_RELAY_WEBHOOK_BYTES = 8 * 1_048_576;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readRelayWebhookBody(request: Request): Promise<string> {
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

export function relayChatIdFromSignedPayload(payload: string): string | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(envelope) || !isRecord(envelope.data)) return null;
  const nested =
    isRecord(envelope.data.chat) ? envelope.data.chat.id : undefined;
  const candidate =
    typeof nested === "string" ? nested : envelope.data.chat_id;
  return typeof candidate === "string" && UUID.test(candidate)
    ? candidate
    : null;
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
    payload = await readRelayWebhookBody(request);
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

  const name =
    relayChatIdFromSignedPayload(payload) ?? RELAY_EVENT_AGENT_NAME;
  const agent = await getAgentByName(env.RelayChat, name);
  return agent.fetch(new Request(request.url, {
    body: payload,
    headers: request.headers,
    method: request.method,
  }));
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz" && request.method === "GET") {
      const errors = configurationErrors(env);
      return errors.length === 0
        ? Response.json({ ok: true })
        : Response.json(
            { ok: false, error: "misconfigured", details: errors },
            { status: 503 },
          );
    }

    if (url.pathname === RELAY_WEBHOOK_PATH) {
      return routeRelayWebhook(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Bindings>;
