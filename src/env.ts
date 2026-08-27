/**
 * Bindings this Worker uses.
 *
 * Hand written on purpose. `wrangler types` generates worker-configuration.d.ts
 * from wrangler.jsonc AND from .dev.vars, so regenerating it on a machine that
 * has local secrets writes those secret names into the file. That file is
 * gitignored here; run `npm run types` locally if you want it.
 */
import type { RelayConversationAgent } from "./agent";
import type { GroupReplyPolicy } from "./relay";

export interface Env {
  /** Relay's public API origin. */
  RELAY_API_ORIGIN: string;
  /** Agent Token from the Relay app. Secret. */
  RELAY_AGENT_TOKEN: string;
  /** signing_secret from POST /v1/webhooks. Secret. */
  RELAY_WEBHOOK_SECRET: string;
  /**
   * What this agent does with a group message it was not named in.
   *
   * `mentions` (the default) replies only when the message mentions the agent.
   * `all` replies to every group message, for an agent whose job really is to
   * read the whole room — a transcriber, a moderator. Direct messages are
   * always answered either way.
   */
  RELAY_GROUP_REPLY_POLICY?: string;
  /** One Durable Object per conversation. */
  RelayConversation: DurableObjectNamespace<RelayConversationAgent>;
  /**
   * Workers AI. Add the `ai` binding to wrangler.jsonc and uncomment this line
   * to use it from generateReply in src/agent.ts.
   */
  // AI: Ai;
}

export function requireWebhookSecret(env: Env): string {
  if (!env.RELAY_WEBHOOK_SECRET) throw new Error("RELAY_WEBHOOK_SECRET is not configured");
  return env.RELAY_WEBHOOK_SECRET;
}

export function requireAgentToken(env: Env): string {
  if (!env.RELAY_AGENT_TOKEN) throw new Error("RELAY_AGENT_TOKEN is not configured");
  return env.RELAY_AGENT_TOKEN;
}

/**
 * The group policy, defaulting to `mentions`.
 *
 * Anything unrecognised also reads as `mentions`. A typo in a var must not be
 * what turns an agent into one that answers every message in every group.
 */
export function groupReplyPolicy(env: Env): GroupReplyPolicy {
  return env.RELAY_GROUP_REPLY_POLICY === "all" ? "all" : "mentions";
}
