# Implementation Plan: issue #171 — bound and race the three remaining provider calls

## Overview

Two halves, both in `src/rlm.ts`, both confined to the three call sites the main loop already
solved for itself:

1. **Bound.** `llm_query`'s prompt, and the downgraded `rlm_query`'s query and context, go through
   `truncateWithSentinels` at the main loop's own ceilings (SPEC A1/D1–D4), before the spend charge
   (D5).
2. **Race.** All three calls — `llm_query`, the downgrade, and the synthesis pass — are wrapped in
   `raceAgainstSignal`, the same wrapper the main loop's own query has used since #75.

## Architecture Decisions (SPEC D1–D7, not restated)

- **D1/D2/D3** — `truncateWithSentinels`; two budgets on the downgrade; value shape.
- **D4** — `DOWNGRADE_CONTEXT_RECOVERY`, because the downgrade has no sandbox to slice in.
- **D5/D6** — bound before charge; `?? "(none)"` preserved byte-for-byte.
- **D7** — no abort branch in the tool-path catches.

## What the race actually pins

Established by measurement before the tests were written, because the obvious test is vacuous: an
abort raised 10 ms after the tool call starts is caught by the sandbox's own cut-off either way, so
a test that only asserts `status === "aborted"` passes without the change. The load-bearing
difference is the **trace**, and it is deterministic when the abort is raised synchronously while
the call is in flight:

| | un-raced | raced |
|---|---|---|
| run ends after | ~250 ms (`ABORT_SETTLE_GRACE_MS`) | ~1 ms |
| `iterations[0].result.error` | `"execution aborted"` | `"RuntimeError"` |
| `calls[]` | `[]` — the in-flight call is gone | the `llm_query` entry survives |

4 runs each way, both tool paths. The synthesis pass is different again: un-raced it never returns
at all, so its test is the only one in the file with an explicit timeout.

## Task List

### Phase 1: bound the two tool-path prompts
- [ ] **Task 1 (T1)** — `DOWNGRADE_CONTEXT_RECOVERY` + the tool-path budget note; bound
      `llm_query`'s prompt and the downgrade's query/context before the charge (`src/rlm.ts`).
      RED-first: ceiling, sentinel wrap, forged-sentinel neutralisation, two-budget independence,
      `Context: (none)` regression pin, and the charge-what-you-send pin.

### Phase 2: race the three calls
- [ ] **Task 2 (T2)** — `raceAgainstSignal` on `onLLMQuery`, the downgrade branch, and the
      synthesis pass. RED-first: trace survival on both tool paths, termination on the synthesis
      pass, and a listener-balance pin over two `llm_query` calls.

### Checkpoint
- [ ] RED verified against the PR-#193 head: 7 of the 10 new tests red, 3 green by design
      (unwrapped pass-through, `Context: (none)`, listener balance).
- [ ] Full `npm test` green; `npm run check` + `npm run build` + `npm run lint` clean;
      `npm run coverage` floors met.

### Phase 3: the record
- [ ] **Task 3 (T3)** — three Implementation-record rows and a `#171` narrative in
      `docs/truncation-policy.md`; correct the #184 narrative's throw spelling in passing.

## Files

- `src/rlm.ts` — one new recovery constant, three bounded interpolations, three race wraps.
- `test/rlm.test.ts` — one new `describe` block, ten tests.
- `docs/truncation-policy.md` — three rows, one narrative, one correction.

## Out of scope

The already-aborted-at-entry synthesis charge (SPEC non-goal 1), context growth across nesting
depth, and #191/#192.
