/** Bindings are generated from wrangler.jsonc by `wrangler types`. */
export type Bindings = Cloudflare.Env;

export interface RelayConfiguration {
  MODEL_ID?: string;
  RELAY_AGENT_HANDLE?: string;
  RELAY_AGENT_TOKEN?: string;
  RELAY_API_ORIGIN?: string;
  RELAY_WEBHOOK_SECRET?: string;
}

export class ConfigurationError extends Error {}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new ConfigurationError(`${name} is not configured`);
  }
  return value;
}

export function requireRelayAgentHandle(env: RelayConfiguration): string {
  return required(env.RELAY_AGENT_HANDLE, "RELAY_AGENT_HANDLE");
}

export function requireRelayToken(env: RelayConfiguration): string {
  return required(env.RELAY_AGENT_TOKEN, "RELAY_AGENT_TOKEN");
}

export function requireRelayWebhookSecret(env: RelayConfiguration): string {
  return required(env.RELAY_WEBHOOK_SECRET, "RELAY_WEBHOOK_SECRET");
}

export function configurationErrors(env: RelayConfiguration): string[] {
  const errors: string[] = [];
  for (const [name, value] of Object.entries({
    MODEL_ID: env.MODEL_ID,
    RELAY_AGENT_HANDLE: env.RELAY_AGENT_HANDLE,
    RELAY_AGENT_TOKEN: env.RELAY_AGENT_TOKEN,
    RELAY_WEBHOOK_SECRET: env.RELAY_WEBHOOK_SECRET,
  })) {
    if (!value?.trim()) errors.push(`${name} is not configured`);
  }

  try {
    const origin = new URL(env.RELAY_API_ORIGIN ?? "");
    if (origin.protocol !== "https:") {
      errors.push("RELAY_API_ORIGIN must use HTTPS");
    }
  } catch {
    errors.push("RELAY_API_ORIGIN is invalid");
  }
  return errors;
}
