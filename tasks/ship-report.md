# Ship report — issue #156: delimit the ok-branch `Output:` section against stdout forgery

Branch `issue-156-output-delimit` from `main` @ `97cc786`. Single writer, autonomous flight.

## Decision: GO

No high-risk or irreversible work (a `> `-quote presentation change in the feedback prompt + two
test-shape updates + one regression-proofing test + minimal doc clauses; no auth/secrets/migrations/
payments/deploys/deps). All three ship sources green: code review (1 Important finding fixed, code
approved), coverage/mutation (PASS), security audit (0 Critical / 0 High / 0 Medium).

## What was built

| Decision | Item | Landed |
|---|---|---|
| D36 | Ok-branch `output` value is `> `-quoted with D19's exact mechanism; `###` headers rejected (one mechanism for the column-0 delimiter-forgery vector) | T2 |
| D37 | Only the non-empty `output` is quoted; `Output: ` and the real `\nstdout:` delimiter stay at column 0; empty output renders byte-identical via `output ? … : ""` | T2 |
| D38 | 1 new RED test (test 25, forged `\nstdout:` in output) + test 2 (`unquoted()` ceiling) + test 3 (`\nstdout:\n` locator) updates, code+test in one commit | T1 + T2 + review fix |
| D39 | Minimal `docs/truncation-policy.md` Exception 5 / #145 clause edits + growth-bound sentence | T2 + review fix |
| D40 | RED-first, coverage floor, bounded mutation sweep over changed sites only | T3 |

Tests: test 25 (forgery close, RED at HEAD) + test 26 (empty-output no-op pin, added at VERIFY after
the sweep exposed an unpinned survivor) + test 2 / test 3 shape updates. Suite 1046 → 1047.

## Gates

- Suite **1047/1047** ×2 deterministic · `tsc --noEmit` + build + lint clean.
- Coverage: **src/rlm.ts 99.12% ≥ 97.69%** floor (both ok-branch quote branches exercised — non-empty
  via test 25, empty via test 26/test 3).
- Bounded mutation sweep (`--mutate "src/rlm.ts:670-676"`): **6/6 changed-site mutants killed**,
  including the `> ` prefix, the `.map`, and the `""` empty-else-branch (the latter pinned by test 26
  after the VERIFY fix). The `output ?` ternary condition itself is not mutable by Stryker 9.6.1
  (recorded, D40 — the empty else-branch is the observable proof point, and it is now pinned).

## Review

REQUEST CHANGES → 1 Important finding fixed, code approved. The finding: test 3's locator
`"\nstdout:"` measured a delimiter byte (32768 vs 32767) with zero headroom; fixed to
`"\nstdout:\n"` (commit `a6cbc11`) and the D38 rationale corrected to "defensive, not
quote-compensation". Suggestions recorded: (1) docs growth-bound sentence updated in the same commit;
(2) extract a shared `quoteLines()` helper — deferred (would touch the error branch, out of D39 scope).

## Security audit

0 Critical / 0 High / 0 Medium / 1 Low / 2 Info. **APPROVE.** The close is complete for the ok
branch: post-change the only column-0 lines are the system-emitted `Output: ` and the real
`\nstdout:` delimiter. Residual (Low, pre-existing, out of scope): the `stdout` value itself renders
raw in both branches, so a nested `\nstdout:` inside stdout can still forge a column-0 line —
steering-only, self-referential, sandbox remains the enforcement boundary. Info: the quote/sentinel
mechanism is a soft control (not authentication); the quote expression is duplicated across branches
(drift risk).

## Residual risks & post-ship follow-ups (hand to the issue-monitor final report)

1. **Raw `stdout` value can forge a nested `\nstdout:`** (Low, pre-existing, out of #156 scope) —
   candidate **#157**: `> `-quote the stdout value in both branches, mirroring D36.
2. **Duplicated `.split/.map/.join` quote expression** (Info) — extract `quoteLines(text)`; deferred
   because it touches the error branch (D39 keeps it untouched).
3. **Template-coupling inventory grew** — test 25/26 pin the ok-branch shape; `\nstdout:` + `> `
   prefix are now pinned by tests 2/3/25/26 (and 8/13/18 from prior flights). Flag on **#78** (the
   convergence flight breaks tests on string matching alone) so its template-coupling inventory is
   updated.

## Rollback

Pure code: revert per-commit (SPEC / plan+tasks / T1 / T2 / VERIFY-fix / REVIEW-fix / review+todo
separable). Each BUILD commit is independently revertable (< 5 min, no infra). The T2 commit is the
atomic unit (code + test-shape updates + docs move together, per #156 DoD).

## Close-out actions

- **#156 closing comment:** DoD satisfied — forgery test RED→green, code+test-3 (and test 2) update
  in one commit, ok-branch `output` quoted (forged `\nstdout:` renders `> stdout:`), coverage floor
  and mutation score green. Evidence: SPEC.md (D36–D40), tasks/plan.md, tasks/review.md, this report.
- **#78 flag:** the ok-branch delimiter change extends the template-coupling inventory (`\nstdout:` +
  `> ` prefix now also pinned by tests 25/26); the convergence flight must re-verify those tests when
  it reshapes the prompt.
- **#157 candidate:** quote the stdout value (see residual 1).
