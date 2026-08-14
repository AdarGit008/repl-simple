#!/usr/bin/env node
/**
 * Run a command inside a transient systemd scope with a hard memory ceiling.
 *
 * Why this exists: tmux 3.4 puts every pane in its own systemd scope, and this
 * user manager runs `DefaultOOMPolicy=stop`. So a single OOM kill *anywhere* in
 * a pane makes systemd tear down the whole scope — every process in it, editor
 * and agent session included, with SIGTERM (exit 143) and no message printed.
 * The suite is heavy enough to trigger that: one full run peaks near 9 GB, and
 * a long-lived worker climbs far past it because `probeTypeCheckerGaps()` leaks
 * ~41 MB per `runInSandbox` call (#68). On 2026-08-13 a single worker reached
 * 13.4 GB and took the pane down with it.
 *
 * `systemd-run --user --scope` moves the job into a scope of its *own*, a
 * sibling of the pane's rather than a child. That is the whole trick: the cap
 * is enforced against the job alone, and if the job does breach it, both the
 * OOM kill and systemd's follow-on teardown are confined to that scope. The
 * pane — and whatever is running in it — never sees it.
 *
 * Deliberately NOT set here:
 *   - `CPUQuota`, because #68's definition of done wants before/after timings
 *     and a throttled scope would make those numbers a fiction.
 *   - swap. `MemorySwapMax=0` makes a breach fail fast instead of thrashing;
 *     swap thrash shows up as test *timeouts*, which is precisely the flapping
 *     signal #109 is trying to measure.
 *
 * A breach must not be silent. It was, once: on 2026-08-14 a full mutation run
 * hit the 12G ceiling at 24%, systemd tore the scope down under the default
 * `OOMPolicy=stop`, and this wrapper reported **exit 0** — because the kill
 * landed on the scope, not on `systemd-run`, so `result.signal` was null and
 * the status was 0. Forty minutes of dead run looked like a clean pass. Two
 * changes stop that repeating:
 *
 *   - `OOMPolicy=continue`, so one OOM kill no longer tears down the whole
 *     scope. The pane is protected by this job living in a scope of its *own*,
 *     not by the teardown, so nothing is lost — and the victim's real exit
 *     status now propagates to the caller instead of vanishing.
 *   - the scope is given a known name and its journal is read afterwards, so
 *     an OOM is reported even when the command itself exits 0.
 *
 * Usage:
 *   node scripts/contained.mjs [--limit SIZE] <command> [args...]
 *
 * Env:
 *   CONTAIN_MEMORY_MAX   default ceiling when --limit is absent (default 12G)
 *   CONTAIN_DISABLE=1    skip containment, run the command directly
 *
 * Containment is skipped — the command still runs — when there is no systemd
 * user session to attach to (CI, a bare container, a non-systemd host). It is a
 * safety net for this box, never a hard requirement for running the suite.
 */
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// npm puts node_modules/.bin on PATH for its own scripts, but this wrapper is
// also meant to be run directly (`node scripts/contained.mjs stryker run`).
// Without this, `tsx` and `stryker` resolve for one caller and not the other.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.PATH = `${join(REPO, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`;

const DEFAULT_LIMIT = process.env.CONTAIN_MEMORY_MAX ?? "12G";

/** Split argv into our own options and the command to run. */
function parseArgs(argv) {
  let limit = DEFAULT_LIMIT;
  let i = 0;
  while (i < argv.length) {
    if (argv[i] === "--limit") {
      limit = argv[i + 1];
      i += 2;
    } else if (argv[i] === "--") {
      i += 1;
      break;
    } else {
      break;
    }
  }
  return { limit, command: argv.slice(i) };
}

/**
 * Whether a transient scope can actually be created here. Checked rather than
 * assumed: on a host without a systemd user session `systemd-run` fails with a
 * bus error, and silently turning that into a test failure would be worse than
 * running uncontained.
 */
function containmentSkipReason() {
  if (process.env.CONTAIN_DISABLE === "1") return "CONTAIN_DISABLE=1";
  if (process.env.CI) return "running under CI";
  if (!process.env.XDG_RUNTIME_DIR) return "no systemd user session";
  const probe = spawnSync("systemd-run", ["--version"], { stdio: "ignore" });
  return probe.status === 0 ? null : "systemd-run unavailable";
}

const { limit, command } = parseArgs(process.argv.slice(2));

if (command.length === 0) {
  process.stderr.write("contained: no command given\n");
  process.exit(2);
}

const skipReason = containmentSkipReason();

/**
 * Whether systemd recorded an OOM kill against this scope.
 *
 * The exit status cannot be trusted to carry this: the kill lands on a process
 * inside the scope, so the caller can — and did — see 0. The journal is the
 * only place the truth is written down.
 */
function scopeWasOOMKilled(unit) {
  const log = spawnSync("journalctl", ["--user", "-u", unit, "--no-pager", "-q"], {
    encoding: "utf8",
  });
  if (log.status !== 0 || !log.stdout) return false;
  return /killed by the OOM killer|result 'oom-kill'/.test(log.stdout);
}

let result;
let unit = null;
if (skipReason === null) {
  unit = `contained-${process.pid}.scope`;
  process.stderr.write(`contained: MemoryMax=${limit}, no swap, unit=${unit}\n`);
  result = spawnSync(
    "systemd-run",
    [
      "--user",
      "--scope",
      "--quiet",
      `--unit=${unit}`,
      "-p",
      `MemoryMax=${limit}`,
      "-p",
      "MemorySwapMax=0",
      // Without this, one OOM kill stops the entire scope and the failure
      // reaches the caller as a success. See the header.
      "-p",
      "OOMPolicy=continue",
      "--",
      ...command,
    ],
    { stdio: "inherit" },
  );
} else {
  process.stderr.write(`contained: ${skipReason} — running uncontained\n`);
  result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
}

if (result.error) {
  process.stderr.write(`contained: ${result.error.message}\n`);
  process.exit(1);
}
// A scope killed on its memory ceiling reports the signal, not an exit code.
if (result.signal) {
  process.stderr.write(`contained: killed by ${result.signal} — likely the ${limit} ceiling\n`);
  process.exit(137);
}
// ...and sometimes reports neither, which is why the journal is consulted even
// when the command claims to have succeeded.
if (unit !== null && scopeWasOOMKilled(unit)) {
  process.stderr.write(
    `contained: OOM kill recorded against ${unit} — the ${limit} ceiling was breached.\n` +
      "contained: whatever the command reported, its results are incomplete.\n",
  );
  process.exit(137);
}
process.exit(result.status ?? 1);
