# Review: #150 — Prove `Repl.resume()` honours an already-aborted signal

Reviewed diff: `origin/main..HEAD`, branch `issue-150-resume-abort-test`. Test-only flight
(`test/repl.test.ts` +20 lines; `SPEC.md`, `tasks/plan.md`, `tasks/todo.md`, `docs/verify-150.md`
as flight artifacts); **no `src/` or `reports/` change** — the wiring under test was already correct
and stays untouched.
Reviewer: fresh adversarial review context, per `code-review-and-quality` skill. The RED step was
re-proven by this reviewer, not taken on trust from the doc.

## Context

- **Intent:** close the gap where a single-field mutant dropping `signal` from
  `session.resume({ onApproval, signal })` at `src/repl.ts:235` would survive the suite — Stryker's
  `ObjectLiteral` mutator only generates `{}`, which the #110 test already kills. Source of truth:
  `SPEC.md`, issue #150.
- **Expected deliverable:** exactly one killing test in `test/repl.test.ts` driving `Repl.resume()`
  with a pre-aborted signal, plus evidence it kills the single-field mutant.

## Evidence chain — machine re-verified by this review

- Diff is exactly 6 files at final HEAD (`ca792fa` onward): `SPEC.md`, `docs/verify-150.md`,
  `docs/review-150.md`, `tasks/plan.md`, `tasks/todo.md`, `test/repl.test.ts` (5 files at this
  review's subject `aa14e30`; this doc + `ca792fa` landed later). No `src/`, no committed
  `reports/` (`reports/` gitignored, `.gitignore:12`). ✅
- Test placement: new test at `test/repl.test.ts:530` in the `#48` describe, immediately after the
  #110 test at `:517`; drives `runner.resume("abort-rt", approve, controller.signal)` where
  `runner = new ReplRunner(cwd)` → `Repl.resume()`, **not** `Session.resume()`. ✅
- Abort trace (read from source, not docs): `Repl.resume` → `live.session.resume({ onApproval,
  signal })` (`src/repl.ts:235`) → `wrappedRunOpts = { ...runOpts, onApproval: … }` carries `signal`
  into `resumeSuspended` (`src/sandbox.ts:1113`) → `if (runOpts.signal.aborted) acc.aborted = true`
  (`src/sandbox.ts:1133`) → early return `runError("aborted", …)` **before** the approval replay
  (`src/sandbox.ts:1144`) → `formatOutcome` renders `[error: aborted]\nexecution aborted`
  (`src/repl.ts:652`). The abort genuinely pre-empts the side effect. ✅
- RED re-proven by this reviewer: hand-applied `session.resume({ onApproval })` at `src/repl.ts:235`
  → focused test fails 1/1 at `test/repl.test.ts:539` (the `[error: aborted]` match), output
  `'[result]\nSuccessfully wrote 2 bytes to abort-rt.txt'` — the write demonstrably landed, so the
  `existsSync` assertion would independently kill too. Restored: line 235 back to
  `{ onApproval, signal }`, `git diff -- src/` empty, focused test 1/1 green. ✅
- Suite counts: full `npm test` → **947/947** (this review). Baseline re-measured in a throwaway
  worktree at `162c02b` → **946/946**; the suite grew by exactly one test, matching
  `docs/verify-150.md`'s corrected baseline. ✅
- Static gates re-run: `npm run check`, `npm run build`, `npm run lint` all exit 0. ✅
- Mutation report machine-read: mtime `2026-08-17 15:02:56 +0300` (postdates the recorded sweep
  start 15:02:09), `files` keys exactly `["src/repl.ts"]`, totals 287 = 193 Killed / 60 Survived /
  34 Timeout / 0 other, `ObjectLiteral "{}"` at `src/repl.ts:235` **Killed** (testsCompleted 1,
  static false). `node scripts/mutation-guard.mjs --report` → "no harness deaths recorded", exit 0. ✅
- The doc's incremental-differ caveat is **true**, independently confirmed: all 193 `statusReason`
  strings reference the previous run's sandbox (`hybUqk` × 4481 occurrences), this run's sandbox
  `WMtY7e` appears 0 times — the 15:02 sweep re-ran zero mutants and the `:235` Killed is carried
  over from the #110 sweep. The verify doc states this honestly and closes the gap with the
  hand-applied RED. ✅

## Findings

### Correctness — no blocking findings

- **Verified** the test cannot pass vacuously: every wrong surface fails the
  `/\[error: aborted\]/` match (no-session, nothing-pending, trust-changed, and thrown paths all
  produce non-matching output, and a throw would fail the test, not pass it). The
  `existsSync(...) === false` assertion is the side-effect invariant and would catch an
  "abort reported but write still ran" regression (e.g. the abort check moved after the replay).
  Both assertions independently kill the single-field mutant — re-proven, not argued. ✅
- **Verified** `docs/verify-150.md` numbers are exact against the machine-readable sources: suite
  counts, mutation totals, `:235` status, mtime/freshness, guard exit, and the corrected 946 → 947
  baseline (re-measured here). No drift, no rounding. ✅
- **Minor** `docs/verify-150.md` + `SPEC.md`: the deviation is recorded, but the stale wording
  lives on in SPEC.md — DoD step 2 and success criterion 2 still predict the RED failure lands on
  the `existsSync` assertion, while the observed first failure is the `[error: aborted]` match
  (test/repl.test.ts:539). The verify doc's own Evidence 2 explains both assertions kill; suggest
  amending the SPEC wording to "fails 1/1 (first on the `[error: aborted]` match; the output shows
  the write landed)" so the recorded prediction matches the recorded observation.

### Readability — two minor

- **Minor** `tasks/plan.md` T1 choreography step 6, Checkpoint, DoD item 4, and Phase handoff
  notes still quote `940/940` — the amended SPEC.md (Assumption 5, DoD step 3, success criterion 4)
  says 946 → 947 / 947/947, and the measured reality is 947/947. The verify doc discloses the
  leftover ("the amendment task scoped the correction to SPEC.md"), but a committed plan that
  contradicts its own SPEC on a checkable number is a small consistency debt. Recommend a one-line
  follow-up amending `tasks/plan.md` (or SHIP noting it in `docs/ship-150.md`).
- **Nit** SPEC D2 line cites drift ±2–3 lines: "never throws" docblock cited at `src/repl.ts:198`
  (actual `:200`); `formatOutcome` cited at `src/repl.ts:655` (actual `:652`). Cosmetic.

### Architecture

- The test reuses the house fixtures (`runner`, `cwd`, `makeTempDir`, `suspend`, `approve`) with
  no new imports (`existsSync` at `test/repl.test.ts:9`, `join` at `:13` were already imported;
  `AbortController` is a platform global). Mirrors the #110 sibling idiom exactly (same
  `write` + `suspend` + pre-assert + post-assert shape), same describe block. No new helpers, no
  scope widening.
- Test-only flight decision is correct: the wiring is already right, so GREEN-first with the
  hand-applied mutant as the honest RED is the only non-vacuous choreography available (D0/D3).

### Security

- Test-only; no secrets, no new dependencies, no external data. Nothing to report.

### Performance

- One additional test: focused run ~2s, full suite 32.7s. Negligible. The only timing note belongs
  to the process: the single-file sweep's incremental reuse (see Evidence) means future
  single-file sweeps must use `--force` to actually re-execute — the verify doc already records
  this caveat.

## Verification story

- RED/GREEN re-proven by this review (mutant hand-applied and restored, diff verified empty).
- `npm test` → 947/947; baseline 946 at `162c02b` re-measured in a throwaway worktree.
- `npm run check`, `npm run build`, `npm run lint` → exit 0.
- `reports/mutation/mutation.json` machine-read; `mutation-guard` exit 0.
- FYI: the closure commands in `docs/verify-150.md` reference
  `docs/verify-150.md-issue-comment.txt`, which does not exist yet — SHIP must generate it before
  running `gh issue comment/close`.

## Verdict

**Approve.** The killing test is genuine: the abort reaches `resumeSuspended` before the replay,
both assertions independently kill the single-field mutant (re-proven 1/1 by this review), the
suite grows 946 → 947, all gates are green, and the evidence doc is machine-exact including its
honest disclosure of the incremental-sweep reuse. Two minor doc-consistency items (SPEC prediction
wording, plan.md stale `940/940`) and two line-cite nits — none touch the test or the evidence.
