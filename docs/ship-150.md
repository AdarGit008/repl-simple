# Ship Report — Issue #150 (killing test for `Repl.resume()` abort propagation)

Branch: `issue-150-resume-abort-test` · Base: `origin/main` @ `0755262` · Flight: /code-pipeline, autonomous.

## Decision

**GO.** Unanimous across the SHIP fan-out (code-reviewer, security-auditor, test-engineer) and the
REVIEW phase. Test-only flight: +1 killing test, zero production-code change; all DoD evidence
machine-verified on the current tree.

## What was delivered

- **One killing test**, `test/repl.test.ts:530` — "suspend → resume with an already-aborted signal
  does not run the pending call". Drives `Repl.resume()` (the wiring layer) with a pre-aborted
  `AbortController`, asserts the `[error: aborted]` surface **and** the no-write invariant. Names
  #150 and the `signal`-drop mutant in its comment.
- **No `src/` change.** The wiring at `src/repl.ts:235` was already correct; this flight proves it.
- **RED proof (primary, per SPEC D0/D3):** Stryker's `ObjectLiteral` mutator cannot generate the
  single-field drop `{ onApproval, signal }` → `{ onApproval }`, so the kill was proven by hand —
  applied transiently, the test fails 1/1 (output `'[result]\nSuccessfully wrote 2 bytes to
  abort-rt.txt'`: the abort was silently dropped and the write ran), then restored with a verified
  empty diff. Re-proven independently by BUILD (T1), VERIFY, REVIEW, and SHIP test-engineer —
  four independent hand-proofs, both mutant variants (`{ onApproval }` and Stryker's `{}`).
- **Mutation sweep:** targeted `--mutate src/repl.ts`, 287 mutants = 193 Killed / 60 Survived /
  34 Timeout (Survived/Timeout pre-existing, unchanged). `ObjectLiteral {}` @ `src/repl.ts:235`
  Killed; `mutation-guard --report` → exit 0, no harness deaths. Freshness gate passed (mtime
  15:02:56 > sweep start 15:02:09, `files == ["src/repl.ts"]`).
  **Recorded caveat (honest):** with `coverageAnalysis: "off"` + incremental reuse, the 15:02 sweep
  re-executed zero mutants — all statuses are carried over from the #110 sweep's cache. The gap is
  closed by the hand-applied RED (primary evidence) re-proven four times on this tree.
- **Suite:** `npm test` 947/947 (baseline measured at pre-test HEAD: 946 → grew by exactly one) ·
  `npm run check` · `npm run build` · `npm run lint` — all exit 0, re-verified independently in
  VERIFY, REVIEW, and SHIP contexts.

## Fan-out verdicts

| Reviewer | Verdict | Key findings |
|---|---|---|
| code-reviewer | GO | All four gates re-verified from source/JSON, not docs; RED re-proven for both mutant variants; 3 minor doc residuals (fixed at ship time in this commit) |
| security-auditor | GO | Zero `src/` changes; abort path traced fail-closed (`src/sandbox.ts:1133` sets `aborted` before the replay prologue at `:1144`); no secrets in any artifact; no new attack surface. 2 INFO follow-ups (below) |
| test-engineer | GO | All five gates self-run: 947/947, static 0s, JSON machine-read fresh + `:235` Killed, hand-applied mutant FAIL 1/1 with both assertions killing independently (proven via a standalone probe), restored tree clean |

## REVIEW phase

`docs/review-150.md` — **APPROVE-WITH-NITS**; no blockers, no majors. Amendments applied
(`ca792fa`, `this commit`): SPEC RED-wording + line cites, plan.md `940/940` → `946 → 947`,
review doc's file-count note, verify doc's superseded-claim note.

## Execution order

1. Merge branch to `main` (squash) — **first**, so the comment's `docs/verify-150.md` link resolves.
2. Post the evidence comment (body: `docs/verify-150.md-issue-comment.txt`).
3. Close #150 with `--reason completed`.

## Rollback plan

- **Trigger:** any CI failure on the merge, or evidence contested after closure.
- **Steps:** `git revert <merge-sha> && git push` (test-only, zero runtime impact); reopen the issue
  with `gh issue reopen 150 --comment "Reopened pending re-verification."`.
- **Time to rollback:** < 5 minutes (single revert + push). No DB, no flags, no runtime state.

## Follow-ups recorded for future flights (not this one)

1. **Adopt `--force` for single-file mutation sweeps** so machine evidence is re-executed, not
   reused from the incremental cache (the `coverageAnalysis: "off"` + incremental reuse caveat
   disclosed in `docs/verify-150.md` §2). Security-auditor INFO #2.
2. **UX polish:** `Session.resume` resolves the `onApproval` callback before the abort gate — a
   pre-aborted resume can flash a dead approval dialog (no side effect runs; fail-closed
   unaffected). Security-auditor INFO #1; candidate for bucket-5.
3. The `--mutate` sweep is ~2h15m cold but ~44s incremental — future flights should state which
   mode the DoD requires (force vs incremental) up front in the SPEC.
