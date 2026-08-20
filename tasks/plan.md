# Implementation Plan: issue #165 — bound tree spend on the shared `SpendBudget`

## Overview

`runRlm` charges only its top-level iteration loop. This plan threads the single resolved
`SpendBudget` pool through the two tool-mediated LLM paths (`llm_query`, the `rlm_query` downgrade)
and the nested `runRlm`, so a configured budget is a hard ceiling on total tree spend. Refused
tool calls degrade to a marker string (D4), never throw. Two sequential tasks, each RED → GREEN,
each leaving the tree green.

## Architecture Decisions

Reference SPEC.md (D61–D63), not restated here. Key implementation facts the coder must respect:

- **Closure capture of later-declared bindings.** The `onLLMQuery` / `onRLMQuery` closures are built
  inside `createRLMTools({...})`, **before** `budget` (minted ~`src/rlm.ts:1110`) and
  `systemPromptTokens` (~`:1120`) are declared as `const`. Both tool callbacks execute only during
  `runInSandbox` inside the loop — after those bindings are initialised — so referencing them inside
  the arrow-function bodies is safe (no TDZ violation; TS accepts deferred references). **Minimal-diff
  approach:** keep the existing declaration order and reference `budget` + `systemPromptTokens` in the
  closures. (Alternative — hoist `budget` minting above the registry and declare
  `let systemPromptTokens` beside `let systemPrompt` — is acceptable but not required.)
- **Reuse `callCost` (D62).** A tool call's cost is `callCost(systemPromptTokens,
  [{role:"user", content}])` — never a bespoke estimate.
- **Refusal markers (D63):** `"[llm_query refused: spend budget exhausted]"` and
  `"[rlm_query refused: spend budget exhausted]"` as private module `const`s; tests pin the literals.
- **Nested threading (D61):** replace `budget: undefined` with `budget` in the nested `runRlm` call
  and update the stale D52 comment ("The child is bounded by maxIterations/maxDepth, not the parent's
  spend pool") to state the child now shares the parent's pool (D61).

## Task List

### Phase 1: charge the tool-mediated single-turn paths (T1)

- **T1** — Charge `llm_query` and the `rlm_query` downgrade against the shared pool; refuse with a
  marker on exhaustion.
  - Tests (RED): #1 `llm_query` charges (consumed === Σ recordedCost); #2 `llm_query` refuses on a
    tight budget (marker, no throw); #3 downgrade charges; #4 downgrade refuses.
  - Implement (GREEN): add `budget`/`systemPromptTokens`-aware charging + refusal markers to
    `onLLMQuery` and the downgrade branch of `onRLMQuery`.

### Checkpoint: after T1

- [ ] `npm test`, `npm run check`, `npm run lint` green; `llm_query` + downgrade charge/refuse.

### Phase 2: thread the pool into nested `runRlm` (T2)

- **T2** — Pass the shared pool to the nested `runRlm`; update the D52 comment.
  - Tests (RED): #5a nested loop's iterations deplete the parent's pool (consumed === Σ recordedCost
    over parent + child); #5b a pool that cannot afford the child's second iteration surfaces
    `[rlm_query error: budget_exhausted]` without throwing.
  - Implement (GREEN): `budget: undefined` → `budget` in the nested call; fix the D52 comment.

### Checkpoint: complete

- [ ] All six new tests green; full suite + `tsc` + biome green; success criteria met.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| TDZ/subtle closure-capture bug if the coder mis-orders `budget`/`systemPromptTokens` | Runtime `ReferenceError` only on tool use | Documented above; tests drive the tool path so any misuse fails loudly in RED/GREEN |
| Test sizing (tight-budget pins) fragile against prompt drift | Flaky budget tests | Follow the existing probe-then-size pattern (budget block test #1); assert on `recordedCost` equality, not magic numbers |
| Scope bleed into #171/#168/#170 | Review churn, duplicated work | Explicit out-of-scope list in SPEC.md; coder contract forbids it |
| Final synthesis pass remains un-charged (D44/D45) | Residual un-bounded single call at the cap | Recorded as residual risk; issue-monitor to recommend filing |

## Open Questions

None blocking.
