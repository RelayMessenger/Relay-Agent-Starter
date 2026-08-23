# Relay as a channel in Cloudflare's Think harness

[Think](https://developers.cloudflare.com/agents/harnesses/think/) is Cloudflare's opinionated chat agent framework. It already talks to Telegram and Slack through Chat SDK adapters. Relay is another one, so a Think agent can answer Relay conversations with the same three lines Cloudflare's own Telegram channel takes.

Use this when you already have a Think agent and want Relay to be one of its channels. If you want an agent whose only job is Relay, the [starter in the repository root](../..) is smaller: it has no model framework in it at all.

## What it is

One file, `src/index.ts`. A `Think` subclass that declares Relay as a messenger channel, and a Worker entry that forwards exactly one path to it.

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

The channel id names the route. Called `relay`, it serves `POST /messengers/relay/webhook`, which is the URL you register with Relay.

On Workers, `@relaymessenger/chat-sdk-adapter` must be `0.2.1` or newer.

## Deploy it

1. Install and deploy.

   ```sh
   npm install
   npx wrangler deploy
   ```

2. Create an agent in the Relay app and copy its Agent Token. Relay shows it once.

   ```sh
   npx wrangler secret put RELAY_AGENT_TOKEN
   ```

3. Register this Worker's webhook URL with Relay. The response carries `signing_secret`, also shown once.

   ```sh
   curl -X POST https://api.relayapp.im/v1/webhooks \
     -H "Authorization: Bearer $RELAY_AGENT_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"url":"https://<your-worker>.workers.dev/messengers/relay/webhook","events":["message.received"]}'
   ```

   ```sh
   npx wrangler secret put RELAY_WEBHOOK_SECRET
   ```

4. Message the agent in Relay.

## What Think does for you

| Think handles | How |
| --- | --- |
| The webhook route | The channel id becomes `/messengers/<id>/webhook`. No routing code of your own. |
| Refusing forged deliveries | `verifyWebhook` runs before anything is parsed. Ours checks Relay's Standard Webhooks signature over the raw body. |
| One conversation per thread | Think fans out to a sub-agent per Chat SDK thread, and a Relay thread is one conversation. |
| Surviving a restart mid-reply | The reply runs in a durable fiber. Think replays it, or posts its interruption message rather than risking a duplicate. |
| Bursts | The Chat SDK debounces a run of messages into one turn. |

## What Relay's shape means here

A streamed Think turn commits exactly one canonical Relay message. The adapter buffers the stream and posts once rather than editing a draft bubble into place, so nothing partial ever reaches a person.

In a group, a reply is scoped to the single-use invocation that produced the inbound event. The first send of a turn carries it, and a second one cannot: Relay answers 403. Typing peeks at the invocation rather than spending it.

## Replace one function

`getModel()` is the whole model decision. It returns Workers AI here. Point it at any AI SDK model and the rest of the file is unchanged.
