#!/usr/bin/env node
/**
 * Run the test suite for Stryker, and refuse to report a verdict the run did
 * not actually produce.
 *
 * Why this exists: Stryker's `command` test runner infers the entire verdict
 * from the exit code — `command-test-runner.js`, `if (exitCode === 0) Success
 * else Failed`. It never reads the output. So "a test caught the mutant" and
 * "the harness died" are the same event to it, and a harness killed by the OOM
 * killer (which delivers `code === null`, not 0) is silently recorded as a
 * **killed mutant**.
 *
 * That is not hypothetical. It is what #109 turned out to be: mutants in
 * `rlm.ts`/`rlm_loop.ts` change loop iteration counts, hence sandbox call
 * counts, hence memory — and against the ~41 MB/call leak that #116 later
 * fixed, that was enough to push a worker into an OOM kill. Every such kill
 * scored as a mutant caught, so the *more* memory a run consumed the *better*
 * the tree appeared to be tested. Two runs of one tree disagreed by 18 mutants
 * and 0.42 points. Proven by SIGKILLing the harness after a fully green suite:
 * a stably-surviving mutant flipped to `Killed`.
 *
 * The fix is to read what Stryker won't. Node's test runner prints a summary
 * (`ℹ fail N`) on every genuine outcome, pass or fail. If the summary is
 * absent the suite did not finish, whatever the exit code says:
 *
 *   summary, fail = 0   -> exit 0    the mutant survived
 *   summary, fail > 0   -> exit 1    the mutant was killed, by a real test
 *   no summary          -> retry; if it keeps dying, record it and shout
 *
 * Note the first case covers the demonstrated failure exactly: a suite that
 * passes and *then* dies is a surviving mutant, and this exits 0 for it.
 *
 * A death that survives its retries cannot be turned into an honest verdict
 * here — Stryker's command runner has no "measurement failed" channel, only
 * pass and fail. So it is logged instead, and `--report` fails the whole run
 * afterwards. A wrong number that announces itself beats a wrong number that
 * doesn't.
 *
 * Usage:
 *   node scripts/mutation-guard.mjs            run the suite, guarded
 *   node scripts/mutation-guard.mjs --report   summarise the log, exit 1 on any fatal death
 *
 * Env:
 *   MUTATION_GUARD_RETRIES   attempts after the first death (default 2)
 *   MUTATION_GUARD_LOG       log path (default .stryker-harness-deaths.log)
 *   MUTATION_GUARD_COMMAND   suite command (default: the tsx --test line below)
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.PATH = `${join(REPO, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`;

/**
 * The real project root, given the directory this script is running from.
 *
 * Stryker copies the project into `<root>/<tempDirName>/sandbox-<id>` and runs
 * the command there, so this script resolves to a throwaway copy and anything
 * written beside it is deleted with the sandbox when the run ends. The log has
 * to outlive that. Found the hard way: the first version logged into the
 * sandbox, so a death was recorded and then discarded — the guard failing in
 * precisely the silent way it exists to prevent.
 */
function projectRoot(dir) {
  const sandbox = dir.match(/^(.*)\/[^/]*stryker[^/]*\/sandbox-[^/]+$/);
  return sandbox ? sandbox[1] : dir;
}

const LOG =
  process.env.MUTATION_GUARD_LOG ?? join(projectRoot(REPO), ".stryker-harness-deaths.log");
const RETRIES = Number(process.env.MUTATION_GUARD_RETRIES ?? "2");
const COMMAND =
  process.env.MUTATION_GUARD_COMMAND ?? "npx tsx --test --test-concurrency=3 test/*.test.ts";

/**
 * The number of failing tests, or null if the suite never reported a summary.
 *
 * Null is the whole point: it is the difference between a verdict and a
 * casualty. Both spellings are accepted so a `--test-reporter` change does not
 * silently turn every death into a passing run.
 */
function failuresReported(output) {
  const spec = output.match(/^\s*(?:ℹ\s*)?fail\s+(\d+)\s*$/m);
  if (spec) return Number(spec[1]);
  const tap = output.match(/^#\s*fail\s+(\d+)\s*$/m);
  return tap ? Number(tap[1]) : null;
}

/** Run the suite once. Returns its combined output and how it ended. */
function runSuite() {
  const result = spawnSync(COMMAND, {
    cwd: REPO,
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, REQUIRE_BRIDGE_TOOLS: "1" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { output, status: result.status, signal: result.signal };
}

if (process.argv.includes("--report")) {
  if (!existsSync(LOG)) {
    process.stdout.write("mutation-guard: no harness deaths recorded\n");
    process.exit(0);
  }
  const lines = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean);
  const deaths = lines.map((l) => JSON.parse(l));
  const fatal = deaths.filter((d) => d.fatal);
  const recovered = deaths.length - fatal.length;
  process.stdout.write(
    `mutation-guard: ${deaths.length} harness death(s) — ${recovered} recovered on retry, ` +
      `${fatal.length} fatal\n`,
  );
  for (const d of fatal) {
    process.stdout.write(`  mutant ${d.mutant}: died ${d.attempts}x, last signal ${d.signal}\n`);
  }
  if (fatal.length > 0) {
    process.stdout.write(
      "\nThese mutants were scored from a suite that never finished. The score is not\n" +
        "trustworthy — find the cause (memory ceiling is the usual one) and re-run.\n",
    );
    process.exit(1);
  }
  process.exit(0);
}

// Stryker sets this per mutant run; it is absent for the initial dry run.
const mutant = process.env.__STRYKER_ACTIVE_MUTANT__ ?? "(dry run)";

// A fresh run starts a fresh log, so `--report` cannot pass on a stale file or
// fail on deaths from a run that has already been dealt with.
if (mutant === "(dry run)" && existsSync(LOG)) rmSync(LOG);

let last = null;
for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
  last = runSuite();
  const failures = failuresReported(last.output);

  if (failures !== null) {
    process.stdout.write(last.output);
    if (attempt > 1) {
      appendFileSync(
        LOG,
        `${JSON.stringify({ mutant, attempts: attempt - 1, signal: last.signal, fatal: false })}\n`,
      );
    }
    process.exit(failures > 0 ? 1 : 0);
  }

  process.stderr.write(
    `mutation-guard: suite produced no summary for mutant ${mutant} ` +
      `(attempt ${attempt}/${RETRIES + 1}, status ${last.status}, signal ${last.signal}) — ` +
      `the harness died rather than the tests failing\n`,
  );
}

appendFileSync(
  LOG,
  `${JSON.stringify({ mutant, attempts: RETRIES + 1, signal: last.signal, fatal: true })}\n`,
);
process.stdout.write(last.output);
process.stderr.write(
  `mutation-guard: mutant ${mutant} never produced a summary. Its verdict is a guess; ` +
    "see --report at the end of the run.\n",
);
// Nothing here is honest. Exiting nonzero at least matches Stryker's own
// pre-existing behaviour, so the log and --report are what carry the truth.
process.exit(1);
