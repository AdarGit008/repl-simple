# Implementation Plan: F-87 — Shared RLM spend budget

## Overview

Give the RLM loop a shared, observable spend budget. #87's premise is that no limit composes into a
ceiling across a fan-out: `maxIterations` bounds one loop, `maxDepth` bounds height, #74 bounds one
conversation — nothing counts total spend. This flight builds the budget **mechanism** (a shared,
mutable `SpendBudget` + a deterministic token estimator) and wires it into `runRlm` at the
single-loop level, then proves the crux — **siblings share one pool** — by passing one `SpendBudget`
instance across multiple `runRlm` calls. The actual `rlm_query` fan-out wiring is #78's scope and is
deferred (D1), with the hand-off recorded for #78.

## Architecture Decisions

Condensed from SPEC.md (the canonical record):

- **D1** — Budget mechanism in `runRlm` now; fan-out *wiring* (pass the shared instance through
  `rlm_query`) waits for #78 step 4. No nesting port here.
- **D2** — Unit = **estimated tokens**: `estimateTokens(text) = ceil(utf8bytes(text) / 4)`, measured
  with `TextEncoder`. Portable (#87's preference), deterministic and tokenizer-independent
  (reconciles `docs/truncation-policy.md` Non-goal — truncation stays byte-based; the spend budget
  is a separate control).
- **D3** — API: `src/budget.ts` (`estimateTokens`, `class SpendBudget` with `limit`/`consumed`/
  `remaining` + `tryCharge(tokens): boolean`); `RlmOptions.budget?: number | SpendBudget`;
  `RlmResult.status` gains `"budget_exhausted"`; `RlmResult.budget?: { limit, consumed, limited }`.
- **D4** — Charge before each LLM call; on unaffordable → degrade (return best answer +
  `budget.limited: true`), never throw. `limited: false` on `"ok"`/`"max_iterations"`.
- **D5** — No budget ⇒ unchanged (test 5); the budget must not become a mandatory ceiling.
- **D6** — `SpendBudget` constructor rejects non-finite/negative; `0` is valid (degrades immediately).
- **D7** — Additive `RlmResult` changes compose with #75/#76/#78 (no collision).
- **D8** — Estimator in `src/budget.ts`; `src/rlm.ts` never references `Buffer`/`byteLength`
  (test 6).

## Task List

### Phase 1: Foundation — the budget object

- [ ] **Task 1:** `SpendBudget` + `estimateTokens` in `src/budget.ts` with unit tests.

### Checkpoint A: Budget module
- [ ] `npm test` (focused `test/budget.test.ts` + full suite green), `npm run check`, `npm run lint`.

### Phase 2: Contract — the type surface

- [ ] **Task 2:** `RlmOptions.budget`, `RlmResult.status` + `budget` report, `RlmBudgetReport`, and
      index.ts exports.

### Checkpoint B: Types compile and are pinned
- [ ] `npm test`, `npm run check` green.

### Phase 3: Wiring — `runRlm` charges and degrades

- [ ] **Task 3:** Wire the budget into `runRlm` (charge, degrade, report) + the five issue tests.

### Checkpoint C: Complete
- [ ] All five issue tests + `test/budget.test.ts` green; `npm test`, `npm run check`, `npm run lint`,
      `npm run coverage` green (floors met).

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `runRlm` byte-counting trips test 6 (`Buffer`/`byteLength` grep) | Med | Estimator lives in `src/budget.ts` using `TextEncoder`; `rlm.ts` imports it (D8). Full-suite gate re-asserts. |
| New `RlmResult.status` member surprises a consumer's exhaustive switch | Low | Additive union member; `status` is a string union already extended by #75/#78; existing tests check equality, not exhaustiveness. |
| "Siblings share one pool" unprovable without nesting | Med | Proven via a shared `SpendBudget` across two `runRlm` calls (D1) + a unit test of shared-instance semantics. |
| Estimator `/4` constant drifts from a real tokenizer's count | Low | Deterministic and pinned by test; `estimateTokens` is the single swap point if a tokenizer ever lands. |
| Pre-charge on an aborted call | Low | Abort path throws and reports nothing; charge is moot there. |
| `RlmResult` field collision with #75/#76/#78 | Low | All additive (new status member + optional field); recorded for those flights (D7). |

## Open Questions

- Fan-out wiring through `rlm_query` — deferred to #78 step 4 (hand-off recorded for #78).
- Provenance of the budget-limited answer — plain `status` + `budget.limited` here; #76 enriches later.
- `/4` bytes-per-token is an approximation — documented, single swap point.
