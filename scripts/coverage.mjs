#!/usr/bin/env node
// Per-file line-coverage floors.
//
// Usage:
//   npm run coverage             measure, compare against the baseline
//   npm run coverage:update      measure 3×, rewrite the baseline (or refuse)
//
// (Runs via `tsx` — the script imports `./coverage-core.ts`, which plain
// `node` cannot load.)
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
//
// Update semantics (#113): a single observation is not a floor. V8 loses
// per-function range counts when coverage from several test processes is
// merged, so identical runs of the same tree differ by a line on some files
// (`src/truncate.ts` measures 99.74% or 100.00%). `--update` measures N times,
// writes the per-file minimum, and refuses to write when a file's spread
// exceeds one line's worth — the decision arithmetic lives in
// `scripts/coverage-core.ts`, unit-tested. The plain gate fails a file only
// when it is *more than one line* below its floor: the instrument cannot
// resolve sub-line differences.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";

import { belowFloor, combineRuns, keepFloorable, pct, refusalReasons } from "./coverage-core.js";

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

/** Every tracked source file expected to carry a floor.
 *
 * `scripts/` is deliberately outside the universe: tooling, not package
 * surface. Its modules can still load in tests and appear in the report —
 * they print as UNMEASURED and are never floored, because their line counts
 * track comment density (V8 counts comment lines of tsx-transformed files as
 * uncovered), not behavior. See `keepFloorable` in `scripts/coverage-core.ts`.
 */
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
        "--",
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

/** How many measurements an update takes. The low observation is rare — the issue saw it once in six runs. */
const UPDATE_RUNS = 3;

/** Rows plus the run's global, the shape `combineRuns` consumes. */
function runResult(measured) {
  const rows = Object.entries(measured)
    .map(([file, counts]) => ({ file, pct: pct(counts), ...counts }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const totalFound = rows.reduce((n, r) => n + r.found, 0);
  const totalHit = rows.reduce((n, r) => n + r.hit, 0);
  return { global: pct({ hit: totalHit, found: totalFound }), rows };
}

const files = testFiles();

if (argv.includes("--update")) {
  // #113: measure N times and write the per-file minimum. Blind `min` is not
  // safe on its own — if a whole process's data is ever genuinely lost, `min`
  // would bake a badly slack floor into the baseline and call it normal — so
  // a spread wider than the known one-line defect refuses the write instead.
  const runs = [];
  const floorable = new Set(sourceFiles());
  let measured;
  for (let i = 0; i < UPDATE_RUNS; i++) {
    console.log(`\nUpdate measurement ${i + 1}/${UPDATE_RUNS}:`);
    measured = measure(files);
    runs.push(keepFloorable(runResult(measured), floorable));
  }
  const combined = combineRuns(runs);

  // The measured spread is printed so a file that starts varying becomes
  // visible rather than being silently absorbed.
  const varying = Object.entries(combined.files)
    .map(([file, f]) => ({ file, ...f, spread: f.max - f.min }))
    .filter((r) => r.spread > 0)
    .sort((a, b) => b.spread - a.spread);
  if (varying.length > 0) {
    console.log("\nfile                            min     max    spread");
    console.log("------------------------------------------------");
    for (const r of varying) {
      console.log(
        `${r.file.padEnd(32)}${r.min.toFixed(2).padStart(6)}${r.max.toFixed(2).padStart(8)}${r.spread
          .toFixed(2)
          .padStart(9)}`,
      );
    }
    console.log("------------------------------------------------");
  } else {
    console.log(`\nNo file varied across the ${UPDATE_RUNS} runs.`);
  }

  const refusals = refusalReasons(combined, UPDATE_RUNS);
  if (refusals.length > 0) {
    console.error(
      "\nRefusing to write the baseline — variance wider than the known one-line defect:\n",
    );
    for (const f of refusals) console.error(`  ${f}`);
    console.error(
      "\nWide variance is a thing to look at, not to average away. Nothing was written.\n",
    );
    exit(1);
  }

  const baseline = {};
  for (const [file, f] of Object.entries(combined.files)) baseline[file] = f.min;
  writeFileSync(
    BASELINE,
    `${JSON.stringify({ global: combined.global, files: baseline }, null, 2)}\n`,
  );
  console.log(
    `\nBaseline written: ${Object.keys(baseline).length} files, ${combined.global.toFixed(
      2,
    )}% global (per-file minima over ${UPDATE_RUNS} runs).`,
  );

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
  console.error(`No ${BASELINE}. Run: npm run coverage:update`);
  exit(1);
}

const measured = measure(files);
const { rows, global } = runResult(measured);

const failures = [];
console.log("\nfile                            line %   floor");
console.log("------------------------------------------------");
for (const r of rows) {
  const floor = baseline.files[r.file];
  // No floor is a failure now (see unflooredFiles), reported once at the end.
  // A row can still land here unfloored and legitimately: an UNMEASURED file
  // that some test has started loading.
  //
  // The comparison carries a one-line tolerance (#113/#132): the instrument
  // cannot resolve sub-line differences, so a file fails only when it is more
  // than one line below its floor. The manifest checks below stay exact.
  const breach = floor !== undefined && belowFloor(r.pct, floor, r.found);
  const flag = floor === undefined ? "  UNMEASURED" : breach ? "  FAIL" : "";
  if (breach) {
    failures.push(
      `${r.file}: ${r.pct.toFixed(2)}% is more than one line below its floor of ${floor.toFixed(2)}%`,
    );
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
