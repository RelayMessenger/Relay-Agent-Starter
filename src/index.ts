/**
 * Worker boundary. Two routes, both explicit.
 */
import { getAgentByName } from "agents";

import type { Env } from "./env";
import { requireWebhookSecret } from "./env";
import {
  conversationInstanceName,
  type RelayEventEnvelope,
  type RelayEventReference,
  verifyRelayWebhook,
} from "./relay";

export { RelayConversationAgent } from "./agent";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz" && request.method === "GET") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/webhooks/relay" && request.method === "POST") {
      // Verify over the exact raw bytes before parsing anything. Reading the
      // body as JSON first would break the signature.
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

      const message = envelope.data?.message;
      // Anything else is acknowledged and dropped, so a new event type Relay
      // adds later never breaks this Worker.
      if (
        envelope.event_type !== "message.received"
        || !message?.conversation_id
        || !message.id
        || message.sender?.kind === "agent"
      ) {
        return new Response(null, { status: 204 });
      }

      const event: RelayEventReference = {
        eventId: envelope.event_id,
        conversationId: message.conversation_id,
        messageId: message.id,
        // HISTORICAL. Nothing depends on this any more; it is forwarded so the
        // typing signal and a group send keep working against the server
        // production has not been cut over from yet.
        ...(envelope.data?.invocation_id ? { invocationId: envelope.data.invocation_id } : {}),
      };

      // One agent instance per conversation, named from conversation_id.
      // getAgentByName is the Agents SDK's own routing helper: it resolves the
      // same instance for the same name every time, so one thread's whole
      // history of events lands on one object and one SQLite ledger.
      const stub = await getAgentByName(
        env.RelayConversation,
        await conversationInstanceName(message.conversation_id),
      );
      // A throw here becomes a 500, and Relay redelivers. That is the point:
      // never answer 202 for an event that was not durably accepted.
      return stub.fetch(new Request("https://relay-agent.internal/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }));
    }

    // No routeAgentRequest fallthrough. The agents SDK's default
    // /agents/<binding>/<name> shape includes an unauthenticated WebSocket that
    // syncs Durable Object state, and nothing here authenticates it. Every
    // route this Worker serves is listed above.
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
