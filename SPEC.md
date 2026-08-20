# Spec: Close the two residual spend gaps left by #165 — issue #182

## Objective

#165 threaded one shared `SpendBudget` pool through `llm_query` / `rlm_query`-downgrade / nested
`runRlm` (D61–D63). Two low-severity holes remain, both of which break the "a configured budget is a
hard ceiling on total tree spend" guarantee in the strict sense:

1. **The D44/D45 synthesis pass is un-charged.** The single final `llmClient.query` after the
   iteration cap runs without a `tryCharge`, so a run at `maxIterations` can over-spend by exactly
   one synthesis call (system prompt + full transcript + synthesis prompt). Bounded (one call,
   cannot loop), but it is a leak past the ceiling.
2. **Zero-token free call.** `callCost` = `estimateTokens(systemPrompt) + Σ estimateTokens(content)`.
   With `options.systemPrompt = ""` and `llm_query("")` both terms are 0, so `tryCharge(0)` succeeds
   and a real provider call is made for 0 estimated tokens. A prompt-injected model could
   `while True: llm_query("")` and burn unbounded spend while `budget.consumed` never moves.

This change closes both: (a) charge the synthesis pass against the shared pool and degrade to
salvage on refusal (matching D4), and (b) enforce a ≥1-token minimum charge so no LLM call is ever
free. It also adds the doc note the issue asks for on the `estimateTokens` lower-bound caveat.

## Current state (fact base — verified against HEAD `a64b3e7`, i.e. #165 merged)

- **`src/budget.ts`** — `SpendBudget` (`limit`, `consumed`, `remaining`, `tryCharge(tokens)`),
  `estimateTokens` (UTF-8 bytes ÷ 4, a deterministic **lower bound** — non-ASCII/emoji/CJK
  under-count up to ~1 token/byte, D2).
- **`src/rlm.ts:~854-862`** — `callCost(systemPromptTokens, messages)` =
  `systemPromptTokens + Σ estimateTokens(message.content)`. Used by the top-level loop, `llm_query`,
  and the `rlm_query` downgrade (D62).
- **`src/rlm.ts:~1061-1063` / `~1084-1086`** — the `llm_query` and `rlm_query`-downgrade charge
  sites added by #165 (D62). These are the paths a `while True: llm_query("")` loop hits.
- **`src/rlm.ts:~1319-1325`** — the D44/D45 synthesis pass: a single final `llmClient.query` after
  the iteration cap, deliberately un-charged today ("one guarded, un-charged synthesis pass").
- **`src/rlm.ts:78-85`** — `RlmOptions.budget?: number | SpendBudget`; omitted → no budget logic (D5).

## Scope

### In scope

- Charge the D44/D45 **synthesis pass** against the resolved budget before it runs; on refusal,
  degrade to **salvage** (return the best answer accumulated so far) instead of throwing — never a
  `budget_exhausted`-only failure caused by the synthesis charge alone.
- Enforce a **≥1-token floor** in `callCost`/`tryCharge` so no charge is ever 0 and no LLM call is
  free.
- Document the `estimateTokens` lower-bound caveat on `RlmOptions.budget` (doc-only, no behavior
  change).
- Tests pinning both behaviors (RED → GREEN).

### Out of scope (explicit)

- **#171** — signal-race / truncation parity of the same `llm_query` / downgrade / synthesis calls.
- **#168** — breadth backstop (cap on host-tool *invocation count* per iteration).
- **#184** — redact provider errors on the `llm_query` / downgraded-`rlm_query` paths (separate
  security issue, adjacent lines, not this run).
- **#170** — nested `inputs` forwarding.
- Any change to `budgetReport`, `SpendBudget`'s public shape, or the public `RlmResult` schema.

## Decisions

Continuing the repo's `D#` numbering (highest cited is D63). New decisions:

- **D64 — The synthesis pass charges the shared pool and degrades to salvage on refusal.** The final
  D44/D45 `llmClient.query` charges `callCost(...)` against the resolved `SpendBudget` before it
  runs (same accounting as every other charged path, D62). If `tryCharge` returns `false`, the run
  **salvages**: it returns the best answer accumulated up to that point (the last iteration's
  extracted answer) rather than running the synthesis query or throwing. This matches D4
  (degrades, never throws). When `budget` is omitted, the synthesis pass stays un-charged (D5
  unchanged).
- **D65 — A ≥1-token charge floor: no LLM call is ever free.** `callCost` (or, equivalently,
  `tryCharge`) enforces a minimum of 1 token so an empty `systemPrompt` + empty tool prompt still
  consumes budget. The floor applies uniformly to every charged path (top-level loop, `llm_query`,
  `rlm_query` downgrade, nested loops, synthesis) with no special-casing.
- **D66 (doc) — Document the `estimateTokens` lower-bound caveat on `RlmOptions.budget`.** A note on
  `RlmOptions.budget` states that `estimateTokens` is a deterministic lower bound (bytes ÷ 4) and
  under-counts non-ASCII/emoji/CJK up to ~1 token/byte; callers needing a hard real-token bound must
  apply their own margin for non-English content.

## Commands

```
Install:   npm ci
Test:      npm test                    # tsx --test test/*.test.ts
Build:     npm run build               # tsc -p tsconfig.build.json
Typecheck: npm run check               # tsc --noEmit
Lint:      npm run lint                # biome check --error-on-warnings
Coverage:  npm run coverage
```

## Project structure

```
src/rlm.ts          → the RLM loop; synthesis pass + charge sites + doc note live here
src/budget.ts       → SpendBudget + estimateTokens; the ≥1-token floor lands here (or in rlm.ts)
test/rlm.test.ts    → tests; extends the "runRlm() — spend budget" block
SPEC.md             → this document
tasks/plan.md       → implementation plan
tasks/todo.md       → task list
```

## Code style

Match `src/rlm.ts` conventions: decision-referencing comments (`// … (D64)`), the `FEEDBACK_`
naming discipline, bracketed lowercase-snake tool prompt strings, and refusal markers following the
same shape. No new dependencies; biome-formatted; 2-space; TS strict (`noUnusedLocals`,
`noUnusedParameters`).

## Testing strategy

TDD — RED first. Integration tests through the real sandbox (`runInSandbox` → Monty), mirroring the
existing "runRlm() — spend budget" block: `mockLlmCodeGen` records every `llmClient.query` call,
`recordedCost` mirrors the loop's charge, and `rlmRegistry()` returns an empty `ToolRegistry`
(runRlm self-registers its RLM tools, D51).

New/strengthened tests:

1. **Synthesis pass charges the pool** — a run that reaches the synthesis pass (no SUBMIT, so it
   runs to the iteration cap) and asserts `consumed` includes the synthesis call's cost; with a
   generous budget the synthesis answer is returned normally.
2. **Synthesis pass degrades to salvage on refusal** — budget sized to afford the iterations but not
   the synthesis call; assert the run returns the salvaged (pre-synthesis) answer, never throws, and
   the status is not a bare `budget_exhausted` caused by the synthesis charge.
3. **Zero-token free call is closed** — `systemPrompt: ""` + `llm_query("")` on a tight budget
   (1 token) still consumes budget and the second such call refuses (proving the floor); assert
   `consumed ≥ 1` per call and no 0-token charge is accepted.
4. **Omitting budget leaves every path un-charged** — existing no-budget regression test still
   passes (D5 unchanged).

## Boundaries

- **Always:** run `npm test`, `npm run check`, `npm run lint` before reporting done; follow D#/code
  style; pin refusal markers/floor behavior as literals in tests (D17 convention).
- **Ask first:** none — this run is autonomous; assumptions are recorded below.
- **Never:** absorb #171/#168/#184/#170 scope; change `budgetReport`/`SpendBudget`'s public shape or
  the public `RlmResult`; add dependencies; reorder unrelated code; leave the tree red between tasks.

## Success criteria

- [ ] The synthesis pass charges the shared pool; on refusal it degrades to salvage (never throws,
      never returns a bare synthesis-caused `budget_exhausted`).
- [ ] No LLM call is ever free: `callCost`/`tryCharge` enforces a ≥1-token floor, uniformly across
      every charged path.
- [ ] `RlmOptions.budget` documents the `estimateTokens` lower-bound caveat (D66).
- [ ] Both behaviors pinned by named tests (RED → GREEN).
- [ ] Full suite green; `tsc` clean; biome clean.

## Assumptions (recorded — no clarifying questions, autonomous run)

1. **Charge, don't document.** The issue offers "charge the synthesis pass … **or** document it as a
   one-call exception on `RlmResult.budget`". This run **charges** it — the stricter option that
   fully restores the "hard ceiling" guarantee. Rationale: documenting the exception would leave the
   ceiling semantically broken; the charge is a small, bounded change.
2. **"Salvage" = return the best answer accumulated so far.** On synthesis refusal, the run returns
   the last iteration's extracted answer (the answer the run would have produced without the
   synthesis refinement). It does **not** invent a new error status; it degrades in place (D4).
   The exact salvage plumbing (which accumulated value) is a plan/coder detail.
3. **The ≥1-token floor belongs in `callCost` (preferred) or `tryCharge`.** Either is acceptable so
   long as the floor is uniform and no special-casing is introduced. The plan will pin one.
4. **The floor is 1 token exactly** (not a larger constant) — the minimum needed to close the
   zero-token hole without distorting normal accounting.
5. **Doc note is doc-only.** D66 changes a JSDoc comment; it has no runtime behavior and needs no
   test (consistent with D2's existing doc note).
6. **No new public API.** Refusal/salvage behavior and the floor are internal; tests pin literals
   per D17.

## Open questions

None blocking.
