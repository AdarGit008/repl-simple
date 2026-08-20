# Implementation Plan: Close the two residual spend gaps left by #165 — issue #182

## Overview

Two behavior changes plus one doc note, all in the RLM spend-accounting path:

1. **D65** — a ≥1-token floor in `callCost` (or `tryCharge`) so no LLM call is ever free.
2. **D64** — charge the D44/D45 synthesis pass against the shared pool; degrade to salvage on
   refusal.
3. **D66 (doc)** — note the `estimateTokens` lower-bound caveat on `RlmOptions.budget`.

Source of truth: `SPEC.md` (D64–D66) + issue #182.

## Architecture Decisions

- **D65 floor lands in `callCost`** (preferred per SPEC Assumption 3): `Math.max(1, systemPromptTokens
  + Σ estimateTokens(content))`. Rationale: it is the single choke point every charged path already
  goes through, so the floor is uniform with zero special-casing and `tryCharge`/`SpendBudget` stay
  untouched. (Fallback if `callCost` proves unsuitable: floor inside `tryCharge`.)
- **D64 synthesis charge uses the same `callCost`** as every other charged path (D62), charged
  immediately before the final `llmClient.query`. On refusal the run salvages: it returns the last
  iteration's extracted answer (the value the run had before the synthesis refinement), never
  throwing and never emitting a bare synthesis-caused `budget_exhausted` status.
- **Salvage is a graceful in-place degrade (D4)**, not a new error status. The accumulated answer is
  already in scope at the synthesis site; the coder wires refusal → return-that-answer.

## Task List

### Phase 1: Foundation (D65 — the ≥1-token floor)

- [ ] **Task 1** — Enforce a ≥1-token minimum in `callCost`; no LLM call is ever free.

### Checkpoint: Foundation
- [ ] `npm test`, `npm run check`, `npm run lint` all green.

### Phase 2: Core (D64 — synthesis charge + salvage)

- [ ] **Task 2** — Charge the D44/D45 synthesis pass and degrade to salvage on refusal.

### Checkpoint: Core
- [ ] Synthesis pass is charged; refusal salvages; full suite green.

### Phase 3: Polish (D66 — doc note)

- [ ] **Task 3** — Document the `estimateTokens` lower-bound caveat on `RlmOptions.budget`.

### Checkpoint: Complete
- [ ] All SPEC success criteria met; `npm test`, `npm run check`, `npm run lint` green.
- [ ] Ready for VERIFY (test-engineer) → REVIEW (code-reviewer) → SHIP (security-auditor).

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Top-level loop charge interferes with "tight budget" RED tests (the code-gen call charges first) | Med | Coder sizes budgets against `recordedCost` of all prior calls; mirrors the existing "spend budget" test helpers; asserts `consumed` deltas, not absolutes, where needed |
| Salvage plumbing ambiguity (which accumulated value to return) | Med | The last iteration's extracted answer is in scope at the synthesis site; coder reads the synthesis region and returns that value; pinned by the salvage RED test asserting the pre-synthesis answer |
| Floor of exactly 1 token could distort the existing #165 `consumed === Σ recordedCost` assertions if those tests use empty prompts | Low | Existing tests use non-empty prompts, so `Math.max(1, …)` is a no-op there; coder runs the full suite to confirm no regression |
| `#184` / `#171` / `#168` scope bleed (adjacent lines in `src/rlm.ts`) | Med | Coder touches only the synthesis charge site + `callCost` + `RlmOptions` doc; out-of-scope items are enumerated in SPEC.md Boundaries |
| Line numbers in SPEC/issue are approximate | Low | Coder locates the synthesis pass and charge sites by symbol (`llmClient.query` after the cap, `callCost`), not by raw line number |

## Open Questions

None blocking (recorded in SPEC.md Assumptions).
