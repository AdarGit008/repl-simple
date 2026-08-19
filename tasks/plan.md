# Implementation Plan: issue #33 — Plumb signal and limits through the extension and ReplRunner

Source of truth: `SPEC.md` (D1–D7). The signal half is already shipped (D1); this plan covers the
missing `limits` forwarding, the model-boundary clamp, and the abort-semantics pinning.

## Overview

Five tasks, strictly ordered. T1 adds the `limits` parameter to `ReplRunner` (foundation). T2 builds
the clamp and exposes two clamped params on the `repl` tool (depends on T1). T3 and T4 pin the two
abort behaviours the issue demands but the suite does not yet cover. T5 is the documentation/DoD
reconciliation pass. Every task is RED-first; the full suite must be green after each.

## Architecture Decisions

- **`ReplRunner` stays a faithful library** — it accepts `limits?: RunLimits | "unbounded"` and
  forwards verbatim; it never clamps and never strips `"unbounded"` (D2). The clamp is the
  extension's job because that is where untrusted model input enters.
- **Clamp lives in the extension as a pure helper** (`clampModelLimits`) so it is unit-testable
  without driving the whole tool `execute` path (D3, Assumption from SPEC).
- **Abort semantics are pinned, not changed** — transcript rollback is already the behaviour; T3
  documents and tests it rather than reworking `Session.run` (D4).
- **`_signal` stays on the two synchronous tools** — renaming would trip `noUnusedParameters`;
  the `_`-prefix is the correct idiom for a fixed-arity unused param (D5).

## Task List

### Phase 1 — Foundation

- [ ] **T1 — Forward `limits` through `ReplRunner.run`/`resume` (D2)**

### Checkpoint: Foundation
- [ ] `npx tsx --test test/repl.test.ts` green; full suite green; `npm run check` + `npm run build` clean.

### Phase 2 — Model boundary

- [ ] **T2 — Clamp helper + expose clamped `maxDurationSecs`/`maxMemory` on the `repl` tool (D3)**

### Checkpoint: Model boundary
- [ ] `npx tsx --test test/extension.test.ts test/repl.test.ts` green; full suite green.

### Phase 3 — Abort behaviour

- [ ] **T3 — Session-state-after-abort: document + assert transcript rollback (D4)**
- [ ] **T4 — End-to-end abort through the real extension path (D7 test 1)**

### Checkpoint: Abort behaviour
- [ ] Both new abort tests present and green; full suite green.

### Phase 4 — Documentation / DoD

- [ ] **T5 — Scope-boundary description + `_signal` reconciliation (D5, D6)**

### Checkpoint: Complete
- [ ] Four issue tests exist and pass; `npm test` + `npm run check` + `npm run build` + `npm run lint` clean.
- [ ] Ready for VERIFY (test-engineer) and REVIEW (code-reviewer).

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Test 1 (abort e2e) reveals signal does **not** stop later host calls despite being plumbed | Med | T4 in-scope: coder fixes the small gap; spec D1 does not forbid a fix if a genuine defect is found |
| Driving `execute` in-test is heavy (approval dialog, ctx) | Low | T2/T4 may split into helper-unit + param-through tests; the split is recorded in the task summary |
| Clamp constants drift from `sandbox.ts` defaults | Low | Caps (300 s / 1024 MiB) are spec-fixed; coder reads the live defaults and only *confirms* them, never changes them |
| Test 3 is a tautology (asserts its own stub) | Med | T1's test must capture the actual `RunOptions` object passed and assert on its fields, not on a value the test itself supplied |

## Open Questions

- None blocking — see SPEC "Open questions / risks" (resume-limits symmetry, clamp-test split,
  side-effect non-assertion are all recorded there as decisions, not blockers).
