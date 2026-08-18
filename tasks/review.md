# Review — post-merge micro-flight F-145b (close #145's two open items, D28/D29)

Five-axis review of `main..HEAD` on `issue-145-post-merge-items` (6 commits) by the code-reviewer
persona (fresh context).

## Verdict: REQUEST CHANGES → single Important finding fixed in the review-fix commit (`b9ea5b9`); code itself approved as-is

### Critical Issues
None.

### Important Issues (fixed)
- **Doc-anachronism (SPEC.md:533, tasks/monitor-report.md:106, tasks/monitor-watch.md:640):** the D29
  mechanical rename swept **dated historical passages** narrating the 2026-08-17 blocked state —
  making them read "`correctDiagnosticText` exists only on main", which was false at that historical
  moment. Fixed by restoring the old identifier with "since renamed …" annotations; the D29 grep
  audit now treats historical references as legitimate.

### Suggestions (recorded)
- Test comment constant corrected (1275 → 1830 for N=60) in the review-fix commit.
- Optional `preambleLineCount()` / `appendSnippet()` helpers to make the counter invariant
  unbreakable rather than merely observable — deferred (guard tests already pin every site).
- tasks/plan.md replaced wholesale by the micro-flight plan (intended — SPEC remains the decision
  source of truth).

### What's Done Well
- Byte-identical by construction (every site reuses the exact `split("\n").length` expression).
- All 5 mutation sites accounted for; counter is derived state, not serialized (no schema change).
- Split-call-count test well-scoped (reference-identity watch set, `finally` restore, 3× headroom).
- Rename hygiene in code/tests perfect; zero stale references outside dated passages.

### Verification Story
- Session tests 67/67 locally; VERIFY 1038/1038 ×2 deterministic, tsc/build/lint/coverage green,
  pin-bite proofs green. No new security surface (pure integer arithmetic, behavior-neutral rename).
