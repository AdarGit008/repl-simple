# Ship Report — W2-3: Dead public API, knip, and the cold-file comment sweep

Branch: `chunk/w2-3-dead-api-knip` · Base: `main` (`e3c68da`) · Spec: `tasks/spec-w2-3.md`
(D133–D138) · Decision: **GO**

Issue closed by the PR: #85. #86 stays open (this is its first half — the owned cold files — the
rest is W3-2). The W1-5 re-verifier's six `redact_*` carry-over findings are all closed here.

## What was built

1. **`arg()` is gone (decision 14, D133).** The positional-or-keyword lookup in `src/registry.ts`
   had seven tests, nine call references and no caller; `resolveToolArgs` (`src/sandbox.ts`) is the
   one argument resolver. Function, tests and the `src/index.ts` re-export moved together, and two
   pins (`"arg" in registryModule === false`; no `arg` line in the barrel) make a re-introduction a
   decision. `CANDIDATE_MODULES` stays — it is the default and the memo identity of
   `probeImportableModules` and the README names it; #85's "referenced nowhere" predates #68
   (D134). The `src/bashenv.ts` exports are recorded as false positives (used in their own file).
   The barrel additionally names `DegradedStub` and `StubDegradationReport`, the return type of
   the public `ToolRegistry.degradedStubs()`.
2. **`resolveToolArgs` has its direct matrix (D136)** in the new `test/resolve_tool_args.test.ts`:
   positional, keyword, keyword order, mixed, value fidelity, no-parameter tool, duplicate (the
   exact `add() got multiple values for argument 'a'` `TypeError`), **missing pinned to today's
   left-out behaviour** with the #65 / W3-1 note on the two rows that flip, explicit-`undefined`
   keyword, surplus positionals and unknown keywords. One todo: a parameter named like an
   `Object.prototype` member (`constructor`) is seen as provided through `in`.
3. **knip is the unused-export check (D135).** `knip@6.34.0` pinned exact, `npm run lint` =
   `biome check --error-on-warnings && knip`, `knip.json` with `ignoreExportsUsedInFile`
   (the brief's false-positive class, which also covers `scripts/coverage-core.ts` and
   `src/toolstore.ts` types this chunk does not own), the three system binaries and the two
   stryker entries knip cannot resolve. What it cannot see is written down: a symbol whose only
   consumers are tests (the `arg()` shape) and a barrel re-export whose only use is the barrel
   (`includeEntryExports` flags all 82 re-exports because nothing imports from `src/index.ts`).
4. **Redaction carry-over (D137).** `Authorization: Bearer "abc…"` masks (quoted credential after
   a known scheme); `Authorization: Digest …` masks `response`, `nonce` and `cnonce` per parameter
   and keeps `username`/`realm`/`uri`/`qop`/`nc`/`opaque`/`algorithm` (the old rule masked the
   parameter *name* `username=` and kept the hash); bare `Bearer <token>` masks only a
   credential-shaped token (≥ 8 chars, and ≥ 16 or a digit/`_`/`-`, and not a lowercase word), so
   `the Bearer authentication scheme is used` is data on one line; the family-4 value never ends in
   `)`, `]` or `}` (`f(KEY=abc)` → `f(KEY=[REDACTED])`, `sorted(rows, key=str.lower)` →
   `sorted(rows, key=[REDACTED])`) while `GITHUB_TOKEN=ghp_…` still collapses whole;
   `docs/redaction.md` describes the density test that ships, pinned by a test that reads it against
   the test's own constants; the assignment rule's ~0.4 s/MiB worst constant is recorded and a
   512 KiB `a-` shape joins the bounded-work test. Exported names and signatures unchanged.
5. **Comment sweep, first half of #86 (D138).** Every comment block in the owned cold files read
   against its code and the tracker (issue states re-checked with `gh`); the table below.

No new runtime dependency (knip is a devDependency). No behavioural change outside the `arg()`
removal and the redaction rules: the model-facing prompt text is byte-identical.

## Comment sweep — count table (#86, owned files)

| File | Blocks checked | Corrected | Deleted | What was wrong |
|---|---|---|---|---|
| `scripts/contained.mjs` | 8 | 1 block, 3 claims | 0 | present tense "leaks ~41 MB per `runInSandbox` call" (fixed by #116 on 0.0.21); "#68's definition of done wants" and "#109 is trying to measure" (both closed) |
| `scripts/mutation-guard.mjs` | 7 | 1 | 0 | the same figure |
| `src/budget.ts` | 10 | 1 | 0 | "once #78 ports nesting" — #78 closed; the nested `rlm_query` tree already shares the pool |
| `src/truncate.ts` | 41 | 1 | 0 | "the three sites" — seven consumers in four modules |
| `src/rlm.ts` (W1-5 prose only) | 12 | 3 | 0 | `RlmResult.error` and the provider-error budget section said a plain `truncateText` cut "at the assignment site"; since W1-5 it is `redact()` (masking, then a head-only cut with a magnitude-free marker); the helper's first line said "head-only truncation" only |
| `src/registry.ts` | 46 | 1 (the argument-helpers header) | 1 (`arg()` doc) | — ; the probe-memo history is accurate (measured today: all six `TY_GAP_CANDIDATES` still unresolved on 0.0.21) |
| `src/index.ts` | 15 | 0 (+1 added) | 0 | — |
| `src/bashenv.ts` | 21 | 0 | 0 | — |
| `src/builtins.ts` | 67 | 0 | 0 | — |
| `src/pathjail.ts` | 12 | 0 | 0 | — |
| `src/pool.ts` | 13 | 0 | 0 | — |
| `src/preamble.ts` | 3 | 0 | 0 | — |
| `src/rlm_tools.ts` | 11 | 0 | 0 | — (W1-5's cap and `void` notes are accurate) |
| **Total** | **266** | **9 blocks (12 claims)** | **1** | |

Not changed, recorded: `renderPythonToolRules` tells the model "Class definitions and match
statements are not supported" — measured on 0.0.21 a plain class with `__init__` and a method runs
(`A(3).get()` → `3`); only inheritance, metaclasses and `match` raise. That line is prompt text, not
a comment, so it is a todo test (`test/registry.test.ts`, "tells the truth about classes") for W3-2.
`src/toolstore.ts` and the rest of `src/rlm.ts` are wave 3.

## Verification evidence

- **Gates at HEAD (`c4e9514`):** `npm run check` clean · `biome check --error-on-warnings` clean ·
  `knip` clean (see the CI-like proof below) · `REQUIRE_BRIDGE_TOOLS=1 npm run test:contained` →
  **1438 tests, 1427 pass, 0 fail, 11 todo** (40.8 s, exit 0, no OOM; 2 of the 11 todos are this
  chunk's) · `npm run coverage` (contained) → **"All per-file floors met"**, exit 0; owned files
  measured `src/registry.ts` 98.27 · `src/redact.ts` 100.00 · `src/index.ts` unmeasured (barrel).
- **`npm run lint` with knip installed.** The shared `node_modules` of this session cannot hold
  knip, so the branch was cloned into the scratchpad with its *own* `node_modules`: `npm ci`
  (338 packages, knip 6.34.0 resolved), then `npm run lint` exactly as CI runs it → **exit 0**;
  `knip` alone → exit 0, no findings. Locally the same config passes with only the uninstalled
  `knip` binary ignored. CI's lint job is the proof of record.
- **RED against main, measured** in that clone: main's `src/` + `extensions/` (`e3c68da`) checked
  out over the branch's tests and docs, `test/registry.test.ts test/redact.test.ts
  test/resolve_tool_args.test.ts` → **200 tests, 178 pass, 20 fail, 2 todo**. The 20 failures are
  exactly the new tests: 9 family-2 (quoted credential ×2, Digest ×5, one-line Bearer prose ×2),
  4 family-4 bracket rows, the `key=str.lower` cost row, 2 corpus entries, both fuzzes, and the two
  `arg` pins. The two `docs/redaction.md` pins pass in that configuration because `docs/` is not
  swapped — their RED is the commit ordering (`183881f` precedes `1363a40`). **Guards, green on
  main by design (disclosed):** the 14 `resolveToolArgs` matrix rows (the function is unchanged),
  the `CANDIDATE_MODULES` pin, the credential-shaped-bare-Bearer row, the bracket-inside-a-value
  row, the Digest-challenge and "Bearer as an adjective" corpus entries, the three new bounded-work
  shapes.
- **RED → GREEN pairs:** `183881f` (RED) → `91c9e2e` (`arg()` deletion) and `1363a40` (redaction
  rules + docs). Then `cfd511e` (comment sweep), `3f0b376` (knip), `c55d5b8` (biome info tidy),
  `c4e9514` (coverage baseline).
- **Coverage baseline (D133).** `npm run coverage:update` ran exactly once, contained, after every
  test was in (3 measurements, no refusal). Kept: `src/registry.ts` 98.30 → **98.27** (twelve fully
  covered lines left the file; the uncovered residue — the probes' dead-worker branches — is
  unchanged; measured 98.27 / 98.46 over the three runs) and `global` 98.32 → 98.74 (reported, not
  a gate). Every other file restored to main's floor: the update's minima moved sibling-owned
  files up (`extensions/repl-extension.ts`, `src/bashenv.ts`, `src/sandbox.ts`, `src/session.ts`,
  `src/toolstore.ts` — not this chunk's call while other wave-2 chunks edit them) and five files
  down by the #113 one-line-of-N defect (`src/preamble.ts` 100 → 97.05 is one line of 34;
  `src/redact.ts` 99.63 is one line of 240; `src/truncate.ts` 99.74 is the documented case;
  `src/pathjail.ts`, `src/builtins.ts` likewise). The plain gate's one-line tolerance absorbs those.
- **Corpus and fuzz re-run:** no-false-positive corpus **33 entries** (29 + 4 new: a Digest
  challenge header, a Digest header without a response, Bearer prose on one line, Bearer as an
  adjective), 0 masked. Fuzz (seeded LCG): **200 random one-to-three-line non-secret documents**
  drawn from 52 header/env/prose/code lines (3 new lines, including a `WWW-Authenticate: Digest`
  challenge with a nonce), **0 false positives**; **200 random header dumps** with a planted
  credential in **8 header shapes** (3 new: `Bearer "…"`, `Basic '…=='`, a full Digest parameter
  list with the credential as both nonce and response), **0 survivals**, every other header
  verbatim. Idempotence over 12 positives + the corpus: second pass masks 0. Bounded work, measured
  at HEAD on this box: one word 9 ms · many words 21 ms · many separators (`a_b-c.`, 1.2 MB) 408 ms
  · BEGIN lines 4 ms · many colons 14 ms · alternating `a-` 191 ms at 512 KiB (399 ms at 1 MiB) ·
  Bearer words 10 ms · Digest parameters 53 ms · a 1 MiB single line of `;`-joined `Digest a=b`
  headers 31 ms (the 4 KiB window keeps it linear) — all under the 2 s budget; density test
  **0.77×** (1024 lines 17.5 ms vs one line 22.7 ms, best of 5 × 4 passes; bound 3×). The
  separator-dense shapes are the assignment rule's ~0.4 s/MiB constant, recorded in
  `docs/redaction.md`.
- **Adversarial probes, reproducible:**
  - `git grep -n '41 MB' -- scripts/` → nothing (exit 1).
  - `npm pack --dry-run` → **25 files**, the bucket-10 list; `knip.json` is not in `files`.
  - `npx tsx -e 'import {maskSecrets} from "./src/redact.ts"; …'` on each re-verifier probe:
    `Authorization: Bearer "abc123def456"\nAccept: 1` → `Bearer "[REDACTED]"`, masked 1;
    `Authorization: Digest username="u", realm="r", response="abc123"` →
    `… username="u", realm="r", response="[REDACTED]"`, masked 1;
    `the Bearer authentication scheme is used` → unchanged, masked 0;
    `sorted(rows, key=str.lower)` → `sorted(rows, key=[REDACTED])`.
  - No behavioural change outside `arg()`: `DEFAULT_RLM_SYSTEM_PROMPT` and `renderPythonToolRules`
    are untouched; the value-export list of `src/index.ts` differs from main by `arg` only.

## Residuals — as todo tests, not issues (decision 9)

| Todo test | Where | Why deferred | Intended approach |
|---|---|---|---|
| `tells the truth about classes: a plain class runs on 0.0.21, only inheritance and match do not` | `test/registry.test.ts` (renderPythonToolRules block) | model-facing prompt text; rewording is a behaviour change outside this chunk's "comments only" scope | W3-2 (#86) rewords the rule to name class inheritance / metaclasses and `match` |
| `a parameter named like an Object.prototype member is not seen as a provided keyword` | `test/resolve_tool_args.test.ts` (residual block) | `src/sandbox.ts` is W2-2's this wave | `Object.hasOwn(kwargs, param.name)` in `resolveToolArgs` |

Also recorded, not hidden: knip cannot flag the two #85 shapes that matter most — an export whose
only consumers are tests, and a barrel re-export whose only use is the barrel — so decision 14's
"deliberate decision" for those stays a reviewer's job (D135, spec). `redact`, `maskSecrets`,
`TY_GAP_REASONS`, `RLM_TOOL_CALL_CAP` and the memo hooks stay module-reachable on purpose.

## Deviations from the brief

- **`src/toolstore.ts` untouched** (the brief's file list had it; the chunk adjustments moved its
  code to W2-1 and its comments to wave 3).
- **`npm run lint` was run locally as its two halves** (`biome check --error-on-warnings`, then
  `npx --yes knip@6.34.0`) because the shared `node_modules` must not be installed into; the
  scratch clone above ran the real script with knip installed, and CI's lint leg is the record.
- **The `resolveToolArgs` matrix is green on main by design** — the brief asks for a matrix of an
  unchanged function; disclosed above rather than counted as RED.
- **Two barrel type exports added** (`DegradedStub`, `StubDegradationReport`) beyond the `arg`
  removal: the barrel's own rule for a public method's return type; types only.

## Rollback plan

| Commit | Reverts |
|---|---|
| `c4e9514` | coverage baseline (registry.ts 98.27, global) |
| `c55d5b8` | String.raw tidy (cosmetic) |
| `3f0b376` | knip devDependency, lock, `knip.json`, the `lint` script |
| `cfd511e` | comment sweep |
| `1363a40` / `183881f` | redaction rules + docs (the RED commit also removes the `arg` tests, so revert `91c9e2e` with it) |
| `91c9e2e` / `183881f` | `arg()` deletion + barrel |

Newest-first reverts are clean; `183881f` is shared by both GREEN pairs, so reverting either GREEN
alone means editing its test block rather than reverting the RED commit whole.

## Closing-comment draft — #85 (for the orchestrator, after merge)

> Closed by <merge SHA> (W2-3). Re-measured at `e3c68da`: `CANDIDATE_MODULES` is live (the default
> and memo identity of `probeImportableModules`, `src/registry.ts`; `test/registry.test.ts`
> "CANDIDATE_MODULES is live"; README) — kept. `arg()` had no caller: deleted with its seven tests
> and the `src/index.ts` re-export (decision 14); pinned absent by `test/registry.test.ts` "dead
> public API (#85)". `resolveToolArgs` stays exported and now has its direct matrix —
> `test/resolve_tool_args.test.ts`: positional, keyword, mixed, duplicate, missing (pinned to
> today's left-out behaviour; #65 flips it), surplus. The future check is `knip@6.34.0` in
> `npm run lint` (`knip.json`); what it cannot see — test-only consumers, barrel-only re-exports —
> is recorded in `tasks/spec-w2-3.md` D135. The `src/bashenv.ts` exports are false positives (used
> in-file).

## Go / No-Go

**GO.** All four gates green at HEAD and in the CI-like clone; 20 new tests RED against main's
`src/`, the rest disclosed as guards; no runtime dependency; no behavioural change outside the
`arg()` removal and the redaction rules; `npm pack` unchanged at 25 files; the two residuals are
todo tests with their intended fixes named.
