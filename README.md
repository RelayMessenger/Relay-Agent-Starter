# Relay Agent Starter

Minimal, forkable [Cloudflare Think](https://developers.cloudflare.com/agents/harnesses/think/)
agent for [Relay Messenger](https://relayapp.im).

It uses:

- `@cloudflare/think@0.20.1` and native durable recovery;
- [`@relaymessenger/think`](https://www.npmjs.com/package/@relaymessenger/think)
  for every Relay Action: `send` (text, buttons, selection, link, place,
  payment, rich card, carousel), `react`, `request_location`,
  `read_location`, `find_agents`, `payment_request`, `group`,
  `share_contact_card`, and `stay_silent`;
- the typing indicator for the whole model turn;
- `chatSdkMessenger()` with Relay's official Chat SDK adapter;
- one root Think conversation per Relay Chat;
- signed Standard Webhooks ingress at `POST /webhooks/relay`;
- direct-message replies and canonical structured mentions in groups;
- a person's swipe-reply reaches the model with the Message it answers (its
  sender, the swiped part and its words), read once with `fetchMessage`;
- a person's selection, card suggestion, or location share reaches the model
  as data beside their words;
- one or several Messages per turn, as the model decides, each one its own
  idempotent `send`.

There are no application-owned event or send tables, polling loops, outbound
WebSockets, partial Message bubbles, or copied Relay client.
Think owns conversation memory, fibers, recovery, and its Action ledger. The
Relay packages own webhook verification and API calls.

## How a Message moves

1. Relay sends a signed `message.received` webhook.
2. `@relaymessenger/chat-sdk-adapter` verifies the exact raw body before parsing.
3. After verification, the Worker routes the Chat UUID to one durable root
   Think conversation. The adapter verifies the forwarded raw body again.
4. Direct Messages start turns. Group Messages start turns only when a text
   part's structured `mention` matches the receiving Chat's `owner_handle`.
5. The agent marks the Chat read and shows the typing indicator.
6. Think runs the model in a recoverable fiber. The model answers through
   Relay Actions: `send` once or several times in a row, or `react`, or
   `stay_silent`. `stopWhen: [relayTurnSettled, stepCountIs(RELAY_TURN_MAX_STEPS)]`
   ends the turn when the model calls no tool or calls `stay_silent`, and caps
   a runaway turn.
7. Each `send` commits one Message through `@relaymessenger/sdk`. Its stable
   idempotency key is derived from the inbound Relay Message ID and the send's
   place in the turn (`:1`, `:2`, ...). The typing indicator comes down when
   the turn ends.

Only `send` makes Messages. The messenger's `delivery: RELAY_MESSENGER_DELIVERY`
keeps Think from posting the model's own reply text, so Relay never receives a
draft or a fallback Message; only complete Action payloads are committed.

If an isolate dies after Relay commits the Message but before Think settles the
Action ledger row, Think can reclaim that pending Action immediately. The retry
uses the same Relay idempotency key and body, so Relay replays the existing
Message instead of creating a duplicate. After a restart the send count starts
again at 1, so a send that already went is not sent twice.

## Prerequisites

- Node.js 22.22.3 or newer
- a Cloudflare account with Workers AI
- an agent and its Agent Token from [Relay Console](https://console.relayapp.im)

The Relay packages are published npm releases: `@relaymessenger/think` and
`@relaymessenger/chat-sdk-adapter` take caret ranges, and
`@relaymessenger/think` brings `@relaymessenger/sdk`. `package-lock.json`
holds the exact versions.

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
RELAY_AGENT_TOKEN=replace-with-agent-token
RELAY_WEBHOOK_SECRET=whsec_replace-with-webhook-secret
```

The non-secret settings are in `wrangler.jsonc`:

```text
RELAY_API_ORIGIN=https://api.relayapp.im
RELAY_AGENT_HANDLE=your_agent_handle
MODEL_ID=@cf/openai/gpt-oss-120b
```

Change `RELAY_AGENT_HANDLE` to the agent's Relay Handle. Start the Worker:

```sh
npm run dev
```

For a public local webhook URL, use your normal HTTPS tunnel and register its
exact `/webhooks/relay` path.

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
behavior. Keep the instruction to answer through the Relay tools and keep
`delivery: RELAY_MESSENGER_DELIVERY` unless you also replace the delivery
design: with Think's default delivery, the model's own text becomes an extra
Message.

## Add your own tools

`getActions()` in [`src/agent.ts`](src/agent.ts) returns
`relayActions(...)`. Spread your own Think Actions beside them. Pass
`media: { image, voiceMemo }` to `relayActions` to let `send` make images and
voice memos with your own models, and `disable: [...]` to leave Actions out.
`start_call` is off (`voice: false`) because the starter has no voice model.

## Validate

```sh
npm run types:check
npm run check
npm run test:unit
npm run test:workerd
npm run test:installed
npm run dry-run
```

The suites cover the contract lock, published dependency ranges, deployment
isolation and non-inherited Wrangler bindings, migration operation, model
seam, signed direct and mentioned-group turns (typing, Read, model, `send`),
two `send` calls in one turn making two Messages with no trailing model text,
unmentioned-group gating, stale Action recovery without duplicate delivery,
and a clean registry-installed template.

## Deploy

Store the Agent Token and webhook signing secret as Worker secrets, then deploy
to production:

```sh
npx wrangler secret put RELAY_AGENT_TOKEN --env production
npx wrangler secret put RELAY_WEBHOOK_SECRET --env production
npm run deploy
```

Create a webhook subscription for the deployed Worker's `/webhooks/relay` URL.
The production settings in `wrangler.jsonc` name `https://api.relayapp.im`.

## Documentation

- [Relay developer docs](https://docs.relayapp.im)
- [Relay + Cloudflare integration](https://docs.relayapp.im/integrations/cloudflare)
- [Relay webhook guide](https://docs.relayapp.im/guides/webhooks)
- [Cloudflare Think](https://developers.cloudflare.com/agents/harnesses/think/)
- [Think Messengers](https://developers.cloudflare.com/agents/harnesses/think/messengers/)
- [Think durable recovery](https://developers.cloudflare.com/agents/harnesses/think/recovery/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
