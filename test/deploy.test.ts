import {
  execFileSync,
  spawnSync,
} from "node:child_process";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface DeployFixture {
  initialCommit: string;
  invocationFile: string;
  remote: string;
  repo: string;
  root: string;
}

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GCM_INTERACTIVE: "never",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createFixture(branch = "staging"): DeployFixture {
  const root = mkdtempSync(join(tmpdir(), "relay-deploy-test-"));
  temporaryRoots.push(root);
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  const invocationFile = join(repo, "wrangler-invocations.jsonl");

  mkdirSync(repo);
  git(root, "init", "--bare", remote);
  git(repo, "init", `--initial-branch=${branch}`);
  git(repo, "config", "user.email", "deploy-test@relay.invalid");
  git(repo, "config", "user.name", "Relay Deploy Test");
  git(repo, "remote", "add", "origin", remote);

  mkdirSync(join(repo, "scripts"));
  copyFileSync("scripts/deploy.mjs", join(repo, "scripts", "deploy.mjs"));
  writeFileSync(join(repo, ".gitignore"), [
    "node_modules/",
    "wrangler-invocations.jsonl",
    "",
  ].join("\n"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    private: true,
    type: "module",
  }));
  writeFileSync(join(repo, "wrangler.jsonc"), JSON.stringify({
    env: {
      production: { name: "relay-think-agent-starter" },
      staging: { name: "relay-think-agent-starter-staging" },
    },
    name: "relay-think-agent-starter-development",
  }));

  const wrangler = join(repo, "node_modules", "wrangler");
  mkdirSync(join(wrangler, "bin"), { recursive: true });
  writeFileSync(join(wrangler, "package.json"), JSON.stringify({
    private: true,
    type: "module",
  }));
  writeFileSync(join(wrangler, "bin", "wrangler.js"), [
    'import { appendFileSync } from "node:fs";',
    "appendFileSync(",
    '  new URL("../../../wrangler-invocations.jsonl", import.meta.url),',
    "  `${JSON.stringify(process.argv.slice(2))}\\n`,",
    ");",
    "",
  ].join("\n"));

  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "fixture");
  git(repo, "push", "--quiet", "--set-upstream", "origin", branch);
  return {
    initialCommit: git(repo, "rev-parse", "HEAD"),
    invocationFile,
    remote,
    repo,
    root,
  };
}

function commitRevision(fixture: DeployFixture, value: string): string {
  writeFileSync(join(fixture.repo, "revision.txt"), `${value}\n`);
  git(fixture.repo, "add", "revision.txt");
  git(fixture.repo, "commit", "--quiet", "-m", value);
  return git(fixture.repo, "rev-parse", "HEAD");
}

function runDeploy(
  fixture: DeployFixture,
  args: string[],
  overrides: Record<string, string | undefined> = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLOUDFLARE_ENV;
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return spawnSync(
    process.execPath,
    [join(fixture.repo, "scripts", "deploy.mjs"), ...args],
    {
      cwd: fixture.repo,
      encoding: "utf8",
      env,
      timeout: 10_000,
    },
  );
}

function expectNoDeploy(fixture: DeployFixture): void {
  expect(existsSync(fixture.invocationFile)).toBe(false);
  expect(
    git(
      fixture.repo,
      "for-each-ref",
      "--format=%(refname)",
      "refs/relay-deploy-verification",
    ),
  ).toBe("");
}

describe("guarded deploy", () => {
  it("fetches the exact branch and invokes only its fixed Wrangler environment", () => {
    for (const target of [
      { branch: "staging", environment: "staging" },
      { branch: "main", environment: "production" },
    ]) {
      const fixture = createFixture(target.branch);
      const result = runDeploy(fixture, [target.environment]);

      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      expect(
        readFileSync(fixture.invocationFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]),
      ).toEqual([[
        "deploy",
        "--config",
        join(fixture.repo, "wrangler.jsonc"),
        "--env",
        target.environment,
      ]]);
      expect(
        git(
          fixture.repo,
          "for-each-ref",
          "--format=%(refname)",
          "refs/relay-deploy-verification",
        ),
      ).toBe("");
    }
  });

  it("rejects a locally rewritten origin ref that only appears to match HEAD", () => {
    const fixture = createFixture();
    const localCommit = commitRevision(fixture, "local-only");
    git(
      fixture.repo,
      "update-ref",
      "refs/remotes/origin/staging",
      localCommit,
    );
    expect(git(fixture.remote, "rev-parse", "refs/heads/staging"))
      .toBe(fixture.initialCommit);

    const result = runDeploy(fixture, ["staging"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "fetched origin/staging is not HEAD",
    );
    expectNoDeploy(fixture);
  });

  it("rejects a stale origin ref after the configured remote advances", () => {
    const fixture = createFixture();
    const remoteCommit = commitRevision(fixture, "remote-advanced");
    git(fixture.repo, "push", "--quiet", "origin", "staging");
    git(fixture.repo, "reset", "--hard", fixture.initialCommit);
    git(
      fixture.repo,
      "update-ref",
      "refs/remotes/origin/staging",
      fixture.initialCommit,
    );
    expect(git(fixture.remote, "rev-parse", "refs/heads/staging"))
      .toBe(remoteCommit);

    const result = runDeploy(fixture, ["staging"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "fetched origin/staging is not HEAD",
    );
    expectNoDeploy(fixture);
  });

  it("rejects argument and CLOUDFLARE_ENV bypass attempts", () => {
    const extraArgument = createFixture();
    const extraResult = runDeploy(
      extraArgument,
      ["staging", "--env", "production"],
    );
    expect(extraResult.status).not.toBe(0);
    expect(extraResult.stderr).toContain(
      "Deploy accepts exactly one environment argument",
    );
    expectNoDeploy(extraArgument);

    const conflictingEnvironment = createFixture();
    const environmentResult = runDeploy(
      conflictingEnvironment,
      ["staging"],
      { CLOUDFLARE_ENV: "production" },
    );
    expect(environmentResult.status).not.toBe(0);
    expect(environmentResult.stderr).toContain(
      "CLOUDFLARE_ENV must be staging",
    );
    expectNoDeploy(conflictingEnvironment);
  });

  it("redacts configured remote credentials when an exact fetch fails", () => {
    const fixture = createFixture();
    const credential = "deploy-audit-secret";
    git(
      fixture.repo,
      "remote",
      "set-url",
      "origin",
      `https://${credential}@127.0.0.1:1/relay.git`,
    );

    const result = runDeploy(fixture, ["staging"]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("could not fetch staging from origin");
    expect(output).not.toContain(credential);
    expectNoDeploy(fixture);
  });
});
