import type { GroupReplyPolicy } from "./relay";

/** Wrangler generates every binding except this optional local policy. */
export interface Env extends Cloudflare.Env {
  RELAY_GROUP_REPLY_POLICY?: string;
  // AI: Ai;
}

export function requireWebhookSecret(env: Env): string {
  if (!env.RELAY_WEBHOOK_SECRET) {
    throw new Error("RELAY_WEBHOOK_SECRET is not configured");
  }
  return env.RELAY_WEBHOOK_SECRET;
}

export function requireAgentToken(env: Env): string {
  if (!env.RELAY_AGENT_TOKEN) {
    throw new Error("RELAY_AGENT_TOKEN is not configured");
  }
  return env.RELAY_AGENT_TOKEN;
}

export function groupReplyPolicy(env: Env): GroupReplyPolicy {
  return env.RELAY_GROUP_REPLY_POLICY === "all" ? "all" : "mentions";
}
