# Review — issue #76: RLM answer provenance

code-reviewer persona (fresh context). Source of truth: `SPEC.md` D41–D47 + Assumptions, `tasks/plan.md`.
Diff reviewed: `git diff 422174f..HEAD` (commits 73654de, a26e675, 3e8c1a1, 3e305fd).

## Verdict

**Approve** — no Critical or Required findings; no merge blocker.

## Overview

Adds `RlmResult.answerSource`, removes the `"(no answer)"` magic string, and introduces a guarded,
un-charged synthesis pass at the iteration cap. All five issue tests + two VERIFY-gap tests present,
behavioral, and green. Implementation matches SPEC D41–D47 exactly; no scope creep into #78.

## Critical Issues

None.

## Important Issues

None.

## Suggestions

- **Optional:** `src/rlm.ts:1034-1037` — synthesis `llmClient.query` is not wrapped in
  `raceAgainstSignal` (unlike the loop query at `:917-918`). Abort is still honoured via the
  post-await `options.signal?.aborted` check, so functionally safe; a consistency nicety only.
- **Nit:** `src/rlm.ts:562` — the fixed comment omits the empty-string guard
  (`r.output && r.output !== "None"`); consider "non-empty non-'None' output".
- **Nit:** test 5's set-membership loop re-checks the same five objects already pinned by exact
  `assert.equal`s; redundant but documents the full union — fine as-is.
- **FYI:** `src/rlm.ts:1032` — `budgetReport(budget, false)` snapshotted before the synthesis await;
  correct here (synthesis un-charged), mirrors the pre-existing site.

## What's Done Well

- Guarded synthesis preserves Assumption 5's abort semantics — abort during synthesis folds to
  salvage, never marks `synthesised`, never throws (pinned by test 6).
- Test 2 is the classic magic-string-collision regression: pins `answer === "(no answer)"` +
  `submitted` vs `answer === ""` + `salvaged`.
- All five return sites set `answerSource`; `RlmResult` only constructed inside `src/rlm.ts`, so no
  path can return an undefined source; `tsc --noEmit` confirms exhaustiveness.

## Verification Story

- Tests: 143 rlm tests + full 1054/1054 pass; all 7 provenance tests green.
- Build: `npm run check` clean; changed files (`src/rlm.ts`, `src/types.ts`, `test/rlm.test.ts`,
  `test/types.test.ts`) biome-clean.
- Coverage: `src/rlm.ts` 99.15% ≥ 97.69 floor.
- Note: repo-wide `npm run lint` reports 87 errors, all in untracked `.pi-subagents/` artifacts —
  not from this change.
