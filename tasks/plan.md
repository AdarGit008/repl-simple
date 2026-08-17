# Implementation Plan: F-77 — Line-offset correction + honest continuity contract

## Overview

Fix #77's two defects in the RLM loop: (1) diagnostics fed back to the model carry line numbers
shifted by the ~90-line RLM preamble and embed preamble source; (2) prompts imply session continuity
while every iteration runs in a fresh sandbox. Per SPEC.md D1-D4: correct offsets in `sandbox.ts`
via a new `RunOptions.lineOffset`, wire both callers (`rlm.ts`, `session.ts`), and rewrite the RLM
prompt to state the fresh-sandbox-per-iteration contract.

## Architecture Decisions

- **D1** — `lineOffset?: number` on the sandbox `RunOptions`; `sandbox.ts` is the single correction
  site (syntax errors: textual line-number correction + prefix-excerpt stripping; runtime errors:
  structured `traceback()` frames, offset-adjusted, prefix frames dropped, survivors re-rendered;
  typing errors: same correction as syntax — the "already line-correct" premise was disproved in
  VERIFY and fixed in Task 7).
- **D2** — Continuity contract = fresh sandbox per iteration; prompts rewritten to say so. True
  continuity declined: `MontyRepl.feed()` supports only `{mount}` (no `externalFunctions`), and the
  host-tool bridge is external-function-based.
- **D3** — Prompt edits preserve the section-header literals that #78's coupled tests locate.
- **D4** — `displayDiagnostics('json')` declined (recorded decision at `sandbox.ts:1067-1073`
  stands; typing diagnostics are already correct).
- #144's 16 KiB error cap in `buildFeedback` is preserved — correction happens upstream of it.

## Task List

### Phase 1: Sandbox-level correction

- [ ] **Task 1:** `lineOffset` in `RunOptions` + syntax-error correction (subtract offset, strip
      prefix excerpt lines) in `sandbox.ts`.
- [ ] **Task 2:** Runtime-error correction via `MontyRuntimeError.traceback()` frames (offset +
      prefix-frame drop + re-render); message fallback when frames are unavailable.

### Checkpoint A: Sandbox core
- [ ] Full suite green; focused sandbox tests green; `npm run check` green.

### Phase 2: Wire the callers

- [ ] **Task 3:** RLM passes `lineOffset` = actual preamble line count; issue tests 1+2
      (line 1 reported as line 1; no preamble token in fed-back diagnostic).
- [ ] **Task 4:** `Session.run` passes `lineOffset` = preamble + prior-snippet line count;
      issue test 3 (stacking case).

### Checkpoint B: Both consumers wired
- [ ] Full suite green; coverage floors green (`npm run coverage`).

### Phase 3: Continuity contract

- [ ] **Task 5:** Rewrite RLM prompt + feedback wording to state the fresh-sandbox-per-iteration
      contract; issue test 4 asserts the prompt says so and continuity-implying wording is gone;
      D3 section literals intact.

### Checkpoint C: Complete
- [ ] All four issue tests pass on Monty 0.0.21; full suite, `check`, `coverage`, `lint` green.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Textual syntax-error correction is fragile (Monty message format) | Med | Pinned Monty 0.0.21; tests cover prefix sizes 1/3/7 and the real ~90-line preamble; reviewer checks format assumptions |
| Runtime traceback re-render breaks existing tests that assert error text shape | Med | Keep the existing `Error: <type>: msg` heading shape; change only the traceback portion; full-suite gate each task |
| Prompt edits break #78's literal-matching tests (D3) | Med | Preserve section-header literals verbatim; full-suite gate |
| Correction accidentally bypasses #144's 16 KiB cap | Low | Correction is upstream of `buildFeedback`; T3 verification re-asserts the cap |
| Sandbox changes affect non-RLM callers (REPL path) | Low | `lineOffset` defaults to absent = current behavior; full suite covers the REPL path |

## Open Questions

- None blocking (autonomous run). Carried forward: true continuity once Monty's `FeedOptions`
  supports `externalFunctions` — issue-monitor's final report will place this on #70/#77.
