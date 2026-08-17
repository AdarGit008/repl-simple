# Ship report — flight F-144 (issue #144: 9.10 — Cap result.error and the question in the RLM feedback loop)

Branch: `issue-144-cap-error-question` (7 commits ahead of flight base `34da5c5`; unmerged, not pushed at write time)
Commits: `01e5c6a` SPEC · `9fb8916` plan · `018e51a` T1 · `e905ce8` T2 · `527244e` T3 · `35b16cd` review · `this` ship

## What was built

| Task | Change | Tests |
|------|--------|-------|
| T1 | `buildFeedback` caps `result.error` ≤ 16 KiB (50/50 head+tail) via shared `truncateText`, recovery "Catch the exception and print the full traceback to see more." (D7) | 8 |
| T2 | `buildInitialPrompt` caps `question` ≤ 64 KiB (50/50) via `truncateText`, recovery "The question was truncated. Answer from the part shown and state the assumption if ambiguous." (D8) | 9 |
| T3 | `docs/truncation-policy.md` budget table extended with both caps; stale "error uncapped" non-goal scoped down to `errorKind` | — |

All tasks RED→GREEN: test 8 RED at 100 KiB vs 16 KiB ceiling; test 9 RED at 131072 vs 65536 bytes. Full suite 950/950 (deterministic, run twice); `tsc --noEmit`, build, biome all clean; coverage floors hold (`src/rlm.ts` 97.40% vs 95.94% floor; baseline untouched). Both new tests have under-budget no-op halves proving byte-identical pass-through.

## Gate results

- **VERIFY** (fresh context): full matrix green ×2 runs — no fixes needed, no blockers. Diff scope `34da5c5..HEAD` = exactly the 6 expected files; no `Buffer`/`byteLength` in `src/rlm.ts` (test 6 invariant). Bounded ~19-min partial mutation sweep of `src/rlm.ts`: 48/451 mutants tested, ≈89.6% detected, no regression signal; full sweep infeasible on this 8-core host (repo's own `docs/mutation-testing.md` warning) — recorded as a limitation.
- **REVIEW** (fresh context, five-axis): verdict **approve** — 0 blockers, 0 majors, 6 minor, 5 nit (`tasks/review.md`, commit `35b16cd`).
- **SHIP fan-out** (parallel, independent, read-only):
  - code-reviewer: **SHIP** — D7/D8/D9 implemented verbatim against SPEC; budget math sound (worst-case `messages[0]` ≈ 97 KiB < 256 KiB).
  - security-auditor: **SHIP** — 0 critical/high/medium; 3 low + 2 info (all pre-existing or defense-in-depth).
  - test-engineer: **SHIP** — tests 8/9 are genuine prove-it tests (verified failing against base `34da5c5`), deterministic (98/98 in ~3.0s), coverage-floor risk nil.

## Risk assessment (doubt-driven check)

Stop-condition review: no auth, secrets, destructive migrations, payments, or deploys in this change — high-risk/irreversible trigger **not met**; no doubt-driven drill required. Closest risks (all recorded below as follow-ups): forged truncation markers (LOW — model misdirection only, sandbox remains enforcement boundary); budget DoS via pathological assistant replies (LOW — pre-existing Assumption 4, now the only uncapped prompt path).

## Decision: **GO**

Merge-ready. Rollback plan: nothing is deployed; the branch is the artifact. If a regression surfaces after merge: (1) revert the merge commit on main — each task is a separate commit so T1/T2/T3 can be reverted independently; (2) as last resort, roll back `src/rlm.ts` and `test/rlm.test.ts` to `34da5c5` (`git checkout 34da5c5 -- src/rlm.ts test/rlm.test.ts`), which restores pre-flight behavior exactly; (3) no data migrations or external state are involved, so rollback has no side effects.

## Residual risks & post-ship follow-ups (from fan-out, not blocking)

1. **Authenticate truncation markers** (security LOW): attacker text is indistinguishable from real `[… X of Y elided …]` markers. Sentinel-delimited markers + a system-prompt note would make them self-authenticating. → #145 (or new issue).
2. **Cap or fail on pathological assistant replies** (`src/rlm.ts:599`, security LOW): the last uncapped prompt path; a prompt-injection-induced multi-MiB reply is carried in every subsequent query. → #145.
3. **Delimit error/stdout sections in feedback** (`src/rlm.ts:352`, security LOW): an exception message containing `\nstdout:` can forge a fake stdout line. Indent/quote or `###` headers. → #145.
4. **Sanitize input names** (`src/rlm.ts:281`, security INFO): input keys interpolated unescaped into the prompt header — a backtick/newline key injects prompt structure. One-line fix. → #145 (this is also the #72-deferral note from F-74 monitor Item 3).
5. **Test-strength gaps** (test-engineer): boundary tests at exactly/just-over budget; "uses the full budget" assertions (a silent 8 KiB cap would still pass today); head/tail shape assertion; composition test (huge question + inputs). → #145.
6. **Naming** (review minor): `ERROR_MAX_BYTES` breaks the `FEEDBACK_` prefix convention (`src/rlm.ts:28`). → #145.
7. Cosmetic: `const { text: q }` single-letter binding (`src/rlm.ts:300`); docs/truncation-policy.md "four rows / one implementation" sentence now stale after adding rows five and six (`docs/truncation-policy.md:390`). → #145.

## Merge notes (important)

`origin/main` advanced 5 commits (#110, #150) after this flight branched from `34da5c5`. Overlap is **editorial-only**: SPEC.md, tasks/plan.md, tasks/todo.md. **Zero overlap** in `src/rlm.ts`, `test/rlm.test.ts`, `docs/truncation-policy.md` (the code merges clean). On merge, resolve the three planning-doc conflicts by taking this flight's versions (they are the F-144 spec-of-record; the other flights' versions live in their own commits). Supervisor decision (recorded): no rebase — verify against flight base.

## Open-issues recommendations

See `tasks/monitor-report.md` (flight monitor). The monitor's final report carries the exact wording to update #144 (DoD checkboxes), #145 (absorb follow-ups 1–7 above), #77/#70 cross-references, and any newly discovered gotchas.
