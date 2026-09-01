import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const targets = {
  production: {
    branch: "main",
    remote: "origin",
    worker: "relay-think-agent-starter",
  },
  staging: {
    branch: "staging",
    remote: "origin",
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
const gitEnvironment = {
  ...process.env,
  GCM_INTERACTIVE: "never",
  GIT_TERMINAL_PROMPT: "0",
};
const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: gitEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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

function worktreeState() {
  const lines = git(
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=normal",
  ).split("\n");
  const oid = lines
    .find((line) => line.startsWith("# branch.oid "))
    ?.slice("# branch.oid ".length);
  const branch = lines
    .find((line) => line.startsWith("# branch.head "))
    ?.slice("# branch.head ".length);
  const dirty = lines.some((line) => line && !line.startsWith("# "));
  return { branch, dirty, oid };
}

function requireCleanBranch(state) {
  if (state.branch !== target.branch) {
    throw new Error(
      `Refusing ${environment} deploy from ${
        state.branch && state.branch !== "(detached)"
          ? state.branch
          : "detached HEAD"
      }; use ${target.branch}.`,
    );
  }
  if (state.dirty) {
    throw new Error("Refusing deploy from a dirty working tree.");
  }
  if (!state.oid || state.oid === "(initial)") {
    throw new Error("Refusing deploy without a committed HEAD.");
  }
}

requireCleanBranch(worktreeState());

const verificationRef =
  `refs/relay-deploy-verification/${randomUUID()}`;
try {
  try {
    execFileSync("git", [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--force",
      target.remote,
      `refs/heads/${target.branch}:${verificationRef}`,
    ], {
      cwd: root,
      env: gitEnvironment,
      stdio: "ignore",
    });
  } catch {
    throw new Error(
      `Refusing deploy: could not fetch ${target.branch} from ${
        target.remote
      }.`,
    );
  }

  let fetched;
  try {
    fetched = git(
      "rev-parse",
      "--verify",
      `${verificationRef}^{commit}`,
    );
  } catch {
    throw new Error(
      `Refusing deploy: ${target.remote}/${target.branch} is not a commit.`,
    );
  }

  // This is intentionally the final repository read before Wrangler starts.
  // One porcelain-v2 snapshot proves the branch, clean tree, and HEAD OID
  // against the exact branch fetched above, without trusting origin/* refs.
  const finalState = worktreeState();
  requireCleanBranch(finalState);
  if (finalState.oid !== fetched) {
    throw new Error(
      `Refusing deploy: fetched ${target.remote}/${target.branch} is not HEAD.`,
    );
  }

  execFileSync(process.execPath, [
    join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
    "deploy",
    "--config",
    join(root, "wrangler.jsonc"),
    "--env",
    environment,
  ], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
} finally {
  try {
    git("update-ref", "-d", verificationRef);
  } catch {
    // A failed cleanup cannot change which fetched commit was deployed.
  }
}
