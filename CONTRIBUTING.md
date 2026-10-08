# Maintaining the Relay Agent Starter

These notes are for Relay maintainers who run the starter's own Workers. A
developer building an agent follows [README.md](README.md).

## Guarded deployments

Relay's own deployment of this starter is manual and branch guarded, from an
exact reviewed `main`:

```sh
git switch main
git pull --ff-only origin main
npm run test:all
npm run deploy:production
```

`deploy:production` requires
environment `production`, branch `main`, and the
`relay-think-agent-starter` Worker. It disables interactive Git prompts, fetch
the exact `refs/heads/<branch>` from the configured `origin` into an isolated
verification ref, suppress fetch diagnostics that could expose a credentialed
remote URL, and compare the fetched commit to one final clean branch/HEAD
snapshot immediately before Wrangler starts. Mutable or stale local
`origin/*` refs are never trusted.

Wrangler bindings and vars do not inherit into named environments, so the
default and production configurations each declare their complete
bindings. The default target is the non-production
`relay-think-agent-starter-development`; therefore a bare `wrangler deploy`
cannot overwrite `relay-think-agent-starter`. `npm run deploy` is the unguarded
production deploy for a developer's own copy. The repository contains no
automatic deploy workflow.

## Contract lock

This revision is tested against:

- Relay Server `3972ba8aaaae5b958985464f21bfbfbd32f688fb`
- `@relaymessenger/think` (caret range in `package.json`, exact version in
  `package-lock.json`)
- OpenAPI SHA-256
  `c0214d4a2b302b3c9dbbc4d5cb8fb07808907d22feace58025ab7377d423515b`
- Relay API `v1`
- Relay webhook payload version `2026-08-30`

The unchanged OpenAPI fixture is under [`contracts/`](contracts/).

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
Action ledger key `message:<inbound-message-id>:<n>` deduplicates send retries
inside one state; it is not a cross-Worker event lock. The cross-Worker boundary
is Relay's authenticated Message idempotency key
`relay-agent:<inbound-message-id>:<n>`, where `<n>` is the send's place in the
turn, which `@relaymessenger/think` 0.1.4 and later use for every `send`.
Starters on `@relaymessenger/think` 0.1.3 or earlier used
`relay-agent:<inbound-message-id>`, and starters before `@relaymessenger/think`
used `relay-agent-starter:<inbound-message-id>`, so an overlap with one of them
is not deduplicated. If both Workers send the same body, Relay replays the
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
