# Review: #110 — Prove `Repl.resume()` forwards `onApproval` to the session

Reviewed diff: `origin/main..HEAD`, branch `issue-110-resume-onapproval`. Docs-only flight
(`SPEC.md`, `tasks/plan.md`, `tasks/todo.md`, `tasks/verify-110.md`, `docs/verify-110.md`,
`docs/verify-110.md-issue-comment.txt`); **no `src/` or `test/` change** — the killing test already
landed in `8ac0a1e` (PR #128).
Reviewer: fresh review context, adversarial pass, per `code-review-and-quality` skill.

## Context

- **Intent:** close the mutation gap where dropping `onApproval` from
  `session.resume({ onApproval, signal })` inside `Repl.resume()` would let the mutation suite stay
  green — a "broken feature, not a bypass" regression. Source of truth: `SPEC.md`, issue #110.
- **Expected deliverable:** evidence (not new code) proving the mutant is killed on this tree, so
  #110 can be closed without rediscovery.

## Evidence chain — machine re-verified by this review

- `reports/mutation/mutation.json` mtime `2026-08-17 14:04:39`, `files` map has a single key
  `src/repl.ts` → fresh single-file sweep, not the stale `00:14:59` full-tree report. ✅
- Per-mutant status at the two targets (read from JSON, not the doc):

  ```
  Killed | BooleanLiteral         | line 210 | repl: 'live'
  Killed | ConditionalExpression  | line 210 | repl: 'true'
  Killed | ConditionalExpression  | line 210 | repl: 'false'
  Killed | BlockStatement         | line 210 | repl: '{}'
  Killed | ObjectLiteral          | line 235 | repl: '{}'
  ```

  Matches `docs/verify-110.md` exactly. ✅
- `src/repl.ts:210` is `if (!live) {` and `src/repl.ts:235` is
  `const result = await live.session.resume({ onApproval, signal });` — the doc's line references
  are current-tree and correct (not the stale `:59`/`:62` from the issue body). ✅
- Killing test `test/repl.test.ts:517` ("suspend → resume(approve) runs the pending call") drives
  `runner.resume("approve-rt", approve)` where `runner = new ReplRunner(cwd)` (constructed at
  `test/repl.test.ts:51`) → goes through `Repl.resume()`, **not** `Session.resume()`. Its comment
  names #110. ✅
- Guard both directions: `test/repl.test.ts:492` (`!live` false — "resume on a live session with
  nothing pending") and `:503` (`!live` true — "resume on a session that does not exist"). Both
  cover the `:210` guard; all four `:210` mutants are Killed. ✅
- `git merge-base --is-ancestor 8ac0a1e origin/main` → yes; commit message is
  "5.1 — Make repl_resume, repl_abandon and repl_reset fail gracefully (#48) (#128)". ✅
- `node scripts/mutation-guard.mjs --report` → "no harness deaths recorded", exit 0 (independently
  re-run by VERIFY). ✅

## Findings

### Correctness — none blocking

- **Verified** `docs/verify-110.md` claims are exact: the five target-mutant statuses, the commit
  ref, the test name/line, the guard test lines, and the "287 mutants: 193 Killed / 60 Survived /
  34 Timeout" full-file context all match the raw JSON. No drift, no rounding, no paraphrase error.
- **FYI** `src/repl.ts:224` (`if (this.sessions.get(sessionId) !== live)`, the D3-parity guard) is a
  *second* no-session guard whose mutants are outside #110's DoD; the SHIP test-engineer check
  confirmed all four of its mutants are Killed (no follow-up gap there). Corrected from `:220`
  per the SHIP-phase finding.
- **FYI** `docs/verify-110.md` correctly scopes `signal` as wired-but-unproven (SPEC Assumption 4),
  and correctly flags the stale tree-wide mutation floor. Neither is silently claimed as done.

### Readability — one minor

- **Minor** `docs/verify-110.md-issue-comment.txt:1` — "Verified closed by a targeted mutation
  sweep…" reads as already-closed past tense. The meaning is "closing after verification", but the
  phrasing could confuse a reader skimming the issue. Suggest rephrasing the first line to
  "Closing: verified by a targeted mutation sweep (`npx stryker run --mutate src/repl.ts`, run
  `2026-08-17`)." Not blocking — the body's evidence is unambiguous.

### Architecture

- The "no new tests, verification-only" decision is defensible: the killing test already exists
  (`8ac0a1e`) and the targeted sweep proves it kills the mutant. Adding a redundant test would
  violate the repo's #23 purge of "tests that cannot fail". The conditional Task 2 (add a regression
  test only if a survivor surfaced) is the correct safety valve and was correctly skipped.
- No production/test code, no new dependencies, no shared-module changes. Flight artifacts follow
  the repo's existing `docs/review-59.md` / `docs/ship-59.md` / `docs/verify-*` conventions.

### Security

- Docs-only; secret-shape scan over `SPEC.md`, `tasks/`, `docs/verify-110.md`, and the comment body
  found nothing (`api_key`, `secret`, `token`, `password`, `ANTHROPIC`, `AWS_`, `SSH_`, `npm_config`,
  private-key markers). No env values, no internal paths beyond public repo-relative paths. The
  comment body is safe to post publicly.

### Performance

- **Process finding (not a code defect):** the plan estimated the targeted sweep at 30–60 min; the
  actual run took ~2h15m (~2x, from ~59 estimated mutants to 287 actual). This is recorded here and
  by the issue-monitor as a planning-calibration item for future single-file sweeps — not a defect
  in the deliverable, but the estimate belongs in `tasks/plan.md`'s risk table at the next revision
  (the monitor owns the open-issue wording; this review just surfaces it).

## Verification story

- `npm test` → 939/939 pass (VERIFY context, independent of BUILD).
- `npm run check`, `npm run build`, `npm run lint` → all exit 0 (VERIFY context).
- `docs/verify-110.md` excerpts match `reports/mutation/mutation.json` exactly (this review,
  machine-read).
- `gh issue comment 110 --body …` and `gh issue close 110 --reason completed --comment …` are valid
  subcommands/flags (checked against `gh issue comment --help` / `gh issue close --help`).
- Git hygiene: three commits at review time (`3d617b0` spec+plan, `b63d84d` verify doc, `9980891` verify verdict);
  the review fix (`d7a98c6`) and the ship report landed after this section was written.
  `git diff --name-status origin/main` shows only the docs/spec/plan/todo files, no `src/`/`test/`.

## Verdict

**Approve.** The evidence chain is exact (machine-verified, not eyeballed), the "no new tests"
decision is the correct one given the already-landed killing test, and the closure commands are
valid. One minor readability nit on the issue-comment body's opening line (rephrase "Verified
closed" → "Closing: verified"); everything else is clean. No blockers, no majors.
