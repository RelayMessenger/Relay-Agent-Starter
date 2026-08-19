# Relay Agent Starter

A Relay agent on Cloudflare Workers. Signed webhook in, durable reply out.

Relay is a messenger where people text AI agents like contacts. This starter is
the smallest backend that behaves correctly on the other end of that: it
verifies Relay's webhook signature, hands the event to one Durable Object per
conversation, marks the message Read, replies once with an idempotency key that
survives redelivery, and stops typing. Replace one function with your model call
and it is your agent.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/relaymessenger/relay-agent-starter)

Or scaffold it locally:

```bash
npm create cloudflare@latest -- --template relaymessenger/relay-agent-starter
```

## Setup

1. **Create your agent.** In the Relay app, create an agent and copy the Agent
   Token. Relay shows it once.

2. **Deploy the Worker.** Use the button above, or from a local checkout:

   ```bash
   npm install
   npx wrangler deploy
   ```

   Note the deployed URL. It looks like
   `https://relay-agent.<your-subdomain>.workers.dev`.

3. **Set the Agent Token.** The deploy button prompts for it. Locally:

   ```bash
   npx wrangler secret put RELAY_AGENT_TOKEN
   ```

4. **Register the webhook.** Point Relay at `/webhooks/relay` on your deployed
   Worker:

   ```bash
   curl -sS -X POST "https://api.relayapp.im/v1/webhooks" \
     -H "Authorization: Bearer $RELAY_AGENT_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://relay-agent.<your-subdomain>.workers.dev/webhooks/relay",
       "events": ["message.received"]
     }'
   ```

   Save `signing_secret` from the response. Relay never returns it again.

5. **Set the signing secret.**

   ```bash
   npx wrangler secret put RELAY_WEBHOOK_SECRET
   ```

   Then redeploy so the Worker picks up both secrets:

   ```bash
   npx wrangler deploy
   ```

6. **Text your agent.** Open Relay, find your agent, send it a message. It
   replies.

`GET /healthz` returns `{"ok":true}` if you want to check the Worker is up.

## Write your agent

Everything you change lives in one function, `generateReply` at the bottom of
[`src/agent.ts`](src/agent.ts):

```ts
async generateReply(text: string, mediaCount: number, handle: string): Promise<string> {
  return `@${handle} here. You said: ${text}`;
}
```

`text` is the whole user turn. One send can commit as several messages (Relay
splits text and photos at ingest), and the plumbing joins them back together
before calling you. `mediaCount` says how many media parts came along, for a
model that cannot see them yet.

Call any model you like from there. A Workers AI example is commented directly
above it, and needs no extra secrets: add the `ai` binding to `wrangler.jsonc`,
uncomment `AI` in `src/env.ts`, and swap the return.

Everything above that function is delivery plumbing, and it is the part worth
keeping:

- **One reply per user turn.** A single send can arrive as several
  `message.received` events, one per committed message. Events are collected
  into a turn — matched on `invocation_id`, or a two-second window in DMs — and
  the turn gets one reply. Without this, a text+photo send draws two replies.
- **Signature first.** `verifyRelayWebhook` checks the Standard Webhooks
  signature over the exact raw request body before anything parses it.
- **Explicit routes only.** There is no `routeAgentRequest` fallthrough. The
  Agents SDK default route shape exposes an unauthenticated WebSocket that syncs
  Durable Object state.
- **Alarm-backed, not queue-backed.** The reply is armed with `schedule()`, so
  an evicted isolate wakes itself back up. `queue()` would strand the reply.
- **202 means accepted.** The Worker acknowledges only after the ledger row and
  the alarm both exist. Anything earlier returns 5xx and Relay redelivers.
- **Content-digested idempotency.** The reply key includes a hash of what is
  being sent, so a retry that writes different words gets a new key instead of
  colliding with `409 idempotency_conflict`.
- **Groups work.** `invocation_id` is threaded into the reply, the Read call,
  and the typing calls.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in both values
npm run dev
```

`npm test` runs the suite. `npm run check` typechecks. `npm run types`
regenerates `worker-configuration.d.ts`, which is gitignored on purpose:
`wrangler types` also writes the names of whatever sits in your `.dev.vars` into
that file.

## Layout

| File | What it holds |
| --- | --- |
| `src/index.ts` | Worker routes: `POST /webhooks/relay`, `GET /healthz` |
| `src/agent.ts` | The Durable Object: turn ledger, retries, `generateReply` |
| `src/relay.ts` | Signature verification, API client, idempotency, ack ordering |
| `src/env.ts` | Bindings |

## Docs

Full API reference and guides: [docs.relayapp.im/quickstart](https://docs.relayapp.im/quickstart).

## License

MIT
