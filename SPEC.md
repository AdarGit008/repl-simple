# Spec: Bound spend of `llm_query` / `rlm_query` / nested `runRlm` against the run budget — issue #165

## Objective

`RlmOptions.budget` currently charges only the **top-level iteration loop** of `runRlm`. Three LLM
paths escape the budget entirely:

1. `onLLMQuery` (`llm_query` from sandbox code) calls `llmClient.query` directly.
2. `onRLMQuery` (`rlm_query`) at the depth limit **downgrades** to a direct `llmClient.query`.
3. `onRLMQuery` below the depth limit spawns a nested `runRlm` that passes `budget: undefined`
   (D52), so the child loop's iterations are uncharged — and each child can itself call
   `llm_query` / `rlm_query`.

Impact: a caller setting `budget` to cap runaway cost gets **no protection against sandbox code
looping `llm_query` / `rlm_query`** — unbounded LLM spend / cost-DoS. Recursion depth is bounded
(`maxDepth`), breadth is not.

This change threads **one `SpendBudget` pool through the whole tree**: every tool-mediated LLM call
and every nested loop charges the same pool, so a configured budget is a hard ceiling on total tree
spend. When a tool-mediated call cannot charge, it degrades to a marker string (never throws),
matching the existing D4 "degrades instead of throwing" semantics.

## Current state (fact base — verified against HEAD `ed94e84`)

- **`src/budget.ts`** — `SpendBudget` class (`limit`, `consumed`, `remaining`, `tryCharge(tokens)`)
  and `estimateTokens` (UTF-8 bytes ÷ 4). Already shared-mutable: "Siblings that pass the same
  instance compete for one pool". This is the seam to reuse — no new abstraction.
- **`src/rlm.ts:78-85`** — `RlmOptions.budget?: number | SpendBudget` (a `number` mints a fresh
  per-run pool; an instance is shared/mutated in place; omitted → no budget logic, D5).
- **`src/rlm.ts:~1110-1115`** — budget minting: `const budget = options.budget instanceof SpendBudget
  ? options.budget : options.budget !== undefined ? new SpendBudget(options.budget) : undefined;`
- **`src/rlm.ts:~1120`** — `const systemPromptTokens = estimateTokens(systemPrompt);` (precomputed
  once; `systemPrompt` is a `let` declared at the top of `runRlm` and resolved after the registry is
  built, D50).
- **`src/rlm.ts:854-862`** — `callCost(systemPromptTokens, messages)` = `systemPromptTokens +
  Σ estimateTokens(message.content)`.
- **`src/rlm.ts:869-875`** — `budgetReport(budget, limited)` returns `{limit, consumed, limited}`
  or `undefined`.
- **`src/rlm.ts:1043-1044`** — `onLLMQuery` calls `llmClient.query(systemPrompt, [{role:"user",
  content: prompt}], options.signal)` with **no charge**.
- **`src/rlm.ts:1045-1096`** — `onRLMQuery`:
  - downgrade branch (`depth >= maxDepth`, `:1051-1069`) calls `llmClient.query(...)` with **no
    charge**;
  - nested branch (`:1072-1091`) calls `runRlm(query, {... budget: undefined ...})` with the D52
    comment "The child is bounded by maxIterations/maxDepth, not the parent's spend pool".
- **`src/rlm.ts:~1154`** — top-level charge inside `for (let i = 0; i < maxIterations; i++)`:
  `const cost = callCost(systemPromptTokens, messages); if (!budget.tryCharge(cost)) return
  {status:"budget_exhausted", ...}`.
- **`src/rlm.ts` (D44/D45)** — the final synthesis `llmClient.query` after the cap is **deliberately
  un-charged** ("one guarded, un-charged synthesis pass").

## Scope

### In scope

- Charge `onLLMQuery` (`llm_query`) against the resolved budget **before** the call.
- Charge the `onRLMQuery` **downgrade** branch against the resolved budget **before** the call.
- Thread the resolved budget into the nested `runRlm` (replace `budget: undefined` with the shared
  instance) so the child loop competes for the same pool.
- Degrade refused tool calls to a deterministic marker string (never throw).
- Update the now-stale D52 comment about nested spend.
- Tests proving each path (RED → GREEN).

### Out of scope (explicit)

- **#171** — signal-race / truncation parity of the same `llm_query` / downgrade / synthesis calls.
- **#168** — breadth backstop (cap on host-tool *invocation count* per iteration).
- **#170** — nested `inputs` forwarding.
- The final **synthesis pass** (D44/D45) stays un-charged — see Assumption 3 / residual risk.
- Any change to `budgetReport`, `SpendBudget`, or the public `RlmResult` shape.

## Decisions

Continuing the repo's `D#` decision numbering (highest cited in `src/` is D53; #78's spec used up to
D60). New decisions:

- **D61 — One shared `SpendBudget` pool through the whole tree.** The single resolved `budget`
  (`SpendBudget | undefined`) is threaded into the `onLLMQuery` and `onRLMQuery` closures and passed
  to nested `runRlm` instead of `undefined`. Every LLM call in the tree — top-level iteration,
  `llm_query`, `rlm_query` downgrade, and every nested loop's iterations — charges the same pool.
  When `budget` is absent, every path stays budget-free (unchanged, D5).

- **D62 — Tool-mediated calls charge at the same per-call cost, before they run.** The cost of a
  single tool-mediated call is `callCost(systemPromptTokens, [{role:"user", content}])` — the shared
  system prompt plus that call's one user message — reusing the existing `callCost` helper so the
  accounting is identical to the top-level loop. `llm_query` charges `prompt`; the `rlm_query`
  downgrade charges the downgrade message content.

- **D63 — A tool call that cannot charge degrades to a marker string, never throws.** Matching D4,
  when `tryCharge` returns `false` the tool returns a deterministic refusal string instead of
  calling the LLM:
  - `llm_query` → `"[llm_query refused: spend budget exhausted]"`
  - `rlm_query` downgrade → `"[rlm_query refused: spend budget exhausted]"`
  Sandbox code sees the string as the tool's return value. The loop then stops at the next iteration
  boundary when its own top-level charge fails (`status: "budget_exhausted"`). A nested loop reports
  exhaustion through its own `budget_exhausted` status, which the parent's existing
  `[rlm_query error: …]` branch already surfaces.

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
src/rlm.ts          → the RLM loop; the three uncharged paths live here
src/budget.ts       → SpendBudget + estimateTokens (unchanged)
test/rlm.test.ts    → tests; extends the "runRlm() — spend budget" block
SPEC.md             → this document
tasks/plan.md       → implementation plan
tasks/todo.md       → task list
```

## Code style

Match `src/rlm.ts` conventions: decision-referencing comments (`// … (D61)`), the `FEEDBACK_`
naming discipline, and bracketed lowercase-snake-tool prompt strings (`[rlm_query error: …]`,
`[rlm_query downgraded at max depth N]`). Refusal markers follow the same shape. No new
dependencies; biome-formatted; 2-space; TS strict (`noUnusedLocals`, `noUnusedParameters`).

## Testing strategy

TDD — RED first. Integration tests through the real sandbox (`runInSandbox` → Monty), mirroring the
existing "runRlm() — spend budget" and "runRlm() — nested rlm_query" blocks: `mockLlmCodeGen`
records every `llmClient.query` call, `recordedCost` mirrors the loop's charge, and `rlmRegistry()`
returns an empty `ToolRegistry` (runRlm self-registers its RLM tools, D51). Use SUBMIT-terminated
runs (status `"ok"`) so the un-charged synthesis pass never fires.

New tests (in a new describe block, or extending the existing "spend budget" block):

1. **`llm_query` charges the shared pool** — generous budget; code `answer = llm_query("…")` then
   `SUBMIT(answer)`; assert `result.budget.consumed === Σ recordedCost(call)` over **all** recorded
   calls (top-level code-gen + the `llm_query` call).
2. **`llm_query` refuses instead of throwing when the pool cannot afford it** — budget sized to the
   first code-gen call only; code calls `llm_query(...)`; assert the answer/stdout carries the
   refusal marker, no throw, and the run terminates `budget_exhausted` (or surfaces the marker).
3. **`rlm_query` downgrade charges the shared pool** — `maxDepth:1, depth:1` so it downgrades;
   generous budget; assert `consumed` includes the downgrade call's cost.
4. **`rlm_query` downgrade refuses instead of throwing** — tight budget; assert the refusal marker.
5. **nested `rlm_query` shares the parent's pool** — a nested spawn; pool sized so the parent's
   code-gen + the child's first code-gen fit but the child's second iteration does not; assert the
   child returns `budget_exhausted`, surfaced as `[rlm_query error: budget_exhausted]` in the
   parent's answer, and the parent's `budget.consumed` reflects the child's spend.
6. **omitting budget leaves every path uncharged** — existing test 5 still passes (no regression).

## Boundaries

- **Always:** run `npm test`, `npm run check`, `npm run lint` before reporting done; follow D#/code
  style; pin refusal markers as literals in tests (D17 convention).
- **Ask first:** none — this run is autonomous; assumptions are recorded below.
- **Never:** absorb #171/#168/#170 scope; change `budgetReport`/`SpendBudget`/public `RlmResult`;
  add dependencies; reorder unrelated code; leave the tree red between tasks.

## Success criteria

- [ ] `llm_query`, `rlm_query` downgrade, and nested `runRlm` all charge the single shared
      `SpendBudget` pool.
- [ ] A refused tool call returns its marker string and never throws or calls the LLM.
- [ ] A configured budget is a hard ceiling on **total tree** spend (nested loops compete for the
      parent's pool).
- [ ] Omitting `budget` leaves all paths budget-free (no regression).
- [ ] Full suite green; `tsc` clean; biome clean.

## Assumptions (recorded — no clarifying questions, autonomous run)

1. "Charge every tool-mediated call" means charge **before** the call (D4's before-the-call charge),
   not after.
2. "Degrade instead of throw" (D4) extends to tool calls: a refused call returns a marker string,
   which matches the tools' string-returning contract.
3. The final **synthesis pass** (D44/D45) is out of scope — the issue names only `llm_query` /
   `rlm_query` / nested. It remains a single un-charged call at the cap. *Recorded as residual risk
   for the issue-monitor to recommend filing.*
4. The cost model for a tool-mediated call is the shared system prompt + the single user message,
   reusing `callCost` — no new token accounting.
5. "Thread one pool through the tree" means: pass the **resolved** `SpendBudget` instance (whatever
   form the caller supplied) to nested loops, and charge tool calls against it. Absent budget → no
   charging anywhere.
6. No new public API; refusal strings are private module constants (tests pin literals, per D17).

## Open questions

None blocking.
