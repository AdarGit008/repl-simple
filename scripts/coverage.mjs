#!/usr/bin/env node
// Per-file line-coverage floors.
//
// Usage:
//   node scripts/coverage.mjs             measure, compare against the baseline
//   node scripts/coverage.mjs --update    measure, rewrite the baseline
//
// Why per-file and not one global number: measured on this repo, deleting
// `test/sandbox.test.ts` — 813 lines, and the only file that kills any
// `sandbox.ts` mutation — moves the global figure by well under a point. Any
// round global floor survives the deletion of the most valuable test file in
// the repository. A per-file floor is the only form of this instrument that
// bites (#25).
//
// This is NOT a quality gate. High coverage says lines executed, not that
// anything was asserted, and this suite has a documented history of tests that
// execute plenty and assert nothing (#23). The mutation score from #24 is the
// quality gate. This is a cheap regression detector that runs in seconds.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const BASELINE = join(REPO, "coverage-baseline.json");

/**
 * Test files excluded from the coverage run — NOT from `npm test`.
 *
 * `extension-loader.test.ts` drives pi's real `discoverAndLoadExtensions`,
 * which loads `extensions/repl-extension.ts` and everything it imports a
 * *second* time through pi's jiti loader. Node merges V8 coverage by file
 * path, so those barely-executed duplicate entries land on top of the real
 * ones and the report collapses. Measured, whole suite:
 *
 *              with it        without it
 *   sandbox.ts   20.80%          83.20%
 *   builtins.ts  19.35%          96.31%
 *   toolstore.ts 23.48%          98.26%
 *   all files    54.13%          93.33%
 *
 * Coverage cannot fall as tests are added, so the first column is the
 * instrument misreporting, not a real gap. The test itself is sound and keeps
 * running under `npm test` — it is the coverage tooling that cannot see
 * through a second module loader.
 */
const EXCLUDED_TEST_FILES = ["test/extension-loader.test.ts"];

/**
 * Source files deliberately outside the instrument. Each one needs its reason
 * here; the point of #105 is that opting out is an edit somebody makes, never
 * the consequence of an omission.
 *
 * `src/index.ts` is the public barrel — nothing but `export … from "./x.js"`.
 * No test imports it, so it never reaches the report, and there is no
 * behaviour in it to cover if one did. `npm run check` already fails if a
 * re-exported name stops resolving, which is the only way a barrel breaks.
 */
const UNMEASURED_SOURCE_FILES = ["src/index.ts"];

/** Every tracked source file expected to carry a floor. */
function sourceFiles() {
  const ls = spawnSync("git", ["ls-files", "src/*.ts", "extensions/*.ts"], {
    cwd: REPO,
    encoding: "utf8",
  });
  if (ls.status !== 0) {
    console.error("could not list source files via git ls-files");
    exit(1);
  }
  return ls.stdout
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !UNMEASURED_SOURCE_FILES.includes(f));
}

/**
 * The mirror of the absent-file check at the bottom of this script. A file
 * with a floor that never loads is an error there; a file that loads with no
 * floor was, until #105, printed as `NEW` and left green — so a new module
 * opted out of the instrument by existing. `src/truncate.ts`, sole owner of
 * all model-facing truncation, sat ungated that way from #29 until #105.
 */
function unflooredFiles(baselineFiles, measuredFiles) {
  return sourceFiles()
    .filter((file) => !(file in baselineFiles))
    .map((file) =>
      file in measuredFiles
        ? `${file} has no floor — run \`npm run coverage:update\``
        : `${file} has no floor and nothing loads it — give it a test, or add it to ` +
          "UNMEASURED_SOURCE_FILES with a reason",
    );
}

function testFiles() {
  const ls = spawnSync("git", ["ls-files", "test/*.test.ts"], {
    cwd: REPO,
    encoding: "utf8",
  });
  if (ls.status !== 0) {
    console.error("could not list test files via git ls-files");
    exit(1);
  }
  return ls.stdout
    .split("\n")
    .filter((f) => f.endsWith(".test.ts"))
    .filter((f) => !EXCLUDED_TEST_FILES.includes(f));
}

/** Run the suite with coverage, returning parsed lcov as {file: {found, hit}}. */
function measure(files) {
  const dir = mkdtempSync(join(tmpdir(), "repl-coverage-"));
  const lcovPath = join(dir, "lcov.info");
  try {
    const run = spawnSync(
      "npx",
      [
        "tsx",
        "--test",
        "--experimental-test-coverage",
        "--test-reporter=lcov",
        `--test-reporter-destination=${lcovPath}`,
        "--test-reporter=dot",
        "--test-reporter-destination=stdout",
        ...files,
      ],
      { cwd: REPO, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] },
    );
    if (run.status !== 0) {
      console.error("\nThe test suite failed. Coverage numbers from a red suite mean nothing.");
      exit(run.status ?? 1);
    }
    return parseLcov(readFileSync(lcovPath, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseLcov(text) {
  const result = {};
  let file = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) file = line.slice(3).trim();
    else if (line.startsWith("LF:") && file) {
      result[file] ??= {};
      result[file].found = Number(line.slice(3));
    } else if (line.startsWith("LH:") && file) {
      result[file] ??= {};
      result[file].hit = Number(line.slice(3));
    } else if (line === "end_of_record") file = null;
  }
  return result;
}

/** Line percentage, floored to 2dp so a baseline never sits above what was measured. */
function pct({ hit, found }) {
  if (!found) return 100;
  return Math.floor((hit / found) * 10000) / 100;
}

const files = testFiles();
const measured = measure(files);
const rows = Object.entries(measured)
  .map(([file, counts]) => ({ file, pct: pct(counts), ...counts }))
  .sort((a, b) => a.file.localeCompare(b.file));

const totalFound = rows.reduce((n, r) => n + r.found, 0);
const totalHit = rows.reduce((n, r) => n + r.hit, 0);
const global = pct({ hit: totalHit, found: totalFound });

if (argv.includes("--update")) {
  const baseline = {};
  for (const r of rows) baseline[r.file] = r.pct;
  writeFileSync(BASELINE, `${JSON.stringify({ global, files: baseline }, null, 2)}\n`);
  console.log(`\nBaseline written: ${rows.length} files, ${global.toFixed(2)}% global.`);

  // A file no test loads cannot be given a floor by measuring — it is absent
  // from the report, so --update cannot write one. Say so here rather than
  // letting the next plain run be the first anyone hears of it.
  const unfloored = unflooredFiles(baseline, measured);
  if (unfloored.length > 0) {
    console.error("\nStill unfloored after the update:\n");
    for (const f of unfloored) console.error(`  ${f}`);
    console.error("");
    exit(1);
  }
  exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  console.error(`No ${BASELINE}. Run: node scripts/coverage.mjs --update`);
  exit(1);
}

const failures = [];
console.log("\nfile                            line %   floor");
console.log("------------------------------------------------");
for (const r of rows) {
  const floor = baseline.files[r.file];
  // No floor is a failure now (see unflooredFiles), reported once at the end.
  // A row can still land here unfloored and legitimately: an UNMEASURED file
  // that some test has started loading.
  const flag = floor === undefined ? "  UNMEASURED" : r.pct < floor ? "  FAIL" : "";
  if (floor !== undefined && r.pct < floor) {
    failures.push(`${r.file}: ${r.pct.toFixed(2)}% is below its floor of ${floor.toFixed(2)}%`);
  }
  console.log(
    `${r.file.padEnd(32)}${r.pct.toFixed(2).padStart(6)}${
      floor === undefined ? "     —" : floor.toFixed(2).padStart(8)
    }${flag}`,
  );
}
console.log("------------------------------------------------");
console.log(`${"all files".padEnd(32)}${global.toFixed(2).padStart(6)}  (reported, not a gate)\n`);

// A file with a floor that is absent from the report is the failure mode
// Node's own report structurally cannot show: it lists only files that were
// *loaded*, so a module that stops being exercised leaves the denominator and
// every percentage RISES. The baseline is a manifest of files expected to be
// reachable, which turns that silent improvement into a hard error.
for (const file of Object.keys(baseline.files)) {
  if (!(file in measured)) {
    failures.push(`${file} has a floor but is absent from the report — nothing loaded it`);
  }
}

failures.push(...unflooredFiles(baseline.files, measured));

if (failures.length > 0) {
  console.error("Coverage floor breached:\n");
  for (const f of failures) console.error(`  ${f}`);
  console.error("\nAdd tests, or if the drop is deliberate, rerun with --update and explain why");
  console.error("in the commit message. Lowering a floor is a decision, not a formality.\n");
  exit(1);
}

console.log("All per-file floors met.\n");
