/**
 * The environment `bash` runs with.
 *
 * Pi builds a bash child's environment from `getShellEnv()`, which is
 * `{...process.env}` with pi's own bin directory prepended to `PATH`. The pi
 * process routinely holds `ANTHROPIC_API_KEY`, and whatever else the user has
 * exported, so a single approved `bash("env")` returned the host's credentials
 * into model context — and from there into the transcript, the session file
 * and every downstream consumer of it (#45).
 *
 * Approval does not cover this. Consent works only if the user understands
 * what they are consenting to, and "run a shell command" does not read as
 * "disclose my keys". The far more common case is worse: a legitimate
 * `npm test` in a shell where a secret happens to be exported, where the
 * disclosure is incidental and invisible to everyone involved.
 *
 * So the environment is an **allowlist**, not a denylist. A denylist of
 * secret-shaped names (`*_KEY`, `*_TOKEN`, `*_SECRET`) catches the obvious
 * cases and misses `SSH_AUTH_SOCK`, `npm_config_//registry:_authToken` and
 * anything the user named themselves. An allowlist is wrong in the direction
 * that fails loudly: a missing variable breaks a command, which is visible and
 * fixable, while a leaked variable is silent and permanent.
 *
 * See docs/bash-env.md for the policy and its reasoning.
 */

import type { BashSpawnContext, BashSpawnHook } from "@earendil-works/pi-coding-agent";

// ── The policy ───────────────────────────────────────────────────

/**
 * Variables a shell command may inherit from the host.
 *
 * Every entry is a path, a locale, or a toolchain flag. None of them is a
 * credential in any environment we could find, which is the only test an entry
 * has to pass — the list is allowed to be generous with non-secrets, because
 * what it costs is nothing and what it buys is `npm test` working.
 *
 * Matching is case-insensitive: environment variable names are conventionally
 * upper-case, Windows treats them case-insensitively, and no name here has a
 * plausible secret-shaped lowercase twin.
 */
export const BASH_ENV_ALLOWLIST: readonly string[] = [
  // Process and shell basics. Without PATH and HOME almost nothing works:
  // HOME is where npm, pip, cargo and git all keep their caches and config.
  "PATH",
  "HOME",
  "PWD",
  "OLDPWD",
  "SHELL",
  "SHLVL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TERM",
  "TZ",
  // Locale. Tools that format numbers or sort text change behaviour without
  // these, which turns a filtered environment into flaky output rather than a
  // clean failure — the worst shape of breakage to debug.
  "LANG",
  "LANGUAGE",
  // Toolchain roots and caches. Paths, all of them.
  "NODE_ENV",
  "NODE_PATH",
  "NODE_OPTIONS",
  "NVM_DIR",
  "NVM_BIN",
  "JAVA_HOME",
  "GOPATH",
  "GOROOT",
  "GOCACHE",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "VIRTUAL_ENV",
  "PYENV_ROOT",
  "PYTHONPATH",
  "CONDA_PREFIX",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  // Windows equivalents. Untested — CI runs ubuntu and macos (see
  // docs/platform-support.md) — but a Windows shell without SYSTEMROOT or
  // COMSPEC does not start at all, so their absence would not be a subtle bug.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMDATA",
];

/**
 * Prefixes allowed wholesale.
 *
 * `LC_` only. It is a closed, standardised set of locale categories
 * (`LC_ALL`, `LC_CTYPE`, `LC_NUMERIC`, …) with no credential-shaped member,
 * and enumerating them would leave the list wrong the moment libc grows
 * another. No other prefix qualifies — `npm_config_` in particular is
 * deliberately absent, because npm stores registry auth tokens in exactly that
 * namespace (`npm_config_//registry.npmjs.org/:_authToken`).
 */
export const BASH_ENV_ALLOW_PREFIXES: readonly string[] = ["LC_"];

/**
 * Set in the child's environment whenever the filter applied.
 *
 * So a shell can tell an allowlisted environment from a naturally sparse one,
 * and `env` describes itself rather than quietly implying the host had nothing
 * else. The value is a flag, never a list of what was withheld — names reach
 * the model only on failure, where they are needed. See `describeWithheld`.
 */
export const BASH_ENV_FILTERED_MARKER = "REPL_BASH_ENV_FILTERED";

/** Extra names to allow, comma-separated. `*` disables the filter entirely. */
export const BASH_ENV_ALLOW_VAR = "REPL_BASH_ENV_ALLOW";

/** Names printed in a failure footer before it starts counting instead. */
const MAX_NAMED_WITHHELD = 10;

// ── Resolution ───────────────────────────────────────────────────

/**
 * Extra allowed names, from the caller or the environment.
 *
 * An explicit `[]` means "no extras" and beats the environment variable, so a
 * caller can pin the policy shut without controlling the variable — the same
 * precedence `httpAllowlist` uses (docs/http-egress.md).
 */
export function resolveBashEnvAllow(configured?: string[]): string[] {
  const raw = configured ?? (process.env[BASH_ENV_ALLOW_VAR] ?? "").split(",");
  return raw.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function isAllowed(name: string, extra: readonly string[]): boolean {
  const upper = name.toUpperCase();
  if (BASH_ENV_ALLOWLIST.some((allowed) => allowed === upper)) return true;
  if (BASH_ENV_ALLOW_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  return extra.some((allowed) => allowed.toUpperCase() === upper);
}

export interface FilteredBashEnv {
  /** What the command runs with. */
  env: NodeJS.ProcessEnv;
  /** Names dropped, sorted. Values are never carried anywhere. */
  withheld: string[];
}

/**
 * Apply the allowlist.
 *
 * `extraAllow` containing `*` returns the environment untouched and withholds
 * nothing — the deliberate opt-out, which has to be typed out to happen. It is
 * the same stance the approval gate takes: strict by default, and the escape
 * hatch is explicit rather than a looser default (docs/approval-grants.md).
 */
export function filterBashEnv(
  env: NodeJS.ProcessEnv,
  extraAllow: readonly string[] = [],
): FilteredBashEnv {
  if (extraAllow.includes("*")) return { env, withheld: [] };

  const kept: NodeJS.ProcessEnv = {};
  const withheld: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isAllowed(name, extraAllow)) {
      kept[name] = value;
    } else {
      withheld.push(name);
    }
  }
  kept[BASH_ENV_FILTERED_MARKER] = "1";
  return { env: kept, withheld: withheld.sort() };
}

// ── The hook ─────────────────────────────────────────────────────

/**
 * Wrap a spawn hook so the filter runs last.
 *
 * Last is the point. `BridgeOptions.bash.spawnHook` is a caller's seam for
 * adding what a command needs; running it first and filtering after means a
 * caller cannot reintroduce a secret by accident, and cannot bypass the policy
 * on purpose without saying so through `bashEnvAllow`. Filtering above the
 * `operations` seam covers custom execution backends too — an SSH backend
 * receives the filtered environment, not the host's.
 */
export function createBashEnvHook(
  extraAllow: readonly string[],
  inner?: BashSpawnHook,
): BashSpawnHook {
  return (context: BashSpawnContext): BashSpawnContext => {
    const base = inner ? inner(context) : context;
    return { ...base, env: filterBashEnv(base.env, extraAllow).env };
  };
}

// ── Visibility ───────────────────────────────────────────────────

/** Every withheld name the failing command or its output already mentions. */
function mentionedIn(withheld: readonly string[], context: string): string[] {
  if (context === "") return [];
  return withheld.filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(context);
  });
}

/**
 * The line appended to a failed command, or `undefined` when nothing was
 * withheld.
 *
 * A command that fails because a variable is missing must be distinguishable
 * from one that fails on its own merits, or the model retries the same command
 * until it runs out of iterations. So every failure says the environment was
 * filtered and how many variables that cost — one line, and enough to stop the
 * loop.
 *
 * **Which** names appear is decided by `context` — the command and its output.
 * A name is only printed when the failure already contains it, which is both
 * the useful case (`ANTHROPIC_API_KEY: unbound variable` is answered by naming
 * that one variable) and the discreet one: the note then tells the model
 * nothing it did not already have. A real host here had 114 withheld
 * variables, and listing them on every failed `npm test` would be noise
 * wrapped around a disclosure. Values are never included, in any case.
 */
export function describeWithheld(withheld: readonly string[], context = ""): string | undefined {
  if (withheld.length === 0) return undefined;

  const opening = `[repl-simple ran this command with an allowlisted environment; ${withheld.length} host variable${withheld.length === 1 ? "" : "s"} withheld`;
  const remedy = `Set ${BASH_ENV_ALLOW_VAR} to a comma-separated list of names to pass one through (docs/bash-env.md).]`;

  const mentioned = mentionedIn(withheld, context);
  if (mentioned.length === 0) return `${opening}. ${remedy}`;

  const named = mentioned.slice(0, MAX_NAMED_WITHHELD).join(", ");
  const rest = mentioned.length - MAX_NAMED_WITHHELD;
  const list = rest > 0 ? `${named}, and ${rest} more` : named;
  return `${opening} — the failure names ${list}. ${remedy}`;
}
