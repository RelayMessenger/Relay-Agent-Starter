import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RELAY_SERVER_SHA =
  "4fe4a71e20f4f51e5f8db5714c985687c8a63d89";
const RELAY_CHAT_SDK_SHA =
  "aac334c5081de6e6498963908c3965c843ebc1cf";
const RELAY_OPENAPI_SHA256 =
  "46eeedd5a5e99e879e32c45972799364021143df9f81acd60837713210639735";
const RELAY_ADAPTER_INTEGRITY =
  "sha512-g12qLaFH1RLrBPcBtjpIHOB/OzwNB18mgxoSO5a3OBhEubHtxgGB5c14vtF+TUetHNDewLaKFiwciFpZJ6Lq2A==";

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
    expect(packageVersion("@cloudflare/think")).toBe("0.17.0");
    expect(packageVersion("@relaymessenger/chat-sdk-adapter"))
      .toBe("0.3.2-staging.0");
    expect(packageVersion("@relaymessenger/sdk")).toBe("0.3.1-staging.2");
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
        "https://registry.npmjs.org/@relaymessenger/chat-sdk-adapter/-/chat-sdk-adapter-0.3.2-staging.0.tgz",
      version: "0.3.2-staging.0",
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

    expect(config.name).toBe("relay-think-agent-starter-development");
    expect(production?.name).toBe("relay-think-agent-starter");
    expect(config.name).not.toBe(production?.name);
    expect(config.secrets?.required).toEqual([
      "RELAY_AGENT_TOKEN",
      "RELAY_WEBHOOK_SECRET",
    ]);
    expect(config.vars).toEqual({
      MODEL_ID: "@cf/openai/gpt-oss-120b",
      RELAY_AGENT_HANDLE: "your_agent_handle",
      RELAY_API_ORIGIN: "https://api.staging.relayapp.im",
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
      .toBe("relay-think-agent-starter-staging");
    expect(config.env?.production?.name)
      .toBe("relay-think-agent-starter");
    for (const environment of ["staging", "production"]) {
      const target = config.env?.[environment];
      expect(target?.secrets?.required).toEqual([
        "RELAY_AGENT_TOKEN",
        "RELAY_WEBHOOK_SECRET",
      ]);
      expect(target?.vars).toMatchObject({
        MODEL_ID: "@cf/openai/gpt-oss-120b",
        RELAY_AGENT_HANDLE: "your_agent_handle",
      });
      expect(target?.ai).toEqual({ binding: "AI" });
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

  it("documents the locked update operation and an honest idempotent overlap", () => {
    const readme = readFileSync("README.md", "utf8");
    const openapi = readFileSync("contracts/relay-openapi.yaml", "utf8");
    const reply = readFileSync("src/reply.ts", "utf8");
    const updatePath = openapi.indexOf(
      "  /v1/webhook-subscriptions/{subscriptionId}:",
    );
    const updateOperation = openapi.slice(
      openapi.indexOf("    put:", updatePath),
      openapi.indexOf("    delete:", updatePath),
    );
    const updateSchema = openapi.slice(
      openapi.indexOf("    UpdateWebhookSubscriptionRequest:"),
      openapi.indexOf("    VoiceMemoAttachment:"),
    );
    const migrationStart = readme.indexOf(
      "## Move the existing staging webhook",
    );
    const migrationEnd = readme.indexOf("## Replace the model");
    const migration = readme.slice(migrationStart, migrationEnd);

    expect(updatePath).toBeGreaterThanOrEqual(0);
    expect(updateOperation).toContain(
      "operationId: updateWebhookSubscription",
    );
    expect(updateOperation).toContain(
      '$ref: "#/components/schemas/UpdateWebhookSubscriptionRequest"',
    );
    for (const field of ["target_url", "subscribed_events", "is_active"]) {
      expect(updateSchema).toContain(`        ${field}:`);
    }
    expect(migrationStart).toBeGreaterThanOrEqual(0);
    expect(migrationEnd).toBeGreaterThan(migrationStart);
    expect(migration).toContain(
      "PUT /v1/webhook-subscriptions/{subscriptionId}",
    );
    expect(migration).toContain(
      "$RELAY_API_ORIGIN/v1/webhook-subscriptions/$SUBSCRIPTION_ID",
    );
    expect(migration).not.toMatch(
      /-X POST[\s\S]*\/v1\/webhook-subscriptions/u,
    );
    expect(migration).toContain('"target_url": "$NEW_WEBHOOK_URL"');
    expect(migration).toContain(
      "`target_url` set to `OLD_WEBHOOK_URL`",
    );
    expect(migration).toContain(
      '"subscribed_events": ["message.received"]',
    );
    expect(migration).toContain('"is_active": true');
    expect(migration).not.toContain('"is_active": false');
    expect(migration).not.toContain("Now drain the old Worker");
    expect(migration).toContain(
      "no pending-delivery queue, delivery",
    );
    expect(migration).toContain(
      "it is not a cross-Worker event lock",
    );
    expect(migration).toContain(
      "`relay-agent-starter:<inbound-message-id>`",
    );
    expect(migration).toContain(
      "documented maximum webhook retry horizon",
    );
    expect(migration).toContain(
      "retain the old\nruntime indefinitely",
    );
    expect(migration).toContain(
      "Retirement after a supplied horizon is a retention policy, not",
    );
    expect(migration).toContain(
      "retain the new Worker and its state for the same",
    );
    expect(reply).toContain(
      "return `relay-agent-starter:${messageId}`",
    );
    expect(reply).toContain(
      "idempotencyKey: () => `message:${deps.turn().messageId}`",
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
