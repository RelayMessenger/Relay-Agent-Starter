import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const targets = {
  production: {
    branch: "main",
    worker: "relay-think-agent-starter",
  },
  staging: {
    branch: "staging",
    worker: "relay-think-agent-starter-staging",
  },
};
if (process.argv.length !== 3) {
  throw new Error("Deploy accepts exactly one environment argument.");
}
const environment = process.argv[2];
const target = targets[environment];
if (!target) {
  throw new Error("Deploy environment must be staging or production.");
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const config = JSON.parse(
  readFileSync(join(root, "wrangler.jsonc"), "utf8"),
);
if (config.env?.[environment]?.name !== target.worker) {
  throw new Error(
    `Refusing deploy: ${environment} must target ${target.worker}.`,
  );
}
if (
  process.env.CLOUDFLARE_ENV
  && process.env.CLOUDFLARE_ENV !== environment
) {
  throw new Error(
    `Refusing deploy: CLOUDFLARE_ENV must be ${environment}.`,
  );
}

const branch = git("branch", "--show-current");
if (branch !== target.branch) {
  throw new Error(
    `Refusing ${environment} deploy from ${
      branch || "detached HEAD"
    }; use ${target.branch}.`,
  );
}
if (git("status", "--porcelain")) {
  throw new Error("Refusing deploy from a dirty working tree.");
}
const head = git("rev-parse", "HEAD");
let remote;
try {
  remote = git("rev-parse", `origin/${target.branch}`);
} catch {
  throw new Error(
    `Refusing deploy: origin/${target.branch} is unavailable.`,
  );
}
if (head !== remote) {
  throw new Error(
    `Refusing deploy: ${target.branch} is not origin/${target.branch}.`,
  );
}

execFileSync(process.execPath, [
  join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
  "deploy",
  "--env",
  environment,
], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
