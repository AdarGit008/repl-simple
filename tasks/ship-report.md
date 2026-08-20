# Ship Report — issue #165 (bound tree spend on the shared `SpendBudget`)

## Decision: **GO** ✅

No Critical / High / Medium findings from any of the three report sources. The change is a
correct, well-tested hardening: the single resolved `SpendBudget` is now a hard ceiling on
*estimated* LLM spend across the whole RLM tree (`llm_query`, `rlm_query` downgrade, nested
`runRlm`), and every new charge path is code-enforced with no string-parsing or TOCTOU gap.

## Fan-out verdicts (all three sources covered — ship fan-out skip rule does not apply)

| Source | Verdict | Findings |
|--------|---------|----------|
| test-engineer (VERIFY) | **GO** | 1063 pass / 0 fail; `tsc` + scoped biome clean; changed regions ~99% line / ~96% branch coverage; all SPEC success criteria pinned by named tests 8–15 |
| code-reviewer (REVIEW) | **APPROVE** | 0 Critical, 0 code-level Important; 1 repo-hygiene Important (lint gate red on `graphify-out/`) — fixed (`.gitignore` += `graphify-out/`, `npm run lint` now green); 3 Suggestions (all non-blocking) |
| security-auditor (SHIP) | **PASS** | 0 Critical / 0 High / 0 Medium; 3 Low + 3 Info — all pre-existing residuals or out-of-scope, none a defect introduced by this change |

## What was built

Threading one `SpendBudget` pool through `runRlm` (D61–D63):

- `onLLMQuery` (`llm_query`) charges `callCost(systemPromptTokens, [{role:"user",content:prompt}])` before the call; refuses with a marker on exhaustion.
- `onRLMQuery` downgrade branch charges the downgrade message before the call; refuses with a marker.
- Nested `runRlm` passes the resolved `SpendBudget` instance (was `budget: undefined`), so child loops compete for the parent's pool; D52 comment updated.
- Refusal degrades, never throws (D4/D63): `"[llm_query refused: spend budget exhausted]"`, `"[rlm_query refused: spend budget exhausted]"`.
- 8 new/strengthened tests (8–15) in `test/rlm.test.ts`, incl. refused-whole boundary, no-budget regression, and a `maxDepth:2` deep-tree charge pin.

## Residual risks (recorded, not hidden)

| Residual | Severity | Owner |
|----------|----------|-------|
| D44/D45 synthesis pass stays un-charged — bounded single-call over-spend at `max_iterations` | Low | new follow-up (SPEC Assumption 3) |
| Breadth flood of refused `rlm_query` spawns → per-spawn `buildSystemPrompt` host work before first charge | Low | #168 (breadth backstop) |
| Empty `systemPrompt` + empty tool prompt → 0-token charge, free call (defense-in-depth) | Low | new follow-up (min 1-token charge) |
| Tool-mediated calls omit `raceAgainstSignal` (client-only cancellation) | Info | #171 (signal-race parity) |
| `estimateTokens` lower bound under-counts non-ASCII (documented D2) | Info | doc note on `RlmOptions.budget` |

## Rollback plan

- **Trigger:** none expected; roll back if post-merge the full suite regresses or the spend
  accounting is observed to differ from `Σ recordedCost`.
- **Steps:** `git revert` the three build commits in reverse order
  (`4124498`, `5dda924`, and the test-reinforcement `50fad63`) — each is an independent,
  cleanly-scoped commit; the spec/plan commit `af5af15` and the `.gitignore` fix `b80f509` are
  independently revertable and orthogonal.
- **Verify:** `npm test` + `npm run check` + `npm run lint` green after revert.
- **Time to rollback:** < 5 minutes (pure code revert, no schema/migration, no deploy).
