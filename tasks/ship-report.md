# Ship report — flight F-74 (issue #74: 9.4 — RLM message growth)

Branch: `issue-74-message-growth` (7 commits ahead of origin/main, not merged, not pushed)
Commits: `904275f` SPEC · `f711649` plan · `d302baf` T1 · `3fa6aee` T2 · `df5feb4` T3 · `bb03e5b` T4 · `08e15aa` review

## What was built

| Task | Change | Tests |
|------|--------|-------|
| T1 | `buildFeedback` caps `stdout` ≤ 32 KiB (25/75 head+tail) and `output` ≤ 16 KiB (50/50) via shared `truncateText` (D1) | 2, 3, 6 |
| T2 | `runRlm` conversation bound: `MAX_CONVERSATION_BYTES` = 256 KiB, drops oldest whole assistant+feedback pairs (keeps initial + newest), cumulative user-role history-drop marker counts toward budget (D2–D3) | 1, 4, 5 |
| T3 | `buildInitialPrompt` input preview capped at 32 KiB aggregate via `truncateText`, with named-variable recovery clause (D6 — #72 deferral) | 7 |
| T4 | `docs/truncation-policy.md` implementation-record extended; Exception 3 (TextEncoder vs Buffer.byteLength) and Exception 4 (transient over-budget LLM reply) recorded | — |

All tests RED→GREEN per task; full suite 946/946 (deterministic, run twice); `tsc --noEmit`, build, biome all clean; coverage floors hold (`src/rlm.ts` 97.24% vs 95.94% floor; baseline untouched). 7 new tests total.

## Gate results

- **VERIFY** (fresh context): full matrix green ×2 runs, no fixes needed, no blockers.
- **REVIEW** (fresh context, five-axis): verdict **approve** — 0 blockers, 0 majors, 5 minor, 5 nit (`tasks/review.md`).
- **SHIP fan-out** (parallel, independent):
  - code-reviewer: **SHIP** — no blockers/majors; D1–D6 faithfully implemented.
  - security-auditor: **SHIP** — 0 critical/high; 2 medium (pre-existing budget bypasses, see residuals).
  - test-engineer: **SHIP (conditional)** — 6/7 new tests are genuine prove-it tests (verified against origin/main), deterministic; 3 high-value tests to add post-ship.

## Risk assessment (doubt-driven check)

Stop-condition review: no auth, secrets, destructive migrations, payments, or deploys in this change — high-risk/irreversible trigger **not met**; no doubt-driven drill required. Closest risk: D6 flat truncation can split a ``` fence so attacker data renders outside its code block (LLM06-adjacent, LOW — sandbox remains the enforcement boundary). Recorded below as a follow-up.

## Decision: **GO**

Merge-ready. Rollback plan: nothing is deployed; the branch is the artifact. If a regression surfaces after merge: (1) revert the merge commit on main — each task is a separate commit so any of T1–T3 can be reverted independently; (2) as last resort, roll back `src/rlm.ts` to `origin/main` (`git checkout origin/main -- src/rlm.ts src/rlm_loop.ts test/rlm.test.ts`), which restores the pre-flight behavior exactly; (3) no data migrations or external state are involved, so rollback has no side effects.

## Residual risks & post-ship follow-ups (from fan-out, not blocking)

1. **`result.error` uncapped** (`src/rlm.ts:313`) — a huge Python exception message (e.g. `raise ValueError("A"*10**7)`) bypasses the 256 KiB bound for one iteration; pre-existing, spec-documented non-goal (Assumption 7), but it undermines the D1 guarantee. Fix: route through `truncateText` (one line) + test. **Recommended next issue.**
2. **`question` uncapped** (`src/rlm.ts:276`) — message[0] is never dropped, so a large question is in every query permanently. Fix: truncate in `buildInitialPrompt`. **Recommended next issue.**
3. **Missing high-value tests** (test-engineer): just-under-budget no-drop/no-marker case; single >256 KiB LLM reply completes without hang (guards the `length >= 5` loop-guard); error-path stdout cap. Add with follow-up.
4. **Fence-split on flat D6 cut** (`src/rlm.ts:264-273`) — per-value truncation before wrapping would close it.
5. Cosmetic nits: marker hardcodes "256KB" (`src/rlm.ts:396`); test 5 could pin the dropped-turn count; ceiling-only assertions don't pin head/tail ratios.

## Open-issues recommendations

See `tasks/monitor-report.md` (flight monitor). Consensus: #74's issue text is partially stale at HEAD (output/stdout already capped by #34; #72 diagnostic fixed); the monitor report carries the exact wording to update #74 and siblings so a future flight doesn't re-derive these facts.
