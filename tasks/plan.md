# Implementation Plan: Bound message growth in the RLM feedback loop (#74)

## Overview

`runRlm` (`src/rlm.ts`) accumulates a conversation of `messages` that grows by two entries per
iteration with no total ceiling, and `buildFeedback` re-interpolates sandbox `stdout`/`output` with
no budget of its own. This plan orders the work in `SPEC.md` into four single-commit tasks, each a
RED → GREEN TDD cycle, so every task lands on a green, type-checked, build-clean tree. The source of
truth for *what* to build is `SPEC.md` decisions D0–D6; this plan only sequences them and states the
per-task acceptance and tests.

Out of scope and never touched: `src/truncate.ts`, `src/sandbox.ts`, `src/repl.ts`, `src/builtins.ts`,
`src/rlm_loop.ts`, `src/types.ts`, `coverage-baseline.json`.

## Architecture Decisions

- **Reuse, don't re-implement (D1, invariant 4).** `buildFeedback` imports the existing `truncateText`
  symbol from `./truncate.js` — the same symbol `sandbox.ts` imports — with feedback budgets equal to
  the policy budgets (`FEEDBACK_STDOUT_MAX_BYTES = STDOUT_MAX_BYTES = 32 KiB`,
  `FEEDBACK_OUTPUT_MAX_BYTES = OUTPUT_MAX_BYTES = 16 KiB`). The normal path is a marker-free no-op
  because the sandbox already cut at these values; a raised `runOptions.maxStdoutBytes` /
  `maxOutputBytes` no longer flows through to the model.
- **Bound the conversation by dropping whole turns, not by summarising (D2–D4).** The `messages` array
  is bounded at `MAX_CONVERSATION_BYTES = 256 KiB` measured with `Buffer.byteLength` over
  `messages[].content`. Keep the initial user message plus the newest turns; drop the oldest middle
  turns in whole assistant+feedback pairs (a feedback never dangles without its assistant message).
  The initial message is never dropped. A single over-budget LLM reply is kept and allowed to exceed
  the budget transiently (Assumption 4). Dropping emits a pi-style marker message so the model knows
  history is partial (D3). Summarisation is explicitly deferred (D4).
- **Budgets are module constants, not public options (Assumption 5).** No new `RlmOptions`/`types.ts`
  surface; `src/types.ts` stays untouched.
- **Aggregate input cap is a flat head+tail cut (D6).** `buildInitialPrompt` keeps its per-value 5000-char
  preview but passes the rendered input section through `truncateText` with
  `INPUT_PREVIEW_MAX_BYTES = 32 KiB`, `VALUE_HEAD_RATIO`, and an input-naming recovery clause.
- **Determinism over timing.** All tests assert structure (message roles/order, marker presence,
  byte ceilings via `Buffer.byteLength`), never wall-clock or race behaviour — the suite recently
  fought mutation flakiness and must stay deterministic.

## Task List

### Phase 1: Feedback caps (D1)

- [ ] **T1 — Cap `buildFeedback` `stdout`/`output` via `truncateText` (D1) + tests 2, 3, 6**

  **Objective:** Make the feedback message bounded independently of the sandbox caps, using the shared
  helper. Introduce `FEEDBACK_STDOUT_MAX_BYTES = STDOUT_MAX_BYTES` and
  `FEEDBACK_OUTPUT_MAX_BYTES = OUTPUT_MAX_BYTES` as module constants in `src/rlm.ts`; import
  `truncateText` and the existing shape constants (`STDOUT_HEAD_RATIO`, `STDOUT_RECOVERY`,
  `VALUE_HEAD_RATIO`, `VALUE_RECOVERY`) from `./truncate.js`; wrap `result.stdout` and
  `result.output` in `buildFeedback`. `result.error` stays uncapped (policy non-goal).

  **Scope (files):**
  - `src/rlm.ts` — import, two module constants, `buildFeedback` interpolation sites.
  - `test/rlm.test.ts` — tests 2, 3, 6.

  **Dependencies:** None.

  **Acceptance criteria (SPEC success criteria):**
  - `buildFeedback` caps `stdout` ≤ 32 KiB and `output` ≤ 16 KiB via `truncateText`, independent of the
    sandbox caps (success criterion 3).
  - Exactly one truncation implementation is used by `rlm.ts` (success criterion 6).

  **RED → GREEN tests:**
  - **Test 2 (RED):** `buildFeedback` with a synthetic `RunResult` whose `output` is huge returns a
    feedback string whose `Output:` section is ≤ 16 KiB and carries the policy marker — assert the
    marker text, not merely the ceiling.
  - **Test 3 (RED):** `buildFeedback` with a synthetic `RunResult` whose `stdout` is huge yields a
    `stdout:` section ≤ 32 KiB even though the sandbox passed more (assert via a raised
    `runOptions.maxStdoutBytes` path or a synthetic `RunResult`).
  - **Test 6 (RED):** source-level check that `rlm.ts` imports `truncateText` from `./truncate.js`
    (the same symbol `sandbox.ts` uses) and defines no hand-rolled truncation.

  **Verify:** `npx tsx --test test/rlm.test.ts` (red → green); `npm test`; `npm run check`;
  `npm run build`; `npm run lint`.

### Phase 2: Conversation bound + drop notice (D2–D3)

- [ ] **T2 — Bound `messages` to 256 KiB, drop oldest whole turns, emit marker (D2–D3) + tests 1, 4, 5**

  **Objective:** Bound cumulative conversation growth. Introduce `MAX_CONVERSATION_BYTES = 256 * 1024`.
  After each push of an assistant+feedback pair, if total `Buffer.byteLength` of `messages[].content`
  exceeds the budget, drop the oldest middle turns in whole pairs (keeping `messages[0]` and the newest
  pair) and emit the D3 marker message (user role, pi-style ellipsis vocabulary) that states what was
  dropped and why. The marker counts toward the budget. A single over-budget reply is kept and allowed
  to exceed the budget transiently (Assumption 4).

  **Scope (files):**
  - `src/rlm.ts` — `MAX_CONVERSATION_BYTES` constant, drop loop, marker constant, integration into the
    iteration append site.
  - `test/rlm.test.ts` — tests 1, 4, 5.

  **Dependencies:** T1 (the reproduction's feedback must already be capped before the 256 KiB bound can
  be meaningfully asserted).

  **Acceptance criteria (SPEC success criteria):**
  - The 1.57 MB reproduction stays bounded (success criteria 1, 2).
  - The conversation-bounding strategy — keep first + last N, drop oldest turns whole — is asserted at
    the boundary (success criterion 4).
  - The model is told when history was dropped (success criterion 5).

  **RED → GREEN tests:**
  - **Test 1 (RED):** four iterations each printing 300 KB (→ ≤32 KiB `stdout` + ≤16 KiB `output` per
    run under default caps) keep the total conversation bytes passed to `llmClient.query` under
    `MAX_CONVERSATION_BYTES` (regression target: no call's total messages exceed 256 KiB; 1.57 MB
    cannot recur).
  - **Test 4 (RED):** enough iterations (or large-enough feedback) to cross 256 KiB → the messages sent
    to the LLM drop the oldest middle turns in whole pairs, keep the initial message and the newest
    turns, and total ≤ budget.
  - **Test 5 (RED):** after a drop, the messages contain the history-dropped marker (D3) and no dangling
    feedback (pairs dropped whole).

  **Verify:** `npx tsx --test test/rlm.test.ts` (red → green); `npm test`; `npm run check`;
  `npm run build`; `npm run lint`.

### Phase 3: Aggregate input cap (D6)

- [ ] **T3 — Cap the initial-prompt input section to 32 KiB (D6) + test 7**

  **Objective:** Close the #72 deferral: `buildInitialPrompt` keeps its per-value 5000-char head/tail
  preview but bounds the aggregate rendered input section. Introduce
  `INPUT_PREVIEW_MAX_BYTES = 32 * 1024` and pass the assembled input section through `truncateText`
  with `VALUE_HEAD_RATIO` and a recovery clause that names the input and says to slice it in Python.

  **Scope (files):**
  - `src/rlm.ts` — `INPUT_PREVIEW_MAX_BYTES` constant + `buildInitialPrompt` aggregate cap.
  - `test/rlm.test.ts` — test 7.

  **Dependencies:** T1 (the `truncateText` import and pattern are already in place); independent of T2.

  **Acceptance criteria (SPEC success criteria):**
  - The D6 aggregate test exists and passes (success criterion 1).
  - `runRlm` with several large inputs produces an initial message whose input-preview section is
    ≤ `INPUT_PREVIEW_MAX_BYTES` (testing strategy item 7).

  **RED → GREEN tests:**
  - **Test 7 (RED):** `runRlm` (or `buildInitialPrompt` via `runRlm`'s recorded initial message) with
    several large inputs produces an initial message whose input-preview section is
    ≤ `INPUT_PREVIEW_MAX_BYTES`.

  **Verify:** `npx tsx --test test/rlm.test.ts` (red → green); `npm test`; `npm run check`;
  `npm run build`; `npm run lint`.

### Phase 4: Document the budgets and strategy

- [ ] **T4 — Record feedback/conversation budgets + history-bounding strategy in `docs/truncation-policy.md`**

  **Objective:** Add implementation-record rows for the RLM feedback budgets (32 KiB `stdout`,
  16 KiB `output`, via the shared helper), the 256 KiB conversation budget with keep-first+last-N /
  drop-oldest-whole-turns strategy, and the 32 KiB aggregate input cap. Record the D4 trade-off
  (no summarisation, why) and the recorded edges (single over-budget reply kept; `error` uncapped).

  **Scope (files):**
  - `docs/truncation-policy.md` — implementation-record table + strategy note.

  **Dependencies:** T1–T3 (documents the implemented behaviour).

  **Acceptance criteria (SPEC success criteria):**
  - The chosen history-bounding strategy and its trade-off are documented (success criterion 4).

  **RED → GREEN tests:** none (documentation task; no code/test change).

  **Verify:** read-through against `src/rlm.ts`; `npm run lint`.

### Checkpoint: Complete

- [ ] All of T1–T4 done; `npm test`, `npm run check`, `npm run build`, `npm run lint`,
  `npm run coverage` all exit 0; mutation score does not regress.

## Definition of Done (whole flight, from SPEC success criteria)

1. All five issue tests (plus the D6 aggregate test) exist and pass; tests 1–5 are red before their
   fix where applicable.
2. The 1.57 MB reproduction stays bounded: 4 iterations of a 300 KB print never exceed 256 KiB of
   total conversation, and 10 iterations trigger the drop, not unbounded growth.
3. `buildFeedback` caps `stdout` ≤ 32 KiB and `output` ≤ 16 KiB via `truncateText`, independent of the
   sandbox caps.
4. The conversation-bounding strategy (keep first + last N, drop oldest turns whole) is asserted at
   the boundary and documented with its trade-off in `docs/truncation-policy.md`.
5. The model is told when history was dropped (D3 marker present).
6. Exactly one truncation implementation is used by `rlm.ts`, `repl.ts` and `sandbox.ts` (verified by
   construction, not by duplicated behaviour).
7. `npm test`, `npm run check`, `npm run build`, `npm run lint`, `npm run coverage` exit 0; mutation
   score does not regress.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| New branches (feedback caps, drop loop, notice, aggregate cap) fall below the `src/rlm.ts` 95.94% coverage floor | High | Each task's tests exercise both truncation paths (over/under budget) and both the drop and no-drop paths; do not hand-edit `coverage-baseline.json`. |
| Determinism/mutation flakiness in the RLM loop tests | Med | Assert structure (roles, order, marker text, `Buffer.byteLength` ceilings), never timing; reuse the existing `mockLlmCodeGen` + real `ToolRegistry` pattern. |
| Double-truncation totals when a caller raises the sandbox cap above the feedback budget | Low | Recorded in SPEC (open question 1); cosmetic, not a correctness failure. |
| A single over-budget LLM reply transiently exceeds 256 KiB | Med | Accepted per Assumption 4; documented; residual risk until summarisation lands. |
| Budget numbers are judgement, not live-model measurement | Low | Recorded in SPEC (open question 3); constants are easy to tune later. |

## Open Questions

- None blocking — the SPEC records its open questions (double-truncation totals, over-budget LLM
  reply, judgement-based budget numbers, uncapped `error`) and marks them fire-and-forget. Any
  unexpected divergence found during BUILD should be recorded in the ship report, not silently decided.

## Parallelization

- T1 → T2 → T3 → T4 is a strict sequence: T2 depends on T1's feedback caps (test 1 measures the
  bound over capped feedback), T3 reuses T1's `truncateText` import pattern, and T4 documents all of
  them. All four tasks touch `src/rlm.ts`/`test/rlm.test.ts` (T4 only docs), so no two tasks run in
  parallel without conflicting edits.
