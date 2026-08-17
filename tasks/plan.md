# Implementation Plan: Cap `result.error` and the `question` in the RLM feedback loop (#144)

## Overview

`runRlm` (`src/rlm.ts`) shipped four feedback/conversation caps in #74 (D1–D6), but two message
paths remain unbounded: `buildFeedback` interpolates `result.error` raw on the `status === "error"`
path (`src/rlm.ts:313`), and `buildInitialPrompt` interpolates the `question` raw
(`src/rlm.ts:276`) into `messages[0]` — which `boundConversation` never drops, so a large question
lives in every query for the whole run. Both are routed through the already-imported shared
`truncateText` (`src/truncate.ts`) — no new truncation implementation, no `src/truncate.ts` edit.
The source of truth for *what* to build is `SPEC.md` decisions D7 and D8; this plan only sequences
them into three single-commit TDD tasks.

Out of scope and never touched: `src/truncate.ts`, `src/sandbox.ts`, `src/repl.ts`, `src/builtins.ts`,
`src/rlm_loop.ts`, `src/types.ts`, `coverage-baseline.json`.

## Architecture Decisions

- **Reuse, don't re-implement (D9, invariant 4).** Both new caps go through the one imported symbol
  `truncateText` from `./truncate.js` (already imported since #74). No byte measurement, no `Buffer`,
  no `byteLength` enters `src/rlm.ts`; `contentBytes` keeps using `TextEncoder` (docs Exception 3).
- **Error cap = value shape (D7).** A traceback is a single value identified by both ends (first
  frame + exception message), so `result.error` reuses `VALUE_HEAD_RATIO` (50/50) at
  `ERROR_MAX_BYTES = 16 * 1024` — the same budget as `output` — with a real recovery route
  (`ERROR_RECOVERY`: re-run under `try/except` and print the full traceback; the model owns the
  Python). Applied in `buildFeedback` on the `status === "error"` branch, before interpolation.
- **Question cap = value shape (D8).** The question is the user's query and is never dropped, so its
  budget bounds the worst case while leaving every realistic question untouched:
  `QUESTION_MAX_BYTES = 64 * 1024`, `VALUE_HEAD_RATIO`, and a deliberately weaker recovery clause
  (`QUESTION_RECOVERY`) because the question is **not** sandbox-accessible — the marker may not
  advertise a route that does not exist (policy Q3). Applied in `buildInitialPrompt` before the
  `# Question` header.
- **Budgets are module constants, not public options** (Assumption 5, unchanged from #74).
- **Under-budget is a marker-free no-op.** Both `truncateText` calls are no-ops for ordinary
  errors/questions, so the normal path is byte-identical to today (each test asserts this).
- **Determinism over timing.** Tests assert structure (section boundaries, marker presence, byte
  ceilings via `Buffer.byteLength` in the test file only), never wall-clock or race behaviour.

## Task List

### Phase 1: Cap `result.error` in `buildFeedback` (D7)

- [ ] **T1 — Cap `result.error` to 16 KiB via `truncateText` (D7) + test 8**

  **Objective:** Close the first uncapped path. Introduce `ERROR_MAX_BYTES = 16 * 1024` and
  `ERROR_RECOVERY = "Catch the exception and print the full traceback to see more."` as module
  constants in `src/rlm.ts`, then wrap `result.error` on the `status === "error"` branch of
  `buildFeedback` before interpolation:
  `const { text: error } = truncateText(result.error, { maxBytes: ERROR_MAX_BYTES, headRatio: VALUE_HEAD_RATIO, recovery: ERROR_RECOVERY });`
  and interpolate `error` (not `result.error`).

  **Scope (files):**
  - `src/rlm.ts` — two module constants + the `buildFeedback` error-branch interpolation site.
  - `test/rlm.test.ts` — test 8.

  **Dependencies:** None (`truncateText` and `VALUE_HEAD_RATIO` already imported).

  **Acceptance criteria (SPEC success criteria):**
  - A huge `result.error` cannot push any iteration's conversation over 256 KiB — the `Error: `
    feedback section is ≤ 16 KiB and carries the marker + `ERROR_RECOVERY` (success criterion 1).
  - A small `error` passes through marker-free (no `elided`), byte-identical to the pre-change shape
    (success criterion 3).

  **RED → GREEN test (test 8):**
  - **Over-budget:** `buildFeedback({ status: "error", error: "E".repeat(100 * 1024), stdout: "", stdoutTruncated: false, calls: [] })` — the section between the `Error: ` prefix and `\nstdout:` is
    ≤ 16 KiB (`Buffer.byteLength`), matches `/elided/`, and matches the recovery clause
    (`/traceback/`). **RED because** the source interpolates `result.error` raw → the section is
    ~100 KiB with no marker and no recovery clause.
  - **No-op:** `buildFeedback({ status: "error", error: "boom", errorKind: "syntax", stdout: "", stdoutTruncated: false, calls: [] })` starts with `Error: boom\n` and contains no `elided` marker.
    **RED because** (pre-fix) it already passes — this assertion is a regression guard, not the
    failing half; the over-budget half is what goes RED first.

  **Verify:** `npx tsx --test test/rlm.test.ts` (red → green); `npm test`; `npm run check`;
  `npm run build`; `npm run lint`.

### Phase 2: Cap the `question` in `buildInitialPrompt` (D8)

- [ ] **T2 — Cap the `question` to 64 KiB via `truncateText` (D8) + test 9**

  **Objective:** Close the second uncapped path. Introduce `QUESTION_MAX_BYTES = 64 * 1024` and
  `QUESTION_RECOVERY = "The question was truncated. Answer from the part shown and state the assumption if ambiguous."` as module constants in `src/rlm.ts`, then wrap the `question` in
  `buildInitialPrompt` before the `# Question` header:
  `const { text: q } = truncateText(question, { maxBytes: QUESTION_MAX_BYTES, headRatio: VALUE_HEAD_RATIO, recovery: QUESTION_RECOVERY });`
  and build `const parts = [\`# Question\n${q}\`];`.

  **Scope (files):**
  - `src/rlm.ts` — two module constants + the `buildInitialPrompt` question interpolation site.
  - `test/rlm.test.ts` — test 9.

  **Dependencies:** T1 (sequential — same two files; single-writer order).

  **Acceptance criteria (SPEC success criteria):**
  - A huge `question` cannot appear uncapped in `messages[0]` — the `# Question` section of the
    initial prompt is ≤ 64 KiB and carries the marker + `QUESTION_RECOVERY` (success criterion 2).
  - A normal `question` appears whole and marker-free in `messages[0]` (success criterion 3).

  **RED → GREEN test (test 9):**
  - **Over-budget:** `runRlm("Q".repeat(128 * 1024), { llmClient, registry, maxIterations: 5 })`
    (mock returns a single `SUBMIT`), then read `llm.calls()[0].messages[0].content`. The
    `# Question` section — from after `# Question\n` up to `\n# Context` (the default `context`
    input always renders a `# Context` header) — is ≤ 64 KiB, matches `/elided/`, and matches
    `/state the assumption/`. **RED because** the source interpolates the question raw → the section
    is ~128 KiB with no marker and no recovery clause.
  - **No-op:** `runRlm("what is the answer?", …)` → `messages[0].content` includes the whole
    question and contains no `elided` marker. Regression guard (passes pre-fix).

  **Verify:** `npx tsx --test test/rlm.test.ts` (red → green); `npm test`; `npm run check`;
  `npm run build`; `npm run lint`.

### Phase 3: Record the two new budgets in the truncation policy

- [ ] **T3 — Update `docs/truncation-policy.md` for the D7/D8 caps**

  **Objective:** Extend the implementation-record table with two rows (`buildFeedback` `error`
  16 KiB / 50/50 head+tail, `buildInitialPrompt` `question` 64 KiB / 50/50 head+tail, both #144),
  retire the "Truncating `error` / `errorKind`" non-goal line (the `error` half is now implemented;
  `errorKind` stays uncapped as a small bounded enum string), and add a short note under the #74
  additions paragraph recording the two new budgets and the deliberate weaker `question` recovery
  (the question is not sandbox-accessible, so its marker does not advertise a route it cannot honour
  — policy Q3).

  **Scope (files):**
  - `docs/truncation-policy.md` — implementation-record table + non-goal edit + one paragraph.

  **Dependencies:** T1, T2 (documents the implemented behaviour).

  **Acceptance criteria:** The two budgets and the `question` recovery rationale are recorded;
  the stale "`error` uncapped" non-goal no longer contradicts the code.

  **RED → GREEN tests:** none (documentation task; no code/test change).

  **Verify:** read-through against `src/rlm.ts`; `npm run lint`.

### Checkpoint: Complete

- [ ] All of T1–T3 done; `npm test`, `npm run check`, `npm run build`, `npm run lint`,
  `npm run coverage` all exit 0; mutation score does not regress.

## Definition of Done (whole flight, from SPEC success criteria)

1. An oversized `result.error` cannot push any iteration's conversation over 256 KiB — the
   `Error: ` feedback section is ≤ 16 KiB via `truncateText`, and the 256 KiB conversation bound is
   intact (test 8).
2. An oversized `question` cannot appear uncapped in `messages[0]` — the `# Question` section is
   ≤ 64 KiB via `truncateText` (test 9).
3. Both paths are RED→GREEN tested (tests 8 and 9), including the under-budget no-op.
4. `truncateText` remains the only truncation implementation (test 6 still passes; no
   `Buffer`/`byteLength` in `src/rlm.ts`).
5. `npm test`, `npm run check`, `npm run build`, `npm run lint`, `npm run coverage` exit 0;
   mutation score does not regress.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| The two new `truncateText` call sites fall below the `src/rlm.ts` 95.94% coverage floor | Med | Each task's test exercises both the over-budget (truncation) and under-budget (no-op) paths, so every new line is hit; do not hand-edit `coverage-baseline.json`. |
| Section-locating assertions break on a prompt-template wording change | Low | Locate the error section via the stable `Error: ` / `\nstdout:` boundaries and the question section via `# Question\n` / `\n# Context`; these are the same literals F-74's test 7 already couples to (recorded gotcha). |
| Double-truncation totals when a caller raises the sandbox cap above the feedback budget | Low | Inherited from #74 (SPEC open question 3); cosmetic, recorded. |
| Budget numbers are judgement, not live-model measurement | Low | Recorded in SPEC (open question 2); constants are easy to tune later. |

## Open Questions

- None blocking — the SPEC records its open questions (weaker `question` recovery, judgement-based
  budgets, double-truncation totals) and marks them fire-and-forget. Any unexpected divergence found
  during BUILD should be recorded in the ship report, not silently decided.

## Parallelization

- T1 → T2 → T3 is a strict sequence: T1 and T2 both touch `src/rlm.ts` and `test/rlm.test.ts`
  (single-writer order avoids conflicting edits), and T3 documents both. No two tasks run in
  parallel without touching the same files.
