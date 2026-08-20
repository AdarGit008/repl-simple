# Todo — issue #182: close the two residual spend gaps left by #165

Source of truth: `SPEC.md` (D64–D66) + `tasks/plan.md`.

- [x] **T1 — Enforce a ≥1-token minimum in `callCost` (D65); no LLM call is ever free**
  - RED: add failing test(s) in `test/rlm.test.ts` proving that with `systemPrompt: ""` and
    `llm_query("")` the charge is ≥1 (not 0): a budget that affords exactly one empty call makes the
    second empty `llm_query("")` refuse with `[llm_query refused: spend budget exhausted]`; assert
    `consumed ≥ 1` per call. Account for the top-level code-gen charge (size budgets via the
    existing `recordedCost` helpers).
  - Implement (GREEN) in `src/rlm.ts` `callCost` (preferred): `Math.max(1, systemPromptTokens +
    Σ estimateTokens(content))`. Fallback: floor inside `src/budget.ts` `tryCharge`. No
    special-casing; uniform across all charged paths.
  - Verify: `npm test` (full), `npm run check`, `npm run lint` all green; existing #165 spend tests
    (non-empty prompts) unaffected.

- [ ] **T2 — Charge the D44/D45 synthesis pass and degrade to salvage on refusal (D64)**
  - RED: add failing tests:
    - synthesis charges — a run with no SUBMIT (runs to the iteration cap) and a generous budget;
      assert `result.budget.consumed` includes the synthesis call's cost and the final answer is the
      synthesized answer.
    - synthesis salvages — budget sized to afford the iterations but not the synthesis call; assert
      the run returns the salvaged (pre-synthesis) answer, never throws, and status is not a bare
      `budget_exhausted` caused by the synthesis charge.
  - Implement (GREEN) in `src/rlm.ts`: `tryCharge(callCost(...))` immediately before the final
    synthesis `llmClient.query`; on refusal return the last iteration's extracted answer (salvage).
    Keep the omitted-budget path un-charged (D5).
  - Verify: `npm test` (full), `npm run check`, `npm run lint` all green.

- [ ] **T3 — Document the `estimateTokens` lower-bound caveat on `RlmOptions.budget` (D66, doc-only)**
  - Add a JSDoc note on `RlmOptions.budget` (in `src/rlm.ts`): `estimateTokens` is a deterministic
    lower bound (bytes ÷ 4) and under-counts non-ASCII/emoji/CJK up to ~1 token/byte; callers
    needing a hard real-token bound must apply their own margin for non-English content.
  - No behavior change, no test (D2 doc note convention).
  - Verify: `npm run check`, `npm run lint` green (no test needed).

## Checkpoint (after T3)

- [ ] All SPEC success criteria met (D64, D65, D66).
- [ ] Full suite, `tsc --noEmit`, and biome clean.

## DoD (from #182, reconciled)

- [ ] The synthesis pass charges the shared pool; refusal degrades to salvage (never throws, never a
      bare synthesis-caused `budget_exhausted`).
- [ ] No LLM call is ever free: a ≥1-token floor applies uniformly across every charged path.
- [ ] `RlmOptions.budget` documents the `estimateTokens` lower-bound caveat.
- [ ] Both behaviors pinned by named tests (RED → GREEN).
- [ ] Out of scope (not touched): #171, #168, #184, #170; `budgetReport`/`SpendBudget`/public
      `RlmResult` shapes.
