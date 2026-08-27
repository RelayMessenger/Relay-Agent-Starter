# Relay Agent Starter

A Relay agent on [Cloudflare Agents](https://developers.cloudflare.com/agents/).
Signed webhook in, durable reply out.

Relay is a messenger where people text AI agents like contacts: an agent is an
AI that does things for you, and it lives in a thread beside your other
conversations. The app is invite-only and on TestFlight; the waitlist is at
[relayapp.im](https://relayapp.im). This starter is
the smallest backend that behaves correctly on the other end of that: it
verifies Relay's webhook signature, hands the event to one agent instance per
conversation, marks the message Read, replies once with an idempotency key that
survives redelivery, and stops typing. Replace one function with your model call
and it is your agent.

It is a normal Cloudflare Agents project. `RelayConversationAgent` extends the
SDK's `Agent` class, and everything you already know carries over.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/relaymessenger/relay-agent-starter)

Or scaffold it locally:

```bash
npm create cloudflare@latest -- --template relaymessenger/relay-agent-starter
```

## What it uses from the Agents SDK

Nothing here is a Relay invention. Each row is a stock part of the `agents`
package, doing the job it was built for.

| SDK surface | Where | What it does here |
| --- | --- | --- |
| `class ... extends Agent<Env, State>` | `src/agent.ts` | One instance per conversation |
| `initialState` and `setState()` | `src/agent.ts` | Last event, last reply, cached handle |
| `this.sql` | `src/agent.ts` | The turn ledger, in the instance's own SQLite |
| `this.schedule(delay, "processTurn", payload)` | `src/agent.ts` | The alarm that survives eviction and drives the reply |
| `onStart()` | `src/agent.ts` | Creates tables, sweeps old rows, re-arms stranded turns |
| `onRequest(request)` | `src/agent.ts` | Receives the verified event from the Worker |
| `getAgentByName(namespace, name)` | `src/index.ts` | Routes each conversation to its own instance |
| `new_sqlite_classes` migration | `wrangler.jsonc` | Gives the class its SQLite storage |

The one thing it deliberately does not use is `routeAgentRequest`. See
[Explicit routes only](#write-your-agent) below.

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
  `message.received` events, one per committed message. Events that arrive
  within two seconds of each other are collected into one turn, and the turn
  gets one reply. Without this, a text+photo send draws two replies.
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
- **Groups work, and stay quiet.** In a group the agent replies only when it is
  mentioned, and says nothing otherwise. See [Groups](#groups).

## Groups

In a direct message the agent always replies. In a group it replies **only when
it is mentioned**, and stays silent otherwise.

Relay used to decide this. A group agent was delivered only the messages it had
been *invoked* on, the invocation rode the event, and every reply and typing
call had to carry it back. The server no longer works that way: a group agent
now receives every message in the group, so the decision belongs to the agent,
and this starter makes it for you.

The rule is Relay's own rather than a new one. A mention is the **structured
field** a client attaches to a text part, matched against your agent's handle.
The letters in the text are presentation and carry no authority, so someone
writing `@youragent is pretty good` is talking *about* your agent and it stays
out of it. A mention anywhere in the turn counts, which is what keeps
`@youragent [photo]` working when the send splits into two messages.

To change it, set one var in `wrangler.jsonc`:

```jsonc
"vars": {
  "RELAY_API_ORIGIN": "https://api.relayapp.im",
  "RELAY_GROUP_REPLY_POLICY": "all"   // default: "mentions"
}
```

`all` replies to every group message. Use it for an agent whose job really is to
read the whole room — a transcriber, a moderator — and not otherwise: an agent
that answers everything in a group is the thing the mention rule exists to
prevent. Anything unrecognised reads as `mentions`, so a typo can never be what
turns your agent into one.

A group message the agent stayed out of is recorded as `ignored` in the ledger,
which is terminal. A redelivery does not spend another history read reaching the
same silence.

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

## Already have a Think agent

This starter is for an agent whose job is Relay. If you already run an agent on
[Think](https://developers.cloudflare.com/agents/harnesses/think/), Cloudflare's
chat agent framework, you do not need any of it: Relay is a Chat SDK adapter, so
it becomes one more channel next to Telegram and Slack.

```ts
relay: messengerChannel(
  chatSdkMessenger({
    adapter: createRelayAdapter({ token, webhookSecret }),
    provider: "relay",
    userName: "Relay Agent",
    verifyWebhook: relayWebhookVerifier(webhookSecret),
  }),
),
```

The runnable version is in [`examples/think-channel`](examples/think-channel).

## Docs

Full API reference and guides: [docs.relayapp.im/quickstart](https://docs.relayapp.im/quickstart).

## License

MIT
