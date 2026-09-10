# repl-simple

Pi extension — sandboxed Python execution via [Monty](https://github.com/pydantic/monty) (Python-in-WebAssembly interpreter).

## Sandbox

Code runs in [Monty](https://github.com/pydantic/monty) (Python-in-WebAssembly), not a host
Python, so the standard library is a fixed, closed set: **there are no third-party packages** and
no way to install one, and most of the stdlib is absent.

**Importable modules** — exactly these, verified against the pinned Monty 0.0.21. The code probes
this at runtime (`probeImportableModules()` over `CANDIDATE_MODULES` in `src/registry.ts`), so the
live answer follows the installed interpreter:

`os`, `sys`, `json`, `re`, `datetime`, `math`, `typing`, `pathlib`, `asyncio`, `collections`,
`itertools`, `dataclasses`

Anything else — `time`, `random`, `subprocess`, `socket`, `functools`, `hashlib`, `requests`,
`numpy` and the rest — is refused by Monty's type checker as an unresolved import, before any code
runs. There is no `subprocess` or `socket`: sandboxed Python cannot spawn processes or open
sockets, and filesystem access goes through the host tools (and, for embedded use, an explicit
mount) — never through `open()` on arbitrary host paths.

**Language limits.** A few Python features raise `NotImplementedError` instead of running:

- **`yield`** — generators are not implemented.
- **`match` statements** — pattern matching is not implemented.
- **class inheritance and metaclasses** — a plain `class` with methods and `__init__` works, but
  `class B(A)` raises `NotImplementedError`.

## Tools

### REPL (direct)

| Tool | Description |
|------|-------------|
| `repl(code, sessionId?)` | Execute Python in a named session. Variables persist across calls. |
| `repl_resume(sessionId?)` | Resume after a gated tool requires approval. |
| `repl_reset(sessionId?)` | Clear all state in a session. |
| `repl_abandon(sessionId?)` | Discard a pending tool approval. |

### The session pool

Sessions are pooled per project directory, with a **cap of 32 live sessions** and **LRU eviction**
when a new one would exceed it: the session used least recently is dropped first. The knobs, in
precedence order: `ReplRunnerOptions.maxSessions` (embedders) > `REPL_MAX_SESSIONS` env (positive
integer) > 32. A dropped session is gone — its variables, imports and cache are released, and the
next `repl` call on that id starts fresh.

**A session with a pending approval is never evicted, and neither is one whose call is still
running.** Evicting either would discard a call the user was asked to approve — or may be about to
be — with the model never told, so the pool temporarily exceeds its cap rather than drop it. The
over-cap state is self-limiting (every suspension demands user attention) and ends the moment the
session is no longer suspended or busy. `repl_reset` also removes the session from the pool, not
just its state: after a reset, `repl_resume` on that id says no session exists, and the next
`repl` call recreates it.

**Sessions belong to one Pi conversation.** When it ends — `/new`, `/resume`, `/fork`, or quitting
pi — every REPL session is disposed, and a call that was still waiting for approval is reported as
dropped: it never executed. The same `sessionId` in the next conversation is a new, empty REPL; the
`repl` tool description says so, because the model cannot tell that from the string. Runners are
keyed by working directory. In pi 0.84.1 `ctx.cwd` is fixed for the life of a conversation, so that
is one runner per conversation in practice; the keying is what keeps the path jail, the preamble
root and the bridge tools rooted where the call was made should a host ever vary it.
See [#60](https://github.com/AdarGit008/repl-simple/issues/60).

Concurrent `repl` calls on one `sessionId` share a single session creation — before #59, two
overlapping calls each built a session and the loser was silently discarded while both reported
success. See [#59](https://github.com/AdarGit008/repl-simple/issues/59).

### The tool trace

Every host-tool call a `repl` or `repl_resume` call makes — each jailed `read`, each `http_get`,
each gated `write` and whether it was approved — is reported on the tool result's `details`, which
pi persists and hands to the renderer, and listed under the result in the TUI: collapsed, one
summary line; expanded, one line per call with its arguments, duration, outcome and what the
built-in tool reported (a truncated read, `bash`'s full-output path). Arguments are masked with the
shared redaction helper and cut head-only at 256 bytes, so a `write` of a file or a pasted token
never lands in the session file; results and `stdout` are not in the trace at all. Only calls that
executed are listed — a call served from the replay cache is not. For embedders,
`ReplRunner.runWithTrace()` / `resumeWithTrace()` return the same text as `run()` / `resume()` plus
the calls, verbatim (`RunTrace`, `TracedCall` and `TraceStatus` are exported). The trace is in
dispatch order; where each call fell in `stdout` is the sandbox's to report per call (`seq`, #46),
not the runner's to reconstruct.
See [docs/tool-trace.md](docs/tool-trace.md) and
[#46](https://github.com/AdarGit008/repl-simple/issues/46).

### RLM Loop (auto-investigation)

`runRlm` is the single RLM entry point: it runs a code-gen → execute loop — the LLM writes Python,
the sandbox runs it, and the results are fed back until `SUBMIT(answer)`.

Each iteration runs in a fresh sandbox — no variables, imports, or state carry over between
iterations, so each snippet must be self-contained. Diagnostics fed back to the model are
offset-corrected: line numbers refer to the model's own code, and no preamble source is shown
([#77](https://github.com/AdarGit008/repl-simple/issues/77)).

`runRlm` declares every `inputs` entry as a sandbox variable and **announces each in the LLM prompt** —
`context` is always declared and defaults to `""`; values render head-and-tail beyond 5000 chars.
Because every input reaches the model, `inputs` must never carry secrets.

The three RLM tools below are self-registered by `runRlm` and available inside the sandbox;
`rlm_query` can spawn a nested `runRlm`, bounded by `maxDepth` (default 1). Each result carries a
`status` (`ok` / `max_iterations` / `budget_exhausted` / `aborted` / `error`), an `answer`, and an
`answerSource` (`submitted` / `salvaged` / `synthesised`) describing where the answer came from.

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
running rather than waiting for the next session. Once trusted, the set of saved tools is
remembered — a sha256 manifest under `$XDG_STATE_HOME/repl-simple` (or `REPL_PREAMBLE_STORE_DIR`),
never inside the project — and a file added or rewritten afterwards is withheld with a
`[preamble changed]` notice until the set is accepted again; the agent's own `save_tool` /
`delete_tool` keep it current in a trusted project, and `/repl-accept-preamble` accepts the whole
current set. A `.pi/code-tools` that cannot be listed, or that resolves outside the project, loads
nothing and says which.
See [docs/project-trust.md](docs/project-trust.md).

The four management tools resolve inside `repl` in every session, and they tell the truth about what
**this session** actually loaded: `list_saved_tools` annotates every name that is not running
(`[not loaded: …]`), `read_tool` refuses to read an untrusted project's files and labels source the
session did not load, `delete_tool` removes a tool so **new sessions** stop running it, and
`save_tool` asks for approval because what it writes executes automatically at the start of every
future session.

### Approvals

`bash`, `edit` and `write` ask before they run, and an approval covers **one execution**. The same
command later in the same call, or in the next one, asks again — approving `bash("date")` once buys
that call and nothing else. The one thing that still runs unasked is the replay of a call already
approved and executed, which is served from the cache and executes nothing.

That is strict mode, and it is the default. `/repl-approvals yolo` turns the gate off for the rest of
the pi process; `/repl-approvals strict` and restarting both put it back. Nothing is auto-approved
without a UI, in either mode. `repl_reset` reports the current mode.
See [docs/approval-grants.md](docs/approval-grants.md).

Every approval dialog offers **four answers**: approve, deny, *decide later*, and *deny remaining*.
Deciding later suspends the session with the call still pending — `repl_resume` asks again,
`repl_abandon` throws it away, and running new code discards it and says so. It is the answer for a
call you want to think about, and it is the only reason `status: "suspended"` exists. Denying the
remaining refuses the call on screen and every gated call after it in the same `repl` or
`repl_resume` call, without asking again. Dismissing the dialog is neither of those: Escape, the
timeout and an abort all **deny**.
See [#51](https://github.com/AdarGit008/repl-simple/issues/51).

Every approval dialog is also **counted**. One `repl` or `repl_resume` call opens at most **8**
dialogs (`MAX_DIALOGS_PER_CALL`); gated calls past that are denied without a dialog, and the result
ends with an `[approval cap]` paragraph so the model asks you rather than retrying. Only dialogs
actually opened count — yolo mode, a headless run and a replayed call spend nothing — and the count
restarts on every `repl_resume`. The dialog title says where it sits (`dialog 3 of 8`). A cap and a
"deny remaining" only ever reduce what gets approved; nothing was added that makes approving easier.
See [#35](https://github.com/AdarGit008/repl-simple/issues/35).

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
  ReplRunner, // new ReplRunner(cwd, { isProjectTrusted, maxSessions?, preambleStoreDir? }); run()/runWithTrace()
  // RLM Loop
  runRlm,
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

In addition to `@pydantic/monty`, `repl-simple` requires the host pi environment to provide
`@earendil-works/pi-coding-agent` — a **peer dependency** satisfied by pi itself, which supplies it at
runtime. It is deliberately *not* a regular dependency: that would let the registry install a second
copy alongside the one pi already owns. It stays in `devDependencies` so local development's types
and factories match the host's, exactly as upstream pi-code-tool does.

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
npm run lint    # biome check --error-on-warnings && knip
npm run format  # biome format --write
npm run coverage # per-file line-coverage floors
npm run mutation # stryker, contained in a memory-capped systemd scope
npm run test:contained # the suite, likewise contained
```

### Module map

The two names that read as a transposition are not one
([#174](https://github.com/AdarGit008/repl-simple/issues/174), session decision 16: documented,
not renamed):

| Path | What it is |
|---|---|
| `src/repl.ts` | `ReplRunner` — the **runner** behind the `repl` / `repl_resume` / `repl_reset` / `repl_abandon` tools: the session pool, project trust and the accepted set, the trace. Nothing RLM. |
| `src/rlm.ts` | `runRlm` — the RLM **loop**: code-gen → execute → feedback until `SUBMIT`, with its prompt budgets, spend budget and salvage. |
| `src/rlm_tools.ts` | The loop's sandbox-side tools — `llm_query`, `rlm_query`, `SUBMIT` — registered by `runRlm` for the sandbox, not by the extension. |
| `repl/repl_server.py` | The bundled Python **preamble** the loop prepends (`getReplPreamble()`; the path is hard-coded in `src/preamble.ts`, and `repl/` is in `package.json` `files` so it ships). Named after pi-reepl's server, which it descends from. |
| `src/session.ts` | `Session` — transcript replay, the call cache, dumps ([docs/session-replay.md](docs/session-replay.md)). |
| `src/sandbox.ts`, `src/pool.ts` | One Monty run — dispatch loop, approval gate, limits — and the worker pool it checks out of. |
| `src/registry.ts`, `src/builtins.ts`, `src/bridge.ts`, `src/toolstore.ts` | Host tools: the registry and stubs, the builtins, the jailed pi bridge, the saved-tool store. |
| `extensions/repl-extension.ts` | The pi extension: registers the four tools and the `/repl-*` commands, renders results and the trace. |

A rename would orphan the `coverage-baseline.json` keys, reopen the package `files` list (#81) and
touch the pinned `scriptName` default `"rlm.py"` (`src/rlm.ts`, `test/rlm.test.ts` M21) that the
diagnostic line-number regex reads; the map is what makes the names harmless.

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
- **`tsconfig.build.json`** — what the compiler *emits*: `src/` only, flat into `dist/` (its
  `rootDir` is `src`, so `dist/` mirrors `src/`). `extensions/` is checked but not built, because pi
  loads the `.ts` source directly through jiti and resolves `typebox` and
  `@earendil-works/pi-coding-agent` from its own install.

`typebox` is a devDependency pinned to the exact version pi pins (`1.3.7`). It is a compile-time
need only — pi supplies it at runtime via a loader alias — and a range rather than a pin could drift
the types the compiler checks away from the ones that actually run.

### Formatting and lint

[Biome](https://biomejs.dev) is the single formatter and linter — `npm run lint` runs `biome check`,
covering the formatter, the linter and import sorting in one pass, and then
[knip](https://knip.dev), the unused-export check that keeps the public barrel honest
([#85](https://github.com/AdarGit008/repl-simple/issues/85)). `.editorconfig` carries the settings
an editor can apply without Biome installed; `biome.json` reads it (`useEditorconfig`) and adds a
100-column line width.

`.claude/` is ignored by git, by Biome (`"!!.claude"` in `files.includes` — the double negation
keeps the scanner out, not only the checker) and by knip. Claude Code keeps per-checkout state
there, and its orchestrator puts agent worktrees under `.claude/worktrees/`, each a full copy of
this tree with its own `biome.json`; Biome's scanner then reports *Found a nested root
configuration* and `npm run lint` fails in the main checkout with nothing wrong in it. (knip prints
a hint that the entry is unused — its `project` globs never reach `.claude/` — which is the point:
they must never start to.)

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
  style preference about how an already-established invariant is spelled. The three `src/` sites it
  was switched off for were rewritten away by
  [#84](https://github.com/AdarGit008/repl-simple/issues/84),
  [#50](https://github.com/AdarGit008/repl-simple/issues/50) and
  [#78](https://github.com/AdarGit008/repl-simple/issues/78): `biome lint
  --only=style/noNonNullAssertion src` reports none today (2026-09-08), so the switch is now a
  preference rather than an exemption, and turning the rule back on is a one-line change.

The bulk-format commit is listed in `.git-blame-ignore-revs`. To skip it in blame locally:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

### Coverage floors

`npm run coverage` runs the suite under Node's `--experimental-test-coverage` and enforces a
**per-file** line-coverage floor from `coverage-baseline.json`. `npm run coverage:update` rewrites the
baseline; lowering a floor is a decision to explain in the commit message, not a formality.

Floors are per file because a global number does not bite. Deleting `test/sandbox.test.ts` — 1811
lines when this was measured, and the only file that kills any `sandbox.ts` mutation — moved the
global figure from 96.92% to **93.64%**, a drop a round global floor of 90% survives without noticing. The same deletion drops
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
  processes is merged, while the block counts inside it survive. **This is why `coverage:update`
  measures three times and writes the per-file minimum**, prints every file that varied with its
  range, and **refuses to write** (naming the file) when a spread is wider than one line's worth —
  a whole process's data going missing is a thing to look at, not to average away. The plain gate
  carries the matching tolerance: a file fails only when it is **more than one line** below its
  floor, because the instrument cannot resolve sub-line differences. Which end a run lands on is
  machine-dependent: `registry.ts` reported its high in five of six local runs and its low on both
  CI runs of the same commit. This is *not*
  [#109](https://github.com/AdarGit008/repl-simple/issues/109) — that is real ordering-dependent
  behaviour in the rlm tests, whereas nothing here executes differently.

CI runs coverage as its own job on Node 24 / ubuntu only. The floors are exact measured numbers, and
V8 line attribution differs enough between Node majors that a baseline shared across the matrix would
have to be slackened until it stopped biting.

(The reported `global` figure includes `scripts/` rows while the floors exclude them — the floor
universe is tracked `src/` and `extensions/` sources; the global is reported, not a gate.)

### Mutation score

`npm run mutation` mutates `src/` and `extensions/` and fails below a **79%** floor
(`thresholds.break`), just under the **79.28%** baseline — 5756 detected of 7263 valid mutants,
re-measured against Monty 0.0.21 on 2026-09-10
([#175](https://github.com/AdarGit008/repl-simple/issues/175)). Full write-up, per-file scores and
the reasoning behind every config value: [docs/mutation-testing.md](docs/mutation-testing.md).

**The floor moved up 58 → 79 because the tree's score did, not because the instrument got kinder.**
Stryker's `coverageAnalysis: "perTest"` only skips tests that could not have killed the mutant, so
it is score-neutral by construction; the rise belongs to waves 1–3 and the 0.0.21 migration. A floor
going *down* is what would need explaining.

This is the quality gate the coverage floors above are explicitly *not*. It used to be
unaffordable: under the old `command` test runner every mutant re-ran the whole suite, and a full
sweep of the current tree measured a **107-hour** ETA. Switching to
[`@stryker-mutator/tap-runner`](https://stryker-mutator.io/docs/stryker-js/tap-runner/) with real
per-test-file coverage brought the same sweep to **3h12m** (1.70 test files per mutant instead of
27). Two consequences:

- **Run it with `npm run mutation`**, which contains it in a systemd scope with a memory ceiling so
  a breach cannot take your terminal session down with it, and sets `REQUIRE_BRIDGE_TOOLS=1` so a
  host without `fd`/`rg` fails loudly instead of skipping those tests and scoring their mutants as
  survivors. **Size `concurrency` by cores now, not RAM**: a test worker measured ~226 MB, and the
  committed `concurrency: 6` peaked at 4 GB of 23 on an 8-core box. The containment stays — a
  scope's cgroup accounts for a process tree while the `REPL_MEMORY_CEILING_MB` guard only sees the
  host process — but memory has stopped being the binding constraint it was.
- **Use `--incremental` or `--mutate` to scope a pull-request run**, and run the full sweep on a
  schedule or on demand. StrykerJS has no `--since` flag; that is Stryker.NET's.

The floor sits 0.28 under the baseline, which is rounding room rather than slack. A run coming in
under it is a regression to explain, not a threshold to lower — though note this baseline is one
run, where 58.09 had a reproducibility band established across sixteen.

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
ubuntu-latest and macos-latest, plus one `npm run lint` job and one `npm run coverage` job (Node 24,
ubuntu), for every push and pull request.

## Attribution

This project derives from two MIT-licensed upstreams and a whitepaper; the full notices are in
[NOTICE](NOTICE):

- **[pi-reepl](https://github.com/ivanvza/pi-reepl)** (Copyright (c) 2026 pi-reepl contributors) —
  the RLM loop, the `repl_server.py` preamble, and the `llm_query`/`SUBMIT`/`context` design.
- **[pi-code-tool](https://github.com/josephkern/pi-code-tool)** (Copyright (c) 2026 Joseph Kern) —
  the code-mode architecture: `ToolRegistry`, builtins, session/replay cache, the toolstore
  (`.pi/code-tools`), the pi-tools bridge, and approval-gating/suspension.
- **[Recursive Language Models](https://arxiv.org/abs/2512.24601)** — Zhang, Kraska, Khattab
  (2025), arXiv:2512.24601, DOI 10.48550/arXiv.2512.24601 — the RLM design this follows.
