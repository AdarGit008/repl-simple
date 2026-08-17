# Ship Report: #59 — Serialize session creation and bound the session pool

**Branch:** `main` (per maintainer decision — direct commits, no PR). **Commits:** `3401add`..`07b7eda`
(10 commits, each referencing #59). **Date:** 2026-08-17.

## What was built

- **Single-flight session creation** (`inflight` promise map): concurrent `run`s on one
  `sessionId` join one creation; a failed creation removes itself — no poisoned ids. Joiners
  re-enter the revalidation loop after landing, so a session built under a trust decision revoked
  mid-flight is never handed to a first run.
- **Bounded pool**: LRU cap (default 32; `ReplRunnerOptions.maxSessions` > `REPL_MAX_SESSIONS` >
  32), eviction of the oldest session that is neither suspended nor mid-call, and a
  refuse-to-evict rule recorded in code, SPEC (D6) and README.
- **`reset()` evicts**: no hollow entries; `repl_resume` after `repl_reset` answers the
  no-session sentence (deliberate contract change, README'd).
- **`[trust changed]` notice** delivered post-landing by the discarder (`attachTrustChangeNotice`),
  one-shot, ordering-correct — the naive `rebuilt` argument was racy by one microtask.
- **Diagnostics**: `liveSessionCount()` — the issue's DoD demands asserting the map size.
- **D3 parity** everywhere a trust check awaits: `run`, `resume`, and the discard-side delete.

## Tests added

- The issue's six DoD tests, red-before-green where the bug existed (tests 1, 2, 4, 5 red at base;
  test 3 guards the new rejection-handling, which the old code did not have — noted in the spec
  rather than hunting a red observation that cannot exist).
- 9 more tests pinning the fan-out findings and edge cases: busy/dialog-open eviction protection,
  trust-flip joiner revalidation, resume/abandon touch semantics, mixed suspended-idle eviction
  scan, env cap precedence, concurrent failing joiners, reset-vs-in-flight-creation, in-flight
  exclusion from the diagnostic, resume D3 parity.
- Two existing tests updated to the new reset contract (never deleted).
- Flake history: the resume-D3 seam test's first two versions raced (timer vs fs I/O) and
  deadlocked (un-armed gate caught the setup run) — both observed, fixed, 6/6 clean runs.
- Suite: **894 tests, 0 failures, 0 cancelled** on the final tree.

## Verification

| Gate | Result |
|------|--------|
| `npm test` | 894 pass, 0 fail |
| `npm run check` / `npm run build` / `npm run lint` | all exit 0 |
| `npm run coverage` | all floors met; `src/repl.ts` 100.00% |
| Mutation (targeted `src/repl.ts`, 287 mutants, minimal honest test set) | **79.09** — break threshold 58 |

## Residual risks (recorded, not hidden)

1. **Full-tree mutation campaign deferred.** With `coverageAnalysis: off`, any test change
   invalidates every mutant and the repo's canonical campaign is ~34 h (4,116 mutants × full-suite
   runs). The targeted campaign covers the changed file; the deferred command is `npm run mutation`.
2. **Mutation survivors in `src/repl.ts`** are env-parse fallbacks (deliberate default-32 policy,
   operator-controlled input), model-message string mutants, and the identity-guarded delete whose
   mutant changes no observable behavior (every access re-checks trust). None in the single-flight,
   LRU, or eviction-skip logic.
3. **Silent eviction for idle sessions** (no model-facing notice when an evicted id comes back
   fresh) — not requested by #59; observe in practice before adding a tombstone.
4. **Concurrent same-id runs through the direct API** replay from the same starting snapshot —
   unreachable via the shipped extension (`executionMode: "sequential"`); inherent to replay-based
   sessions, belongs to #61 if it ever matters.
5. The campaign ran under CPU contention from an unrelated campaign in another worktree; timings
   (49 min) reflect that, not the tree.

## Review

Five-axis self-review (`docs/review-59.md`) + independent fan-out (code-reviewer,
security-auditor, test-engineer). 2 Required + 2 Optional findings, all fixed red-first and
committed (`59.5`, `59.6`). Security verdict: no gate bypass, no cross-session leakage, session ids
remain Map keys only, the test seam is instance-local, `liveSessionCount` exposes only an integer
to hosts.

## Go / No-Go

**GO.** All gates green; mutation above the break threshold; the two Required review findings
closed with tests; every deliberate behavior change (reset contract, eviction policy, cap knobs)
is documented in README + SPEC. Residual risks above are recorded and none block.

## Rollback plan

- **Trigger:** any post-push regression in CI (lint/coverage/check+test), or a user-visible pool
  regression in practice.
- **Step 1:** `git revert 3401add..07b7eda` — the commits are atomic per task, so a partial
  revert is possible if only one increment misbehaves (`59.2`'s LRU vs `59.1`'s single-flight).
- **Step 2:** verify with `npm test && npm run coverage` before pushing the revert.
- **Step 3:** no data migration or persistence exists — sessions are in-memory; a revert cannot
  strand user data.
- **Time to roll back:** one revert + push, < 5 minutes.

## Ship actions

- [x] Targeted mutation green; temp dirs removed
- [x] `tasks/todo.md` checkpoint complete
- [x] `git push origin main`
