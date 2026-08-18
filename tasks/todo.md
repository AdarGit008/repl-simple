# F-87 Task List

- [x] Task 1: `SpendBudget` + `estimateTokens` in `src/budget.ts`
  - Acceptance: `estimateTokens(text)` returns `ceil(TextEncoder byte length / 4)` (empty string →
    0; a known string → a pinned token count). `class SpendBudget` exposes `limit`/`consumed`/
    `remaining` getters and `tryCharge(tokens): boolean` — `false` (no charge) when `tokens < 0`
    or the charge would exceed `limit`, otherwise increments `consumed` and returns `true`. The
    constructor throws on non-finite or negative `limit`; `0` is accepted. `test/budget.test.ts`
    covers: estimator determinism (incl. empty → 0), `tryCharge` refusing overspend and negative,
    `remaining`/`consumed`/`limit` observability, constructor validation (negative, `NaN`,
    `Infinity`), and shared-instance semantics (two chargers on one instance compete for one
    `remaining` pool).
  - Verify: `npm test` (focused `test/budget.test.ts` green, full suite green), `npm run check`,
    `npm run lint`
  - Files: `src/budget.ts` (new), `test/budget.test.ts` (new)

- [ ] Task 2: Type surface — `RlmOptions.budget`, `RlmResult` budget report, exports
  - Acceptance: `RlmOptions.budget?: number | SpendBudget` (type-imported from `./budget.js`).
    `RlmResult.status` is `"ok" | "max_iterations" | "budget_exhausted"`; new exported interface
    `RlmBudgetReport { limit: number; consumed: number; limited: boolean }` and
    `RlmResult.budget?: RlmBudgetReport`. `src/index.ts` exports `SpendBudget` and `estimateTokens`
    (values) and the `RlmBudgetReport` type. A `test/types.test.ts` pin asserts the new status
    member and the `budget` field shape. Existing tests stay green (no behavior change yet).
  - Verify: `npm test` (full suite green), `npm run check`, `npm run lint`
  - Files: `src/types.ts`, `src/index.ts`, `test/types.test.ts`

- [ ] Task 3: Wire the budget into `runRlm` + the five issue tests
  - Acceptance: `runRlm` builds a budget from `options.budget` (number → fresh `SpendBudget`;
    instance → used and mutated in place; absent → no budget logic). Before each LLM call (after
    the abort check), compute `cost = estimateTokens(systemPrompt) + Σ estimateTokens(m.content)`;
    when a budget is configured and `!budget.tryCharge(cost)`, return
    `{ status: "budget_exhausted", answer: extractBestAnswer(iterations), iterations,
    budget: { limit, consumed, limited: true } }` (no throw). The `"ok"` (SUBMIT) and
    `"max_iterations"` returns attach `budget: { limit, consumed, limited: false }` when configured.
    `src/rlm.ts` never references `Buffer`/`byteLength` (test 6 stays green). Add the five issue
    tests to `test/rlm.test.ts`: (1) small budget stops before `maxIterations` with
    `status: "budget_exhausted"`; (2) two `runRlm` calls sharing one `SpendBudget` — the second
    sees the first's spend (`budget.consumed` is cumulative, second is `limited`); (3) a budget too
    small for the first call returns a result (never throws) with `budget.limited: true`; (4)
    `result.budget.consumed === Σ estimateTokens` over the mock's recorded calls; (5) omitting
    `budget` yields `status` in `"ok" | "max_iterations"`, no `budget` field, existing assertions
    unchanged.
  - Verify: `npm test` (full suite green, ~8–10 new tests), `npm run check`, `npm run lint`,
    `npm run coverage` (floors met)
  - Files: `src/rlm.ts`, `test/rlm.test.ts`
