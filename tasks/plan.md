# Implementation Plan: issue #78 — Converge on `runRlm` and delete `rlm_loop.ts`

Source of truth: `SPEC.md` (decisions D48–D60). This plan decomposes the spec into 8
dependency-ordered tasks. Flight pattern: DEFINE (done) → BUILD (T1–T8, RED-first) → VERIFY
(test-engineer) → REVIEW (code-reviewer) → SHIP (security-auditor). Single writer, one coder per
task, one commit per task.

## Overview

Make `runRlm` (`src/rlm.ts`) the single RLM implementation and delete `rlm_loop.ts` (`RLMLoop`),
folding in the capabilities only `RLMLoop` had: registry-built prompt, self-registered RLM tools with
a name-collision guard, nesting with `maxDepth` downgrade, and `status:"error"`. The public import
surface for `runRlm`/`LlmClient`/`RlmResult`/… is preserved; `RLMLoop` and its types are removed.

## Architecture decisions (see SPEC D48–D60)

- **D48** `runRlm` is canonical; `rlm_loop.ts` deleted (no deprecation shim).
- **D49** RLM types (`LlmClient`, `RlmIteration`, `RlmOptions`, `RlmResult`) move from `types.ts`
  into `rlm.ts`; the `types.ts → registry.js`/`budget.js` type-only inversion is removed; re-export
  from `index.ts` unchanged.
- **D51** `runRlm` **self-registers** its RLM tools (`llm_query` → `llmClient`, `rlm_query` → nested
  `runRlm`/downgrade, `SUBMIT`) via `createRLMTools`, merges them into the sandbox registry, and
  **throws** on a name collision with the caller's registry (port of `RLMLoop`'s constructor check).
- **D50** the merged system prompt is **registry-built** (stubs + python-tool rules) and carries the
  F-77 fresh-sandbox wording and the D17 sentinel rule **verbatim**, naming all three RLM tools.
- **D52** nesting: `maxDepth?` (default 1) / `depth?` (default 0); at the limit `rlm_query` downgrades
  to `llm_query`; otherwise it spawns a nested `runRlm`; the child **inherits the parent's context**.
- **D53/D54** `status:"error"` + `error?: string` return an `llmClient` throw as a result; keep
  `answerSource` verbatim (D41).
- **D55** `getReplPreamble` → `src/preamble.ts` (same `repl/repl_server.py` path resolution).
- **D56/D57/D59** delete `rlm_loop.ts` + its test, fold the unique cases into `rlm.test.ts`, update
  the barrel and README; no further rename.
- **D58** defaults pin behaviour: `maxIterations`→10 (M1), `scriptName`→`"rlm.py"` (M21).

## Task list

### Phase 1 — Foundation (refactors, no behaviour change)

- [ ] **T1 — Move RLM types into `rlm.ts` (D49).** Pure move + barrel re-export.
- [ ] **T2 — Move `getReplPreamble` to `src/preamble.ts` (D55).** Pure move + barrel + coverage floor.

**Checkpoint after T1–T2:** `npm test` + `npm run check` + `npm run build` green.

### Phase 2 — Core convergence (behaviour)

- [ ] **T3 — `runRlm` self-registers RLM tools + collision guard + option validation (D51).**
  The "flip": caller registry must no longer pre-register `llm_query`/`rlm_query`/`SUBMIT`.
- [ ] **T4 — Nesting, `maxDepth` downgrade, parent-context inheritance (D52).**
- [ ] **T5 — Registry-built prompt (D50).** Carries F-77 + D17 + tool naming; update template-coupled literals.
- [ ] **T6 — `status:"error"` + `error?: string` (D53/D54).**
- [ ] **T7 — Defaults: `maxIterations`→10, `scriptName`→`"rlm.py"` (D58).**

**Checkpoint after T3–T7:** all seven issue tests green; full suite green.

### Phase 3 — Removal (deletion + docs)

- [ ] **T8 — Delete `rlm_loop.ts` + its test; fold stragglers; barrel + README + coverage (D56/D57/D59).**

**Checkpoint after T8:** `grep RLMLoop src/` empty; `npm test`/`check`/`build`/`lint` clean; coverage
floors met.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **T3 flips the registry contract** — ~110 `runRlm` invocations pass `rlmRegistry()` (which pre-registers RLM tools) | High | Redefine the `rlmRegistry()` helper (empty/plain registry) in the SAME task; fix each fallout test so the suite is green before commit |
| **T5 template-coupling** — prompt rewording breaks pinned literals (`256.0KB`, `# Question`, `# Input (…)`, sentinels, D27 sentences, F-77 wording) | High | Update every pinned literal in the same commit (inventory in SPEC D50); run `test/rlm.test.ts` focused first |
| **T8 deletion** — removing a public type (`RlmMessage`, `RLMLoop*`) and a coverage floor | Med | Barrel + README updated in the same task; drop `src/rlm_loop.ts` from `coverage-baseline.json`; `coverage:update` for `preamble.ts` |
| **`answerSource`/`status` regressions** across T3–T6 | Med | Property-style tests already pin every `answerSource`; add status-branch tests (SPEC D60) |
| **Mutation baseline stale** (predates 0.0.21) | Low | Treat absolute scores as directional; concrete kills are M1/M21 (T7 tests) |

## Open questions

None requiring human input — all resolved as recorded assumptions (SPEC "Assumptions" 1–7). The
flagged follow-ups (RlmStep/RlmProgressEvent, question-as-input, residual repl/rlm naming) go to the
issue-monitor final report.
