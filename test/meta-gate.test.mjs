// Meta-loop gate (RED).
// This repo must be baseline-green AND its dependencies green.
// RED until baseline reports 0 blockers for this repo.
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { accessSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function baselineChecker() {
  if (process.env.META_BASELINE_CHECKER) return process.env.META_BASELINE_CHECKER;
  return path.resolve(__dirname, "..", "..", "baseline-skill", "check.mjs");
}

test("meta-loop gate: baseline-green + deps green", () => {
  const checker = baselineChecker();
  accessSync(checker); // throws if baseline not found
  const out = execFileSync(
    "node", [checker, "--repo", ".", "--no-exec", "--json"],
    { cwd: repoRoot, encoding: "utf8", stdio: "pipe" }
  );
  const summary = JSON.parse(out).summary || {};
  assert.equal(summary.blockers ?? 0, 0, `blockers present: ${JSON.stringify(summary)}`);
});
