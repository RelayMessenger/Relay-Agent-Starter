import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  configurationErrors,
  requireRelayToken,
} from "../src/env";
import type { RelayConfiguration } from "../src/env";

function bindings(
  overrides: RelayConfiguration = {},
): RelayConfiguration {
  return {
    MODEL_ID: "@cf/openai/gpt-oss-120b",
    RELAY_AGENT_HANDLE: "starter_test",
    RELAY_AGENT_TOKEN: "relay-test-token",
    RELAY_API_ORIGIN: "https://api.staging.relayapp.im",
    RELAY_WEBHOOK_SECRET: "whsec_dGVzdC1zZWNyZXQ=",
    ...overrides,
  };
}

describe("configuration", () => {
  it("accepts the documented environment", () => {
    expect(configurationErrors(bindings())).toEqual([]);
  });

  it("reports missing values and non-HTTPS Relay origins", () => {
    expect(configurationErrors(bindings({
      RELAY_AGENT_HANDLE: "",
      RELAY_API_ORIGIN: "http://api.example.test",
    }))).toEqual([
      "RELAY_AGENT_HANDLE is not configured",
      "RELAY_API_ORIGIN must use HTTPS",
    ]);
  });

  it("fails closed when the Agent Token is absent", () => {
    expect(() => requireRelayToken(bindings({ RELAY_AGENT_TOKEN: "" })))
      .toThrow(ConfigurationError);
  });
});
