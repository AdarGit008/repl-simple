# Spec — W1-2: `Session.resume` carries what it was suspended with

Chunk: `w1-2` · Branch: `chunk/w1-2-session-resume-carries` · Base: `main` (`3770e46`) · Closes #38, #84, #26, #47 · Decision IDs: D73–D80

## Objective

One function, four findings, two epics. `Session.resume` must run the continuation with the options
the run was *suspended* with — mount and byte caps included, not only `limits` — under an explicit,
written precedence rule; the two clocks must be documented as they measure, not as the 0.0.18 doc
guessed; the two bucket-5 residuals that block closing #47 (dialog on a dead call; a throwing resume
wedging the session) must be fixed; and the bucket-2 exit criterion 4 boundary mutant at
`src/truncate.ts:262` must be killed by tests that sit exactly on the cap.

## Current state, measured at `3770e46` (2026-09-08)

- `src/session.ts:366` stores the raw `runOpts` on suspension; `:437` merges only `limits`
  (`runOpts?.limits ?? this.suspendedRunOpts?.limits`, #177 D4); `:470` re-stores
  `{ ...runOpts, limits }` on a nested re-suspension; `:611` restores `suspendedRunOpts` on `load`.
  Nothing reads `mount`, `maxStdoutBytes` or `maxOutputBytes` back. `grep -n mount src/session.ts
  test/session.test.ts` → no hits.
- `src/sandbox.ts:1270` (`maxStdoutBytes`), `:1311` (`mount`), `:1400` and `:937` via `capOutput`
  (`maxOutputBytes`), `:1281` (`signal`), `:1298` (`onPrint`), `:1308`/`:1313` (`limits`),
  `:1349`/`:1452` (`lineOffset`) are what `resumeSuspended` reads from the options it is handed.
  `inputs` (`:1225`) and `scriptName` (`:1173`) are read only by `runInSandbox`.
- `src/repl.ts:250`: `ReplRunner.resume` passes `{ onApproval, signal, limits }` — nothing else — so
  through the product a resumed run has no mount and the 32 KiB / 16 KiB default caps.
- `src/session.ts:399-404`: `onApproval` is awaited before any abort check; the extension guards at
  `extensions/repl-extension.ts:227`, the library entry does not (#47, PR #151 INFO #1).
- `src/session.ts:442-458`: `resumeSuspended` is awaited with no `try`; the suspension is cleared
  only on the success path. A throw (e.g. `SandboxMemoryError` from `assertMemoryHeadroom`,
  `src/sandbox.ts:538`) leaves `suspended` set and `isSuspended()` true.
- `src/types.ts:59-64` says *"Suspension resets the sandbox clock … `maxDurationSecs` starts over"*.
  **Measured false** (probes in the ship report): the compute budget is cumulative *and pinned in the
  snapshot*; the host wall clock (`hostDeadlineAt`, `src/sandbox.ts:771`, `Date.now()` per call) is
  per-segment. `RunSuspended` (`:186-194`) documents neither.
- `src/sandbox.ts:1300-1307` comment says #84 "is untouched here". `LoadSnapshotOptions`
  (`node_modules/@pydantic/monty/dist/session.d.ts:75-90`) has four fields; the audit is recorded in
  the rewritten comment (D76) and below.
- `src/truncate.ts:262` `overBudget()` is `totalBytes > maxBytes || totalLines > maxLines`.
  Hand-applying `>=` to either comparison leaves `test/truncate.test.ts` 33/33 and the sandbox
  truncation tests green: no test sits on the boundary.

## Decisions

- **D73 — What is carried.** Exactly four fields survive a suspension: `limits`, `mount`,
  `maxStdoutBytes`, `maxOutputBytes` — the options `resumeSuspended` reads that describe *the run
  being continued*. They are stored as an explicit `CarriedRunOptions` pick at both suspension
  sites (`run` and the re-suspend branch of `resume`) and normalised again on `load`, so a dump
  never carries an `AbortSignal` serialised as `{}` or a closure that JSON dropped. Old dumps with
  the raw shape still load; the extra keys are ignored.
- **D74 — Precedence: the resume call wins.** `caller ?? suspended` for every carried field
  (maintainer decision 2, matching #177 D4). A caller that says nothing gets the suspended value; a
  caller that says something is describing this invocation and is obeyed. Written at `resume()`.
- **D75 — Not carried, by design, and said so in a comment.** `onApproval`, `signal`, `onPrint`
  describe the current invocation (who is asking, whose turn can be cancelled, whose terminal is
  watching). `inputs` are globals in the snapshot already. `scriptName` names the feed for the
  syntax/typing diagnostics `feedStart` raises; a resume is past both. `lineOffset` is the session's
  to compute. `maxWallClockSecs` rides inside `limits` and is the one knob a resume caller can change.
- **D76 — The two clocks, as measured.** `maxDurationSecs` is a budget over the whole run: the
  snapshot carries both the limit and the compute already spent, so a resume cannot lift it, lower
  it, or reset it (probes: 0.2 s snapshot + resume passed 60 s → `TimeoutError` at 200.00 ms;
  60 s snapshot + resume passed 0.1 s → ran ~60 s). `maxWallClockSecs` restarts on every resume
  (maintainer decision 1; 1.8 s + 1.8 s of host-tool time across a gate under a 3 s budget → `ok`;
  the same 3.6 s in one segment → `timeout` at 3001 ms). Both documented on `RunLimits` and
  `RunSuspended`; no `elapsed` field is added because the snapshot already carries it. The
  `LoadSnapshotOptions` audit replaces the "#84 untouched" text in `src/sandbox.ts` (comment only).
- **D77 — Cumulative-budget test is a `todo`.** The only Session-level observable is breach-or-not,
  so a burn/gate/burn assertion is a calibration and cannot be both load-robust and discriminating
  (iteration cost swung 111 → 165 ns/iter between two measurements on this shared host). It ships
  self-calibrating and `{ todo }`, with the intended 20/20 gate in its reason; the measurements are
  in the ship report. What *does* merge as a guard is the load-independent half: the snapshot pins
  the budget, so a gated-tool loop cannot escape the budget of the run that started it (#38 test 3).
- **D78 — A pre-aborted resume asks nobody.** `resume()` checks `runOpts.signal.aborted` before
  consulting `onApproval`; an aborted turn has nobody left to ask. The decision is a denial that
  `resumeSuspended`'s abort gate reports as `aborted` before anything runs, and the suspension is
  consumed — the same outcome the extension's own guard already produces.
- **D79 — The suspension is cleared in `finally`.** `resumeSuspended` is awaited inside
  `try/catch/finally`: the suspension state is cleared whatever happens, a throw also revokes the
  grants the call was holding (a call that threw is over), and a re-suspension re-stores state after
  the clear. A throwing resume leaves `isSuspended() === false` and `run()` usable.
- **D80 — Boundary guards for the `>` vs `>=` mutant.** Tests at exactly the cap — `Truncator`
  bytes and lines, `truncateText`, and both sandbox entry points — assert `truncated === false`
  and verbatim content. They are green on `main` by construction (guards, not RED tests) and fail
  under the hand-applied mutant; the evidence is in the ship report.

## Tests — RED → GREEN plan

RED against `main`'s `src/` (fail before the fix, pass after):

| # | File | Test | Why RED on main |
|---|---|---|---|
| 1 | test/session.test.ts | mounted file readable after suspend/approve/resume (#38 t1, #84 t2) | resume has no mount → `PermissionError` |
| 2 | test/session.test.ts | suspended `maxStdoutBytes` caps post-resume stdout | 32 KiB default → not truncated |
| 3 | test/session.test.ts | suspended `maxOutputBytes` caps post-resume output | 16 KiB default → not truncated |
| 4 | test/session.test.ts | nested re-suspension still carries the mount | re-suspend branch stores no mount |
| 5 | test/session.test.ts | dump/load carries mount + cap, never a `{}` signal (#84 t5) | dump has `signal: {}`; resume has no mount |
| 6 | test/session.test.ts | pre-aborted resume never asks `onApproval` (#47 r1) | `onApproval` awaited first |
| 7 | test/session.test.ts | throwing continuation clears the suspension; `run()` clean (#47 r2) | cleared only on the success path |
| 8 | test/session.test.ts | throwing continuation revokes the call's grants | grants untouched on throw |

Pins and guards (green on `main`; they fix the contract or kill a mutant):

| # | File | Test | Guards |
|---|---|---|---|
| 9 | test/session.test.ts | explicit mount on resume wins (D74) | precedence direction |
| 10 | test/session.test.ts | explicit `maxStdoutBytes` on resume wins (D74) | precedence direction |
| 11 | test/session.test.ts | `inputs` survive through the snapshot (#84 t3) | D75 wording |
| 12 | test/session.test.ts | suspended `signal`/`onApproval` are not carried (#84 t4) | D75 |
| 13 | test/session.test.ts | host wall clock restarts per segment (decision 1) | D76 doc |
| 14 | test/session.test.ts | snapshot pins the compute budget; resume cannot lift it (#38 t3) | D76 doc |
| 15 | test/session.test.ts | `{ todo }` cumulative compute budget (#38 t2) | D77 |
| 16 | test/sandbox.test.ts | stdout exactly at cap on both entry points; lines at `STDOUT_MAX_LINES` | mutant `>=` (D80) |
| 17 | test/truncate.test.ts | `Truncator`/`truncateText` exactly at bytes and lines | mutant `>=` (D80) |

## Boundaries

- Modify: `src/session.ts`, `src/types.ts` (docs only), `src/sandbox.ts` (one comment block only),
  `test/session.test.ts`, `test/sandbox.test.ts`, `test/truncate.test.ts`. Create: this file and the
  ship report.
- Not run: `npm run coverage:update` (W1-5 owns the baseline). Floors met by tests: `src/session.ts`
  98.73, `src/types.ts` 100, `src/truncate.ts` 100.
- No issue comments; no new issues; residuals are `todo` tests.
- Out of scope, recorded for the verifier: the host wall clock's result reaches the caller only once
  the worker's own feed ends when the runaway is Python rather than a host tool (`runInSandbox`,
  compute 3 s / wall 1 s → returned at 3075 ms with the wall-clock message). Lives in
  `src/sandbox.ts` code, which this chunk may not change.
