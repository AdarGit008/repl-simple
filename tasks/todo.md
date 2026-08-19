# Todo — issue #78: Converge on runRlm and delete rlm_loop.ts

Source of truth: `SPEC.md` (D48–D60) + `tasks/plan.md`. Each task is RED-first (write the failing
test before the code) except T1/T2 (pure refactors — verify the existing suite stays green). One
coder per task, fresh context, one commit per task. After each task the full suite must be green.

- [ ] **T1 — Move RLM types into `rlm.ts` (D49)**
  - Move `LlmClient`, `RlmIteration`, `RlmOptions`, `RlmResult` (+ RLM-only `RlmBudgetReport`) from
    `src/types.ts` into `src/rlm.ts`; delete the `import type { ToolRegistry } from "./registry.js"`
    and `import type { SpendBudget } from "./budget.js"` inversion lines in `types.ts`.
  - Re-export the moved types from `src/index.ts` so no public import breaks.
  - Verify: `npm run check` + `npm run build` + `npm test` green.
  - Files: `src/types.ts`, `src/rlm.ts`, `src/index.ts` (no behaviour change).

- [ ] **T2 — Move `getReplPreamble` to `src/preamble.ts` (D55)**
  - Create `src/preamble.ts` with `getReplPreamble` (same `join(__dirname, "..", "repl", "repl_server.py")` path resolution); remove it from `src/rlm_loop.ts`; re-export from `src/index.ts`.
  - Add a coverage floor for `src/preamble.ts` via `npm run coverage:update` (keep `rlm_loop.ts` floor for now).
  - Verify: `npm run check` + `npm run build` + `npm test` green; coverage passes.
  - Files: `src/preamble.ts` (new), `src/rlm_loop.ts`, `src/index.ts`, `coverage-baseline.json`.

- [x] **T3 — `runRlm` self-registers RLM tools + collision guard + validation (D51)**
  - RED: test that `runRlm` throws when the caller's registry already has `llm_query`/`rlm_query`/`SUBMIT` (port `RLMLoop`'s message shape, prefix `runRlm:`).
  - Implement: `runRlm` builds its RLM tools via `createRLMTools` and merges them into the sandbox registry. `onLLMQuery` → `llmClient.query(systemPrompt, [{role:"user",content:prompt}], signal)`; `SUBMIT` as-is; `rlm_query` wired to a **placeholder** that downgrades to `llm_query` (real nesting lands in T4). Validate `maxIterations >= 1` and `maxDepth >= 0`.
  - **Flip the test helper:** redefine every `rlmRegistry()` to NOT pre-register RLM tools (empty or plain custom tools); fix each fallout test so the full suite is green (tests needing `llm_query` now control `options.llmClient`).
  - Verify: `npx tsx --test test/rlm.test.ts` green; full suite green; `npm run check`/`build` clean.
  - Files: `src/rlm.ts`, `test/rlm.test.ts`.

- [x] **T4 — Nesting, `maxDepth` downgrade, parent-context inheritance (D52)**
  - RED: fold the `rlm_loop` nesting cases — `rlm_query` spawns a nested `runRlm`; at `maxDepth` it downgrades to `llm_query`; default `depth` 0; nested + `llm_query` compose; and the child inherits the parent's context.
  - Implement: `RlmOptions.maxDepth?` (default 1) / `depth?` (default 0); `onRLMQuery` spawns nested `runRlm(query, { depth: depth+1, … })` and on nested `ok` returns its `answer`, else `[rlm_query error: <status>] …`; at `depth >= maxDepth` downgrade to `llm_query`. Child `context` = parent context merged with the explicit `rlm_query` context arg (parent-context inheritance).
  - Verify: `npx tsx --test test/rlm.test.ts` green; full suite green.
  - Files: `src/rlm.ts`, `test/rlm.test.ts`.

- [ ] **T5 — Registry-built prompt (D50)**
  - RED: test that the merged prompt **names every registered tool** (content assertion, not length).
  - Implement: port `RLMLoop.buildSystemPrompt` — render `registry.renderTypeStubs()` + `renderPythonToolRules(probeImportableModules())`, name `llm_query`/`rlm_query`/`SUBMIT`, and carry **verbatim** the F-77 fresh-sandbox wording and the D17 sentinel rule (both already in `DEFAULT_RLM_SYSTEM_PROMPT`). Update every template-coupled pinned literal in `test/rlm.test.ts` in the same commit (inventory in SPEC D50).
  - Verify: `npx tsx --test test/rlm.test.ts` green; full suite green.
  - Files: `src/rlm.ts`, `test/rlm.test.ts`.

- [ ] **T6 — `status:"error"` + `error?: string` (D53/D54)**
  - RED: test that a non-abort `llmClient.query` rejection returns `{ status:"error", error, answer, answerSource:"salvaged", iterations }`, not an exception.
  - Implement: add `"error"` to `RlmResult["status"]` and `error?: string`; catch the main-loop query throw (non-abort) and return the result; abort stays the `"aborted"` path.
  - Verify: `npx tsx --test test/rlm.test.ts` green; full suite green; `npm run check` clean.
  - Files: `src/rlm.ts`, `test/rlm.test.ts`.

- [ ] **T7 — Defaults: `maxIterations`→10, `scriptName`→`"rlm.py"` (D58)**
  - RED: test that omitting `maxIterations` yields 10 iterations (kills M1); test that `scriptName` defaults to `"rlm.py"` (kills M21).
  - Implement: pin both defaults if not already.
  - Verify: `npx tsx --test test/rlm.test.ts` green; full suite green.
  - Files: `src/rlm.ts`, `test/rlm.test.ts`.

- [ ] **T8 — Delete `rlm_loop.ts` + its test; fold stragglers; barrel + README + coverage (D56/D57/D59)**
  - Delete `src/rlm_loop.ts` and `test/rlm_loop.test.ts`; remove `RLMLoop`, `RLMLoopOptions`, `RLMLoopResult`, `RlmMessage` from `src/index.ts`.
  - Ensure every behaviour `rlm_loop.test.ts` covered lives on against `runRlm` (nesting/collision/prompt already in T3–T5; fold the F-77 `lineOffset` pair if not already covered by `runRlm`'s parallel describe). Add the status-branch tests (ok/max_iterations/budget_exhausted/aborted/error) if any is missing (SPEC Assumption 2).
  - Update `README.md` to document `runRlm` as the single entry point (drop `RLMLoop`).
  - Drop `src/rlm_loop.ts` from `coverage-baseline.json` (run `coverage:update` if needed).
  - Verify: `grep RLMLoop src/` empty; `npm test` + `npm run check` + `npm run build` + `npm run lint` clean; `npm run coverage` passes.
  - Files: delete `src/rlm_loop.ts`, `test/rlm_loop.test.ts`; `src/index.ts`, `test/rlm.test.ts`, `README.md`, `coverage-baseline.json`.

## Checkpoint (after T8)

- [ ] All seven issue tests pass; full suite green; check/build/lint clean; coverage floors met.

## DoD (from #78)

- [ ] `grep RLMLoop src/` returns nothing.
- [ ] `test/rlm_loop.test.ts`'s nesting/depth/collision/prompt cases live on and pass.
- [ ] M1 and M21 no longer survive; `rlm.ts` mutation score is no longer 0 of 9.
- [ ] The README documents one RLM entry point.
- [ ] Every `runRlm` status branch (`ok`/`max_iterations`/`budget_exhausted`/`aborted`/`error`) has a genuine test.
