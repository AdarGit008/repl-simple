# Implementation Plan: issue #195 — early-return the synthesis pass on an already-aborted signal

## Overview

One control-flow guard in `src/rlm.ts`'s synthesis pass: when `options.signal?.aborted` is already
true at the pass (after the loop), return a salvaged result before the charge and before the provider
call. Today the `llmClient.query(...)` promise is constructed as the argument to `raceAgainstSignal`,
so an already-aborted run still calls the provider and charges the budget for a synthesis whose
result is discarded. The fix mirrors the D64 budget-refusal branch already in the function.

## Architecture Decisions (SPEC D1–D4, not restated)

- **D1/D2/D3** — early return; reuse `max_iterations`/`salvaged`; budget reported uncharged.
- **D4** — RED first, then the minimal guard.

## Task List

### Phase 1: the guard

- [ ] **Task 1 (T1)** — RED: add a test in `test/rlm.test.ts` asserting zero synthesis
      `llmClient.query` calls and zero charge when the signal is already aborted at the synthesis
      pass; it must fail at HEAD. Then GREEN: insert the early-return guard in `src/rlm.ts` before
      the `tryCharge`, mirroring the D64 refusal shape with a conditional budget field (A2). Per
      A5, move/update any existing assertion that pins a call count through an aborted synthesis.
      Verify: focused `rlm.test.ts` green, then full suite + `check` + `build` + `lint` clean.

### Checkpoint
- [ ] RED verified against HEAD (the test fails before the guard).
- [ ] Full `npm test` green; `npm run check`, `npm run build`, `npm run lint` clean;
      `npm run coverage` floors met.

## Files

- `src/rlm.ts` — one early-return guard in the synthesis pass.
- `test/rlm.test.ts` — one new test; possibly one moved assertion (A5).

## Out of scope

The race itself (#171, landed); the two tool paths (their charge sits inside a sandbox-aborted
tool); the main loop's loop-top check; `docs/`; #191/#192/#173/#170.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| A pre-existing test asserts a synthesis `llmClient.query` call count through an aborted signal | Low | A5: the guard legitimately removes one call; the assertion moves, and the RED test documents why |
| The guard changes the budget field shape vs the D64 refusal branch | Low | A2: conditional `...(budget ? … : {})`, matching the fall-through salvage |
| Provider call still made because the guard lands after `synthesisMessages` but after the charge | Low | A3: invariant is "before `tryCharge`", verified by the charge-asserting test |

## Open Questions

None — the issue body is prescriptive and this run is autonomous (assumptions recorded in SPEC.md).
