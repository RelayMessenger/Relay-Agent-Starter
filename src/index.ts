import { getAgentByName } from "agents";

import { RelayChatAgent } from "./agent";
import type { Bindings } from "./env";
import { configurationErrors } from "./env";

export { RelayChatAgent, ThinkMessengerStateAgent } from "./agent";

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

    if (url.pathname === "/webhooks/relay") {
      const root = await getAgentByName(env.RelayChat, "relay-messenger");
      return root.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Bindings>;
