# Plan — issue #75: abort returns what it completed

Branch `issue-75-abort-iterations` from `main` @ `8529f24`. Flight pattern: DEFINE (SPEC D30–D35,
done) → BUILD (T1–T5, RED-first) → VERIFY (T6) → REVIEW → SHIP. Single writer, strict sequence.

## Architecture decisions

- **Return, never throw** (D30): an aborted `runRlm` produces a first-class `RlmResult`, not an
  exception — restoring `rlm_loop.ts`'s old contract.
- **Salvage is the existing `extractBestAnswer`** (D31): no new answer string; #76's provenance work
  is untouched.
- **Signal flows to the client** (D32): the loop races as a safety net, but cancellation is the
  client's job, so a well-behaved client stops being billed.
- **The listener leak is fixed at its root** in `sandbox.ts` (D33), not papered over in `rlm.ts`.
- **One post-run check covers every mid-iteration abort** (D34), so the abort matrix is exhaustive
  with two sites (loop-top + post-run) plus the query catch.

## Task list

### Phase 1 — RED (tests first, all fail at HEAD)

- [ ] **T1 — Write the six tests red**

  **Description:** Flip 5.3.10 to assert resolution; add issue tests A–E. `mockLlmCodeGen`
  (`test/rlm.test.ts:303`) gains a `signal` param it records.

  **Acceptance criteria:**
  - [ ] 5.3.10 asserts `status:"aborted"`, `iterations.length === 1`, no rejection.
  - [ ] A: abort at iteration 2 of 5 → `"aborted"`, 2 iterations. (kills M2)
  - [ ] B: iteration 0 `x = 42` → abort → `answer === "42"`.
  - [ ] C: 8 iterations → 0 abort listeners (instance spy; signal never fires).
  - [ ] D: `query` receives the signal; a signal-honouring client is observed cancelling.
  - [ ] E: mid-run abort surfaces a partial `errorKind:"aborted"` iteration; run returns `"aborted"`.

  **Verification:** `npx tsx --test test/rlm.test.ts` → all six **fail** (RED), nothing else broke.

  **Files:** `test/rlm.test.ts`.

  **Scope:** S.

### Phase 2 — BUILD (green)

- [ ] **T2 — D30/D31: return aborted (loop-top + query catch), status union**

  `src/rlm.ts`: local `aborted()` builder; loop-top `return aborted()`; wrap the query in try/catch
  (`isAbortError` per D35). `src/types.ts`: add `"aborted"` to `RlmResult.status`, update JSDoc.

  **Verify:** A, B, flip 5.3.10 green; `npm run check`.

- [ ] **T3 — D32: `LlmClient.query` signal param + pass-through**

  `src/types.ts` + `src/rlm.ts` query call pass `options.signal`. Update mock to record it.

  **Verify:** D green; `npm run check`; `test/types.test.ts` unchanged and green (assignability).

- [ ] **T4 — D33: fix the `runInSandbox` listener leak**

  `src/sandbox.ts` (~1180-1186): wrap in `finally` removing `onAbort` when a signal was attached.
  Mirror `withHostDeadline`'s comment discipline.

  **Verify:** C green; `npx tsx --test test/sandbox.test.ts` green (abort path unchanged).

- [ ] **T5 — D34: mid-run abort surfaces the partial iteration**

  `src/rlm.ts`: post-run `if (options.signal?.aborted) return aborted();` between iteration record
  and SUBMIT check.

  **Verify:** E green; full `npm test`.

### Checkpoint: after T1–T5
- [ ] All six tests green; `npm test` green ×2 deterministic; `npm run check` + `npm run build` +
      `npm run lint` green; `npm run coverage` green (rlm.ts ≥ 97.69, sandbox.ts ≥ 97.65).

### Phase 3 — VERIFY / REVIEW / SHIP

- [ ] **T6 — VERIFY + bounded mutation sweep**

  Bounded sweep over the changed sites; assert **M2 dead** and no regression vs. #145/#144 baseline.

  **Verify:** `npm run mutation` (or the bounded-sweep variant per docs/mutation-testing.md).

- [ ] **T7 — REVIEW + SHIP**

  `tasks/review.md` (five-axis, code-reviewer persona) → `tasks/ship-report.md`. Flag the `LlmClient`
  interface change on #78 (issue comment). Mark #75 DoD boxes in the closing comment.

## Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `resumeSuspended`'s identical leak left unfixed | Med | Out of scope by decision (D33); flagged to #150/#33 — recorded, not silently ignored |
| Mid-run-abort test hangs on a non-yielding Python loop | Med | `withHostDeadline` 250 ms grace race bounds it (Assumption 5); snippet chosen for < 1 s |
| `LlmClient.query` change breaks embedder types | Low | Param is optional; fewer-arg implementations stay assignable (verified at `check`) |
| Coverage floor dips from the new branches | Low | Every branch is exercised by its test; floors never hand-edited |
| Mutation sweep flags the now-unreachable `buildFeedback` `aborted` branch | Low | Recorded (Open question 4); don't widen the sweep beyond changed sites |

## Open questions

- Abort-wins-over-SUBMIT ordering (Assumption 1) — reversible one-liner if a human prefers `"ok"`.
