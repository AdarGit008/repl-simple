# Ship Report — W3-2: Craft close-out (#86, #174, #83; #175 re-homed)

Branch: `chunk/w3-2-craft-closeout` · Base: `main` (`acadb19`) · Commits: `d362ff6` (RED),
`44eddb4` (GREEN), this report · Spec: `tasks/spec-w3-2.md` (D151–D158) · Maintainer decisions
applied: 16, 17, 9 · Decision: **GO**

## What was built

1. **`Session` carry-overs (D154, `src/session.ts`).** The snippet cap now applies on `resume()`
   (`snippetCapRefusal`, `:1349`; the same `unavailable` `RunError` as `run()`, the suspension
   left pending, nothing executed). Every stdout mark is a safe integer (`expectCount`, `:459`),
   their sum too (`:629`), and the suspension's mark must equal the retained stdout's byte length
   whenever `stdoutTruncated` is false (`:566`). One combined replay-cache cap at load counts
   `callCache`, `suspended.preGateCache` and the slot the suspended call itself needs (`:655`).
   The replay filter is positional: `createCachingRegistry` logs one flag per `execute` it saw
   (`invocations`, `:234`), and `withoutReplayedCalls` (`:1546`) pairs the trace with that log after
   classifying each entry with `reachedRegistry` (`:1578`) — keys are never compared, and an
   approved restored gated call that ran for real stays in `calls`. Surviving entries are the
   sandbox's own objects.
2. **Redaction carry-overs (D155, `src/redact.ts`).** The ten distinctive prefixes mask when glued
   to a preceding word; `sk-` keeps its boundary and the tests pin why (`TOKEN_PREFIX`, `:69`). The
   Digest parameter list is tokenised one parameter at a time — no window, quoted values read to
   their closing quote, a parameter masked by its own name only (`DIGEST_HEADER` `:134`,
   `DIGEST_TOKEN` `:145`, `maskDigestParameters` `:279`). A trailing period is not Bearer evidence
   and is not masked (`BEARER_VALUE`, `:171`).
3. **Prompt text and public surface (D156, D157).** `renderPythonToolRules` names inheritance,
   metaclasses and `match` as unsupported and says a plain class works (`src/registry.ts:518`);
   `src/index.ts:130` re-exports `RunTrace`, `TracedCall`, `TraceStatus`.
4. **#86, second half (D151).** The comment sweep over every file W3-1 does not own — the
   ledger below — with corrections applied in the owned files and reported for the rest.
5. **#174 (D152, decision 16).** A README "Module map" section: `repl.ts` is the runner,
   `rlm.ts` the loop, `rlm_tools.ts` its sandbox-side tools, `repl/repl_server.py` the bundled
   preamble; why the names stay.
6. **#175 → #83 (D153, decision 17).** `docs/mutation-rebaseline-runbook.md`: the out-of-session
   procedure (fresh incremental cache and why, `--dryRunOnly` sizing, `--mutate` shards into one
   incremental file, `contained.mjs --limit`, never concurrent, freshness *and* provenance checks,
   which numbers to record where). #175 is re-labelled `infra` (`bucket-11` removed) with the
   runbook linked in a comment; #83 closes on its three criteria (below).
7. **Tooling hygiene (D158).** `.claude/` is ignored by git, by Biome (`"!!.claude"`) and by knip,
   with the reason in `.gitignore` and README. Verified: a throwaway `.claude/worktrees/probe/`
   holding a `biome.json` copy made `biome check` fail with *Found a nested root configuration*
   before, and `npm run lint` exits 0 with it present after (then removed).

No new dependency. No rename. No file outside the chunk's list touched. `coverage-baseline.json`
unchanged (no floor moved).

## Comment sweep — count table (#86, second half)

Method (D151): in the owned files every comment block was read against its code and against the
tracker (issue states re-checked over the REST API — `gh issue view` fails on this repo); a claim
was corrected only when measured false today, a comment deleted only when it restated its line.
In files this chunk may not modify, every claim-bearing comment line (tense, issue and wave
markers) was read; findings go to *Deviations*. Block counts are `/** */` and `/* */` blocks plus
runs of `//` lines, counted by script at HEAD.

| File | Blocks checked | Corrected | Deleted | What was wrong / verified |
|---|---|---|---|---|
| `src/session.ts` | 144 (all) | 5 | 0 | `DEFAULT_GRANT_USES` said bucket 5's dialog "will want" an allow-next-N grant (#35 landed *deny remaining* and none such); `withoutReplayedCalls` described a key match (now positional); `CachingRegistry`, `expectCount`, the resume cap documented with their fixes. Verified: `resumeSuspended` calls `tool.execute` directly (`src/sandbox.ts:1428`); the first snippet's mark includes the preamble's prints (probe: 12 bytes for `prefix line\n`). |
| `src/repl.ts` | 108 (all) | 4 | 1 | "`Session` strips replayed entries from an ok result and from nothing else" (false since D125); "`Session.filterCachedCalls`" (renamed in W2-2); "the pi command … lands separately" (`/repl-accept-preamble` shipped in W2-1); the `seq`-is-wave-3 sentence rephrased as the sandbox's to report. Deleted: an orphaned "Render a filename inside a model-facing notice" block whose function lives in `toolstore.ts`. |
| `src/bridge.ts` | 36 (all) | 1 | 0 | "Read-only tools … require no approval" omitted `gateReads`. Verified against `@earendil-works/pi-coding-agent` 0.84.1 `dist`: no exported `detectImageMimeType`; `find` uses `operations.glob` instead of `fd`; the bash schema says "no default timeout"; a non-zero exit throws with the output as the message; NFD and curly-quote path fallbacks. |
| `src/redact.ts` | 28 (all) | 4 | 0 | consumers said the #46 / #63 exports were "next" (both landed); family 1, Digest and Bearer docs rewritten with their rules. |
| `src/registry.ts` (prompt text; comments were W2-3's) | 1 | 1 | 0 | "Class definitions … are not supported" — a plain class runs on 0.0.21 (measured in the test). |
| `src/index.ts` | 15 (all) | 1 | 0 | the Repl section comment named two outcome types; three trace types added. |
| `README.md` | 527 lines (all) | 8 (+2 sections) | 0 | lint is `biome check && knip` (×2); the non-null-assertion sentence ("three `src/` sites … #84, #50, #78 are actively rewriting" — zero sites, all three closed); "treat the 57%" vs the 58% floor; "all 465 tests" (~1450); CI has lint and coverage jobs; "1811 lines" dated; the trace sentence. Added: Module map (#174), the `.claude/` note. |
| `docs/mutation-testing.md` | 372 lines (all) | 3 | 0 | the two `resume` survivors "untracked elsewhere" (both measured killed, below); the depth guard cited at `rlm_loop.ts:223-227` (now `src/rlm.ts`, `onRLMQuery`); runbook pointer. |
| `docs/approval-grants.md` | 186 lines (all) | 1 | 0 | "#110 … still has no test" (closed 2026-08-17, PR #147). Verified: `:49-52` already says replay stays (W2-2); `:107` "`dump()`/`load()` are never called on the shipped path" (`grep` of `src/repl.ts`, `extensions/`: none). |
| `docs/redaction.md` | 124 lines (all) | 6 | 0 | rows 1, 2a-Digest, 2b; the false-negative and false-positive lists; the consumers table ("per their specs / wave 2" → the two budgets). |
| `docs/project-trust.md` | 232 lines (all) | 2 | 0 | "lands in the next wave" / "not in this wave" for `/repl-accept-preamble`. |
| `src/toolstore.ts` (not owned) | 143 blocks; 63 claim lines read | 0 | 0 | nothing found false. |
| `src/rlm.ts` (not owned) | 175 blocks; 96 claim lines read | 0 (1 reported) | 0 | `:793-794` "refinement deferred to #76's synthesis" — #76 is closed and the hedge is still verbatim by test 9.3.6; stale tense, reported below. |
| `docs/session-replay.md`, `docs/tool-trace.md`, `docs/bash-env.md`, `docs/http-egress.md`, `docs/path-jail.md`, `docs/platform-support.md` (not owned) | 826 lines; forward-looking and issue lines read | 0 (2 reported) | 0 | `session-replay.md:99` "refuses a dump beyond either cap" (now also the combined cap); `tool-trace.md:148-149` "`seq` … arrives in wave 3" (true at this HEAD, W3-1-dependent). |
| historical records (`docs/review-*`, `ship-*`, `verify-*`, `REVIEW.md`, `monty-0021-spike.md`) | dated documents | — | — | not swept for currency, by design. |
| **Total** | **≈ 700 blocks + 1 631 doc lines** | **36 corrections (+2 sections)** | **1** | |

The brief's three greps at HEAD: `git grep '#40 removes transcript replay' -- src docs scripts` →
nothing. `'41 MB'` → four hits, all past tense (`docs/monty-0021-spike.md:13`,
`docs/mutation-testing.md:130,252`, `src/registry.ts:354`, `src/sandbox.ts:448` — "that leak is
gone", "later fixed"). `'never read'` → five hits, all true statements about untrusted files, the
guard's exit-code reading or the memory of `maxFiles`; none is the stale claim.

**Claims that became tests** (the part with lasting value):

| Claim (was prose) | Test |
|---|---|
| "nothing about the session changes on a refusal" — now on resume too | `test/session.test.ts:3117` |
| "reject, never coerce" for the stdout marks; the suspension's mark is the retained stdout's length | `:3152`, `:3170` |
| "a dump the cache could not admit the suspended call into is refused at load" | `:3239`, `:3257` |
| "every outcome's trace is this call's" — including an approved restored gated call | `:3267`, `:3298`, `:3343` |
| "the prefix is the evidence, not the boundary" / why `sk-` differs | `test/redact.test.ts:123`, `:143` |
| "a trailing period is punctuation" | `:462` |
| "the Digest list is read per parameter, not through a window; a parameter is masked by its own name" | `:481`, `:495`, `:512`; bounded-work shapes `:1176-1188` |
| "a plain class runs; inheritance raises" (prompt text) | `test/registry.test.ts:261` |
| "the barrel does not name `arg`" (whole word) | `:198` |
| "the trace types are public" | `test/repl.test.ts:3586` |
| "the resume message says what was not resumed" (StringLiteral survivor) | `:525` |
| the docs say what the code does (redaction window, accept command) | `test/redact.test.ts:1267`, `test/repl.test.ts:3597` |

## Verification evidence

- **RED at `d362ff6`, against main's `src/`** (the branch's own `src/` is main's at that commit):
  `test/session.test.ts` 126 tests, 117 pass, **7 fail**, 2 todo; `test/redact.test.ts` 146, 140,
  **6 fail**; `test/registry.test.ts` 50, 49, **1 fail**; `test/repl.test.ts` 141, 138, **2 fail**,
  1 todo. Every failure is the intended assertion (`'ok' !== 'error'` on the resume cap, "Missing
  expected exception" on the three validator tests, `calls` `[]` on P1, the glued/Digest/Bearer
  masks, the class text, the barrel text, the two docs pins). Controls green on main by design,
  disclosed in the RED commit: the `/\barg\b/` pin, the second-sentence assertion (RED by blanking
  the literal: `docs/mutation-testing.md` records it), the quoted-Digest guard, the
  resolution-failure classification pin, the 1022 + 1 resume half, the four bounded-work shapes.
- **GREEN at `44eddb4`:** the four files 126/124/0/2 · 146/146/0/0 · 50/50/0/0 · 141/140/0/1;
  `test/readme.test.ts` 6/6 after the module map.
- **Gates at `44eddb4`:** `npm run check` exit 0 · `npm run lint` exit 0 (Biome 61 files clean;
  knip clean, one *configuration hint* that the `.claude/**` ignore is unused — expected, see
  Deviations) · `REQUIRE_BRIDGE_TOOLS=1 npm run test:contained` → **1543 tests, 1531 pass, 0 fail,
  12 todo** (47.7 s, `MemoryMax=12G`, exit 0, no OOM) · `npm run coverage` (in a 14G scope) →
  **"All per-file floors met"**, exit 0: `src/session.ts` 99.87 (floor 98.73), `src/redact.ts`
  100.00 (100), `src/registry.ts` 98.27 (98.27), `src/repl.ts` 100.00 (100), `src/bridge.ts`
  100.00 (99.77), global 99.01.
- **Measurements behind the decisions** (probe scripts in the session scratchpad, results in the
  spec): the suspension's `stdoutBytes` equals `byteLength(stdout)` on every real dump with
  `stdoutTruncated: false` (100/100, 20/20 with a partial line and UTF-8, 41/41 across a
  re-suspension, 0/0) and exceeds it when true (40001 vs 32750; 13890 vs 4741 by the line cap);
  the resume-path `live.busy--` → `live.busy++` mutant fails `test/repl.test.ts:1813` with
  `2 !== 1`; a `.claude/worktrees/probe/biome.json` makes `biome check` exit 1 with the
  nested-root diagnostic, and `.gitignore` alone, `"!.claude"` alone and `"!!.claude"` alone each
  make it exit 0 (`"!!.claude/**"` does not); `**{"text": "b"}` is the one resolution failure
  Monty's checker cannot see.
- **How a reviewer reproduces the adversarial probes:**
  - P1: `test/session.test.ts:3267` is the verifier's probe verbatim; drop
    `invocations.push(false)` before the restored-gated `originalExecute` in `src/session.ts` and it
    fails with `calls` `[]`.
  - P8: `:3117`; revert the `resumeNow` cap and the test ends with `Session.load` refusing the
    session's own dump (257 snippets).
  - P9 / P11: `:3239`, `:3152` — revert `Number.isSafeInteger` to `Number.isInteger` or drop the
    combined cap and the "Missing expected exception" assertions fire.
  - Redaction: `npx tsx -e 'import {maskSecrets} from "./src/redact.ts"; …'` with the three
    verifier inputs (`xxxghp_…`, the 4 200-char `uri=`, `the Bearer implementations.`) → masked
    1 / 1 / 0.
  - Prose-comb: every `file:line` cited in this report and in `tasks/spec-w3-2.md` was re-read at
    `44eddb4`; the ten README/docs citations most likely to be picked (`src/preamble.ts` path,
    `src/rlm.ts` `"rlm.py"`, `test/rlm.test.ts` M21, `extensions/repl-extension.ts`
    `/repl-accept-preamble`, `test/repl.test.ts:517` in mutation-testing.md, `docs/ship-150.md`,
    `scripts/contained.mjs --limit`, `scripts/mutation-guard.mjs --report`, `--dryRunOnly`,
    `onRLMQuery`'s `depth >= maxDepth`) resolve.
  - Tooling: `mkdir -p .claude/worktrees/x && cp biome.json .claude/worktrees/x/ && npm run lint`
    → exit 0; the same on `acadb19` → exit 1.

## Residuals as todo tests

None new. The 12 todos in the suite are the pre-existing ones (W2-1's concurrent-runs recorder,
W2-2's denied-restored-entry cursor, and the earlier waves'); W2-3's class-rule todo is now a
passing test.

## Deviations

- **`sk-` keeps its word boundary** (D155). "Mask a token glued mid-word" is applied to ten of the
  eleven prefixes; without the boundary `task-force-2024-report` and `risk-assessment-2025-final`
  are `sk-` keys. Pinned both ways (`test/redact.test.ts:143`), recorded in `docs/redaction.md`.
- **"Bound it to the retained stdout length"** (D154b) is applied where a retained length exists —
  the suspension's mark equals `byteLength(suspended.stdout)` when nothing was truncated — and as
  the safe-integer bound elsewhere: the per-snippet marks measure the live stream, which a dump does
  not retain, so no tighter bound is honest.
- **The combined cache cap counts the suspended call's slot** (D154c), one more than the verifier's
  suggested `callCache + preGateCache <= 1024`: that is what rejects P9's 1023 + 1 dump *at load*,
  which was the finding.
- **knip prints a configuration hint** ("`.claude/**` knip.json Remove from ignore") because its
  `project` globs never reach `.claude/`; the entry is kept as instructed and the README says why.
  Exit code 0; CI's lint leg is unaffected.
- **Not owned, reported for their owners** (exact text): `src/rlm.ts:793-794` "A comma hedge … is
  submitted verbatim — pinned by test, refinement deferred to #76's synthesis" → "kept verbatim by
  design (#76 closed without refining it)". `docs/session-replay.md:99` "`load()` refuses a dump
  beyond either cap." → "… beyond either cap, and one whose `callCache` and `preGateCache` together
  leave no room for the suspended call (D154c)." `docs/tool-trace.md:148-149` "the `seq` index that
  lines the two up arrives in wave 3 (decision 11)" is true at this HEAD and becomes stale when
  W3-1 lands; neither file is in either wave-3 chunk's list.
- **README `:82` ("Unordered relative to `stdout` for now")** is now phrased for either outcome of
  W3-1 ("where each call fell in `stdout` is the sandbox's to report per call (`seq`, #46)").
- **`test/session.test.ts:409-419` (#178's third site)** already uses `withPatchedPrototype` — W2-2
  applied it at `:430`; nothing to do.
- **The runbook's shard list is a suggestion**, sized from `docs/mutation-testing.md`'s memory
  findings, not measured; the runbook says so and asks for `--dryRunOnly` first.
- **`gh issue view --comments` / `gh issue edit` fail on this repo** (Projects-classic GraphQL
  deprecation); issues were read and #175's label and comment actions taken over the REST API.

## Closing-comment drafts (for the orchestrator, after merge)

**#86**
> Closed by W3-2 (PR #NNN, merge `<sha>`), the second half of the sweep (W2-3 did the cold files in
> #212). Ledger in `tasks/ship-report-w3-2.md`: every comment block in `src/session.ts` (144),
> `src/repl.ts` (108), `src/bridge.ts` (36), `src/redact.ts` (28), `src/index.ts` (15) and the
> prompt text of `src/registry.ts` read against the code and the tracker; 16 blocks corrected, 1
> deleted; `README.md` and five docs swept (20 corrections); `src/toolstore.ts` and `src/rlm.ts`
> checked on their claim-bearing lines (one stale tense reported). Twelve checkable claims became
> named tests — the table "Claims that became tests" lists each with its `file:line`; the two
> resume-method survivors from the #110 sweep are measured killed (`docs/mutation-testing.md`).
> DoD: the three contradictions in the issue's table were resolved by #71, #76 and #23; the
> `resolveToolArgs` comment is W3-1's (`src/sandbox.ts`) this wave.

**#174**
> Closed by W3-2 (PR #NNN) as document-only, per session decision 16. README now carries a "Module
> map": `src/repl.ts` is the runner behind the `repl*` tools, `src/rlm.ts` the RLM loop,
> `src/rlm_tools.ts` the loop's sandbox-side tools, `repl/repl_server.py` the bundled preamble
> (hard-coded in `src/preamble.ts`, shipped via `package.json` `files`). No rename: it would orphan
> `coverage-baseline.json` keys, reopen #81's `files` list, and touch the pinned `scriptName`
> default `"rlm.py"` (`src/rlm.ts`, `test/rlm.test.ts` M21) the diagnostic regex reads.

**#83**
> Closed by W3-2 (PR #NNN). The three exit criteria, evidenced:
> 1. *No exported symbol is unreachable* — `knip` runs in `npm run lint` since W2-3 (#212,
>    decision 14); `arg()` deleted, the barrel pinned (`test/registry.test.ts:198`).
> 2. *No comment in `src/` contradicts the code beneath it* — W2-3's ledger (266 blocks, cold
>    files) plus this one (`tasks/ship-report-w3-2.md`, the warm files and docs); the remaining
>    unowned findings are three stale sentences listed in the report's Deviations.
> 3. *Resumed runs preserve the options they were suspended with* — W1-2 (#84, decision 2):
>    `test/session.test.ts` "resume carries what it was suspended with (#84, #38)".
> #175 is re-homed as standalone infra (decision 17) with `docs/mutation-rebaseline-runbook.md`;
> #178 (the `bucket-11` label added by the W1-1 audit) is closed.

**#175** (posted by this chunk on re-label — the only issue action taken)
> Re-homed as standalone infrastructure (session decision 17, 2026-09-08): `bucket-11` removed,
> `infra` added. The procedure is `docs/mutation-rebaseline-runbook.md` (PR #NNN): a fresh
> `.stryker-incremental.json` and why, `--dryRunOnly` to size the run, `--mutate` shards into one
> incremental file under `scripts/contained.mjs --limit`, a big-memory host with nothing else
> running the suite, freshness and provenance checks, and which numbers to write where. The #165
> charge/refusal branches in `src/rlm.ts` are in the shard list.

## Go / No-Go

**GO.** Four gates green at `44eddb4`; every new non-control test RED against main's `src/` and
GREEN on the branch; no floor moved; no file outside the chunk's list touched; the only issue
action is #175's re-label and comment.
