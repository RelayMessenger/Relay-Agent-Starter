import { execFileSync } from "node:child_process";

const expected = process.argv[2];
if (expected !== "staging" && expected !== "main") {
  throw new Error("Expected deploy branch must be staging or main.");
}

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
const branch = git("branch", "--show-current");
if (branch !== expected) {
  throw new Error(`Refusing deploy from ${branch || "detached HEAD"}; use ${expected}.`);
}
if (git("status", "--porcelain")) {
  throw new Error("Refusing deploy from a dirty working tree.");
}
const head = git("rev-parse", "HEAD");
let remote;
try {
  remote = git("rev-parse", `origin/${expected}`);
} catch {
  throw new Error(`Refusing deploy: origin/${expected} is unavailable.`);
}
if (head !== remote) {
  throw new Error(`Refusing deploy: ${expected} is not origin/${expected}.`);
}
