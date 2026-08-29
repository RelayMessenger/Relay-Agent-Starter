# Relay Agent Starter

A webhook-first Relay agent on Cloudflare Workers and Durable Objects.

This repository follows the current Relay v1 developer contract:

- Standard Webhooks in
- one durable inbox row per `event_id`
- processing only after the webhook is accepted
- idempotent REST replies through Chats and Messages

## Delivery flow

1. Relay sends `message.received` to `POST /webhooks/relay`.
2. The Worker verifies the Standard Webhooks signature over the raw body.
3. The Chat's Durable Object commits the complete event and `event_id`.
4. The Durable Object creates alarm-backed work.
5. Only then does the Worker return `2xx`.
6. Processing marks the Chat Read and persists the reply text before its first
   outbound request.
7. It sends the persisted, idempotent reply through
   `POST /v1/chats/{chatId}/messages`.

Cloudflare Workers remain webhook-only because they do not reliably own a
single long-lived outbound WebSocket. Relay's optional WebSocket transport is
for always-on consumers that can durably enqueue every event before cumulative
ACK.

## Setup

Create an Agent Contact and copy its Agent Token. Relay shows the token once.

```sh
npm install
npx wrangler secret put RELAY_AGENT_TOKEN
```

Register the deployed Worker URL:

```sh
curl -sS -X POST "https://api.relayapp.im/v1/webhook-subscriptions" \
  -H "Authorization: Bearer $RELAY_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target_url": "https://relay-agent.<your-subdomain>.workers.dev/webhooks/relay",
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

## Write your agent

Replace `generateReply` in [`src/agent.ts`](src/agent.ts). The rest of the
file is receive, deduplication, retry, and send plumbing.

The example implementation reads:

- text from `part.value`
- attachments from `media` parts
- structured group mentions from `part.mention`
- the authenticated agent Handle from `data.chat.owner_handle`

It does not treat visible `@name` text as a mention unless Relay supplied the
structured mention field.

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
npx wrangler deploy --dry-run
```

The tests prove signature verification, complete-event durable acceptance,
`event_id` deduplication, group mentions, idempotency, and exact v1 request
paths and bodies. The dry run builds locally and does not publish.

## Layout

| File | Purpose |
| --- | --- |
| `src/index.ts` | Public webhook and health routes |
| `src/agent.ts` | Durable inbox, retries, processing, and model hook |
| `src/relay.ts` | Current webhook types, Standard Webhooks, and REST client |
| `src/env.ts` | Worker bindings |

Full docs: <https://docs.relayapp.im>
