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

| Tool | Description |
|------|-------------|
| `llm_query(prompt)` | Ask the LLM a question from sandbox code. |
| `rlm_query(query, context?)` | Spawn a nested RLM investigation. |
| `SUBMIT(answer)` | Signal completion with final answer. |

### Available Python-side tools

**Pi bridge:** `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`

**Builtins:** `read_file`, `list_files`, `http_get`

**Tool store:** `save_tool`, `delete_tool`, `list_saved_tools`, `read_tool`

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
  // Session
  Session,
  // Tool composition
  ToolRegistry,
  createPiBridgeTools,
  createBuiltinTools,
  createRLMTools,
  createToolStoreTools,
  loadSavedTools,
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
`@pydantic/monty` publishes no musl binary, and the install succeeds before failing at load. See
[docs/platform-support.md](docs/platform-support.md).

## Dev

```bash
npm test        # tsx --test test/*.test.ts
npm run check   # tsc --noEmit            (tsconfig.json)
npm run build   # tsc -p tsconfig.build.json
npm run lint    # biome check --error-on-warnings
npm run format  # biome format --write
npm run coverage # per-file line-coverage floors
```

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

Floors are per file because a global number does not bite. Deleting `test/sandbox.test.ts` — 813
lines, and the only file that kills any `sandbox.ts` mutation — moves the global figure from 93.33% to
**92.78%**, a 0.55 pp drop that any round global floor survives. The same deletion drops
`src/sandbox.ts` from 83.19% to 80.71%, which the per-file floor catches.

**This is not a quality gate.** Coverage says lines executed, not that anything was asserted, and this
suite has a documented history of tests that execute plenty and assert nothing (see
[#23](https://github.com/AdarGit008/repl-simple/issues/23)). The mutation score from
[#24](https://github.com/AdarGit008/repl-simple/issues/24) is the quality gate. This is a cheap
regression detector that runs in seconds — do not let a coverage number justify skipping a test.

Two things worth knowing before relying on it:

- **`test/extension-loader.test.ts` is excluded from the coverage run** (not from `npm test`). It
  drives pi's real `discoverAndLoadExtensions`, which loads `src/` a second time through pi's jiti
  loader; Node merges V8 coverage by file path, so those barely-executed duplicates land on top of the
  real entries. With it in the run, `src/sandbox.ts` reports **20.80%** against a true **83.20%**, and
  the global figure reads 54.13% instead of 93.33%. Coverage cannot fall as tests are added — the low
  number is the instrument misreporting, not a gap.
- **Node's report cannot see a module that stopped being loaded.** It lists only files that were
  loaded, so a module dropping out of the suite leaves the denominator and every percentage *rises*.
  `coverage-baseline.json` doubles as a manifest for exactly this: a file with a floor that is absent
  from the report is a hard error.

CI runs coverage as its own job on Node 24 / ubuntu only. The floors are exact measured numbers, and
V8 line attribution differs enough between Node majors that a baseline shared across the matrix would
have to be slackened until it stopped biting.

### Mutation score

`npx stryker run` mutates `src/` and `extensions/` and fails below a **57%** floor. The measured
baseline on `e556a70` is **58.28%** (1235 detected of 2119 mutants). Full write-up, per-file scores
and the reasoning behind every config value:
[docs/mutation-testing.md](docs/mutation-testing.md).

This is the quality gate the coverage floors above are explicitly *not*. It is also expensive —
**~33 CPU-hours** for a full run, because the command runner re-runs all 426 tests per mutant with no
per-test filtering. Two consequences:

- **Do not run it on a machine you are using.** `npm test` is already parallel, so Stryker's
  `concurrency` multiplies against node's own fan-out. Size it by **RAM** (~4.8 GB per worker), not
  by cores — memory binds first, and exceeding it drives the box into swap. The committed
  `concurrency: 2` is sized for an 8-core / 24 GB machine.
- **Use `--incremental` or `--since` on pull requests**, and run the full sweep on a schedule or on
  demand.

The floor is set at 57 rather than at the measured 58.28 on purpose: the suite is not yet
deterministic, and re-scoring the same tree from an independent run gives 57.86%. That band is
[#109](https://github.com/AdarGit008/repl-simple/issues/109), not slack — raise the floor when it
closes.

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
