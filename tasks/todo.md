# Todo — issue #33: Plumb signal and limits through the extension and ReplRunner

Source of truth: `SPEC.md` (D1–D7) + `tasks/plan.md`. Each task is RED-first (write the failing
test before the code). One coder per task, fresh context, one commit per task. After each task the
full suite must be green. Signal plumbing is already done (D1) — do not redo it.

- [x] **T1 — Forward `limits` through `ReplRunner.run`/`resume` (D2)**
  - RED: `ReplRunner`-layer test with a stub `Session` asserting `session.run`/`session.resume`
    receive `{ onApproval, signal, limits }` — must fail today because `limits` is dropped (D7 test 3).
  - Implement: append `limits?: RunLimits | "unbounded"` as the last param of `run` and `resume`;
    forward into the `RunOptions` passed to `session.run`/`session.resume`. No clamping, no default
    change here (omission stays fail-safe via `limitsConfig()`).
  - Verify: `npx tsx --test test/repl.test.ts` green; full suite green; `npm run check`/`build` clean.
  - Files: `src/repl.ts`, `test/repl.test.ts`.

- [x] **T2 — Clamp helper + expose clamped limits on the `repl` tool (D3)**
  - RED: test 2 — a model-supplied `maxDurationSecs`/`maxMemory` above the cap is clamped to
    300 / 1024 MiB, not honoured; and the tool never emits `"unbounded"`.
  - Implement: exported pure `clampModelLimits(maxDurationSecs?, maxMemoryMiB?)` in
    `extensions/repl-extension.ts` (upper-bound only; invalid/≤0 → omit); add the two params to the
    `repl` tool schema; build a `RunLimits` and pass it through `ReplRunner.run`.
  - Verify: `npx tsx --test test/extension.test.ts` green; full suite green; `npm run check`/`build` clean.
  - Files: `extensions/repl-extension.ts`, `test/extension.test.ts`.

- [x] **T3 — Session-state-after-abort: document + assert transcript rollback (D4)**
  - RED: test 4 — an aborted run's variable bindings are invisible to a later `repl` call in the
    same session (transcript dropped), while an `ok` run's bindings persist.
  - Implement: add the D4 semantics to `ReplRunner.run`'s JSDoc (transcript rolls back; host-tool
    side effects persist). No behaviour change expected — this pins the existing contract.
  - Verify: `npx tsx --test test/repl.test.ts` green; full suite green.
  - Files: `src/repl.ts`, `test/repl.test.ts`.

- [x] **T4 — End-to-end abort through the real extension path (D7 test 1)**
  - RED: test 1 — through `ReplRunner` (extension path), run code making ≥2 gated host calls, abort
    after the first returns, assert the later calls never ran via a side-effect counter.
  - Implement: the test itself (signal is already plumbed). If it reveals signal does NOT stop
    later calls, fix the small gap in-scope and record it. Do not mistake the existing
    dialog-abort test (`extension.test.ts:508`) for this coverage.
  - Verify: `npx tsx --test test/extension.test.ts` green; full suite green.
  - Files: `test/extension.test.ts` (and `extensions/repl-extension.ts` only if a real gap is found).

- [ ] **T5 — Scope-boundary description + `_signal` reconciliation (D5, D6)**
  - Implement: append the D6 sentence to the `repl` tool `description` (cancel stops between tool
    calls; a pause-less Python loop runs to the duration limit). Add a one-line comment on
    `repl_reset`/`repl_abandon` explaining why `_signal` stays (synchronous, non-abortable,
    `noUnusedParameters`).
  - Verify: `npm test` + `npm run check` + `npm run build` + `npm run lint` clean.
  - Files: `extensions/repl-extension.ts`.

## Checkpoint (after T5)

- [ ] All four issue tests exist and pass; full suite green; check/build/lint clean.

## DoD (from #33, reconciled per D5)

- [ ] No `_signal` remains on the abortable tools (`repl`, `repl_resume`) — already true.
- [ ] All four tests exist and pass.
- [ ] A cancel in Pi's UI stops further host tool execution (demonstrated by T4's test).
- [ ] The scope boundary is written into the `repl` tool description (D6).
