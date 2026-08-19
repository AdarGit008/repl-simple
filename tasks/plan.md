# Implementation Plan: issue #177 — `repl_resume` re-applies the suspended run's clamped limits; pin the extension's signal forward

## Overview

`Session.run` persists the suspended run's raw `RunOptions` into `suspendedRunOpts`
(`src/session.ts:366`), so the clamped limits granted to a `repl` call survive the suspension.
`Session.resume` throws that record away: its `wrappedRunOpts` (`src/session.ts:435-439`) is built
purely from the caller's `runOpts` and never reads `suspendedRunOpts`, so the resumed continuation
runs under `limitsConfig()` defaults (30 s / 512 MiB) rather than the grant the original call was
given. The fix is one field: merge `suspendedRunOpts.limits` in when the caller supplied none
(D1). Separately, `repl_resume.execute` already forwards the abort `signal` to
`ReplRunner.resume` (`extensions/repl-extension.ts:371-375`), but no test proves it — the second
deliverable is a pin test at that extension seam (D2).

## Architecture Decisions (SPEC D1–D6, not restated)

- **D1 — fix lives in `Session.resume`, not the schema.** One merge field:
  `limits: runOpts?.limits ?? this.suspendedRunOpts?.limits` (D4 precedence: caller wins via `??`;
  `"unbounded"` is truthy and carries through). `onApproval`/`signal` stay caller-supplied.
- **D2 — signal forwarding is a test-only gap** at the extension layer; `ReplRunner`→`Session`→sandbox
  is already pinned (#150, D7 test 3). No `src/repl.ts` / `extensions/repl-extension.ts` change.
- **D3 — `limits` field only.** No `mount`/`inputs`/`scriptName`/`maxStdoutBytes` (that is #84's).
- **D5/D6 — env discipline.** `limitsConfig()` reads `process.env` at call time, so the Session-level
  tests snapshot/clear `REPL_MAX_DURATION_SECS` / `REPL_MAX_MEMORY_MB` (the `before`/`after` pattern
  in `test/extension.test.ts:207-231`), and the extension pin restores the stubbed prototype in `finally`.

## Chosen test-observation mechanism (SPEC assumption 3)

**A below-default `maxMemory` observed as `RunError.errorKind === "memory"`** — the Option (i)
behavioural seam, but with the *memory* knob instead of the *duration* knob the SPEC example named.

Why it proves the fix, deterministically:

- The resumed worker's limits come from the same place as the run path:
  `resumeSuspended` hands `{ limits: toResourceLimits(runOpts?.limits) }` to the checkout
  (`src/sandbox.ts:1313`) and `hostDeadlineAt(runOpts?.limits)` (`:1308`). With
  `runOpts.limits === undefined`, every knob falls back to `limitsConfig()` (`:752-762`).
- `maxMemory` is enforced **on resumed instructions**, not just the first run:
  `classifyResumeError`'s contract states a resume "may breach `maxDurationSecs` or `maxMemory` on any
  instruction it executes after the resume" (`src/sandbox.ts:145`), and `runtimeKind` maps
  `MontyRuntimeError` typeName `"MemoryError"` → `"memory"` (`:187-192`).
- The assertion has **no timing dependence**: `bytearray(128 MiB)` against a 32 MiB ceiling fails at
  the allocation; against the 512 MiB default it succeeds. Wide margins on both sides (128 MiB > 32 MiB
  by 4×; 128 MiB + ~10 MiB baseline ≈ 138 MiB < 512 MiB). The discriminating signal is the error
  *kind*, so the test is immune to message rewording.
- The SUSPEND phase never allocates: the gated call is the first statement; the `bytearray(...)` line
  executes only after the resume approves, so the 32 MiB ceiling comfortably survives the
  suspend/resume machinery (~8.7 MiB bare session per `src/sandbox.ts:731`).

Rejected alternatives:

- **Option (i) via `maxDurationSecs` (busy loop → timeout):** `maxDurationSecs` is polled inside the
  worker and advances only while the interpreter executes (`src/types.ts` `RunLimits` JSDoc), so the
  moment a loop trips it is poll-granularity-dependent — flaky under load. Memory is a hard, immediate
  failure.
- **Option (ii) spy/seam:** `resumeSuspended` is an ESM named import in `src/session.ts:1`, not
  reassignable from a test; the suite's only stub pattern is prototype stubbing
  (`test/extension.test.ts:347-372`), which cannot reach a module-level binding without a new
  abstraction — which the SPEC forbids for a single `??` merge field.
- **Option (iii) dump/load serialisation:** `Session.dump()` already serializes `suspendedRunOpts.limits`
  (`src/session.ts:542`), so that assertion is GREEN before the fix — it proves storage, not
  re-application, and cannot be the RED test.

## Task List

### Phase 1: the fix + its Session-level proof
- [ ] **Task 1 (T1)** — `Session.resume` merges `suspendedRunOpts.limits`; RED: two Session-level
  integration tests (below-default ceiling; tightened-env survival) in `test/session.test.ts`.

### Checkpoint 1: Session layer proven
- [ ] Focused `npx tsx --test test/session.test.ts` green; full suite green; `check`/`build`/`lint` clean.

### Phase 2: the extension-layer signal pin
- [ ] **Task 2 (T2)** — pin `repl_resume.execute` forwards the abort `signal` to `ReplRunner.resume`
  (characterization test; no source change).

### Checkpoint 2: complete
- [ ] Issue acceptance met; all tests green; ready for review.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Ambient `REPL_MAX_MEMORY_MB` in the outer `npm test` process would make the unfixed 512 MiB fallback wrong, so assertion 1 would not be RED | High (invalid test) | Describe-level `before`/`after` clears both `REPL_MAX_DURATION_SECS` and `REPL_MAX_MEMORY_MB` (D6), exactly like `test/extension.test.ts:207-231` |
| Tightened-env test would not be RED if the env var is still set at resume time (`limitsConfig()` re-reads it) | High (invalid test) | The test deletes `REPL_MAX_MEMORY_MB` *before* `resume`, so the unfixed path reads the 512 MiB default and the 320 MiB allocation succeeds — while the fixed path uses the persisted 256 MiB and fails. The delete is the point of the test |
| 32 MiB ceiling too tight for the suspend/resume machinery (snapshot dump, gated-tool replay) | Low | Bare session is ~8.7 MiB (`src/sandbox.ts:731`); the gated call runs before any allocation, so the suspend phase stays well under 32 MiB. If CI reveals otherwise, raise the ceiling to 64 MiB and the allocation to 256 MiB (still 4× apart) |
| `bytearray` not available / type-check rejects the literal | Low | `bytearray` is a standard builtin; use a plain integer literal (`128 * 1024 * 1024`) to sidestep any underscore-literal parsing concern |
| Extension pin test leaks the `ReplRunner.prototype.resume` stub | Med | Restore in `finally` (mandatory); safe because the extension test file runs sequentially (the `#178` chore is about *documenting* that assumption, not changing it) |

## Open Questions

None blocking (SPEC "Open questions").
