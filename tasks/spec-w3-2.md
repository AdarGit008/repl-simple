# Spec — W3-2: Craft close-out

Chunk: `w3-2` · Branch: `chunk/w3-2-craft-closeout` · Base: `main` (`acadb19`) · Closes #86, #174,
#83 (with #175 re-homed, not closed) · Decision IDs: D151–D158 · Maintainer decisions applied: 16
(#174 document-only), 17 (#175 standalone infra), 9 (residuals as todo tests)

## Objective

Close bucket 11. Three things are owed:

- **#86, second half** — the comment sweep over every file W3-1 does not own (W2-3 did the cold
  files), with the counted ledger the issue's DoD asks for: files checked, comments corrected,
  deleted, and which checkable claims became named tests.
- **#174** — the `repl.ts` / `rlm.ts` / `rlm_tools.ts` / `repl_server.py` naming, resolved by
  documenting it (decision 16): a README module map, no renames.
- **#175 → #83** — the 0.0.21 mutation re-baseline is not a session task; it is re-labelled as
  standalone infra with a runbook (decision 17), so #83's three exit criteria can be evidenced and
  the epic closed.

And the wave-2 carry-overs this chunk owns: four `src/session.ts` findings (W2-2 verifier), four
`src/redact.ts` findings (W2-1/W2-3 verifiers), the false class claim in `renderPythonToolRules`,
two stale sentences in `docs/project-trust.md`, the weak barrel pin, the missing `RunTrace`
re-export, and the Biome nested-root failure caused by the orchestrator's worktrees under
`.claude/`.

## Current state, measured at `acadb19` (2026-09-08)

- `src/session.ts:744-758` `runNow()` refuses at `MAX_SNIPPETS`; `resumeNow()` (`:912-1034`) never
  consults it and `retain()` (`:1297`) appends unconditionally, so a hand-built dump with 256
  snippets plus a suspension resumes to 257 snippets that `dump()` writes and `load()` refuses.
- `:430-435` `expectCount` accepts `1e308` (`Number.isInteger` is true); one such mark empties the
  next run's stdout, two sum to `Infinity` and `makePrintCallback`'s `Number.isFinite` guard
  (`src/sandbox.ts:406-409`) turns that into "skip nothing". **Measured** (probe): on a real dump
  `suspended.stdoutBytes === Buffer.byteLength(suspended.stdout)` whenever `stdoutTruncated` is
  false — 100/100, 20/20 (partial line + UTF-8), 41/41 across a re-suspension, 0/0 — and strictly
  greater when it is true (40001 vs 32750 by bytes; 13890 vs 4741 by the line cap). The relation
  cannot be asserted for the truncated case: the marker can be longer than the dropped tail.
- `:531` and `:584` cap `preGateCache` and `callCache` at 1024 each, independently; `resumeNow`'s
  capacity (`:962`) is `1024 − callCache − preGate`, so a dump of 1023 + 1 loads and then refuses
  the suspended call itself with `session replay cache is full` (verifier probe P9).
- `:1454-1497` `withoutReplayedCalls` drops trace entries whose key matches one of the first
  `priorEntryCount` cache keys. A restored gated entry (D128) that the user approves runs for real
  (`:259`) and advances the cursor (`:253`); its `approved: true` trace entry is dropped as if
  served (probe P1: `calls` is `[]` while executions went 1 → 2 and a dialog was shown).
  `src/sandbox.ts:1051-1181, :1429-1481` push exactly one trace entry per `tool.execute`
  invocation (return, throw, `SubmitSignal`) and one for each of the two calls that never reach
  `execute`: a resolution failure (`:1051`, `ok: false`, no `approved`) and a denial (`:1095`,
  `ok: false, approved: false`).
- `src/redact.ts:61-62` `TOKEN_PREFIX` requires `\b` before every prefix, so `xxxghp_…` is data;
  `:115-118` `DIGEST_HEADER` reads `[^\n]{0,4096}` past `Digest`, so a `response=` beyond a 4 KiB
  `uri=` survives; `:119-122` `DIGEST_PARAMETER` matches `\bresponse=` anywhere in that window,
  inside another parameter's quoted value included; `:135-142` `BEARER_VALUE` counts `.` toward the
  16-character evidence, so `the Bearer implementations.` masks one prose word.
- `src/registry.ts:518` tells the model "Class definitions and match statements are not
  supported"; `test/registry.test.ts:258` is W2-3's todo test for it; README `:24-29` already says
  a plain class works and only inheritance, metaclasses and `match` raise.
- `src/index.ts` re-exports `ReplRunner`, `AbandonOutcome`, `ReplRunnerOptions`, `ResetOutcome`
  and not `RunTrace` / `TracedCall` / `TraceStatus`, the return type of the public
  `runWithTrace()` (`src/repl.ts:82-99`); `extensions/repl-extension.ts:5` imports them from
  `../src/repl.js` directly.
- `test/registry.test.ts:198-200` pins the barrel with `/^\s*arg,?\s*$/m`, which a one-line
  `export { arg } from "./registry.js"` would pass; `git grep '\barg\b' src/index.ts` is empty.
- `test/session.test.ts:430` already uses `withPatchedPrototype` (W2-2 applied #178's third site;
  the brief's `:409-419` cite predates that). Nothing to do.
- `docs/project-trust.md:131-132, :204` say the accept command "lands in the next wave" / "is not
  in this wave"; `extensions/repl-extension.ts:29` registers `/repl-accept-preamble` (W2-1).
- `docs/mutation-testing.md:349-358` lists `src/repl.ts:230` (StringLiteral, "nothing waiting")
  and `:233` (UpdateOperator, `live.busy--`) as survivors "untracked elsewhere". **Measured:**
  the resume-path `live.busy--` → `live.busy++` (now `src/repl.ts:574`) is killed by
  `test/repl.test.ts:1813` ("a pending suspension is never evicted — the pool exceeds its cap
  instead", assertion at `:1836`: `2 !== 1`). The string literal (now `:562-563`) is asserted only
  by its first sentence (`/nothing waiting for approval/i`, five sites); the second sentence is
  unasserted.
- README stale spots: `:270` and `:355` say `npm run lint` is `biome check` (it is `biome check
  --error-on-warnings && knip` since W2-3); `:379-382` "its three `src/` sites … #84, #50, #78 are
  actively rewriting" — `biome lint --only=style/noNonNullAssertion src` reports zero sites and all
  three issues are closed; `:466` vs `:474` (58% floor vs "the 57%"); `:477` "all 465 tests" (the
  suite is ~1450); `:513` CI runs lint and coverage jobs too (`.github/workflows/ci.yml`); `:82`
  "Unordered relative to `stdout` for now" is W3-1's to change and is phrased for either outcome.
- `src/repl.ts:114-119` says `Session` strips replayed entries "from an ok result and from nothing
  else" (false since D125 — all three outcomes); `:178` names `Session.filterCachedCalls` (renamed
  `withoutReplayedCalls` in W2-2); `:633-634` "the pi command that exposes it lands separately"
  (it landed); `:1086-1091` is an orphaned doc block for a function that moved to `toolstore.ts`.
- `src/session.ts:66-71` says bucket 5's dialog "will want to hand out 'allow the next N'" — #35
  landed with *deny remaining* and, deliberately, no such option (`docs/approval-grants.md:72-77`).
- `src/redact.ts:30-31` says the trace and dump exports of #46 / #63 are "next" — both landed in
  wave 2 (`src/session.ts:1149`, `extensions/repl-extension.ts` `buildDetails`).
- `docs/approval-grants.md:185-186` says #110 "still has no test" — closed 2026-08-17 (PR #147),
  `test/repl.test.ts:540-575` drives `Repl.resume()` with approve, pre-aborted and deny.
- Biome: a directory `.claude/worktrees/<x>/` holding a copy of `biome.json` makes `biome check`
  from the root fail with *Found a nested root configuration* (reproduced with a probe dir).
  **Measured:** `.claude/` in `.gitignore` alone fixes it (`vcs.useIgnoreFile: true`); so does
  `"!!.claude"` in `files.includes` alone; `"!.claude"` too; `"!!.claude/**"` does not. `knip`
  passes with the probe present (its `project` globs never reach `.claude/`).
- `gh issue view --comments` and `gh issue edit` fail on this repo (Projects-classic GraphQL
  deprecation); the REST API works and is what this chunk uses for reading and for #175's actions.

## Decisions

- **D151 — The #86 ledger: method, scope, what counts.** Every comment block in the owned files
  (`src/session.ts`, `src/repl.ts`, `src/bridge.ts`, `src/redact.ts`, `src/registry.ts` prompt
  text, `src/index.ts`) and every sentence in the owned docs (`README.md`, `docs/mutation-testing.md`,
  `docs/approval-grants.md`, `docs/redaction.md`, `docs/project-trust.md`) is read against the code
  it describes and against the tracker (issue states re-checked over REST). A claim is corrected
  only when measured false today; a comment that merely restates its line is deleted; a
  guarantee stated in prose gets a named test where one is cheap and missing. Files W3-1 does not
  own but this chunk may not modify (`src/toolstore.ts`, `src/rlm.ts`, `docs/session-replay.md`,
  `docs/tool-trace.md`, the four bucket-4 docs) are **checked and ledgered**; their corrections go
  to the ship report's deviations with exact text, never applied. Historical records
  (`docs/review-*`, `ship-*`, `verify-*`, `REVIEW.md`, `monty-0021-spike.md`) are dated documents
  and are listed as such, not swept for currency. pi-internals claims in `src/bridge.ts` are
  verified against `node_modules/@earendil-works/pi-coding-agent/dist` (0.84.1).
- **D152 — #174 is a README module map, no renames (decision 16).** The transposition is real:
  `src/repl.ts` is the *runner* behind the `repl*` tools and `src/rlm.ts` is the RLM *loop*;
  `src/rlm_tools.ts` is the loop's sandbox-side tools; `repl/repl_server.py` is the bundled
  preamble, hard-coded at `src/preamble.ts:7` and shipped through `package.json` `files`. A rename
  would orphan `coverage-baseline.json` keys, reopen bucket 10's `files` list (#81), and touch the
  pinned `scriptName` default `"rlm.py"` (`src/rlm.ts:1275`, `test/rlm.test.ts:5415`, M21) and the
  diagnostic regex that reads it. The map says what each file is so the names stop misleading.
- **D153 — #175 is standalone infra with a runbook (decision 17); #83 closes.**
  `docs/mutation-rebaseline-runbook.md` is the out-of-session procedure: fresh
  `.stryker-incremental.json` (the `coverageAnalysis: "off"` reuse trap, `docs/ship-150.md`), a
  big-memory host (20G ceiling ample; the recursion-guard mutants reach 5.6 GB each), never
  concurrent with another suite (an OOM kill scores as a killed mutant, #109), sharding by
  `--mutate` with one incremental file, `scripts/contained.mjs --limit`, `--dryRunOnly` to size the
  run, freshness *and* provenance checks before any number is written down, and exactly which
  numbers to record where. The only issue actions this chunk takes: #175 loses `bucket-11` and
  gains `infra`, and gets the runbook link as a comment. #83's criteria: 1 (no unreachable export)
  is W2-3's `knip` gate; 2 (no contradicting comment) is this ledger plus W2-3's; 3 (resumed runs
  keep their options) is W1-2's `test/session.test.ts` "#84" block. Closed by the PR's `Closes`
  lines, not by hand.
- **D154 — `Session` carry-overs, four fixes.**
  (a) `resumeNow()` refuses before touching anything when `snippets.length >= MAX_SNIPPETS`: the
  same `unavailable` `RunError` as `run()`, the suspension left pending, nothing executed; `reset()`
  (or `abandon()`) is the way out. The alternative — refusing the dump at load — was not taken: the
  instruction is a `RunError` on resume, and a dump at the cap without a suspension is legitimate.
  (b) Every stdout mark is a **safe integer** (`<= Number.MAX_SAFE_INTEGER`), their sum too, so no
  file can turn the mark into `Infinity`; and the suspension's figure is bound to the retained
  stdout: when `stdoutTruncated` is false, `suspended.stdoutBytes` must equal
  `Buffer.byteLength(suspended.stdout)` (measured to hold on every real dump). Nothing is bounded
  against a length the dump does not carry — the per-snippet marks measure the live stream, which
  is not retained.
  (c) One combined cache cap at load: `callCache + suspended.preGateCache` (+ 1 for the suspended
  call's own entry, which the continuation must record) `<= MAX_CACHE_ENTRIES`, refused by name
  with both counts. The per-array caps stay (their messages are pinned).
  (d) `withoutReplayedCalls` is **positional**: `createCachingRegistry` keeps an invocation log —
  one boolean per `execute` call it saw, in order, `true` when the call was answered from the
  cache — and the session walks the trace classifying each entry as an invocation or not (a
  resolution failure — `resolveToolArgs` throws again on its arguments — and a denial —
  `approved === false` — never reached the registry), pairing invocations with the log in order and
  dropping exactly the served ones. Keys are never compared. Surviving entries are the sandbox's
  own objects, so any field W3-1 adds (`seq`) rides through untouched. A pure count of leading
  `ok: true` entries was rejected: the restored-gated case has an executed entry *before* a served
  one, which is the bug itself.
- **D155 — `redact.ts` carry-overs, three rules.**
  Family 1 drops the word boundary for the ten distinctive prefixes (`ghp_` … `AIza`) so a glued
  token masks; `sk-` keeps its boundary, because without it `task-force-2024-report` and
  `risk-assessment-2025` are masked whole — a real cost the tests pin both ways. The Digest rule
  becomes a **per-parameter tokenizer**: the header's parameter list is consumed one `name=value`
  at a time (quoted values read to their closing quote, spaces and commas inside them included;
  bare values to the next separator; the list ends at `;`, a newline or an unparseable token), and
  only a parameter *named* `response` / `nonce` / `cnonce` is masked — so a hash after a 1 MiB
  `uri=` is masked, `username="nonce=zzz"` is one parameter, and `uri="/x?response=1"` survives. No
  window; each header is one bounded scan of its own list, pinned by three new bounded-work shapes.
  The bare-Bearer evidence counts 16 token characters *not ending in a period*, and the masked run
  never ends in one, so `the Bearer implementations.` is prose and `bearer 0123456789abcdef.` keeps
  its full stop.
- **D156 — The class line is prompt text and prompt text is behaviour.** `renderPythonToolRules`
  now says class inheritance, metaclasses and `match` are unsupported and a plain class with
  `__init__` and methods works; W2-3's todo test loses its `todo` and gains the measurement it
  asserts (a plain class runs, `class B(A)` raises `NotImplementedError`) so the sentence cannot
  outlive the interpreter it describes.
- **D157 — Public surface and doc corrections.** `src/index.ts` re-exports `type RunTrace`,
  `TracedCall`, `TraceStatus` beside `ReplRunner` (pinned by a text test on the barrel; a type
  export has no runtime to fail). The barrel pin becomes `/\barg\b/` over the whole file. The
  "nothing waiting" message's second sentence is asserted at the M7 test. `docs/mutation-testing.md`
  records the measured kill of the `busy--` mutant and this chunk's assertion for the literal.
  `docs/project-trust.md` says the command exists. README fixes: lint command, non-null-assertion
  sentence, 58/57, test count, CI jobs, the module map, and the `.claude/` note.
- **D158 — `.claude/` is tooling state, ignored three ways.** `.gitignore` (`.claude/`), Biome
  (`"!!.claude"` in `files.includes` — the double negation keeps the scanner out, which is what the
  nested-root check runs in; `.gitignore` alone would also do, and both are kept so the fix does
  not depend on `vcs.useIgnoreFile`), and `knip.json` `ignore` (`.claude/**`). Verified with a
  throwaway `.claude/worktrees/probe/` holding a `biome.json` copy: `npm run lint` fails before,
  passes after, and the probe is removed. README's lint section says why.

## Tests — RED → GREEN plan

RED commit (each fails against `main`'s `src/`, except the disclosed pins):

| Test | File | Fails on main because |
|---|---|---|
| resume at the snippet cap refuses (`unavailable`), keeps the suspension, dump still loads | `test/session.test.ts` | main resumes to 257 snippets and `load()` refuses the dump |
| `stdoutBytes[i]` and `suspended.stdoutBytes` over `MAX_SAFE_INTEGER` (1e308, 2^53) rejected by name; a safe pair whose sum is unsafe rejected | `test/session.test.ts` | main accepts them |
| `suspended.stdoutBytes ≠ byteLength(stdout)` with `stdoutTruncated: false` rejected; equal loads; unequal with `true` loads | `test/session.test.ts` | main accepts the mismatch |
| 1023 + 1 with a suspension refused at load naming both; 1022 + 1 loads and resumes to 1024 | `test/session.test.ts` | main loads 1023 + 1 |
| approved restored gated call is in `calls` (P1); mixed restored `[gate, echo]` keeps the gate and drops the echo; served/executed pair with one key keeps the executed one; kept entries are the sandbox's objects, fields intact | `test/session.test.ts` | main filters by key |
| `xxxghp_…` masks; `xxxsk-…` and `task-force-2024-report` are data | `test/redact.test.ts` | main: glued is data |
| Digest `response` after a 5 000-char `uri` masks; `username="nonce=zzz"` untouched; `uri="/x?response=1"` survives with `masked 1`; quoted value with spaces | `test/redact.test.ts` | window / inner match |
| `the Bearer implementations.` unchanged; `bearer 0123456789abcdef.` keeps its period | `test/redact.test.ts` | `.` counted |
| bounded work: 1 MiB `;`-joined Digest headers, one Digest with a 1 MiB `uri`, one with 60 000 parameters | `test/redact.test.ts` | pins linearity (control, green on main) |
| class rule: no "Class definitions … not supported", names inheritance; a plain class runs, `class B(A)` raises | `test/registry.test.ts` | main's text |
| barrel names `RunTrace`, `TracedCall`, `TraceStatus` | `test/repl.test.ts` | main's barrel lacks them |
| barrel pin `/\barg\b/` | `test/registry.test.ts` | pin — green on main (disclosed) |
| "nothing waiting" second sentence | `test/repl.test.ts` | pin — RED by blanking the literal (disclosed) |
| docs pins: `docs/redaction.md` has no "4 KiB" limit row; `docs/project-trust.md` no "next wave" | `test/redact.test.ts`, `test/repl.test.ts` | RED by commit order (docs are not swapped) |

GREEN: `src/session.ts`, `src/redact.ts`, `src/registry.ts`, `src/index.ts`, then docs, README,
tooling. Todo tests for anything left.

## Boundaries

Owned: `src/session.ts`, `src/repl.ts`, `src/bridge.ts`, `src/index.ts`, `src/registry.ts`,
`src/redact.ts`, `test/session.test.ts`, `test/repl.test.ts`, `test/redact.test.ts`,
`test/registry.test.ts`, `README.md`, `docs/mutation-testing.md`, `docs/approval-grants.md`,
`docs/redaction.md`, `docs/project-trust.md`, `coverage-baseline.json`, `.gitignore`, `biome.json`,
`knip.json`; created: `tasks/spec-w3-2.md`, `tasks/ship-report-w3-2.md`,
`docs/mutation-rebaseline-runbook.md`. Never: W3-1's files (`src/sandbox.ts`, `src/types.ts`,
`src/truncate.ts`, `src/submit_signal.ts`, `extensions/`, their tests, `docs/truncation-policy.md`).
No new dependency. No rename. No issue comment except #175's re-label and runbook link.
