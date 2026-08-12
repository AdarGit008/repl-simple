import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Availability of the external binaries the bridged `find` and `grep` tools
 * shell out to, and the guard that keeps the suite from downloading them.
 *
 * Importing this module sets `PI_OFFLINE=1` unless the caller has already set
 * it. Without that, `pi-coding-agent`'s `ensureTool()` reaches
 * `api.github.com/repos/{sharkdp/fd,BurntSushi/ripgrep}/releases/latest` **in
 * the middle of the test run** and installs an unpinned "latest" binary onto
 * the machine. That is a network dependency on a rate-limited third-party API,
 * and it made two runs of an identical tree disagree — see issue #91.
 *
 * Import this from any test file that exercises `find` or `grep`, directly or
 * through `ReplRunner`. Import order is not critical: `ensureTool` reads the
 * variable when the tool runs, not when it is defined.
 */

// Set before any tool executes. `??=` so an explicit PI_OFFLINE=0 still wins,
// which is the only way to deliberately exercise the download path.
process.env.PI_OFFLINE ??= "1";

const EXE = platform() === "win32" ? ".exe" : "";

/**
 * Mirrors `getToolPath` in pi's `utils/tools-manager.js`: its own bin dir
 * first, then PATH. Kept to those two checks deliberately — a fuller copy of
 * pi's resolution would be a second implementation free to drift from the one
 * that actually runs.
 */
function piBinDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  return envDir ? join(envDir, "bin") : join(homedir(), ".pi", "agent", "bin");
}

function onPath(command: string): boolean {
  try {
    const result = spawnSync(command, ["--version"], { stdio: "pipe" });
    return result.error === undefined || result.error === null;
  } catch {
    return false;
  }
}

function available(binaryName: string, systemNames: string[]): boolean {
  if (existsSync(join(piBinDir(), binaryName + EXE))) return true;
  return systemNames.some(onPath);
}

const HAS_FD = available("fd", ["fd", "fdfind"]);
const HAS_RG = available("rg", ["rg"]);

function missingNames(): string[] {
  const missing: string[] = [];
  if (!HAS_FD) missing.push("fd (or fdfind)");
  if (!HAS_RG) missing.push("rg (ripgrep)");
  return missing;
}

/**
 * Skip reason for tests needing `fd`/`rg`, or `false` when both are present.
 *
 * Pass straight to node:test — `it(name, { skip: BRIDGE_TOOLS_SKIP }, fn)`.
 *
 * Set `REQUIRE_BRIDGE_TOOLS=1` to turn a skip into an immediate, loud failure.
 * CI sets it, because a CI leg that silently skips these tests is the exact
 * "green means nothing" failure bucket 1 exists to eliminate: if the runner's
 * install step ever breaks, the suite must go red rather than quietly drop
 * coverage.
 */
export const BRIDGE_TOOLS_SKIP: string | false = (() => {
  const missing = missingNames();
  if (missing.length === 0) return false;

  const detail =
    `${missing.join(" and ")} not found on PATH or in ${piBinDir()}. ` +
    "The bridged find/grep tools shell out to them. " +
    "Install with `apt install fd-find ripgrep` or `brew install fd ripgrep`.";

  if (process.env.REQUIRE_BRIDGE_TOOLS === "1") {
    throw new Error(
      `REQUIRE_BRIDGE_TOOLS=1 but ${detail}\n` +
        "Set REQUIRE_BRIDGE_TOOLS=0 to skip these tests instead of failing.",
    );
  }

  return detail;
})();
