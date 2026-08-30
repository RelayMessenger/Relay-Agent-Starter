import { getAgentByName } from "agents";

import type { Env } from "./env";
import { requireWebhookSecret } from "./env";
import {
  chatInstanceName,
  type RelayEventEnvelope,
  type RelayEventReference,
  verifyRelayWebhook,
} from "./relay";

export { RelayChatAgent } from "./agent";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz" && request.method === "GET") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/webhooks/relay" && request.method === "POST") {
      let body: string;
      try {
        body = await verifyRelayWebhook(request, requireWebhookSecret(env));
      } catch {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      let envelope: RelayEventEnvelope;
      try {
        envelope = JSON.parse(body) as RelayEventEnvelope;
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 });
      }
      if (typeof envelope.event_id !== "string" || envelope.event_id.length === 0) {
        return Response.json({ error: "invalid_event_id" }, { status: 400 });
      }

      const message = envelope.data;
      if (
        envelope.event_type !== "message.received"
        || !message?.chat?.id
        || !message.id
        || message.direction !== "inbound"
      ) {
        return new Response(null, { status: 204 });
      }

      const event: RelayEventReference = {
        eventId: envelope.event_id,
        chatId: message.chat.id,
        messageId: message.id,
        envelope,
      };
      const stub = await getAgentByName(
        env.RelayChat,
        await chatInstanceName(message.chat.id),
      );
      return stub.fetch(new Request("https://relay-agent.internal/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }));
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
