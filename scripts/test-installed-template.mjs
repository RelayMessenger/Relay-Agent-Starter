import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

const source = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), "relay-agent-starter-"));
const installed = join(temporary, "Relay-Agent-Starter");
const excluded = new Set([
  ".artifacts",
  ".dev.vars",
  ".git",
  ".wrangler",
  "coverage",
  "node_modules",
]);

function include(path) {
  const name = relative(source, path).split(/[\\/]/u)[0];
  return !excluded.has(name);
}

function run(command, args) {
  execFileSync(command, args, {
    cwd: installed,
    env: { ...process.env, CI: "1" },
    stdio: "inherit",
  });
}

try {
  cpSync(source, installed, { filter: include, recursive: true });
  const adapterTarball = process.env.RELAY_ADAPTER_TARBALL;
  if (adapterTarball) {
    const absoluteTarball = resolve(adapterTarball);
    const manifestPath = join(installed, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dependencies["@relaymessenger/chat-sdk-adapter"] =
      `file:${absoluteTarball}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    rmSync(join(installed, "package-lock.json"), { force: true });
    run("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
  } else {
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  }

  run("npm", ["run", "types"]);
  run("npm", ["run", "types:check"]);
  run("npm", ["run", "check"]);
  run("npm", ["run", "test:unit"]);
  run("npm", ["run", "test:workerd"]);
  run("npm", ["run", "dry-run"]);

  console.log(`installed template ok: ${basename(installed)}`);
} finally {
  if (process.env.RELAY_KEEP_INSTALLED_TEMPLATE !== "1") {
    rmSync(temporary, { force: true, recursive: true });
  } else {
    console.log(`kept installed template: ${installed}`);
  }
}
