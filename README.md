# repl-simple

Pi extension — sandboxed Python execution via [Monty](https://github.com/pydantic/monty) (Python-in-WebAssembly interpreter).

## Tools

### REPL (direct)

| Tool | Description |
|------|-------------|
| `repl(code, sessionId?)` | Execute Python in a named session. Variables persist across calls. |
| `repl_resume(sessionId?)` | Resume after a gated tool requires approval. |
| `repl_reset(sessionId?)` | Clear all state in a session. |
| `repl_abandon(sessionId?)` | Discard a pending tool approval. |

### RLM Loop (auto-investigation)

`RLMLoop` runs a code-gen → execute loop: LLM writes Python, sandbox runs it, results fed back until `SUBMIT(answer)`.

`runRlm` declares every `inputs` entry as a sandbox variable and **announces each in the LLM prompt** —
`context` is always declared and defaults to `""`; values render head-and-tail beyond 5000 chars.
Because every input reaches the model, `inputs` must never carry secrets.

| Tool | Description |
|------|-------------|
| `llm_query(prompt)` | Ask the LLM a question from sandbox code. |
| `rlm_query(query, context?)` | Spawn a nested RLM investigation. |
| `SUBMIT(answer)` | Signal completion with final answer. |

### Available Python-side tools

**Pi bridge:** `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`

The four read tools are confined to the project root, as `read_file` and `list_files` always were.
An absolute path outside it, a `..` traversal, and a symlink whose target leaves the tree are all
refused — so `~/.ssh`, `~/.aws`, `~/.config` and sibling checkouts are out of reach, which is a real
cost when the thing you want to read genuinely lives there. The escape hatch is a `bash` call, which
asks for approval first. See [docs/path-jail.md](docs/path-jail.md).

`bash` runs with an **allowlisted environment**, not the host's: `PATH`, `HOME`, the locale and the
toolchain paths are inherited, and everything else — `ANTHROPIC_API_KEY`, `SSH_AUTH_SOCK`,
`npm_config_*`, `PI_*` and whatever else you have exported — is withheld, because approving "run a
shell command" is not approving "disclose my keys". A failed command says how many variables were
withheld, and names the one it referenced. `REPL_BASH_ENV_ALLOW` passes named variables through, and
`REPL_BASH_ENV_ALLOW='*'` turns the filter off. See [docs/bash-env.md](docs/bash-env.md).

**Builtins:** `read_file`, `list_files`, `http_get`

`http_get` is the only way out of the sandbox to the network, so it is never both silent and
unrestricted: with `REPL_HTTP_ALLOWLIST` set the listed hosts are fetched without a prompt and every
other host is refused, and without it every fetch asks for approval. Either way, private, loopback and
link-local destinations are refused on every redirect hop. See
[docs/http-egress.md](docs/http-egress.md).

**Tool store:** `save_tool`, `delete_tool`, `list_saved_tools`, `read_tool`

Saved tools are `.py` files under `.pi/code-tools`, and they execute before your code on every `repl`
call. Because `.pi/` travels with a clone, that used to mean cloning a repository and asking one
question was enough to run its author's Python. They are now loaded **only in a project you have
trusted in pi** — an untrusted project's files are never even read, the session works without them,
and the model is told by name what was withheld so it does not call one and get a bare `NameError`.
Trusted or not, the preamble is capped at 32 files and 64 KiB, and revoking trust stops the code
running rather than waiting for the next session.
See [docs/project-trust.md](docs/project-trust.md).

### Approvals

`bash`, `edit` and `write` ask before they run, and an approval covers **one execution**. The same
command later in the same call, or in the next one, asks again — approving `bash("date")` once buys
that call and nothing else. The one thing that still runs unasked is the replay of a call already
approved and executed, which is served from the cache and executes nothing.

That is strict mode, and it is the default. `/repl-approvals yolo` turns the gate off for the rest of
the pi process; `/repl-approvals strict` and restarting both put it back. Nothing is auto-approved
without a UI, in either mode. `repl_reset` reports the current mode.
See [docs/approval-grants.md](docs/approval-grants.md).

Every approval dialog offers **three answers**: approve, deny, and *decide later*. Deciding later
suspends the session with the call still pending — `repl_resume` asks again, `repl_abandon` throws
it away, and running new code discards it and says so. It is the answer for a call you want to think
about, and it is the only reason `status: "suspended"` exists. Dismissing the dialog is not that
answer: Escape, the timeout and an abort all **deny**.
See [#51](https://github.com/AdarGit008/repl-simple/issues/51).

Every approval dialog is also **answerable and bounded**. The four `repl` tools declare
`executionMode: "sequential"`, so two of them never run at once — two dialogs open together leaves
the first one orphaned and pi with no way back. Escape dismisses a dialog and aborts the run rather
than being swallowed, and a dialog nobody answers denies itself after five minutes.
`REPL_APPROVAL_TIMEOUT_MS` changes that bound, and `0` removes it.
See [#49](https://github.com/AdarGit008/repl-simple/issues/49).

All four tools also **answer in every state**, with a sentence rather than an exception or a message
about some other state. `repl_resume` on a session with nothing pending says so instead of throwing;
`repl_abandon` tells "no such session" apart from "nothing to abandon"; `repl_reset` does not claim
to have reset a session that never existed. A suspension names the session it belongs to, so with
more than one live the model knows which to resume.
See [#48](https://github.com/AdarGit008/repl-simple/issues/48).

## API

```typescript
import {
  // REPL
  ReplRunner,
  // RLM Loop
  RLMLoop,
  getReplPreamble,
  // Sandbox
  runInSandbox,
  resumeSuspended,
  // Worker pool
  getSandboxPool,
  closeSandboxPool,
  poolConfig,
  // Session
  Session,
  // Tool composition
  ToolRegistry,
  createPiBridgeTools,
  createBuiltinTools,
  createRLMTools,
  createToolStoreTools,
  loadSavedTools,
  savedToolNames,
  DEFAULT_PREAMBLE_LIMITS,
  // Types
  HostToolError,
  SubmitSignal,
} from "repl-simple";
```

## Install

```json
{
  "dependencies": {
    "repl-simple": "*"
  }
}
```

The `pi.extensions` field in `package.json` points at `extensions/repl-extension.ts`, which pi
auto-loads to register the `repl` tools. It must name the **file**, not the `extensions/` directory —
pi's discovery path (`<cwd>/.pi/extensions/`, `<agentDir>/extensions/`) passes the manifest entry
straight to its module loader without expanding directories, so a directory entry registers zero
tools. See [#37](https://github.com/AdarGit008/repl-simple/issues/37).

Requires Node **>= 22.19.0** on glibc Linux, macOS, or Windows. **Alpine/musl does not work** —
`@pydantic/monty` publishes no musl binary, and the install succeeds before failing at load. 0.0.21
also ships a wasm runtime at `@pydantic/monty/wasm` that looks like a way around this and is not:
it runs Python in-process, so a runaway blocks the event loop and there is no crash isolation. See
[docs/platform-support.md](docs/platform-support.md).

## Dev

```bash
npm test        # tsx --test test/*.test.ts
npm run check   # tsc --noEmit            (tsconfig.json)
npm run build   # tsc -p tsconfig.build.json
npm run lint    # biome check --error-on-warnings
npm run format  # biome format --write
npm run coverage # per-file line-coverage floors
npm run mutation # stryker, contained in a memory-capped systemd scope
npm run test:contained # the suite, likewise contained
```

Nine environment variables tune the sandbox, all read at call time.

Three are the default resource limits every run gets. A caller who passes no `limits` gets these,
not "no limits" — omission cannot be a way to opt out, because before #32 it was the only way
anything ran and nothing in this repository passed any. Opting out is spelled `limits: "unbounded"`,
which is deliberate, greppable, and documented as holding a pooled worker for as long as the run
lasts.

| variable | default | effect |
|---|---|---|
| `REPL_MAX_DURATION_SECS` | `30` | Interpreter compute budget. **Not wall clock:** the sandbox clock advances only while Python executes and stops while a host tool runs, so `bash("npm test")` costs it nothing. Breach → `errorKind: "timeout"`. |
| `REPL_MAX_MEMORY_MB` | `512` | Sandbox heap ceiling, enforced inside the worker as a catchable `MemoryError` rather than an OOM kill. Breach → `errorKind: "memory"`. |
| `REPL_MAX_WALL_CLOCK_SECS` | `300` | Host wall clock for a whole run, host-tool time included. The only thing that bounds a host tool that never returns — and the only thing that hands that run's worker back. |

The last of those is the fail-safe the other two cannot be. Monty's clock is polled inside the
worker, so it cannot fire while the worker is idle waiting for us: `bash("sleep 99999")` would
otherwise hang the run forever with every in-sandbox limit armed, holding its worker throughout.
`createPiBridgeTools` also gives `bash` a 120 s default timeout of its own, so a hung command fails
as one tool call — leaving the script alive to handle it — rather than as the death of the run.

Two guard against a runaway exhausting the host:

| variable | default | effect |
|---|---|---|
| `REPL_MEMORY_CEILING_MB` | `5120` | Per-process RSS ceiling; `runInSandbox` throws `SandboxMemoryError` at or above it. Clamped down automatically inside a cgroup, since `/proc/meminfo` cannot see a container limit. `0` disables. |
| `REPL_MEMORY_FLOOR_MB` | `0` (off) | Refuse to start when the host has less than this much memory available. Opt-in: whether the machine as a whole is short of memory is not this library's business to police. |

**Both now measure the host process, which is no longer where sandboxed Python allocates.** Python
runs in a worker subprocess, so a script allocating gigabytes grows the worker and is stopped by
`RunLimits.maxMemory` inside it, not by these. What they still catch is growth on *our* side of the
line — accumulated messages, buffers, a caller looping over runs — which is what a host ceiling can
honestly speak to.

Two bound `http_get`. They are egress policy, not resource limits; the reasoning is in
[docs/http-egress.md](docs/http-egress.md).

| variable | default | effect |
|---|---|---|
| `REPL_HTTP_ALLOWLIST` | empty | Comma-separated hosts `http_get` may reach, as a hostname or a `*.`-prefixed suffix. Set → those hosts need no approval and every other host is refused. Unset → every fetch requires approval. |
| `REPL_HTTP_TIMEOUT_SECS` | `30` | Deadline for one `http_get`, redirect chain and body read included. Breach → `TimeoutError` in Python. |

Two size the worker pool. Neither is left to `@pydantic/monty`'s own default, because both of those
fail open: `maxProcesses` follows the CPU count, and `checkoutTimeout` waits **forever**, so an
exhausted pool hangs with no error and no log rather than failing.

| variable | default | effect |
|---|---|---|
| `REPL_POOL_MAX_PROCESSES` | `4` | Worker cap. Sized by memory (~8.5 MB each), not by core count. |
| `REPL_POOL_CHECKOUT_TIMEOUT_SECS` | `30` | How long a run waits for a free worker before failing with `errorKind: "unavailable"` — a `RunError` like any other, not a throw. |

### The worker pool

Python runs in crash-isolated `monty` worker subprocesses checked out of a pool, one pool per
process, created on first use. `closeSandboxPool()` shuts it down; nothing requires you to call it,
since an idle pool holds no handle that keeps the event loop alive.

This is what makes a runaway survivable. Under 0.0.18 the interpreter ran in-process: an infinite
loop fired **zero** host timers in 12 s and needed a SIGKILL of the whole process to clear. The same
loop under a 1 s budget now raises a catchable error at 1.001 s with the host event loop ticking
throughout. A worker that dies outright takes only its own session, and surfaces as
`errorKind: "crashed"` — the one error kind that means the Python state is gone rather than merely
errored, so there is nothing left to resume against.

Two TypeScript configs, deliberately:

- **`tsconfig.json`** — what the compiler *checks*: `src/`, `test/` **and** `extensions/`. It is the
  default config, so editors and a bare `tsc` see the same program CI does.
- **`tsconfig.build.json`** — what the compiler *emits*: `src/` and `test/`. `extensions/` is checked
  but not built, because pi loads the `.ts` source directly through jiti and resolves `typebox` and
  `@earendil-works/pi-coding-agent` from its own install.

`typebox` is a devDependency pinned to the exact version pi pins (`1.3.7`). It is a compile-time
need only — pi supplies it at runtime via a loader alias — and a range rather than a pin could drift
the types the compiler checks away from the ones that actually run.

### Formatting and lint

[Biome](https://biomejs.dev) is the single formatter and linter — `npm run lint` runs `biome check`,
covering the formatter, the linter and import sorting in one pass. `.editorconfig` carries the
settings an editor can apply without Biome installed; `biome.json` reads it (`useEditorconfig`) and
adds a 100-column line width.

`--error-on-warnings` is what makes it a gate. Biome exits 0 on warning-severity diagnostics by
default, so a rule like `noExplicitAny` would print and still pass. CI runs lint as its own job,
once — formatting does not vary by platform or Node version, so it does not belong on the matrix.

`@biomejs/biome` is pinned exactly, for the same reason `typebox` is: a linter on a caret range can
turn a green `main` red on a new minor that adds a rule, with no change to this repo.

**Import sorting is off.** Biome 2's `organizeImports` assist sorts every import and re-export in a
file as one alphabetical block, ignoring the blank lines between them. `src/index.ts` is a barrel
organised into commented sections (`// ── Registry ──`, `// ── Sandbox ──`, …); sorting it globally
detached every section comment from the exports it labels. Deterministic import order is not worth
losing authored structure in a change whose whole premise is that it alters no behaviour.

Two lint rules are configured away from their defaults, both deliberately:

- **`useTemplate: "error"`** — promoted from Biome's default `info`, which never fails a build. A rule
  that cannot go red is decoration.
- **`noNonNullAssertion: "off"`** — `strictNullChecks` already covers the safety case; the rule is a
  style preference about how an already-established invariant is spelled. Its three `src/` sites sit
  in code that [#84](https://github.com/AdarGit008/repl-simple/issues/84),
  [#50](https://github.com/AdarGit008/repl-simple/issues/50) and
  [#78](https://github.com/AdarGit008/repl-simple/issues/78) are actively rewriting; worth revisiting
  once they land.

The bulk-format commit is listed in `.git-blame-ignore-revs`. To skip it in blame locally:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

### Coverage floors

`npm run coverage` runs the suite under Node's `--experimental-test-coverage` and enforces a
**per-file** line-coverage floor from `coverage-baseline.json`. `npm run coverage:update` rewrites the
baseline; lowering a floor is a decision to explain in the commit message, not a formality.

Floors are per file because a global number does not bite. Deleting `test/sandbox.test.ts` — 1811
lines, and the only file that kills any `sandbox.ts` mutation — moves the global figure from 96.92%
to **93.64%**, a drop a round global floor of 90% survives without noticing. The same deletion drops
`src/sandbox.ts` from 97.06% to 83.63%, which the per-file floor catches. (Re-measured on 0.0.21;
the same experiment on 0.0.18 moved the global figure by 0.55 pp.)

**This is not a quality gate.** Coverage says lines executed, not that anything was asserted, and this
suite has a documented history of tests that execute plenty and assert nothing (see
[#23](https://github.com/AdarGit008/repl-simple/issues/23)). The mutation score from
[#24](https://github.com/AdarGit008/repl-simple/issues/24) is the quality gate. This is a cheap
regression detector that runs in seconds — do not let a coverage number justify skipping a test.

**Adding a file under `src/` or `extensions/` means re-running `coverage:update` in the same change.**
A source file with no floor has no gate, so the run fails until it gets one. If a file genuinely
belongs outside the instrument, add it to `UNMEASURED_SOURCE_FILES` in `scripts/coverage.mjs` with its
reason — `src/index.ts` is there today, a pure re-export barrel that `npm run check` already gates.
Opting out has to be an edit somebody makes.

Four things worth knowing before relying on it:

- **`test/extension-loader.test.ts` is excluded from the coverage run** (not from `npm test`). It
  drives pi's real `discoverAndLoadExtensions`, which loads `src/` a second time through pi's jiti
  loader; Node merges V8 coverage by file path, so those barely-executed duplicates land on top of the
  real entries. With it in the run, `src/sandbox.ts` reports **41.44%** against a true **97.06%**, and
  the global figure reads 59.25% instead of 96.92%. Coverage cannot fall as tests are added — the low
  number is the instrument misreporting, not a gap.
- **Node's report cannot see a module that stopped being loaded.** It lists only files that were
  loaded, so a module dropping out of the suite leaves the denominator and every percentage *rises*.
  `coverage-baseline.json` doubles as a manifest for exactly this: a file with a floor that is absent
  from the report is a hard error.
- **A floor proves the lines run, not that the file's own tests do.** `src/truncate.ts` measures 100%
  with `test/truncate.test.ts` deleted — the sandbox tests route enough output through the truncator to
  execute every line of it. The floor still catches a *regression* in `truncate.ts`, which is its job;
  it will not notice its test file leaving. Nothing here substitutes for
  [#24](https://github.com/AdarGit008/repl-simple/issues/24).
- **Two files' coverage varies between identical runs**, so `coverage:update` alone can write a floor
  that flakes red. Measured over six back-to-back runs of the same tree: `src/truncate.ts` reports
  99.74% or 100.00%, `src/registry.ts` 99.50% or 100.00%. The varying line in `truncate.ts` is
  `truncateText`'s declaration, and the lcov record shows it is the *instrument* that varies, not the
  suite — in the low run the function's body carries a hit count of 380 while its declaration line
  reads 0:

  ```
  DA:384,0      export function truncateText(     ← the declaration
  DA:385,380      text: string,
  DA:388,380      const t = new Truncator(opts);  ← the body, 380 executions
  ```

  A function cannot run its body 380 times without being called. Nothing about test execution
  differed between the runs; V8's per-function range count is lost when coverage from several test
  processes is merged, while the block counts inside it survive. **A file that varies gets its floor
  set by hand at the low observation, not at whatever `--update` happened to measure** —
  `truncate.ts` is pinned to 99.74 for this reason. Which end you land on is machine-dependent:
  `registry.ts` reported its high in five of six local runs and its low on both CI runs of the same
  commit. This is *not*
  [#109](https://github.com/AdarGit008/repl-simple/issues/109) — that is real ordering-dependent
  behaviour in the rlm tests, whereas nothing here executes differently.

CI runs coverage as its own job on Node 24 / ubuntu only. The floors are exact measured numbers, and
V8 line attribution differs enough between Node majors that a baseline shared across the matrix would
have to be slackened until it stopped biting.

### Mutation score

`npm run mutation` mutates `src/` and `extensions/` and fails below a **58%** floor
(`thresholds.break`), just under the **58.09%** baseline. Full write-up, per-file scores and the
reasoning behind every config value: [docs/mutation-testing.md](docs/mutation-testing.md).

**The baseline predates the Monty 0.0.21 migration and has not been re-measured against it.**
`src/sandbox.ts` was rewritten and `src/pool.ts` is new, so both the mutant population and the score
have moved by an unknown amount, in an unknown direction. The floor is not a CI gate — mutation runs
on demand, not in `.github/workflows/ci.yml` — so nothing is silently passing on a stale number, but
treat the 57% as unverified until a full sweep re-baselines it.

This is the quality gate the coverage floors above are explicitly *not*. It is also expensive —
**~33 CPU-hours** for a full run, because the command runner re-runs all 465 tests per mutant with no
per-test filtering. Two consequences:

- **Run it with `npm run mutation`**, which contains it in a systemd scope with a memory ceiling so
  a breach cannot take your terminal session down with it. `npm test` is already parallel, so
  Stryker's `concurrency` multiplies against node's own fan-out; size it by **RAM**, not by cores.
  One worker is ~1 GB and the committed `concurrency: 2` is ~2 GB — see
  [`docs/mutation-testing.md`](docs/mutation-testing.md), which records how that number was wrong
  twice before it was right. The containment is **not** lifted by the move to worker subprocesses;
  if anything it matters more, since a scope's cgroup accounts for a process tree while the
  `REPL_MEMORY_CEILING_MB` guard only sees the host process. The sizing figures above predate the
  migration and each Stryker worker now spawns monty workers of its own.
- **Use `--incremental` or `--since` on pull requests**, and run the full sweep on a schedule or on
  demand.

The floor sits 0.09 under the baseline, which is rounding room rather than slack: the reproducibility
band that once justified a wider gap was an artefact of a harness scoring runs that never happened,
and it closed with [#109](https://github.com/AdarGit008/repl-simple/issues/109). A run coming in
under the floor is a regression to explain, not a threshold to lower.

### Optional: `fd` and `ripgrep`

The bridged `find` and `grep` tools shell out to `fd` and `rg`. Install them to run the tests that
exercise those two tools:

```bash
apt install fd-find ripgrep     # Debian/Ubuntu
brew install fd ripgrep         # macOS
```

Without them, those tests **skip** with a message naming what is missing; the rest of the suite runs
normally. The suite never downloads them: `test/support/bridge-tools.ts` sets `PI_OFFLINE=1`, which
stops `pi-coding-agent` fetching an unpinned "latest" binary from GitHub releases mid-run. Set
`REQUIRE_BRIDGE_TOOLS=1` to turn the skip into a failure instead — CI does, so a broken install step
goes red rather than quietly dropping coverage.

CI (`.github/workflows/ci.yml`) runs `npm ci && npm run check && npm test` on Node 22 and 24 across
ubuntu-latest and macos-latest, for every push and pull request.
