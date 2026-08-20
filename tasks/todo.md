# Todo — issue #165: bound tree spend on the shared `SpendBudget`

Source of truth: `SPEC.md` (D61–D63) + `tasks/plan.md`.

- [ ] **T1 — Charge `llm_query` + `rlm_query` downgrade against the shared pool; refuse on exhaustion**
  - RED: add failing tests in `test/rlm.test.ts` (extend the "runRlm() — spend budget" block or a new
    sibling block):
    - `llm_query` charges the pool — generous budget; `answer = llm_query("…")` + `SUBMIT(answer)`;
      assert `result.budget.consumed === Σ recordedCost(all recorded calls)`.
    - `llm_query` refuses on a tight budget — budget sized to the first code-gen call only; assert the
      refusal marker in the answer/stdout, no throw, termination as `budget_exhausted`/marker.
    - `rlm_query` downgrade charges — `maxDepth:1, depth:1`; assert `consumed` includes the downgrade
      call.
    - `rlm_query` downgrade refuses — tight budget; assert the refusal marker.
  - Implement (GREEN) in `src/rlm.ts`: add `budget` + `systemPromptTokens`-aware `callCost` charging
    and refusal markers (`"[llm_query refused: spend budget exhausted]"`,
    `"[rlm_query refused: spend budget exhausted]"`) to `onLLMQuery` and the downgrade branch of
    `onRLMQuery`.
  - Verify: `npm test` (full), `npm run check`, `npm run lint` all green.

- [ ] **T2 — Thread the shared pool into nested `runRlm`; update the D52 comment**
  - RED: add failing tests:
    - nested `rlm_query` shares the parent's pool — generous budget; assert
      `result.budget.consumed === Σ recordedCost(parent + child calls)`.
    - a pool that cannot afford the child's second iteration → child returns `budget_exhausted`,
      surfaced as `[rlm_query error: budget_exhausted]`, no throw.
  - Implement (GREEN) in `src/rlm.ts`: change `budget: undefined` → `budget` in the nested `runRlm`
    call inside `onRLMQuery`; rewrite the stale D52 comment to state the child shares the parent's
    pool (D61).
  - Verify: `npm test` (full), `npm run check`, `npm run lint` all green.

## Checkpoint (after T2)

- [ ] All six new tests green; full suite, `tsc --noEmit`, and biome clean.
- [ ] SPEC.md success criteria met.

## DoD (from #165, reconciled)

- [ ] `llm_query`, `rlm_query` downgrade, and nested `runRlm` all charge the single shared
      `SpendBudget` pool.
- [ ] A refused tool call returns its marker string and never throws or calls the LLM.
- [ ] A configured budget is a hard ceiling on **total tree** spend.
- [ ] Omitting `budget` leaves every path budget-free (no regression).
- [ ] Out of scope (not touched): #171, #168, #170, the final synthesis pass (D44/D45),
      `budgetReport`/`SpendBudget`/public `RlmResult`.
