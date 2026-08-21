# Implementation Plan: issue #184 — redact provider errors on the llm_query / downgraded-rlm_query tool paths

## Overview

`onLLMQuery` (`src/rlm.ts:1087`) and the `depth >= maxDepth` downgrade branch of `rlm_query`
(`src/rlm.ts:1111`) call `llmClient.query` with no truncation. A provider rejection throws out of
the tool into the sandbox as a Python `RuntimeError` (`src/sandbox.ts` maps the thrown `err.message`
verbatim), and the raw message reaches both `buildFeedback` (16 KiB 50/50 → tail retained,
model-visible) and `iterations[].result.error` (raw, caller-visible). The fix is one choke point per
tool path: wrap the call, truncate head-only at 1 KiB with the existing `truncateText` + the three
#167 constants, and re-throw a plain `Error`. Both consumers then read the bounded form; short
messages pass byte-identical.

## Architecture Decisions (SPEC D1–D7, not restated)

- **D1/D2** — source choke points at the two call sites; plain `truncateText`, no sentinel wrap.
- **D3/D4/D5** — reuse `RLM_ERROR_MAX_BYTES` (1024), `HEAD_ONLY_RATIO` (1), `RLM_ERROR_RECOVERY`.
- **D6** — re-throw `new Error(truncated)`; `RuntimeError` semantics preserved (A4).
- **D7** — module-private `redactProviderError(err: unknown): string` helper beside the RLM
  provider-error constants; both call sites use it.

## Task List

### Phase 1: the fix + its RED-first tests
- [ ] **Task 1 (T1)** — truncate provider errors at the two tool paths (`src/rlm.ts`); RED-first:
      two new long-message tests + one short-message regression pin in `test/rlm.test.ts`.

### Checkpoint 1: code + tests
- [ ] Focused `npx tsx --test test/rlm.test.ts` green; full `npm test` green;
      `npm run check` + `npm run build` clean; scoped lint (`npx biome check src extensions test`)
      clean.

### Phase 2: policy documentation
- [ ] **Task 2 (T2)** — record the two tool-path surfaces in `docs/truncation-policy.md`
      (Implementation-record row + short narrative).

### Checkpoint 2: complete
- [ ] Issue acceptance met; all tests green; ready for review.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| 1 KiB cap truncates a legitimately useful provider error | Low | Recorded assumption (A1/D3); head-only keeps the error-type prefix; veto point is Phase 6 |
| Re-throwing `new Error` changes abort/error classification on the tool path | Low | A4/D6 — no reclassification; `err.message` already becomes `RuntimeError`; #171 owns signal-racing |
| Double truncation (source + `buildFeedback`) | Low | Harmless — the source output is ≤ 1 KiB, so `buildFeedback`'s 16 KiB split passes it through unchanged |
| Doc task (T2) has no test | Low | `check`/`build`/`lint` unaffected; doc reviewed in Phase 5 for accuracy |
| Overlap with #171/#182 (same file) | Med | Strictly scope T1 to the two call sites + helper; do not touch budget/`tryCharge` or interpolation |

## Open Questions

None blocking (SPEC "Open questions").
