import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RELAY_SERVER_SHA =
  "a25111520f7fc92c25ecd945d1dfc9afa9f60a1f";
const RELAY_CHAT_SDK_SHA =
  "aac334c5081de6e6498963908c3965c843ebc1cf";
const RELAY_OPENAPI_SHA256 =
  "9f3e662a13cd0e6b16a52fba4b53c75fe5817d134dcf152e00b054699c37839c";
const RELAY_ADAPTER_INTEGRITY =
  "sha512-gdfDAMJ16RAd1PpUx01FcPgFzBsk9UjM0XBte4A/aksnm0y8u6jtxIHXFpnoLuQPqQ3ytMXJ5GI+NMj69OTIHg==";

function packageVersion(name: string): string {
  const manifest = JSON.parse(
    readFileSync(join("node_modules", name, "package.json"), "utf8"),
  ) as { version?: string };
  if (!manifest.version) throw new Error(`${name} has no package version`);
  return manifest.version;
}

describe("locked runtime contracts", () => {
  it(`uses the unchanged OpenAPI from Relay Server ${RELAY_SERVER_SHA.slice(0, 12)}`, () => {
    const openapi = readFileSync("contracts/relay-openapi.yaml");
    expect(createHash("sha256").update(openapi).digest("hex"))
      .toBe(RELAY_OPENAPI_SHA256);
  });

  it("does not advertise anonymous Agent registration", () => {
    const openapi = readFileSync("contracts/relay-openapi.yaml", "utf8");
    const agentPath = openapi.match(
      /^  \/v1\/agents:\r?\n((?:(?: {4}.*|[ \t]*)\r?\n)*)/mu,
    )?.[1] ?? "";
    expect(agentPath).not.toMatch(/^    post:/mu);
  });

  it("pins the coordinated Think and Relay packages", () => {
    expect(packageVersion("@cloudflare/think")).toBe("0.19.0");
    expect(packageVersion("@relaymessenger/chat-sdk-adapter"))
      .toBe("0.3.7-staging.22");
    expect(packageVersion("@relaymessenger/sdk")).toBe("0.3.6-staging.29");
  });

  it(`locks the adapter tarball built from Relay Chat SDK ${RELAY_CHAT_SDK_SHA.slice(0, 7)}`, () => {
    const lock = JSON.parse(
      readFileSync("package-lock.json", "utf8"),
    ) as {
      packages?: Record<string, {
        integrity?: string;
        resolved?: string;
        version?: string;
      }>;
    };
    const adapter =
      lock.packages?.["node_modules/@relaymessenger/chat-sdk-adapter"];
    expect(adapter).toMatchObject({
      integrity: RELAY_ADAPTER_INTEGRITY,
      resolved:
        "https://registry.npmjs.org/@relaymessenger/chat-sdk-adapter/-/chat-sdk-adapter-0.3.7-staging.22.tgz",
      version: "0.3.7-staging.22",
    });
  });

  it("identifies the public starter repository exactly", () => {
    const manifest = JSON.parse(
      readFileSync("package.json", "utf8"),
    ) as { repository?: { url?: string } };
    expect(manifest.repository?.url).toBe(
      "git+https://github.com/RelayMessenger/Relay-Agent-Starter.git",
    );
  });

  it("makes bare Wrangler deploy complete and non-production", () => {
    const config = JSON.parse(
      readFileSync("wrangler.jsonc", "utf8"),
    ) as {
      ai?: { binding?: string };
      durable_objects?: {
        bindings?: Array<{ class_name?: string; name?: string }>;
      };
      env?: Record<string, {
        ai?: { binding?: string };
        durable_objects?: {
          bindings?: Array<{ class_name?: string; name?: string }>;
        };
        name?: string;
        secrets?: { required?: string[] };
        vars?: Record<string, string>;
      }>;
      name?: string;
      secrets?: { required?: string[] };
      vars?: Record<string, string>;
    };
    const manifest = JSON.parse(
      readFileSync("package.json", "utf8"),
    ) as { scripts?: Record<string, string> };
    const production = config.env?.production;

    expect(config.name).toBe("tanias-pizza-agent-development");
    expect(production?.name).toBe("tanias-pizza-agent");
    expect(config.name).not.toBe(production?.name);
    expect(config.secrets?.required).toEqual([
      "RELAY_AGENT_TOKEN",
      "RELAY_WEBHOOK_SECRET",
    ]);
    expect(config.vars).toEqual({
      CAL_EVENT_TYPE_ID: "",
      MODEL_ID: "@cf/zai-org/glm-5.3",
      RELAY_AGENT_HANDLE: "taniaspizza",
      RELAY_API_ORIGIN: "https://api.staging.relayapp.im",
      RELAY_INTERACTIVE_PARTS: "true",
      TOAST_RESTAURANT_GUID: "",
    });
    expect(config.ai).toEqual({ binding: "AI" });
    expect(config.durable_objects?.bindings).toEqual([{
      class_name: "RelayChatAgent",
      name: "RelayChat",
    }]);
    expect(manifest.scripts?.deploy).toBeUndefined();
    expect(manifest.scripts?.["dry-run:default"])
      .toBe("wrangler deploy --dry-run");
  });

  it("fully defines non-inheritable bindings for named deploys", () => {
    const config = JSON.parse(
      readFileSync("wrangler.jsonc", "utf8"),
    ) as {
      env?: Record<string, {
        ai?: { binding?: string };
        durable_objects?: {
          bindings?: Array<{ class_name?: string; name?: string }>;
        };
        name?: string;
        secrets?: { required?: string[] };
        vars?: Record<string, string>;
      }>;
    };

    expect(config.env?.staging?.name)
      .toBe("tanias-pizza-agent-staging");
    expect(config.env?.production?.name)
      .toBe("tanias-pizza-agent");
    for (const environment of ["staging", "production"]) {
      const target = config.env?.[environment];
      expect(target?.secrets?.required).toEqual([
        "RELAY_AGENT_TOKEN",
        "RELAY_WEBHOOK_SECRET",
      ]);
      expect(target?.vars).toMatchObject({
        MODEL_ID: "@cf/zai-org/glm-5.3",
        RELAY_AGENT_HANDLE: "taniaspizza",
      });
      expect(target?.ai).toEqual({ binding: "AI" });
      // Per-sender cap on inference spend; bindings don't inherit.
      expect((target as { ratelimits?: unknown }).ratelimits).toEqual([{
        name: "SENDER_LIMITER",
        namespace_id: "1001",
        simple: { limit: 20, period: 60 },
      }]);
      expect(target?.durable_objects?.bindings).toEqual([{
        class_name: "RelayChatAgent",
        name: "RelayChat",
      }]);
    }
    expect(config.env?.staging?.vars?.RELAY_API_ORIGIN)
      .toBe("https://api.staging.relayapp.im");
    expect(config.env?.production?.vars?.RELAY_API_ORIGIN)
      .toBe("https://api.relayapp.im");
  });

  it("guards each explicit deploy by target, branch, cleanliness, and remote SHA", () => {
    const guard = readFileSync(
      "scripts/deploy.mjs",
      "utf8",
    );
    const manifest = JSON.parse(
      readFileSync("package.json", "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(manifest.scripts?.["deploy:staging"]).toBe(
      "node scripts/deploy.mjs staging",
    );
    expect(manifest.scripts?.["deploy:production"]).toBe(
      "node scripts/deploy.mjs production",
    );
    expect(guard).toMatch(/process\.argv\.length !== 3/u);
    expect(guard).toMatch(/production: \{\s+branch: "main"/u);
    expect(guard).toMatch(/staging: \{\s+branch: "staging"/u);
    expect(guard).toMatch(/remote: "origin"/u);
    expect(guard).toMatch(/config\.env\?\.\[environment\]\?\.name/u);
    expect(guard).toMatch(/CLOUDFLARE_ENV !== environment/u);
    expect(guard).toMatch(/GIT_TERMINAL_PROMPT: "0"/u);
    expect(guard).toMatch(/"--no-write-fetch-head"/u);
    expect(guard).toMatch(
      /`refs\/heads\/\$\{target\.branch\}:\$\{verificationRef\}`/u,
    );
    expect(guard).toMatch(/"--porcelain=v2"/u);
    expect(guard).toMatch(/finalState\.oid !== fetched/u);
    expect(guard).not.toMatch(/refs\/remotes\/|`origin\/\$\{/u);
    expect(guard).toMatch(
      /"deploy",\s+"--config",[\s\S]*"--env",\s+environment,/u,
    );
  });

  it("documents one-time webhook setup and the idempotency boundaries", () => {
    const readme = readFileSync("README.md", "utf8");
    const openapi = readFileSync("contracts/relay-openapi.yaml", "utf8");
    const reply = readFileSync("src/reply.ts", "utf8");
    const index = readFileSync("src/index.ts", "utf8");

    expect(openapi).toContain("operationId: createWebhookSubscription");
    expect(readme).toContain(
      '-X POST "$RELAY_API_ORIGIN/v1/webhook-subscriptions"',
    );
    expect(readme).toContain('"subscribed_events":["message.received"]');
    expect(readme).toContain("`tanias-pizza-agent:<inbound-message-id>`");
    expect(readme).toContain(
      "`tanias-pizza-agent:catering:<booking-uid>:<status>`",
    );
    expect(reply).toContain("return `tanias-pizza-agent:${messageId}`");
    expect(reply).toContain(
      "idempotencyKey: () => `message:${deps.turn().messageId}`",
    );
    expect(index).toContain(
      "`tanias-pizza-agent:catering:${decision.bookingUid}:${decision.status}`",
    );
    expect(openapi).toContain(
      "The same authenticated sender, key, and Message body return the original",
    );
    expect(openapi).toContain(
      "Message. Reusing the key with a different body returns a conflict.",
    );
  });

  it("pins CI Actions and prevents checkout credential persistence", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).toMatch(/\npermissions:\n  contents: read\n/u);
    expect(workflow).toContain(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    );
    expect(workflow).toContain(
      "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    );
    expect(workflow).toMatch(/persist-credentials: false/u);
    expect(workflow).not.toMatch(/uses: actions\/[^@\n]+@v\d/u);
  });

  it("binds but does not migrate Think's facet-only test state class", () => {
    const config = JSON.parse(
      readFileSync("wrangler.test.jsonc", "utf8"),
    ) as {
      durable_objects?: {
        bindings?: Array<{ class_name?: string; name?: string }>;
      };
      migrations?: Array<{ new_sqlite_classes?: string[] }>;
    };
    expect(config.durable_objects?.bindings).toContainEqual({
      class_name: "ThinkMessengerStateAgent",
      name: "ThinkMessengerStateAgent",
    });
    expect(
      config.migrations?.flatMap(
        (migration) => migration.new_sqlite_classes ?? [],
      ),
    ).not.toContain("ThinkMessengerStateAgent");
  });

  it("contains no legacy transport or custom delivery persistence", () => {
    const source = readdirSync("src")
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join("src", name), "utf8"))
      .join("\n");

    for (const forbidden of [
      /\bCREATE TABLE\b/iu,
      /\bscheduleEvery\b|\bsetInterval\b|long.?poll/iu,
      /\bnew\s+WebSocket\b/iu,
      /\/v3(?:\/|["'`])/u,
      /\/v1\/conversations\b|\/v1\/events\b/u,
      /\bmessage effects?\b|\bsend effects?\b/iu,
    ]) {
      expect(source).not.toMatch(forbidden);
    }
    expect(source).toMatch(/chatSdkMessenger\(/u);
    expect(source).toMatch(/extends Think<Bindings>/u);
    expect(source).toMatch(
      /ACTION_RETRY_LEASE_MS = 0/u,
    );
    expect(source).toMatch(
      /actionLedgerPendingRetryLeaseMs = ACTION_RETRY_LEASE_MS/u,
    );
  });
});
