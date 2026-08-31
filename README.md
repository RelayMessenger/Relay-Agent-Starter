# Relay Agent Starter

Build a Relay agent on Cloudflare Workers and Durable Objects.

The starter receives signed webhooks, processes each event durably, and replies
through Relay API v1:

- Standard Webhooks in
- one durable inbox row per `event_id`
- webhook `2xx` responses that acknowledge transport only
- Read only after durable processing actually begins
- Read and typing state through Relay v1
- idempotent REST replies through Chats and Messages

## Delivery flow

1. Relay sends `message.received` to `POST /webhooks/relay`.
2. The Worker verifies the Standard Webhooks signature over the raw body.
3. The Chat's Durable Object commits the complete event and `event_id`.
4. The Durable Object creates alarm-backed work.
5. Only then does the Worker return `2xx`. This acknowledges durable transport;
   it is not a Read receipt.
6. When scheduled processing begins and decides to handle the message, it marks
   the Chat Read, starts typing, and persists the reply text before its first
   outbound message request.
7. It sends the persisted, idempotent reply through
   `POST /v1/chats/{chatId}/messages`.
8. It stops typing after the send or any failure.

Subscribe this starter to `message.received`, the event it processes. Add a
checked handler before subscribing it to another event type.
It is pinned to OpenAPI SHA-256
`8561112386f0fe92e125f2d93ac93c5b70a960722426cc1ee8f23bc260b2c8a5`.

## Setup

Create an agent in Relay Console and copy its Agent Token. Relay shows the token
once.

```sh
npm install
npx wrangler secret put RELAY_AGENT_TOKEN
```

Register the deployed Worker URL:

```sh
curl -sS -X POST "https://api.staging.relayapp.im/v1/webhook-subscriptions" \
  -H "Authorization: Bearer $RELAY_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target_url": "https://relay-agent-starter-staging.<your-subdomain>.workers.dev/webhooks/relay",
    "subscribed_events": ["message.received"]
  }'
```

Save the one-time `signing_secret`:

```sh
npx wrangler secret put RELAY_WEBHOOK_SECRET
```

Then run:

```sh
npm run dev
```

`GET /healthz` returns `{"ok":true}`.

Local development uses the isolated staging Worker configuration by default:
the staging API origin, staging Agent Token, staging Webhook secret, and
staging Durable Object namespace. Production has a separate environment.

## Write your agent

Replace `generateReply` in [`src/agent.ts`](src/agent.ts). The rest of the
file is receive, deduplication, retry, and send plumbing.

The example implementation reads:

- text from `part.value`
- attachments from `media` parts
- structured group mentions from `part.mention`
- the authenticated agent Handle from `data.chat.owner_handle`

Only Relay's structured mention field invokes the agent in a group.

## Groups

Direct messages are answered by default. Group messages are answered only when
they contain a structured mention of this agent.

To let an agent intentionally answer every group message:

```jsonc
"vars": {
  "RELAY_API_ORIGIN": "https://api.relayapp.im",
  "RELAY_GROUP_REPLY_POLICY": "all"
}
```

## Validate

```sh
npm run types
npm run check
npm test
npm run dry-run
```

The tests prove signature verification, transport-only `2xx` acceptance,
complete-event durability, `event_id` deduplication, group mentions,
idempotency, pinned API and webhook versions, and exact v1 request paths and
bodies. They also guard hand-authored product files against accidental
major-version-three paths. The dry run builds locally and does not publish.

## Layout

| File | Purpose |
| --- | --- |
| `src/index.ts` | Public webhook and health routes |
| `src/agent.ts` | Durable inbox, retries, processing, and model hook |
| `src/relay.ts` | Current webhook types, Standard Webhooks, and REST client |
| `src/env.ts` | Worker bindings |

Full docs: <https://docs.relayapp.im>
