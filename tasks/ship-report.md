# Ship Report — issue #182 (close the two residual spend gaps left by #165)

## Decision: **GO** ✅

No Critical / High / Medium findings from any of the three report sources. The change is a correct,
well-tested hardening: a configured `budget` is now a strict (estimated-token) ceiling on total tree
spend with no free call and no un-charged synthesis pass. Both behavior changes are code-enforced at
the single `callCost` choke point and pinned by RED→GREEN tests.

## Fan-out verdicts (all three sources covered — ship fan-out skip rule does not apply)

| Source | Verdict | Findings |
|--------|---------|----------|
| test-engineer (VERIFY) | **GO** | 1072 pass / 0 fail; `tsc` + biome clean; coverage floors met (`src/rlm.ts` 99.36% vs 99.14% floor); changed regions 100% line. One gap found (charged-then-thrown synthesis unasserted) → coder closed it; re-verify GO |
| code-reviewer (REVIEW) | **APPROVE** | 0 Critical, 0 Important; 3 Suggestions (non-blocking): `recordedCost` helper docstring doesn't note the floor mirror; `RlmBudgetReport.limited` wording imprecision (pre-existing, surfaced by D64); `tasks/todo.md` Checkpoint/DoD boxes left unchecked — ticked at ship |
| security-auditor (SHIP) | **PASS** | 0 Critical / 0 High / 0 Medium / 0 Low; 3 Info: D66 doc understates the worst-case under-count *factor* (~3–4×, not "~1 token/byte"); synthesis-refusal `limited:false` observability nuance; charged-then-thrown synthesis is non-refundable (intended D4 accounting) |

## What was built

Three decisions closing #182's two gaps, all in the spend-accounting path:

- **D65 — ≥1-token floor in `callCost`** (`src/rlm.ts:901-914`): `Math.max(1, systemPromptTokens +
  Σ estimateTokens(content))` at the single choke point every charged path routes through. Closes the
  `while True: llm_query("")` zero-token free-call bypass. `SpendBudget`/`tryCharge` untouched.
- **D64 — synthesis pass charged, degrades to salvage** (`src/rlm.ts:1363-1409`): the D44/D45 final
  `llmClient.query` charges `callCost` before running; on refusal returns
  `extractBestAnswer(iterations)` with `status:"max_iterations"`, `answerSource:"salvaged"`,
  `limited:false` — degrades, never throws, never a bare synthesis-caused `budget_exhausted` (D4).
  Omitted-budget path stays un-charged (D5).
- **D66 (doc)** — `RlmOptions.budget` JSDoc notes `estimateTokens` is a deterministic lower bound
  (bytes ÷ 4) that under-counts non-ASCII/emoji/CJK; callers needing a hard real-token bound must
  apply their own margin.

Tests added/updated in `test/rlm.test.ts`: `spend budget` #16 (floor), #17 (synthesis charges), #18
(synthesis salvages), `answer provenance` #7 (updated — synthesis now charged) and #8 (charged-then-
thrown synthesis still counts and salvages). Full suite: **1072 pass / 0 fail**.

## Residual risks (recorded, not hidden)

| Residual | Severity | Owner |
|----------|----------|-------|
| `budget` is an *estimated-token* soft ceiling: `estimateTokens` (bytes ÷ 4) under-counts non-ASCII/emoji/CJK up to ~3–4× | Low | doc note (D66); real tokenizer is D2 |
| Host-tool invocation breadth unbounded (a loop calling host tools inside one iteration) | Low | #168 (breadth backstop) |
| Synthesis/`llm_query`/downgrade calls omit `raceAgainstSignal` (client-only cancellation) | Info | #171 (signal-race parity) |
| Charged-then-thrown synthesis is non-refundable (charge-without-value) | Info | intended D4 charge-before-call accounting; pinned by provenance test 8 |
| Synthesis-refusal salvage reports `limited:false` while `consumed ≈ limit` | Info | doc follow-up on `RlmBudgetReport.limited` |

## Rollback plan

- **Trigger:** none expected; roll back if post-merge the full suite regresses or spend accounting
  diverges from `Σ recordedCost`.
- **Steps:** `git revert` the five build commits in reverse order
  (`1685e8d`, `132a72e`, `92ad957`, `9c81e5d`, `49684b8`). Each is independent and cleanly scoped
  (one decision per commit); the spec/plan commit `49684b8` is revertable on its own if the code
  revert alone is preferred.
- **Verify:** `npm test` + `npm run check` + `npm run lint` green after revert.
- **Time to rollback:** < 5 minutes (pure code revert, no schema/migration, no deploy).

## Follow-ups (from Suggestions / Info, non-blocking)

- Tighten the D66 JSDoc to state the under-count *factor* (≥4× margin) rather than "~1 token/byte".
- Document the `limited:false` nuance on `RlmBudgetReport.limited` (code-reviewer + security-auditor
  both flagged).
- Optionally mirror the floor in the `recordedCost` test helpers (or comment the intentional
  divergence).
