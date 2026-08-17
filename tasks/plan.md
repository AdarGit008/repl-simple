# Implementation Plan: Prove `Repl.resume()` honours an aborted signal (#150)

## Overview

This is a **proof-of-wiring flight, not a fix flight**. `Repl.resume()` already threads `signal`
into `session.resume({ onApproval, signal })` (`src/repl.ts:235`) and `resumeSuspended`
(`src/sandbox.ts:1113`) already early-returns `runError("aborted", …)` before replaying the suspended
call — but no test proves the `signal` field is load-bearing on the resume path. The deliverable is a
single killing test driving `Repl.resume()` with an already-aborted signal, plus the evidence that
proves it kills the single-field mutant `{ onApproval, signal }` → `{ onApproval }`.

The source of truth for *what* to build is `SPEC.md` decisions D0–D4 and Assumptions 1–6; this plan
only sequences them into two single-commit BUILD tasks and states per-task acceptance, tests, and
handoff. VERIFY, REVIEW, and SHIP are separate phases (not tasks here) — the last section names what
VERIFY must independently re-check.

Out of scope and never touched (as permanent changes): `src/repl.ts`, `src/session.ts`,
`src/sandbox.ts`, `extensions/*`, `src/rlm.ts`, `src/rlm_loop.ts`, `coverage-baseline.json`. The only
exception is the **transient hand-applied mutant** at `src/repl.ts:235` for the RED step (D0/D3),
always restored before commit.

## Architecture Decisions

- **Test-only change (D3).** The wiring is already correct. The new test is expected to be GREEN on
  first run against the unmodified tree — that is recorded as the correct outcome, never "fixed
  around". RED is exercised honestly by hand-applying the single-field mutant Stryker cannot generate.
- **The mutant to kill is the single-field drop, proven by hand-application (D0).** Stryker 9.6.1's
  `ObjectLiteral` mutator yields only `{}` (verified in SPEC Objective), so
  `{ onApproval, signal }` → `{ onApproval }` survives the suite. The hand-apply prove-it technique
  from the #110 flight is the primary kill; the targeted sweep is a confirmatory regression check.
- **The public abort surface is the `[error: aborted]` result string, not a throw (D2).**
  `Repl.resume()` never throws; abort surfaces as `[error: aborted]\nexecution aborted`. Assert the
  string, not an `AbortError`.
- **Single-file targeted sweep only (Assumption 4).** `--mutate src/repl.ts` — not the full tree — and
  no re-baseline of the tree-wide floor.
- **Mutation-report freshness is a gate (D4).** `reports/mutation/mutation.json` is overwritten only
  when the run finishes; assert mtime postdates sweep start **and** `list(json['files'].keys())` is
  exactly `["src/repl.ts"]` before reading any evidence.

## Task List

### Phase 1: The killing test

- [ ] **T1 — Add the abort-propagation killing test + prove RED via the hand-applied mutant (D1, D3)**

  **Objective:** Add one test inside the existing
  `describe("ReplRunner — every tool answers, in every state (#48)")` block in `test/repl.test.ts`,
  immediately after the #110 test at `:517`, driving `Repl.resume()` (not `Session.resume()`) with an
  `AbortController` aborted **before** resume. The test (SPEC D1, verbatim shape) asserts
  `[error: aborted]` is surfaced **and** `abort-rt.txt` was never written. Then prove it kills the
  mutant by hand-applying `{ onApproval }` at `src/repl.ts:235`, observing RED, restoring, observing
  GREEN.

  **Scope (files):**
  - `test/repl.test.ts` — one new test (D1), reusing `runner`/`cwd`/`suspend`/`approve` fixtures.
  - `src/repl.ts` — **transient only**: `:235` `{ onApproval, signal }` → `{ onApproval }` for RED,
    restored via `git restore src/repl.ts` before commit.

  **Dependencies:** None.

  **Acceptance criteria (SPEC success criteria 1–2, D1, D3):**
  - The new test drives `Repl.resume()` and passes on the unmodified tree (success criterion 1).
  - The hand-applied `{ onApproval }` mutant makes it fail 1/1 on the `existsSync(...) === false`
    assertion (the file is written), and the mutant is restored (success criterion 2).

  **RED → GREEN choreography (exact, in order):**
  1. **Write the test** (D1) — no production change.
  2. **GREEN-expected:** `npx tsx --test test/repl.test.ts` — the new test passes on the unmodified
     tree (recorded, not "fixed around", D3).
  3. **RED (prove-it):** edit `src/repl.ts:235` to `session.resume({ onApproval })`; run the focused
     test; confirm the new test fails 1/1 with the `existsSync` assertion (write landed).
  4. **Restore:** `git restore src/repl.ts`; assert `git diff -- src/repl.ts` is empty (the mutant is
     **never committed**).
  5. **GREEN:** `npx tsx --test test/repl.test.ts` — the new test passes again.
  6. **Regression:** `npm test` → **947/947** (suite grows by exactly one: 946 → 947, Assumption 5).
  7. **Static gates:** `npm run check` && `npm run build` && `npm run lint` — all exit 0.
  8. **Commit** `test/repl.test.ts` **only** (no `src/` diff), message
     `150 — Prove Repl.resume() honours an aborted signal (#150)`. Confirm
     `git diff --name-only HEAD~1` is exactly `test/repl.test.ts`.

  **Verify:** the eight steps above; `git status --porcelain` clean after commit.

### Phase 2: Mutation evidence

- [ ] **T2 — Targeted single-file mutation sweep + freshness + harness-death check (D4)**

  **Objective:** Run the single-file sweep that regenerates `reports/mutation/mutation.json` for
  `src/repl.ts`, assert its freshness, confirm the `ObjectLiteral` at `src/repl.ts:235` is **Killed**
  (whole-object `{}` mutant, already killed by #110, must remain so) and that no new survivor appears
  at that line, and confirm zero harness deaths. This is a confirmatory regression check; the primary
  kill is T1's hand-applied RED.

  **Scope (files):** none committed — `reports/` and `.stryker-*` are gitignored. The fresh JSON is the
  on-disk artifact VERIFY machine-reads and records in `docs/verify-150.md`.

  **Dependencies:** T1 (the killing test must land first so the sweep runs against it).

  **Budget (SPEC open risk 1):** ~2h15m on the #110 flight. Rely on the incremental state
  (`.stryker-incremental.json`) to keep it bounded. **If the sweep is impractical in this flight's
  window, T1's hand-applied RED is the primary evidence; record the sweep as pending in the ship
  report — do not block the remaining phases.**

  **Acceptance criteria (SPEC success criterion 3, D4):**
  - `reports/mutation/mutation.json` is fresh: mtime postdates sweep start **and**
    `list(json['files'].keys())` is exactly `["src/repl.ts"]`.
  - `ObjectLiteral` at `src/repl.ts:235` is `Killed`; no new survivor at that line.
  - `node scripts/mutation-guard.mjs --report` → `mutation-guard: no harness deaths recorded`, exit 0.

  **Commands:**
  1. `node scripts/contained.mjs --limit 12G npx stryker run --mutate src/repl.ts` (record start time).
  2. Freshness check (D4) on `reports/mutation/mutation.json`.
  3. Extract per-mutant status at `src/repl.ts:235` (machine-read, not eyeballed).
  4. `node scripts/mutation-guard.mjs --report`.

  **Verify:** all four commands; record the per-mutant status and freshness check for VERIFY.

### Checkpoint: Complete

- [ ] T1 and T2 done; `npm test` → 947/947; `npm run check`, `npm run build`, `npm run lint` exit 0;
  tree clean; `src/` has no permanent diff against the branch base.

## Definition of Done (whole flight, from SPEC success criteria 1–5)

1. One new test exists in `test/repl.test.ts`, drives `Repl.resume()` (not `Session.resume()`), and
   passes on the unmodified tree — proving `signal` is wired end-to-end.
2. The hand-applied single-field mutant (`{ onApproval }`, dropping `signal`) makes that test fail 1/1
   with the exact no-write assertion, and is restored.
3. The targeted `--mutate src/repl.ts` sweep keeps the `ObjectLiteral` `{}` mutant at `src/repl.ts:235`
   Killed, with a fresh single-file report and zero harness deaths.
4. `npm test` (947/947), `npm run check`, `npm run build`, `npm run lint` all exit 0.
5. The evidence chain (RED/GREEN/mutation/harness-death) is recorded in `docs/verify-150.md` with the
   mutation-report freshness check stated (D4).

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| The single-file sweep is slow (~2h15m, SPEC open risk 1) | Med | Own late task (T2) with an explicit budget; rely on incremental state; if impractical, T1's hand-applied RED is primary and the sweep is recorded pending in the ship report. |
| 60-Survived / 34-Timeout mutants elsewhere in `src/repl.ts` (SPEC open risk 2) read as this flight's regression | High (false-evidence) | Recorded as pre-existing/out-of-scope in every downstream report; the only line under assertion is `src/repl.ts:235`. |
| The transient mutant leaks into a commit | High (would change production code) | Choreography step 4 mandates `git restore src/repl.ts` + `git diff` empty; commit step asserts `git diff --name-only HEAD~1` is exactly `test/repl.test.ts`. |
| Stale `mutation.json` misread as this run's evidence (D4 / monitor Item H) | High | Freshness check is part of T2's DoD (mtime + `files == ["src/repl.ts"]`). |
| The new test is green-on-first-run and someone "fixes around" it | Med | D3 records GREEN-first as the correct outcome; RED is proven only via the hand-applied mutant, never by editing the test. |

## Open Questions

- None blocking — the SPEC records its open questions (sweep budget, pre-existing survivors) and marks
  them fire-and-forget. Any unexpected divergence found during BUILD is recorded in the ship report,
  not silently decided.

## Phase handoff notes

- **BUILD → VERIFY:** BUILD leaves on disk: the committed killing test, the fresh
  `reports/mutation/mutation.json` (single `src/repl.ts` key), and the recorded per-mutant status.
  VERIFY must independently re-run the full suite (**947/947**), `npm run check` / `npm run build` /
  `npm run lint`, machine-read the JSON for freshness and the `ObjectLiteral`/`:235` `Killed` status,
  re-run `node scripts/mutation-guard.mjs --report`, confirm `git status --porcelain` clean and the
  diff vs base is exactly `test/repl.test.ts` (plus this flight's docs), then write
  `docs/verify-150.md`.
- **VERIFY → REVIEW / SHIP:** the evidence chain lives in `docs/verify-150.md`; REVIEW reads it (and
  the diff) for the five-axis pass; SHIP fans out to the three reviewers and merges into go/no-go +
  rollback plan, writing `docs/review-150.md` and `docs/ship-150.md`.

## Parallelization

- T1 → T2 is a strict sequence (T2 must sweep against the committed killing test). Both are BUILD
  tasks in a single writer context. VERIFY / REVIEW / SHIP are separate phases, each in a fresh
  subagent context, and must not run concurrently with each other in the same worktree.
