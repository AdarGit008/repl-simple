# Contributing to repl-simple

This file is for working on repl-simple itself. For installing and using it, see the
[README](README.md); for reporting a vulnerability, see [SECURITY.md](SECURITY.md).

## Setup

Use Node 22.19.0 or newer (`.nvmrc` pins the floor, so local development exercises the oldest
supported runtime), then:

```bash
git clone https://github.com/AdarGit008/repl-simple
cd repl-simple
npm ci
```

To try a checkout in pi, install it by path: `pi install ./path/to/repl-simple`. pi adds a local
path to its settings without copying it, so edits take effect the next time pi loads the
package.

Before opening a pull request, run what CI runs: `npm run lint`, `npm run check`, `npm test` and
`npm run coverage` (see [CI](#ci) below). Commit messages and pull request titles use
conventional prefixes such as `fix:`, `docs:` and `feat(rlm):`.

## Commands

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

## Module map

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

The runtime environment variables are documented in the README under
[Configuration](README.md#configuration).

## TypeScript configs

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

## Packaging notes

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

The pinned `@pydantic/monty` 0.0.23 also ships a wasm runtime at `@pydantic/monty/wasm`, which loads
with no extra install and looks like a way around the musl gap in [Prerequisites](README.md#prerequisites).
It is not: it runs Python in-process, so a runaway blocks the event loop and there is no crash
isolation. See [docs/platform-support.md](docs/platform-support.md).

## Formatting and lint

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

## Coverage floors

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
- **Three files' coverage varies between identical runs**, so `coverage:update` alone can write a
  floor that flakes red. Measured over six back-to-back runs of the same tree: `src/truncate.ts`
  reports 99.74% or 100.00%, `src/registry.ts` 99.50% or 100.00%. The varying line in
  `truncate.ts` is `truncateText`'s declaration, and the lcov record shows it is the *instrument*
  that varies, not the suite — in the low run the function's body carries a hit count of 380 while
  its declaration line reads 0:

  ```
  DA:384,0      export function truncateText(     ← the declaration
  DA:385,380      text: string,
  DA:388,380      const t = new Truncator(opts);  ← the body, 380 executions
  ```

  The third file is `src/preamble.ts`, and it is the same artefact: in the low run
  `getReplPreamble`'s declaration reads 0 while the function is recorded as called twice
  (`FNDA:2`) and its body line twice. `truncate.ts` shows it on `formatValue`'s declaration too
  (0 against `FNDA:1299`). Measured 2026-09-10 with the gate's own invocation on this tree and on
  `origin/main` at Monty 0.0.21 alike, so neither is a regression; one gate run that day read both
  files at 100.00%, three read 97.05% and 99.88%.

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

## Mutation score

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

## Optional: `fd` and `ripgrep`

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

## CI

CI (`.github/workflows/ci.yml`) runs `npm ci && npm run check && npm test` on Node 22 and 24 across
ubuntu-latest and macos-latest, plus one `npm run lint` job and one `npm run coverage` job (Node 24,
ubuntu), for every push and pull request.
