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

## Move the existing staging webhook

This Think starter intentionally uses a new
`relay-think-agent-starter-staging` Worker instead of the pre-Think
`relay-agent-starter-staging`. Do not deploy this runtime over the old Durable
Object namespace.

The migration must move the existing Relay subscription. Do **not** `POST` a
second subscription. Relay v1 updates a subscription with
`PUT /v1/webhook-subscriptions/{subscriptionId}` and the fields `target_url`,
`subscribed_events`, and `is_active`. That update does not return a new
`signing_secret`; the new Worker must use the existing subscription's saved
secret.

Deploy the new Worker, set its existing secrets interactively, and require a
healthy response before changing the subscription:

```sh
npx wrangler secret put RELAY_AGENT_TOKEN --env staging
npx wrangler secret put RELAY_WEBHOOK_SECRET --env staging
npm run deploy:staging
curl -fsS \
  "https://relay-think-agent-starter-staging.<your-subdomain>.workers.dev/healthz"
```

Keep the old Worker deployed. Set these migration variables, then list the
subscriptions and identify the one whose `target_url` is `OLD_WEBHOOK_URL`:

```sh
export RELAY_API_ORIGIN="https://api.staging.relayapp.im"
export OLD_WEBHOOK_URL="https://relay-agent-starter-staging.<your-subdomain>.workers.dev/webhooks/relay"
export NEW_WEBHOOK_URL="https://relay-think-agent-starter-staging.<your-subdomain>.workers.dev/webhooks/relay"
export SUBSCRIPTION_ID="<existing-subscription-id>"

curl -fsS \
  "$RELAY_API_ORIGIN/v1/webhook-subscriptions" \
  -H "Authorization: Bearer $RELAY_AGENT_TOKEN"
```

Confirm there is exactly one matching subscription and preserve its complete
settings. If there is none, this is a fresh registration rather than a
migration; follow the Relay webhook guide. If there is more than one, stop and
resolve the duplicates before continuing.

Relay's locked API does not promise that events are buffered while
`is_active` is false. Establish an auditable sender-side maintenance boundary
before deactivation and keep inbound senders paused until the new Worker passes
its canary. Snapshot all pages of `GET /v1/chats` and all pages of
`GET /v1/chats/{chatId}/messages`; retain the IDs where `is_from_me` is false.
If senders cannot be paused and that source-of-truth snapshot cannot be
repeated, do not use this drain-first procedure: it would create an
unverifiable event window.

With senders paused, stop ingress to the old Worker by deactivating the same
subscription. Because the update replaces settings, send all three fields:

```sh
curl -fsS -X PUT \
  "$RELAY_API_ORIGIN/v1/webhook-subscriptions/$SUBSCRIPTION_ID" \
  -H "Authorization: Bearer $RELAY_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON
{
  "target_url": "$OLD_WEBHOOK_URL",
  "subscribed_events": ["message.received"],
  "is_active": false
}
JSON
```

Read that subscription back and record the response proving the same `id`,
the old `target_url`, and `is_active: false`:

```sh
curl -fsS \
  "$RELAY_API_ORIGIN/v1/webhook-subscriptions/$SUBSCRIPTION_ID" \
  -H "Authorization: Bearer $RELAY_AGENT_TOKEN"
```

Now drain the old Worker's durable inbox and scheduled retries. Prove, from the
old runtime's authoritative queue/retry inspection, that pending inbox work,
scheduled retries, and active webhook requests are all zero and remain zero
across two observations after its last accepted request. Sampled HTTP logs are
not drain proof. Repeat the Relay Chat/Message snapshot and verify that no new
inbound Message ID appeared after the maintenance boundary. If the old runtime
cannot provide those counters, or an inbound ID appeared, stop and account for
it; do not claim a completed drain.

After that proof, cut over by updating and reactivating the **same**
subscription:

```sh
curl -fsS -X PUT \
  "$RELAY_API_ORIGIN/v1/webhook-subscriptions/$SUBSCRIPTION_ID" \
  -H "Authorization: Bearer $RELAY_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON
{
  "target_url": "$NEW_WEBHOOK_URL",
  "subscribed_events": ["message.received"],
  "is_active": true
}
JSON
```

Read it back and save the response proving the same `id`, the new `target_url`,
and `is_active: true`. Send one uniquely identifiable Message while the sender
pause is still controlled; prove the new Worker accepted that webhook and
committed exactly one reply, and prove the old Worker accepted none. Only then
release senders.

Keep the old Worker intact for the rollback window. Before cutover, rollback is
the same `PUT` with `OLD_WEBHOOK_URL` and `is_active: true`. After cutover,
pause senders again, deactivate the same subscription at `NEW_WEBHOOK_URL`,
drain and prove the new Worker exactly as above, then update the same
subscription to `OLD_WEBHOOK_URL` with `is_active: true` and run a canary.
Never create a second subscription for rollback. Retire the old Worker only
after the rollback window, the saved drain evidence, and the old Worker's
continued zero-ingress observation all pass.

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

The suites cover the contract lock, dependency pins, deployment isolation and
non-inherited Wrangler bindings, migration operation, model seam, signed direct
and mentioned-group model/Action turns, unmentioned-group gating, stale Action
recovery without duplicate delivery, and a clean registry-installed template.

## Guarded deployments

Deployment is intentionally manual and branch guarded:

```sh
git switch staging
git pull --ff-only origin staging
npm run test:all
npm run deploy:staging
```

Production uses the explicit production environment from an exact reviewed
`main`:

```sh
git switch main
git pull --ff-only origin main
npm run test:all
npm run deploy:production
```

`deploy:staging` requires environment `staging`, branch `staging`, and the
`relay-think-agent-starter-staging` Worker. `deploy:production` requires
environment `production`, branch `main`, and the
`relay-think-agent-starter` Worker. Both refuse a dirty tree or a local commit
that is not exactly its `origin` branch.

Wrangler bindings and vars do not inherit into named environments, so the
default, staging, and production configurations each declare their complete
bindings. The default target is the non-production
`relay-think-agent-starter-development`; therefore a bare `wrangler deploy`
cannot overwrite `relay-think-agent-starter`. There is deliberately no bare
`deploy` package script. The repository contains no automatic deploy workflow.
Run neither guarded command without your own review and credentials.

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
