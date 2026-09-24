import type { CateringConfiguration } from "./catering";
import { cateringConfigured } from "./catering";
import type { ToastConfiguration } from "./toast";
import { type WebConfiguration, webConfigured } from "./web";
import { toastConfigured } from "./toast";

/** Bindings are generated from wrangler.jsonc by `wrangler types`. */
export type Bindings = Cloudflare.Env;

/**
 * Optional integrations. Secrets are set with `wrangler secret put`; the
 * agent works without them (bundled menu snapshot, catering by phone).
 */
export type OptionalConfiguration = ToastConfiguration & CateringConfiguration & WebConfiguration & {
  /** Catering deposit charged through Relay payments once Tania's confirms; unset = no deposit. */
  CATERING_DEPOSIT_CENTS?: string;
};

export function optionalConfiguration(env: object): OptionalConfiguration {
  const values = env as Record<string, unknown>;
  const pick = (name: keyof OptionalConfiguration) =>
    typeof values[name] === "string" ? (values[name] as string) : undefined;
  return {
    CAL_API_KEY: pick("CAL_API_KEY"),
    CAL_API_ORIGIN: pick("CAL_API_ORIGIN"),
    CAL_EVENT_TYPE_ID: pick("CAL_EVENT_TYPE_ID"),
    CAL_WEBHOOK_SECRET: pick("CAL_WEBHOOK_SECRET"),
    CATERING_DEPOSIT_CENTS: pick("CATERING_DEPOSIT_CENTS"),
    TAVILY_API_KEY: pick("TAVILY_API_KEY"),
    TOAST_API_HOSTNAME: pick("TOAST_API_HOSTNAME"),
    TOAST_CLIENT_ID: pick("TOAST_CLIENT_ID"),
    TOAST_CLIENT_SECRET: pick("TOAST_CLIENT_SECRET"),
    TOAST_RESTAURANT_GUID: pick("TOAST_RESTAURANT_GUID"),
  };
}

export function integrationStatus(env: object) {
  const config = optionalConfiguration(env);
  return {
    catering: cateringConfigured(config) ? "cal.com" : "phone",
    cateringWebhook: Boolean(config.CAL_WEBHOOK_SECRET?.trim()),
    menu: toastConfigured(config) ? "toast-live" : "snapshot",
    webSearch: webConfigured(config),
  };
}

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
