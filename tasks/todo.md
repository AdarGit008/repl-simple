# Todo — issue #177: `repl_resume` re-applies the suspended run's clamped limits; pin the signal forward

Source of truth: `SPEC.md` (D1–D6) + `tasks/plan.md`. Each task is RED-first. One coder per task,
fresh context, one commit per task. After each task the full suite must be green. Do **not** touch
`src/sandbox.ts`, `src/repl.ts`, or `extensions/repl-extension.ts`. Only `src/session.ts`,
`test/session.test.ts`, and `test/extension.test.ts` are in scope.

- [x] **T1 — `Session.resume` re-applies `suspendedRunOpts.limits` (D1, D4)**
  - [x] RED — add a new `describe("Session — resume re-applies the suspended run's limits (#177)")` block
    to `test/session.test.ts` (after the `approval & suspension` describe, reusing the `err`/`suspended`
    helpers at `:15`/`:19`). It needs a gated tool, a `before`/`after` that snapshot+clear
    `REPL_MAX_DURATION_SECS` / `REPL_MAX_MEMORY_MB` (mirror `test/extension.test.ts:207-231`), and two
    tests:
    1. **Below-default ceiling.** `suspended(await session.run('gated_limits("x")\nbig = bytearray(128 * 1024 * 1024)', { onApproval: () => "suspend", limits: { maxMemory: 32 * 1_048_576 } }))`,
       then `resume({ onApproval: () => true })` with **no** limits; assert `err(result)` and
       `result.errorKind === "memory"`. Today this returns `"ok"` (the 128 MiB allocation succeeds under
       the 512 MiB default) — RED.
    2. **Tightened-env survival (D5/D6).** Set `REPL_MAX_MEMORY_MB = "256"`; suspend a run granted
       `limits: { maxMemory: 256 * 1_048_576 }` whose second line is `big = bytearray(320 * 1024 * 1024)`;
       **delete `REPL_MAX_MEMORY_MB` before resuming** (this is what makes it RED: the unfixed resume
       re-reads `limitsConfig()` and gets the 512 MiB default, so 320 MiB succeeds); `resume({ onApproval:
       () => true })`; assert `err(result)` and `result.errorKind === "memory"`. Today RED.
  - [x] Implement — one line in `src/session.ts` `Session.resume`, in the `wrappedRunOpts` literal
    (`:435-439`), after `...runOpts,`:
    ```ts
      limits: runOpts?.limits ?? this.suspendedRunOpts?.limits,
    ```
    Nothing else. Do not recover `onApproval`/`signal` from the suspension (D1/D2); do not add
    `mount`/`inputs`/`scriptName`/`maxStdoutBytes` (D3).
  - [x] Verify — `npx tsx --test test/session.test.ts` green; full `npm test` green;
    `npm run check` + `npm run build` + `npm run lint` clean.
  - Files — `src/session.ts`, `test/session.test.ts`.
  - Post-build finding: Monty's snapshot restore already preserves maxDurationSecs/maxMemory across resume; the fix is library-layer hardening (maxWallClockSecs + #84 seam). Tests are acceptance tests of the invariant, not RED-for-the-fix.

- [x] **T2 — Pin `repl_resume.execute` forwards the abort `signal` to `ReplRunner.resume` (D2)**
  - RED — this is a **characterization pin**, not a bug fix: the code already forwards the signal
    (`extensions/repl-extension.ts:371-375`), so the new test passes on first run and guards the seam.
    Add a new `describe("repl extension — repl_resume forwards the abort signal (#177 D2)")` block to
    `test/extension.test.ts` (after the `suspension is reachable (#51)` describe at `:983`), with a
    `mkdtemp` `cwd` in `before`/`after`. Stub `ReplRunner.prototype.resume` (mirroring
    `runWithLimits` at `:347-372`) to capture its 3rd positional argument, restore it in `finally`:
    ```ts
    const controller = new AbortController();
    const seen: unknown[] = [];
    const originalResume = ReplRunner.prototype.resume;
    ReplRunner.prototype.resume = (async (_sessionId, _onApproval, signal) => {
      seen.push(signal);
      return "[result]\n1";
    }) as unknown as typeof ReplRunner.prototype.resume;
    try {
      const resume = (await loadTools()).find((t) => t.name === "repl_resume");
      assert.ok(resume);
      await resume.execute("sig-1", { sessionId: "sig" }, controller.signal, undefined,
        { cwd, isProjectTrusted: () => true, hasUI: true, ui: { select: async () => APPROVE_CHOICE } });
    } finally {
      ReplRunner.prototype.resume = originalResume;
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0], controller.signal);
    ```
  - Implement — none. If the test fails, the signal forward has regressed: record the blocker and do
    not "fix" it by changing `repl-extension.ts` out of scope.
  - Verify — `npx tsx --test test/extension.test.ts` green; full `npm test` green;
    `npm run check` + `npm run build` + `npm run lint` clean.
  - Files — `test/extension.test.ts`.

## Checkpoint (after T2)

- [ ] Issue acceptance met: a resumed run honours the same clamped limits the original `repl` call was
      granted (derived ceilings, never 300 s / 1024 MiB); explicit caller limits still win (D4).
- [ ] `repl_resume` signal-forwarding seam pinned.
- [ ] Tightened `REPL_MAX_MEMORY_MB` survives into resume (tested).
- [ ] Full suite green; `check`/`build`/`lint` clean.

## DoD (from #177, reconciled)

- [ ] `Session.resume` merges `runOpts?.limits ?? this.suspendedRunOpts?.limits`; caller limits win.
- [ ] Session-level integration test proves resumed runs use the suspended limits (memory seam).
- [ ] Extension-level test pins `repl_resume` → `ReplRunner.resume` signal forwarding.
- [ ] No changes to `src/sandbox.ts`, `src/repl.ts`, `extensions/repl-extension.ts`; no `repl_resume`
      schema/description change; no #84 merge (mount/inputs/scriptName/maxStdoutBytes).
