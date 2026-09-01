# Relay Agent Starter

Minimal, forkable [Cloudflare Think](https://developers.cloudflare.com/agents/harnesses/think/)
agent for [Relay Messenger](https://relayapp.im).

It uses:

- `@cloudflare/think@0.17.0` and native durable recovery;
- `chatSdkMessenger()` with Relay's official Chat SDK adapter;
- one root Think conversation per Relay Chat;
- signed Standard Webhooks ingress at `POST /webhooks/relay`;
- direct-message replies and canonical structured mentions in groups;
- one buffered, idempotent Relay Message per model turn.

There are no application-owned event or send tables, polling loops, outbound
WebSockets, partial Message bubbles, Message effects, or copied Relay client.
Think owns conversation memory, fibers, recovery, and its Action ledger. The
Relay packages own webhook verification and API calls.

## How a Message moves

1. Relay sends a signed `message.received` webhook.
2. `@relaymessenger/chat-sdk-adapter` verifies the exact raw body before parsing.
3. After verification, the Worker routes the Chat UUID to one durable root
   Think conversation. The adapter verifies the forwarded raw body again.
4. Direct Messages start turns. Group Messages start turns only when a text
   part's structured `mention` matches the receiving Chat's `owner_handle`.
5. Think runs the model in a recoverable fiber. The model must call the native
   `reply` Action once.
6. The Action commits one complete Message through
   `@relaymessenger/sdk@0.3.0-staging.4`. Its stable idempotency key is derived
   from the inbound Relay Message ID.

Think's streamed response surface is intentionally limited to zero visible
characters. Relay therefore never receives a draft or a second fallback
Message; only the complete Action payload is committed.

If an isolate dies after Relay commits the Message but before Think settles the
Action ledger row, Think can reclaim that pending Action immediately. The retry
uses the same Relay idempotency key and body, so Relay replays the existing
Message instead of creating a duplicate.

## Prerequisites

- Node.js 22.22.3 or newer
- a Cloudflare account with Workers AI
- a staging agent and Agent Token from Relay Console

The adapter release used by this staging branch is
`@relaymessenger/chat-sdk-adapter@0.3.0-staging.0`, published to npm with
provenance from `Relay-Chat-SDK`
`469a9c1aafed7e31cdc4e8581df4dd6a34c94e17`. Its runtime implementation was
independently audited at `f90e312aeecefa9c929398a56be77441e8c2137c`.

## Local setup

Install the exact registry artifacts from `package-lock.json`:

```sh
npm ci
```

Copy the local secret template:

```sh
cp .dev.vars.example .dev.vars
```

Set both values in `.dev.vars`:

```dotenv
RELAY_AGENT_TOKEN=replace-with-staging-agent-token
RELAY_WEBHOOK_SECRET=whsec_replace-with-staging-webhook-secret
```

The non-secret staging settings are in `wrangler.jsonc`:

```text
RELAY_API_ORIGIN=https://api.staging.relayapp.im
RELAY_AGENT_HANDLE=your_agent_handle
MODEL_ID=@cf/openai/gpt-oss-120b
```

Change `RELAY_AGENT_HANDLE` to the agent's Relay Handle. Start the Worker:

```sh
npm run dev
```

For a public local webhook URL, use your normal HTTPS tunnel and register its
exact `/webhooks/relay` path.

## Register the staging webhook

This Think starter intentionally uses the new
`relay-think-agent-starter-staging` Worker name. If you deployed the pre-Think
`relay-agent-starter-staging`, leave it running until its durable inbox and
scheduled retries are empty. Then move the Relay Webhook subscription to the
new URL and retire the old Worker. Do not deploy this runtime over the old
Durable Object namespace.

After a guarded staging deployment, register exactly the deployed HTTPS URL:

```sh
curl -sS -X POST \
  "https://api.staging.relayapp.im/v1/webhook-subscriptions" \
  -H "Authorization: Bearer $RELAY_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target_url": "https://relay-think-agent-starter-staging.<your-subdomain>.workers.dev/webhooks/relay",
    "subscribed_events": ["message.received"]
  }'
```

Save the one-time `signing_secret` from the response as
`RELAY_WEBHOOK_SECRET`. Do not put either secret in source, shell history, or
Wrangler vars.

Set Cloudflare secrets interactively:

```sh
npx wrangler secret put RELAY_AGENT_TOKEN --env staging
npx wrangler secret put RELAY_WEBHOOK_SECRET --env staging
```

## Replace the model

[`src/model.ts`](src/model.ts) is the model seam:

```ts
export function starterModel(env) {
  return env.MODEL_ID;
}
```

Return another Workers AI model ID, or replace the function with any AI SDK
`LanguageModel`. Relay ingress, group routing, recovery, and canonical delivery
do not need to change.

Change the short system prompt in [`src/agent.ts`](src/agent.ts) for product
behavior. Keep the instruction to call `reply` once unless you also replace the
delivery design.

## Validate

```sh
npm run types:check
npm run check
npm run test:unit
npm run test:workerd
npm run test:installed
npm run dry-run
```

The suites cover the contract lock, dependency pins, model seam, signed direct
and mentioned-group model/Action turns, unmentioned-group gating, stale Action
recovery without duplicate delivery, and a clean registry-installed template.

## Guarded staging deploy example

Deployment is intentionally manual and branch guarded:

```sh
git switch staging
git pull --ff-only origin staging
npm run test:all
npm run deploy:staging
```

`deploy:staging` refuses a dirty tree, any branch other than `staging`, or a
local commit that is not exactly `origin/staging`. The repository contains no
automatic deploy workflow. Run neither this command nor any production command
without your own review and credentials.

## Contract lock

This revision is tested against:

- Relay Server `9b4d5bb32cc749c6fd271969948c385300d404d6`
- Relay Chat SDK `f90e312aeecefa9c929398a56be77441e8c2137c`
- `@relaymessenger/chat-sdk-adapter@0.3.0-staging.0` npm integrity
  `sha512-IuWa2VVv3hKArnQPO6SV4Ntq+/9pp7eEIzWgVSBgg6E5pWpVV+hxTFCwfwwBJvmhYjzVgOFxrrk6haL05ANquw==`
- OpenAPI SHA-256
  `f62f431fc0daa48500926bf87753f81c3fdda25ab463b130ca97f2896367e0a5`
- Relay API `v1`
- Relay webhook payload version `2026-08-30`

The unchanged OpenAPI fixture is under [`contracts/`](contracts/).

## Documentation

- [Relay developer docs](https://docs.relayapp.im)
- [Relay + Cloudflare integration](https://docs.relayapp.im/integrations/cloudflare)
- [Relay webhook guide](https://docs.relayapp.im/guides/webhooks)
- [Cloudflare Think](https://developers.cloudflare.com/agents/harnesses/think/)
- [Think Messengers](https://developers.cloudflare.com/agents/harnesses/think/messengers/)
- [Think durable recovery](https://developers.cloudflare.com/agents/harnesses/think/recovery/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
