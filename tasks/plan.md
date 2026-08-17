# Implementation Plan: Issue #110 — Prove `Repl.resume()` forwards `onApproval` (verification + closure)

## Overview

Issue #110 describes a mutation gap: dropping `onApproval` from the `session.resume({ onApproval,
signal })` call inside `Repl.resume()` (`src/repl.ts:235`) would let the mutation suite stay green.
The DEFINE phase established that the killing test already landed on `origin/main` via commit
`8ac0a1e` ("5.1 — Make repl_resume, repl_abandon and repl_reset fail gracefully (#48)" · PR #128)
and passes on this tree (`test/repl.test.ts:517`, *"suspend → resume(approve) runs the pending
call"*). This flight is therefore **verification + closure**, not greenfield implementation: run a
targeted mutation sweep over the one affected file, capture evidence that the mutant is Killed and
that the `!session` guard is covered in both directions, write a verification report, and record the
closure mechanics for the SHIP phase. Production/test code changes happen **only** if the sweep
surfaces a survivor.

Source of truth: `SPEC.md` (read it; do not re-derive). All line numbers below are current-tree,
not the stale ones in the issue body.

## Architecture Decisions

- **Single-file mutation sweep, not the full tree.** `--mutate src/repl.ts` limits Stryker to the
  one file containing the target. A full `npm run mutation` costs ~33 CPU-hours and re-baselines the
  whole tree (post-#40 the tree-wide floor is stale); it is out of scope for #110. `src/repl.ts` had
  59 valid mutants at the last measured baseline (`docs/mutation-testing.md`), so the targeted run
  is on the order of tens of minutes at `concurrency: 2`, not hours.
- **Evidence is captured in a committed doc, not in `reports/`.** `reports/` (the Stryker JSON/HTML
  output) is gitignored, so `docs/verify-110.md` carries the extracted excerpts. The raw artifacts
  remain on disk for the VERIFY/REVIEW phases to re-open but are not committed.
- **The authoritative command runs through `contained.mjs`.** The 12G memory ceiling is ample for a
  `src/repl.ts`-only sweep (the worst-mutant ~6 GB/worker case in the docs is the RLM recursion
  mutants in `rlm_loop.ts`, which this sweep never mutates). Containment auto-skips where no systemd
  user session exists.
- **The mutation verdict is read from `reports/mutation/mutation.json`, not the terminal.**
  Stryker's per-mutant status lives in the JSON `files` map (each file → `mutants[]` with `status`,
  `mutatorName`, `location.start.line`, `replacement`). The `clear-text`/`progress` stdout is a
  convenience; the JSON is the record.
- **A harness death invalidates the verdict.** `scripts/mutation-guard.mjs` is the configured test
  command and refuses to score a run that never printed a `fail N` summary. After the sweep, run
  `node scripts/mutation-guard.mjs --report` — any fatal deaths there mean the score is untrustworthy
  and the run must be repeated, not interpreted.
- **Closure is a SHIP-phase orchestrator decision, recorded here not executed here.** Per SPEC
  boundaries, GitHub state (closing #110) is the orchestrator's to act on. BUILD writes the evidence
  report and the exact `gh` commands; SHIP executes them on a go decision.

## Task List

### Phase 1: Evidence

- [ ] **Task 1 — Targeted mutation sweep of `src/repl.ts`, and read the verdict**
  - Description: run the single-file sweep, then extract and record the status of (a) the
    `ObjectLiteral` mutant at `src/repl.ts:235` and (b) every mutant on the `if (!live)` guard at
    `src/repl.ts:210` (condition-removal and negation/true/false mutants — the issue's stale
    `:57-60` "four survivors" refer to these same code points after the #48/#59 rewrite).
  - Acceptance:
    - The sweep completes and `node scripts/mutation-guard.mjs --report` reports **zero fatal** harness deaths.
    - `reports/mutation/mutation.json` shows the `ObjectLiteral` mutant at `src/repl.ts:235` with
      status `Killed` (or `Timeout`, which counts as detected).
    - Every mutant whose `location.start.line` is `210` has status `Killed` or `Timeout` — no
      `Survived`/`NoCoverage` on the guard in either direction.
    - A written evidence excerpt (statuses + `mutatorName` + line numbers) is captured for Task 3.
  - Verify:
    - `node scripts/contained.mjs --limit 12G npx stryker run --mutate src/repl.ts` (exit 0)
    - `node scripts/mutation-guard.mjs --report` (exit 0, "no harness deaths recorded" or all-recovered)
    - `python3 -c "import json; ..."` against `reports/mutation/mutation.json` printing the
      `src/repl.ts` mutants filtered to lines 210 and 235 (exact snippet in Task 1 note).
  - Files: none committed (writes `reports/mutation/*`, `.stryker-incremental.json`, both gitignored)
  - Dependencies: none
  - Estimated scope: S (run-only; no code)

### Checkpoint: Evidence captured
- [ ] Sweep finished with a trustworthy verdict (no fatal harness deaths)
- [ ] The `ObjectLiteral` at `:235` and the guard at `:210` are both confirmed detected
- [ ] Decision point reached: survivors present → proceed to Task 2; else skip Task 2 and go to Task 3

### Phase 2: Gap-closing (conditional)

- [ ] **Task 2 — Only if Task 1 surfaces a survivor: add the minimal regression test**
  - Description: if (and only if) the `ObjectLiteral` at `:235` or any guard mutant at `:210` is
    `Survived`/`NoCoverage`, add the smallest test to `test/repl.test.ts` that drives `Repl.resume()`
    (not `Session.resume()`) and makes that mutant fail. RED first (confirm the new test fails
    against the surviving mutant, e.g. by re-running the targeted sweep or temporarily applying the
    mutation), then GREEN, then re-run the sweep to confirm the mutant is now detected.
  - Acceptance:
    - New test goes through `Repl.resume()` — the wiring layer, not `Session.resume()`.
    - The previously-surviving mutant is now `Killed`/`Timeout` in a fresh targeted sweep.
    - No redundant "test that cannot fail" is added (repo purged those in #23); no edit to
      `src/session.ts`; no production `src/*.ts` change unless a test genuinely cannot kill the
      mutant otherwise.
  - Verify:
    - `npx tsx --test test/repl.test.ts` (green)
    - re-run the Task 1 sweep and confirm the mutant flipped to detected; delete
      `.stryker-incremental.json` first (or pass `--force`) so the re-run does not skip the changed
      test's mutants
    - `npm run check` and `npm run lint` if any test file changed
  - Files: `test/repl.test.ts` only (if triggered)
  - Dependencies: Task 1 (only entered when Task 1 found a survivor)
  - Estimated scope: S (1 file, conditional)

### Phase 3: Record and close

- [ ] **Task 3 — Verification report `docs/verify-110.md`**
  - Description: write the evidence record following the repo's `docs/review-59.md` / `docs/ship-59.md`
    naming convention. It states the issue, the already-landed killing test (`8ac0a1e`, PR #128),
    the targeted sweep command, the extracted mutation statuses (ObjectLiteral:235 and guard:210 both
    directions), the harness-death check result, and the recommendation to close #110.
  - Acceptance:
    - Contains: issue link; commit `8ac0a1e` evidence; test name + `test/repl.test.ts:517` reference;
      the exact sweep command; the status excerpt for lines 210 and 235; `--report` result; closure
      recommendation.
    - No production/test diff recorded beyond what Task 2 (if any) produced — the report itself is
      the deliverable when Task 2 is skipped.
  - Verify: read-through against `reports/mutation/mutation.json` (excerpts must match the raw file);
    `npm run lint` unaffected (markdown not linted, but confirm nothing else changed).
  - Files: `docs/verify-110.md`
  - Dependencies: Task 1 (and Task 2 if triggered)
  - Estimated scope: XS (1 file)

- [ ] **Task 4 — Closure mechanics (recorded for SHIP; not executed in BUILD)**
  - Description: record the exact `gh` commands the SHIP phase runs on a go decision, so the
    closure is one mechanical step. Per SPEC boundaries this is flagged as an orchestrator decision.
  - Acceptance: the commands below are present in `docs/verify-110.md` (or this plan) verbatim.
  - Commands:
    - `gh issue comment 110 --body "$(cat docs/verify-110.md-issue-comment.txt)"` (evidence comment)
    - `gh issue close 110 --reason completed --comment "Closed by targeted mutation verification — see docs/verify-110.md (#110)."`
  - Files: none new (recorded in `docs/verify-110.md`)
  - Dependencies: Task 3
  - Estimated scope: XS

### Checkpoint: Complete
- [ ] `docs/verify-110.md` exists with full evidence
- [ ] Focused test green; check/build/lint green (only if a test/source file changed)
- [ ] Closure commands recorded and flagged for SHIP

## Commit plan (branch `issue-110-resume-onapproval`)

Match repo style (`git log --oneline` shows `docs:`, `test:`, `chore:` prefixes and a `(#NNN)`
suffix; some entries are `9.3 — …` titled):

1. Before Task 1 (BUILD entry): commit the flight artifacts — `SPEC.md`, `tasks/plan.md`,
   `tasks/todo.md` — as `docs: spec + plan for issue #110 verification (#110)`.
2. Task 1: no commit (its artifacts are gitignored).
3. Task 2 (if triggered): `test: kill the resume onApproval survivor (#110)`.
4. Task 3: `docs: verify #110 — resume forwards onApproval, kill the mutant (#110)` committing
   `docs/verify-110.md`.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Targeted sweep returns a harness death (no `fail N` summary), not a verdict | High — a "Killed" scored from a dead harness is exactly the #109/#110 class of false positive | `mutation-guard --report` after the run; any fatal death → re-run, never interpret. `contained.mjs` 12G ceiling + journal check makes a breach loud. |
| Sweep takes longer than a normal BUILD task (~30–60 min for ~59 mutants at concurrency 2) | Med — wall-clock | Timeboxed expectation recorded; run through `contained.mjs` and let it complete; do not shorten by skipping the guard report. |
| `ObjectLiteral` at `:235` turns out to already be `Survived` on this exact tree (spec assumption wrong) | High — the whole "already resolved" premise fails | Task 2 becomes mandatory: add the regression test, re-sweep, and only then write the report. The plan's conditional path is the safety valve. |
| Reading the wrong JSON node (Stryker `files` map shape vs. a flat list) | Low — wrong evidence | Task 1 includes the exact `python3` extraction snippet against `reports/mutation/mutation.json` so evidence is machine-read, not eyeballed. |
| `--mutate src/repl.ts` is rejected by Stryker CLI (glob vs. exact path) | Low — command fails fast | Fallback `--mutate 'src/repl.ts'` (quoted) or the config-equivalent; the sweep still lands on one file. |
| `reports/` is gitignored, so evidence is lost if only the JSON is kept | Med — unverifiable claim | `docs/verify-110.md` captures the excerpt verbatim; raw JSON remains on disk for VERIFY/REVIEW to re-open. |

## Open Questions

- **Close now, or await a full-tree re-baseline?** (carried from SPEC) The one-file sweep confirms
  #110 specifically; it does not re-baseline the stale post-#40 tree-wide floor. Closure of #110 is
  safe on the one-file evidence, but the tree-wide floor stays unverified until someone runs
  `npm run mutation`. Flagged for the orchestrator, not decided here.
- **`signal` wiring test?** `Repl.resume()`'s `signal` field is a separate untested path, out of
  scope for #110 (SPEC Assumption 4). Flag as a possible follow-up issue, not a task.
