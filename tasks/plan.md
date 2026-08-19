# Implementation Plan: issue #176 — Derive the clamp ceilings from the operator's limits

## Overview

The `repl` tool's model-facing clamp (`clampModelLimits` in `extensions/repl-extension.ts`) uses
hardcoded ceilings (`MAX_MODEL_DURATION_SECS = 300`, `MAX_MODEL_MEMORY_MIB = 1024`). Because the
sandbox fills only *unset* knobs from `limitsConfig()`, an extension-supplied value overrides the
operator's `REPL_MAX_DURATION_SECS` / `REPL_MAX_MEMORY_MB` — a prompt-injected model can amplify
past the operator's bound. Fix: derive each ceiling as `min(specCap, limitsConfig() effective
value)` and integerize the byte conversion. See `SPEC.md` (D1–D6) for the decisions.

## Architecture Decisions

- **Ceiling = `min(specCap, limitsConfig() value)`** (D1). Spec caps stay as the absolute upper
  bound; `limitsConfig()` supplies the operator's value or the sandbox default. Default model
  ceiling tightens to 30 s / 512 MiB (deliberate, recorded in SPEC.md D1).
- **Floor the byte conversion** (D2): `Math.floor(memoryMiB * BYTES_PER_MIB)`.
- **Fix is entirely at the model boundary** (D4): `src/sandbox.ts` untouched; import `limitsConfig`
  from `../src/sandbox.js` (D5).
- **Two sequential tasks**, each a self-contained RED→GREEN→verify increment with a clean rollback
  point: T1 (integerize) is independent; T2 (derive ceilings) builds on it and updates the stale
  fixed-cap assertions.

## Task List

### Phase 1: Integerize the byte conversion
- [ ] **Task 1** — Floor `maxMemory` bytes; RED test for `0.1` MiB → `104857`.

### Checkpoint: integerize landed
- [ ] Focused test green; full suite green; `check`/`build`/`lint` clean.

### Phase 2: Derive the ceilings
- [ ] **Task 2** — Derive both ceilings from `limitsConfig()`; update the four stale fixed-cap tests.

### Checkpoint: complete
- [ ] Issue acceptance met (env var is the true ceiling); all tests green; ready for review.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Default model ceiling tightens (300→30 s, 1024→512 MiB) — functional regression vs #33 | Med | Deliberate, security-correct (SPEC.md D1); surfaced to review and the user in the ship decision |
| Env leaks between tests in `test/extension.test.ts` | Low | Save/restore env in `try/finally` or before/after hooks (D3) |
| `limitsConfig()` import drags heavy sandbox deps into the extension | Low | Extension already transitively imports sandbox via `ReplRunner`; no new boundary (D5) |
| #177 later re-hardcodes 300/1024 | Med | Close-out note (D6); issue-monitor final report flags it |

## Open Questions

None blocking (SPEC.md "Open questions").
