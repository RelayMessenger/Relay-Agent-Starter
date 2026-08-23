import { getAgentByName } from "agents";
import { Think, messengerChannel } from "@cloudflare/think";
import {
  chatSdkMessenger,
  ThinkMessengerStateAgent,
} from "@cloudflare/think/messengers";
import {
  createRelayAdapter,
  verifyWebhookSignature,
} from "@relaymessenger/chat-sdk-adapter";
import { createWorkersAI } from "workers-ai-provider";

// Think stores Chat SDK state in sub-agents of this class. Sub-agent routing
// resolves it by name, so the Worker has to export it even though nothing
// binds it directly.
export { ThinkMessengerStateAgent };

interface Env {
  AI: Ai;
  RelayThink: DurableObjectNamespace<RelayThinkAgent>;
  RELAY_AGENT_TOKEN: string;
  RELAY_WEBHOOK_SECRET: string;
}

// Think requires an explicit verifier on every custom messenger, or an
// explicit `verifyWebhook: false`. Relay signs deliveries with Standard
// Webhooks, so the adapter's own verifier is the whole implementation: HMAC
// over the exact raw body, checked before Think parses anything.
function relayWebhookVerifier(secret: string) {
  return async (request: Request): Promise<boolean> => {
    try {
      await verifyWebhookSignature({
        secret,
        payload: await request.text(),
        headers: {
          "webhook-id": request.headers.get("webhook-id"),
          "webhook-timestamp": request.headers.get("webhook-timestamp"),
          "webhook-signature": request.headers.get("webhook-signature"),
        },
      });
      return true;
    } catch {
      return false;
    }
  };
}

export class RelayThinkAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.6",
    );
  }

  configureChannels() {
    return {
      // Relay is a messenger channel, the same shape Cloudflare's own
      // Telegram channel takes. The channel id names the webhook route:
      // `relay` serves POST /messengers/relay/webhook.
      relay: messengerChannel(
        chatSdkMessenger({
          adapter: createRelayAdapter({
            token: this.env.RELAY_AGENT_TOKEN,
            webhookSecret: this.env.RELAY_WEBHOOK_SECRET,
            // Adapter 0.2.0 stores the global fetch on its client and calls it
            // as a method. Node tolerates that; Workers answers every send
            // with "Illegal invocation" instead. Handing it a bound fetch
            // keeps `this` right. Drop this line once the adapter ships the
            // fix.
            fetch: (input, init) => fetch(input, init),
          }),
          provider: "relay",
          userName: "Relay Agent",
          verifyWebhook: relayWebhookVerifier(this.env.RELAY_WEBHOOK_SECRET),
        }),
      ),
    };
  }
}

// One named root agent owns the messenger route. Messenger webhooks are
// root-only in Think: a sub-agent that declares channels gets no route, and
// Think fans out to a sub-agent per conversation on its own.
const ROOT_AGENT = "relay";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Deliberately not `routeAgentRequest`. Its default routes expose an
    // unauthenticated WebSocket that syncs agent state to anyone who knows
    // the instance name. This Worker forwards one path, the signed webhook,
    // and answers everything else with 404.
    if (url.pathname === "/messengers/relay/webhook") {
      const agent = await getAgentByName(env.RelayThink, ROOT_AGENT);
      return agent.fetch(request);
    }

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  },
};
