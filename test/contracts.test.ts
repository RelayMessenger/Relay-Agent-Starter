import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RELAY_SERVER_SHA =
  "9b4d5bb32cc749c6fd271969948c385300d404d6";
const RELAY_CHAT_SDK_SHA =
  "f90e312aeecefa9c929398a56be77441e8c2137c";
const RELAY_OPENAPI_SHA256 =
  "f62f431fc0daa48500926bf87753f81c3fdda25ab463b130ca97f2896367e0a5";
const RELAY_ADAPTER_INTEGRITY =
  "sha512-IuWa2VVv3hKArnQPO6SV4Ntq+/9pp7eEIzWgVSBgg6E5pWpVV+hxTFCwfwwBJvmhYjzVgOFxrrk6haL05ANquw==";

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

  it("pins the coordinated Think and Relay packages", () => {
    expect(packageVersion("@cloudflare/think")).toBe("0.17.0");
    expect(packageVersion("@relaymessenger/chat-sdk-adapter"))
      .toBe("0.3.0-staging.0");
    expect(packageVersion("@relaymessenger/sdk")).toBe("0.3.0-staging.4");
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
      version: "0.3.0-staging.0",
    });
    const manifest = JSON.parse(
      readFileSync("package.json", "utf8"),
    ) as { dependencies?: Record<string, string> };
    if (
      manifest.dependencies?.["@relaymessenger/chat-sdk-adapter"]
        === "0.3.0-staging.0"
    ) {
      expect(adapter?.resolved).toBe(
        "https://registry.npmjs.org/@relaymessenger/chat-sdk-adapter/-/chat-sdk-adapter-0.3.0-staging.0.tgz",
      );
    } else {
      expect(adapter?.resolved).toMatch(/^file:/u);
    }
  });

  it("identifies the public starter repository exactly", () => {
    const manifest = JSON.parse(
      readFileSync("package.json", "utf8"),
    ) as { repository?: { url?: string } };
    expect(manifest.repository?.url).toBe(
      "git+https://github.com/RelayMessenger/Relay-Agent-Starter.git",
    );
  });

  it("guards the staging deploy by branch, cleanliness, and remote SHA", () => {
    const guard = readFileSync(
      "scripts/require-deploy-branch.mjs",
      "utf8",
    );
    expect(guard).toMatch(/branch !== expected/u);
    expect(guard).toMatch(/status", "--porcelain/u);
    expect(guard).toMatch(/origin\/\$\{expected\}/u);
    expect(guard).toMatch(/head !== remote/u);
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
      /actionLedgerPendingRetryLeaseMs[^=]*= false/u,
    );
  });
});
