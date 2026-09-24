# Tania's Pizza on Relay

The official [Relay Messenger](https://relayapp.im) agent for
[Tania's Pizza](https://www.taniaspizza.com), Royal Oak, MI: **@taniaspizza**.

Customers text it to ask about the menu, prices, hours and delivery, to get
sent straight to the right item on Tania's Toast ordering page, and to request
catering.

It is built from the [Relay Agent Starter](https://github.com/RelayMessenger/Relay-Agent-Starter)
([Cloudflare Think](https://developers.cloudflare.com/agents/harnesses/think/)):

- one durable Think conversation per Relay Chat, fed by signed Relay webhooks;
- read-only tools for the menu, hours and catering availability;
- two Actions with side effects, each idempotent: `reply` (the one Relay
  Message per turn) and `request_catering` (a pending Cal.com booking);
- Workers AI for the model, billed to the Cloudflare account that hosts it.

## Ownership

Relay built and configures this agent. **Tania's owns it**: it deploys to
Tania's own Cloudflare account, Tania's pays for that account's Workers and
Workers AI usage, and the catering calendar and Toast credentials are Tania's.
Relay itself stays free and never proxies or bills inference.

Expected running cost at a single pizzeria's volume: Workers Paid is $5/month.
Workers AI bills per token (`@cf/openai/gpt-oss-120b` is $0.35 / $0.75 per
million input/output tokens on Cloudflare's pricing page); a typical 6-turn
chat is well under a cent.

## What the agent does and doesn't do

| Customer asks | Agent |
| --- | --- |
| Menu, prices, sizes, crusts, toppings | Answers only from the menu tools; never invents items or prices |
| "I want a large deluxe" | Sends the item's Toast link; it opens inside Relay's in-app browser (Safari View Controller), where the customer customizes, pays (card or Apple Pay), picks pickup or delivery, and earns Toast Rewards |
| Hours / open now | Answers from the owner-confirmed hours in `src/business.ts` |
| Delivery | Within about 3 miles; Toast checkout confirms the address; otherwise pickup or the delivery apps |
| Allergies | Shares menu facts (gluten-free crust, vegan cheese/pepperoni) but never promises allergen safety; serious allergies → call the store |
| Beer, wine, tobacco | Never sells, links or recommends them (they need a 21+ ID). Age-restricted categories are invisible to the tools |
| Catering | Offers only open slots from Tania's Cal.com calendar, collects the details, files a **pending** request. Tania's confirms/declines in Cal.com; the agent messages the customer with the decision |
| Complaints, refunds, anything else | Apologizes and gives (248) 288-4774 |

It never places, pays for or confirms an order.

### Why a link, not in-chat checkout

Toast's restaurant self-service API access is read-only; creating orders needs
Toast's Partner program or a custom integration arranged through Tania's Toast
representative. Driving Toast checkout with a bot browser is ruled out: Toast's
`robots.txt` disallows `/*/v3/checkout` and `/*/v3/cart`, the agent would have
to handle card data (PCI DSS), and 3-D Secure challenges need the customer.
Item links keep payment, Apple Pay and Toast Rewards on Toast's own page.

## Configuration

Non-secret settings (`wrangler.jsonc`, per environment):

| Var | Value |
| --- | --- |
| `RELAY_AGENT_HANDLE` | `taniaspizza` |
| `RELAY_API_ORIGIN` | `https://api.staging.relayapp.im` (staging) / `https://api.relayapp.im` (production) |
| `MODEL_ID` | `@cf/openai/gpt-oss-120b` |
| `CAL_EVENT_TYPE_ID` | Cal.com "Catering request" event type ID, from `scripts/setup-catering.mjs` (blank = catering by phone) |
| `TOAST_RESTAURANT_GUID` | Tania's Toast restaurant GUID (blank = bundled menu snapshot) |

Secrets (`npx wrangler secret put NAME --env <env>`):

| Secret | Required | From |
| --- | --- | --- |
| `RELAY_AGENT_TOKEN` | yes | Relay Console → @taniaspizza → Agent Tokens (shown once) |
| `RELAY_WEBHOOK_SECRET` | yes | `signing_secret` from creating the webhook subscription (shown once) |
| `CAL_API_KEY` | for online catering | Tania's Cal.com → Settings → Developer → API keys |
| `CAL_WEBHOOK_SECRET` | for catering decisions | the secret you pass to `scripts/setup-catering.mjs` |
| `TOAST_CLIENT_ID`, `TOAST_CLIENT_SECRET` | for a live menu | Toast Web → Integrations → Toast API access (Standard, read-only, needs `menus:read`) |

`GET /healthz` reports missing required settings and which integrations are
live, e.g. `{"ok":true,"integrations":{"menu":"snapshot","catering":"phone","cateringWebhook":false}}`.

### Menu

`data/menu.snapshot.json` is Tania's full public Toast menu with every item's
direct link, captured by `scripts/snapshot-menu.mjs` (Playwright; read-only,
never touches cart or checkout). Refresh it whenever the menu changes:

```sh
npx -y -p playwright@latest playwright install chromium   # once
npx -y -p playwright@latest node scripts/snapshot-menu.mjs
```

With Toast Standard API access configured, the agent reads live prices from
Toast's menus v2 API (cached 5 minutes) and keeps the snapshot's item links by
GUID; any Toast failure falls back to the snapshot.

### Catering

Catering uses a Cal.com event type that enforces owner confirmation on every
request, a per-day cap, minimum notice and the intake questions. Create it
(and the decision webhook) in Tania's Cal.com account:

```sh
CAL_API_KEY=cal_live_... node scripts/setup-catering.mjs \
  --webhook-url https://<worker-host>/webhooks/cal \
  --webhook-secret "$(openssl rand -hex 32)" \
  --min-notice-hours 48 --max-per-day 2 --apply
```

Without `--apply` it prints the exact requests and changes nothing. Set the
printed event type ID as `CAL_EVENT_TYPE_ID` and the webhook secret as
`CAL_WEBHOOK_SECRET`. The defaults (48 hours notice, 2 per day) are
placeholders until Tania's confirms its real rules.

## Launch runbook

1. **Accounts (Tania's).** Cloudflare account on Workers Paid with Workers AI;
   Cal.com account for catering; optionally Toast Standard API access.
2. **Relay (Tania's organization in Relay Console).** Create the agent with
   handle `taniaspizza`, name "Tania's Pizza", logo, about text and greeting;
   apply for the verified badge; create an Agent Token.
3. **Deploy.** `npm ci`, set the secrets above, then `npm run deploy:staging`
   (or production). Check `/healthz`.
4. **Webhook.** Create the Relay webhook subscription once and store its
   `signing_secret` as `RELAY_WEBHOOK_SECRET`:

   ```sh
   curl -fsS -X POST "$RELAY_API_ORIGIN/v1/webhook-subscriptions" \
     -H "Authorization: Bearer $RELAY_AGENT_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"target_url":"https://<worker-host>/webhooks/relay","subscribed_events":["message.received"]}'
   ```

5. **Catering.** Run `scripts/setup-catering.mjs` as above.
6. **Promote.** Share `https://relayapp.im/@taniaspizza` and its QR code
   (Relay's share sheet) on boxes, the counter, Instagram and Facebook. New
   customers are sent to the App Store and land in this chat after install.

## Delivery guarantees

Inherited from the starter: the Worker verifies Standard Webhooks over the
exact raw body before routing; each Chat gets one durable Think conversation;
the turn ends when the single `reply` Action commits. The reply's Relay
idempotency key is `tanias-pizza-agent:<inbound-message-id>`, so a retried
Action replays the same Message instead of sending a second one. Catering
decisions use `tanias-pizza-agent:catering:<booking-uid>:<status>`, so Cal.com
retries are safe. Each turn is capped at 6 model steps, and each person at 12
messages a minute (Workers Rate Limiting), bounding Tania's inference bill.
If a turn completes without calling `reply`, the customer gets a short
fallback (order link and phone) under the same reply idempotency key, so they
never hear silence and never get two answers.

## Validate

```sh
npm run types:check
npm run check
npm run test:unit      # hours, menu, catering, Toast, prompt, contracts, deploy guard
npm run test:workerd   # signed webhooks, multi-step tool turns, Cal.com webhook, recovery
npm run test:installed
npm run dry-run
npm run eval           # live-model conversations; needs a model endpoint (see scripts/eval.mjs)
```

## Guarded deployments

`deploy:staging` requires environment `staging`, branch `staging`, and the
`tanias-pizza-agent-staging` Worker. `deploy:production` requires environment
`production`, branch `main`, and the `tanias-pizza-agent` Worker. Both fetch
the exact branch from `origin` and refuse to deploy a dirty or stale tree. A
bare `wrangler deploy` targets the non-production
`tanias-pizza-agent-development`.

## Contract lock

Tested against Relay API `v1`, webhook payload version `2026-08-30`, and the
unchanged OpenAPI fixture under [`contracts/`](contracts/) (SHA-256
`9f3e662a13cd0e6b16a52fba4b53c75fe5817d134dcf152e00b054699c37839c`), with
`@relaymessenger/chat-sdk-adapter@0.3.2-staging.0` and
`@relaymessenger/sdk@0.3.1-staging.2`.
