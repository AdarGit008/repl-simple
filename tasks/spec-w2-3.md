# Spec: W2-3 — Dead public API, knip, and the cold-file comment sweep

Issues: #85 (closes). #86 stays open for W3-2 — this chunk delivers its first half (the owned
cold files) with a count table. Carry-over from the W1-5 re-verification: the six `redact_*`
findings (`src/redact.ts`, `test/redact.test.ts`, `docs/redaction.md` are owned this wave).

Branch `chunk/w2-3-dead-api-knip`, base `origin/main` = `e3c68da`. Decision IDs D133–D138.

## Objective

1. The dead public API #85 measured is decided and moved together with its tests (decision 14):
   `arg()` is deleted with its seven tests and its barrel re-export; `CANDIDATE_MODULES` is kept
   because it is live; `resolveToolArgs` gets the direct matrix #65 will build on.
2. The class is caught in future: `knip` is a pinned devDependency, configured for this repo, and
   `npm run lint` runs it — with an honest record of what it can and cannot see.
3. The owned cold files no longer carry claims their code contradicts (#86, first half): every
   comment block checked, the stale ones corrected, counted per file.
4. The redaction helper closes the re-verifier's findings: a quoted credential after a known
   scheme masks, Digest `response`/`nonce`/`cnonce` mask, one-line `Bearer` prose does not, the
   family-4 value never swallows a closing bracket, and `docs/redaction.md` describes only tests
   that ship.

## Current state (measured at HEAD `e3c68da`, 2026-09-08)

- `src/registry.ts:300-311` `arg()`: positional-or-keyword lookup. Callers in `src/` +
  `extensions/`: **0**. Re-exported at `src/index.ts:28`. Tests: `test/registry.test.ts:179-221`,
  seven `it`s, nine call references. The live resolver is `resolveToolArgs`
  (`src/sandbox.ts:655-680`), called at `src/sandbox.ts:1010`, `:1388`, `src/session.ts:804`,
  `:865`; barrel `src/index.ts:53`; **zero direct tests** (grep `resolveToolArgs` in `test/`: one
  comment, `test/rlm.test.ts:4322`).
- `src/registry.ts:324-351` `CANDIDATE_MODULES`: the default of `probeImportableModules` (`:400`)
  and the memo's identity key (`:402`, `:422`); `test/registry.test.ts:330` spreads it to prove
  "same contents, different array" is not served from the memo; `README.md:12` names it. Live —
  the issue's "referenced nowhere" was measured before #68 made it the memo key.
- `src/bashenv.ts:43` `BASH_ENV_ALLOWLIST`, `:109` `BASH_ENV_ALLOW_PREFIXES`: exported, consumed
  by `isAllowed` (`:143-144`) in the same file; `:148` `FilteredBashEnv` is `filterBashEnv`'s
  return type (`:166`). No importer outside the file.
- `npx knip@6.34.0` with no config, on main: 1 unused devDependency (`@stryker-mutator/core` —
  the `mutation` script reaches `stryker` through `node scripts/contained.mjs …`, which knip's
  script parser does not follow), 1 unlisted dependency (`@stryker-mutator/command-runner` — the
  stryker plugin maps `testRunner: "command"` to a package that is bundled in core since
  Stryker 9), 4 unlisted binaries (`systemd-run`, `journalctl`, `mkfifo` ×2 — system binaries),
  2 unused exports (the two bashenv constants), 4 unused exported types (`RunRow`,
  `FileAcrossRuns` in `scripts/coverage-core.ts`; `DegradedStub` `src/registry.ts:122`;
  `PreambleManifestRead` `src/toolstore.ts:1440`) — every one used in its own file. With
  `includeEntryExports: true` knip lists all 48 value and 34 type re-exports of `src/index.ts`:
  nothing in the repo imports from the barrel (tests and `extensions/` import modules directly),
  so that switch cannot separate dead from live.
- `npm pack --dry-run`: 25 files, the bucket-10 list (`tasks/ship-report-bucket-10.md:14-16`).
- `src/redact.ts:81-89` header rule: the scheme branch needs an unquoted value straight after
  `[ \t]+`, so `Authorization: Bearer "abc123def456"` masks nothing (measured: `masked: 0`);
  `Digest username="u", realm="r", response="abc123"` masks `username=` and keeps the response
  hash. `:92` bare-`Bearer` rule: any ≥ 8 token characters, so `the Bearer authentication scheme
  is used` → `the Bearer [REDACTED] scheme is used`. `:125-132` family 4 value class
  `[^\s"';,&]+` swallows `)` — `sorted(rows, key=str.lower)` → `sorted(rows, key=[REDACTED]`.
  `docs/redaction.md:44-47` describes a "3× per doubling from 256 KiB to 1 MiB" growth test; the
  shipped proof is the fixed-size density test (`test/redact.test.ts:855`: 1 vs 1024 `BEGIN`
  lines in exactly 1 MiB, best of 5 × 4 passes, ratio < 3). Worst measured constant: the
  assignment rule on `"a-".repeat(512 Ki) + "KEY=x"`, ~420 ms per MiB, linear.
- Stale prose in owned files: `scripts/contained.mjs:9-12` (present tense: `probeTypeCheckerGaps()`
  "leaks ~41 MB per `runInSandbox` call" — fixed by #116 on 0.0.21), `scripts/mutation-guard.mjs:13-16`
  (the figure again), `src/budget.ts:3-4` ("once #78 ports nesting" — #78 is closed and nested
  `rlm_query` shares the budget), `src/rlm.ts:157-165` and `:194-199` (say `RlmResult.error` is a
  plain `truncateText` cut "at the assignment site" — since W1-5 it is `redact()` through
  `redactProviderError`, masking then head-only with `unknownTotal`), `src/rlm.ts:215` (the
  helper's first line says "head-only truncation" only), `src/truncate.ts:4-6` ("the three sites"
  — seven consumers today). `src/registry.ts:353-373` (probe memo) is past tense and accurate:
  measured today, all six `TY_GAP_CANDIDATES` still report unresolved on 0.0.21.
  `src/registry.ts:527` `renderPythonToolRules` tells the model "Class definitions and match
  statements are not supported" — measured: a plain class with `__init__` and a method runs on
  0.0.21 (`A(3).get()` → `3`); inheritance and `match` raise `NotImplementedError`. That is prompt
  text, not a comment: recorded as a todo test, not changed here.
- Coverage floors: `src/registry.ts` 98.30, `src/redact.ts` 100, `src/sandbox.ts` 97.66.

## Decisions

| ID | Decision |
|---|---|
| D133 | **`arg()` is deleted with its tests and its barrel re-export (decision 14).** `resolveToolArgs` is the one argument resolver; the deletion is pinned by two tests (`"arg" in registryModule === false`; `src/index.ts` has no `arg` export line) so a re-introduction is a decision, not drift. `requireString` stays (live: `builtins.ts`, `bridge.ts`, `toolstore.ts`). |
| D134 | **`CANDIDATE_MODULES` stays** — live as the default and the memo identity of `probeImportableModules`, named in the README; #85's count predates #68. The `src/bashenv.ts` exports are **false positives**: used in their own file, the `export` is what `docs/bash-env.md` points a reader at, and un-exporting buys nothing. The barrel gains `DegradedStub` and `StubDegradationReport` — the return type of the public `ToolRegistry.degradedStubs()` (the same rule the barrel already states for `AbandonOutcome`). The other W1-5 module-level names (`redact`, `maskSecrets`, `TY_GAP_REASONS`, `RLM_TOOL_CALL_CAP`, the memo hooks) stay module-reachable on purpose: internal helpers and test hooks, not public API. |
| D135 | **knip.** `knip@6.34.0` pinned exact in `devDependencies` (the lock updated with `--package-lock-only`; the shared `node_modules` untouched, CI's `npm ci` installs it); `npm run lint` = `biome check --error-on-warnings && knip`; `knip.json`: entries `extensions/repl-extension.ts`, `test/**/*.test.ts`, `scripts/*.{mjs,ts}` (plus knip's default `src/index.ts`), project = `src`, `extensions`, `test`, `scripts`; `ignoreExportsUsedInFile: true` (an export consumed in its own file is not dead API — the brief's false-positive class, and it covers `scripts/coverage-core.ts` and `src/toolstore.ts`, which this chunk does not own); `ignoreBinaries` for the three system binaries; `ignoreDependencies` for the two stryker entries above. **What knip sees:** an exported symbol with no importer anywhere in `src`/`extensions`/`test`/`scripts` — the `CANDIDATE_MODULES`-as-filed class. **What it cannot see, recorded:** a symbol whose only consumers are tests (`arg()` — tests count as importers) and a barrel re-export whose only "use" is the barrel (`includeEntryExports` flags all 82 re-exports because nothing imports from `src/index.ts`; `--production` would flag every test-only hook). Decision 14's "deliberate decision" for those two shapes stays a reviewer's job. |
| D136 | **`resolveToolArgs` matrix** in the new `test/resolve_tool_args.test.ts` (the function lives in `src/sandbox.ts`; W2-2 owns `test/sandbox.test.ts`): positional, keyword, keyword in any order, mixed, duplicate (`HostToolError`, `pythonType: "TypeError"`, the exact `tool() got multiple values for argument 'x'` message), **missing pinned to today's behaviour** — the key is absent from the result, optional or not, and the caller decides — with the note that W3-1 / #65 flips a missing required parameter to a `TypeError` and this test changes with it; surplus positionals and unknown keywords dropped (today, same note); an explicit `undefined` keyword counts as provided. These are guards, green on main by design (the function is unchanged) — disclosed, not counted as RED. One todo test: a parameter named like an `Object.prototype` member (`constructor`) is seen as a provided keyword through `in`, so it can never be passed positionally (`got multiple values`); intended fix `Object.hasOwn` in `src/sandbox.ts` (not owned). |
| D137 | **Redaction carry-over.** (a) A known scheme may be followed by an opening quote: `Authorization: Bearer "abc123def456"` → `Authorization: Bearer "[REDACTED]"` (both quote styles; the idempotence lookahead admits the quote). (b) `Digest` is handled per parameter: on an `Authorization: Digest …` line whose first token is a `name=` parameter, the values of `response`, `nonce` and `cnonce` are masked (quoted or bare) and every other parameter — `username`, `realm`, `uri`, `qop`, `nc`, `opaque`, `algorithm` — survives; a `Digest` followed by a bare token keeps the old scheme-and-credential shape; the generic header rule refuses a `Digest` parameter list so it can no longer mask `username=`. (c) Bare `Bearer <token>` (family 2b) masks only a credential-shaped token: ≥ 8 token characters **and** (≥ 16 characters or containing a digit, `_` or `-`) **and** not a run of lowercase letters. `the Bearer authentication scheme is used` is data; `bearer 0123456789abcdef` masks. The match is case-insensitive on the word and case-sensitive on the lowercase-word test (spelled `[Bb][Ee]…`, no `i` flag). Recorded false negative: an all-lowercase-letter bearer token outside a header. (d) The family-4 value never *ends* in `)`, `]` or `}`: `sorted(rows, key=str.lower)` → `sorted(rows, key=[REDACTED])`, `f(KEY=abc)` → `f(KEY=[REDACTED])`, while `PASSWORD=ab)cd` still masks whole (a bracket inside the value is part of it). (e) `docs/redaction.md` describes the density test that ships, pinned by a test that reads the document; the worst-constant observation is recorded there and a 512 KiB `a-` shape joins the bounded-work test. Exported names and signatures (`redact`, `maskSecrets`, `REDACTED`, `REDACTED_PRIVATE_KEY`, `MaskResult`, `RedactOptions`, `RedactResult`) are unchanged — W2-1 and W2-2 import them. |
| D138 | **Comment sweep** over the owned cold files only (`src/registry.ts`, `src/index.ts`, `src/bashenv.ts`, `src/builtins.ts`, `src/pathjail.ts`, `src/pool.ts`, `src/preamble.ts`, `src/budget.ts`, `src/truncate.ts`, `src/rlm_tools.ts`, `scripts/contained.mjs`, `scripts/mutation-guard.mjs`; in `src/rlm.ts` only the prose W1-5 left stale). Method: every comment block read against the code it describes and against the issue tracker (issue states re-checked with `gh`), a claim corrected only when measured false today. Corrections: the two scripts' present-tense leak claims (the figure is dropped; `git grep '41 MB' scripts/` returns nothing), `#68`/`#109` tense in `contained.mjs`, `src/budget.ts` #78, `src/rlm.ts` provider-error prose (three blocks), `src/truncate.ts` "three sites". Not changed: `src/registry.ts` probe memo (accurate, past tense); the `renderPythonToolRules` class claim (behaviour — todo test). `src/toolstore.ts` and the rest of `src/rlm.ts` are wave 3. |

## Tests — RED → GREEN plan

RED commit(s) first, each new test failing against main's `src/` + `extensions/` unless marked
*guard* (green by design, disclosed):

| Test | File | RED on main? |
|---|---|---|
| `arg` is no longer exported from `src/registry.ts` | `test/registry.test.ts` | yes (`arg` exists) |
| `src/index.ts` does not re-export `arg` | `test/registry.test.ts` | yes (line `arg,` present) |
| `CANDIDATE_MODULES` is the default list of `probeImportableModules` | `test/registry.test.ts` | guard |
| `renderPythonToolRules` claims class definitions are unsupported (todo) | `test/registry.test.ts` | todo |
| `resolveToolArgs` matrix (positional / keyword / order / mixed / duplicate / missing / surplus / explicit undefined / no params) | `test/resolve_tool_args.test.ts` | guards |
| prototype-member parameter name (todo) | `test/resolve_tool_args.test.ts` | todo |
| quoted credential after a known scheme (Bearer/Basic, `"`/`'`, JSON) | `test/redact.test.ts` | yes |
| Digest parameters: response/nonce/cnonce masked, the rest kept; bare Digest token; idempotent | `test/redact.test.ts` | yes |
| one-line Bearer prose is data (corpus + fuzz lines); credential-shaped bare tokens still mask | `test/redact.test.ts` | yes |
| family-4 value keeps a closing bracket/brace/paren; a bracket inside a value masks whole | `test/redact.test.ts` | yes |
| `docs/redaction.md` describes the density test and no per-doubling test | `test/redact.test.ts` | ordering (docs not swapped) |
| bounded work: 512 KiB alternating `a-` | `test/redact.test.ts` | guard (records the constant) |

GREEN: `src/registry.ts` (delete `arg`), `src/index.ts` (drop `arg`, add the two types),
`src/redact.ts` + `docs/redaction.md`, then the comment sweep, then knip (`package.json`,
`package-lock.json`, `knip.json`).

## Boundaries

- Owned: the files listed in D138 plus `test/registry.test.ts`, `test/resolve_tool_args.test.ts`
  (new), `test/redact.test.ts`, `src/redact.ts`, `docs/redaction.md`, `package.json`,
  `package-lock.json`, `knip.json` (new), `coverage-baseline.json`, the two `tasks/*-w2-3.md`.
- Not touched: `src/toolstore.ts` (W2-1 changes its code; comments are wave 3), `src/sandbox.ts`
  (the `Object.hasOwn` fix is a todo), `test/sandbox.test.ts` (W2-2), `scripts/coverage-core.ts`,
  `README.md`, `SPEC.md`, `tasks/plan.md`, `tasks/todo.md`.
- No behavioural change outside the `arg()` removal and the redaction rules above; the model-facing
  prompt text is byte-identical.
- `coverage-baseline.json`: `npm run coverage:update` runs at most once, only if a floor moves
  more than the one-line tolerance, and is justified in the PR.
