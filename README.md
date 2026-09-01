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

Relay v1 exposes subscription settings, but no pending-delivery queue, delivery
attempt list, queue depth, or maximum retry horizon. A subscription read, Chat
snapshot, quiet log, or zero application work count therefore cannot prove that
Relay has no older delivery left for the old URL. Do not deactivate the
subscription and call the old Worker drained; `is_active: false` has no
contractual buffering guarantee and does not account for already-pending
deliveries.

The safest upgrade preserves the existing Worker URL, Durable Object identity,
and event state. Use that path only when the new code and migrations are
compatible with the old namespace. The pre-Think namespace is not compatible
with this starter, so moving to the new Worker requires an idempotent overlap.

During overlap, a Relay event may execute in both durable states. Think's
Action ledger key `message:<inbound-message-id>` deduplicates reply retries
inside one state; it is not a cross-Worker event lock. The cross-Worker boundary
is Relay's authenticated Message idempotency key
`relay-agent-starter:<inbound-message-id>`. This starter has no other
user-visible Action. If both Workers send the same body, Relay replays the
existing Message. If their bodies differ, Relay returns an idempotency conflict
instead of committing a second Message. The winning Message remains canonical,
but the losing Action can remain failed and must be observed.

Before moving the target, verify that the old runtime:

- stays online with its Durable Objects, schedules, secrets, and old URL;
- uses the same Agent Token and saved webhook signing secret;
- derives the exact same outbound idempotency key from the inbound Relay
  Message ID; and
- has no non-idempotent side effect outside that Relay Message send.

If any condition is false, do not cut over. First ship and audit a compatibility
release on the old runtime that adds these boundaries without changing its
state identity, or keep the old subscription and Worker unchanged.

Deploy the new Worker, set the existing secrets interactively, and require a
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

Keep the subscription active and move the **same** subscription in one update.
Because the operation replaces settings, send all three fields:

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
and `is_active: true`. Send one uniquely identifiable Message and verify the
new Worker can accept it and commit a reply. That canary verifies the new path;
it does not prove that the old path has no pending delivery.

Keep the old URL, runtime, and all old Durable Object state available for at
least Relay's documented maximum webhook retry horizon measured from the
successful `PUT`. The locked v1 contract does not publish that horizon. Unless
Relay supplies an authoritative horizon for this subscription, retain the old
runtime indefinitely; do not infer one from logs or counters and do not claim a
drained queue. Retirement after a supplied horizon is a retention policy, not
proof that a queue was empty.

Rollback uses the same active subscription and the same three-field `PUT`, with
`target_url` set to `OLD_WEBHOOK_URL` and `is_active: true`. Do not deactivate
or create a second subscription. Because deliveries already pending for the new
URL are equally unknowable, retain the new Worker and its state for the same
documented horizon after rollback. The identical Message idempotency boundary
must remain enabled on both sides for the entire overlap.

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
`relay-think-agent-starter` Worker. Both disable interactive Git prompts, fetch
the exact `refs/heads/<branch>` from the configured `origin` into an isolated
verification ref, suppress fetch diagnostics that could expose a credentialed
remote URL, and compare the fetched commit to one final clean branch/HEAD
snapshot immediately before Wrangler starts. Mutable or stale local
`origin/*` refs are never trusted.

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
