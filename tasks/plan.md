# Implementation Plan: issue #167 — redact `RlmResult.error` before return and nested re-interpolation

## Overview

`RlmResult.error` is assigned raw at `src/rlm.ts:1188` (`err.message`) and has exactly two
consumers: the public `status: "error"` return, and the nested-feedback re-interpolation at
`src/rlm.ts:1093` (`[rlm_query error: ${nested.status}] ${nested.error}`). Provider error text can
carry request context (prompt snippets, request IDs, retry hints). The fix is a single choke point:
truncate the message at the assignment site with the shared `truncateText` (invariant 4 — "the only
place that cuts") at a 1 KiB cap, with a neutral recovery clause. Both consumers then read the
bounded value; short messages pass through byte-identical.

## Architecture Decisions (SPEC D1–D6, not restated)

- **D1 — source choke point at `:1188`.** No edit at `:1093`; the re-interpolation reads the
  already-bounded `nested.error`.
- **D2 — plain `truncateText`, not `truncateWithSentinels`.** The public return is an API surface;
  D17 sentinels must not leak to callers. The model-facing nested error carries an unauthenticated
  `[…]` marker — accepted, #166's scope.
- **D3 — `RLM_ERROR_MAX_BYTES = 1024`.** "Small cap"; 16 KiB is the sandbox `RunResult.error` budget
  (`FEEDBACK_ERROR_MAX_BYTES`), a different field. Reuse `VALUE_HEAD_RATIO` (0.5).
- **D4 — `RLM_ERROR_RECOVERY = "The full provider error is not surfaced."`** Neutral for both
  audiences; `ERROR_RECOVERY` (Python re-run) is semantically wrong for an LLM rejection.
- **D5 — existing short-message tests (`:880`, `:1104-1115`) stay GREEN, not rewritten.** `truncateText`
  is byte-identical under budget; `"boom"` (4 B) and `"child llm failure"` (17 B) are far under 1 KiB.

## Chosen test-observation mechanism

Direct assertion on the public seam — the existing `runRlm()` tests already drive `runRlm` with a
fake `LlmClient` (issue test 4 at `:1104`, the nested `rlm_query` test at `:855`). Two new tests:

1. **Public return.** Fake `LlmClient.query` throws `Error("A".repeat(64 * 1024) + "UNIQUE-TAIL-SENTINEL")`.
   Assert `status === "error"`, `result.error` lacks `UNIQUE-TAIL-SENTINEL`, contains `[…`, and its
   UTF-8 byte length ≤ 1024 (+ the marker/recovery bytes — a small documented tolerance).
2. **Nested re-interpolation.** Child `rlm_query` throws a huge message ending in
   `NESTED-TAIL-SENTINEL`; parent does `SUBMIT("outer: " + result)`. Assert `answer` starts with
   `"outer: [rlm_query error: error] "` and lacks `NESTED-TAIL-SENTINEL`.

Both are RED today: the current code returns/interpolates the full 64 KiB message. The two existing
short-message assertions are the regression pins (D5) and must remain untouched.

## Task List

### Phase 1: the fix + its RED-first tests
- [ ] **Task 1 (T1)** — truncate `RlmResult.error` at the source (`src/rlm.ts:1188`); RED: two new
  long-message tests in `test/rlm.test.ts`.

### Checkpoint 1: code + tests
- [ ] Focused `npx tsx --test test/rlm.test.ts` green; full suite green; `check`/`build`/`lint` clean.

### Phase 2: policy documentation
- [ ] **Task 2 (T2)** — record the new surface in `docs/truncation-policy.md` (Implementation-record
  row, Non-goals line, short narrative).

### Checkpoint 2: complete
- [ ] Issue acceptance met; all tests green; ready for review.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| 1 KiB cap truncates a legitimately useful short-ish provider error (e.g. a long request-ID tail the caller wants) | Low | Recorded assumption (D3); the head 50% keeps the human-readable prefix; veto point is the Phase 6 go/no-go |
| The two existing tests at `:880`/`:1104-1115` actually *do* break (e.g. `truncateText` is not a no-op under budget for these inputs) | Low | If RED/GREEN reveals this, the coder records it as a post-build finding and adjusts only those assertions — do not silently rewrite; report for the Phase 6 reconciliation |
| `truncateText`'s elision marker pushes the emitted string slightly over 1024 bytes (marker + recovery bytes are additive) | Low | Assert `<= 1024 + tolerance` where tolerance is the measured marker+recovery size; or assert absence of the tail sentinel as the primary signal and treat the byte ceiling as approximate |
| Doc task (T2) touches a doc with no test | Low | `npm run lint`/`check`/`build` unaffected; review the doc in Phase 5 for accuracy against the landed code |
| Overlap with #166/#171 (same file) | Med | Strictly scope T1 to `:1188` + constants + `RlmResult.error` JSDoc; do not touch `:1093` or the `systemPrompt`/downgrade blocks |

## Open Questions

None blocking (SPEC "Open questions").
