# Tasks — issue #156: delimit the ok-branch `Output:` section against stdout forgery

Branch `issue-156-output-delimit` from #70 (child of Bucket 9, residual of #145/D19). DEFINE (SPEC
D36–D40) done. RED → BUILD → VERIFY → REVIEW → SHIP. Single writer, strict sequence. Commit cadence:
commit 1 = RED test only (T1); commit 2 = code + test 2/3 shape updates + docs (T2).

- [ ] **T1 — RED: forgery test** (forged `\nstdout:` in ok-branch `output`; assert exactly one column-0 `stdout:`, `> stdout: FORGED`, real delimiter via `indexOf("\nstdout:")`) — fails at HEAD (two column-0 `stdout:`). Commit 1: RED test only.
- [ ] **T2 — D36/D37: quote `output` + D38 test 2/3 shape updates + D39 docs** (3-line insert at `src/rlm.ts:662-663`; `unquoted()` ceiling; `indexOf("\nstdout:")` locator; two doc clauses) — code + test move together, commit 2.
- [ ] **T3 — VERIFY: coverage gate (rlm.ts ≥ 97.69, both quote branches) + bounded mutation sweep (kill `> `, `.map`, `output ?`)**
- [ ] **T4 — REVIEW (`tasks/review.md`, five-axis) + SHIP (`tasks/ship-report.md`, go/no-go + rollback)**

## Checkpoint (after T2)
- [ ] New test green; test 18 (error-branch forgery) untouched green; `npm test` ×2 deterministic; `check`/`build`/`lint`/`coverage` all exit 0.

## DoD (from #156)
- [ ] Forgery test added RED first, green after.
- [ ] Code + test 3 update (and test 2) land in the same commit.
- [ ] Ok-branch `output` quoted — forged `\nstdout:` renders `> stdout:` and never at column 0.
- [ ] Coverage floor (rlm.ts ≥ 97.69) and mutation score stay green.
