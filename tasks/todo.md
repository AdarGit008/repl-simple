# Todo — issue #176: Derive the clamp ceilings from the operator's limits

Source of truth: `SPEC.md` (D1–D6) + `tasks/plan.md`. Each task is RED-first (write the failing
test before the code). One coder per task, fresh context, one commit per task. After each task the
full suite must be green. The bug is at the model boundary only — do not touch `src/sandbox.ts`.

- [x] **T1 — Integerize the `maxMemory` byte conversion (D2)**
  - RED: `clampModelLimits(undefined, 0.1)` must equal `{ maxMemory: 104857 }` (today it is
    `104857.6`). Add to the `describe("repl extension — clampModelLimits")` block in
    `test/extension.test.ts`; confirm it fails.
  - Implement: `limits.maxMemory = Math.floor(memoryMiB * BYTES_PER_MIB)` in
    `extensions/repl-extension.ts` (`clampModelLimits`). The existing `(undefined, 0.5) → 524288`
    assertion must stay green (0.5 × MiB is already integral).
  - Verify: `npx tsx --test test/extension.test.ts` green; full `npm test` green;
    `npm run check` + `npm run build` + `npm run lint` clean.
  - Files: `extensions/repl-extension.ts`, `test/extension.test.ts`.

- [x] **T2 — Derive both clamp ceilings from `limitsConfig()` (D1, D5)**
  - RED (add to the same describe block, save/restore env in `try/finally`):
    1. With `REPL_MAX_MEMORY_MB=256`, `clampModelLimits(undefined, 1024)` → `{ maxMemory: 256 * 1_048_576 }`.
    2. With `REPL_MAX_DURATION_SECS=10`, `clampModelLimits(1000, undefined)` → `{ maxDurationSecs: 10 }`.
    Both fail today (they return the fixed `1024 * MiB` / `300`).
  - Implement: `import { limitsConfig } from "../src/sandbox.js";` in
    `extensions/repl-extension.ts`; in `clampModelLimits`, derive
    `durationCap = Math.min(MAX_MODEL_DURATION_SECS, limitsConfig().maxDurationSecs)` and
    `memoryCapMiB = Math.min(MAX_MODEL_MEMORY_MIB, limitsConfig().maxMemory / BYTES_PER_MIB)`, and
    clamp against those instead of the constants. Update the JSDoc to state `clampModelLimits`
    now reads `process.env` via `limitsConfig()`.
  - Update the four stale fixed-cap assertions in `test/extension.test.ts` (the
    `(10_000, undefined) → 300`, `(undefined, 2048) → 1024*MiB`, `(300, 1024) → {300, 1024*MiB}`,
    `(301, undefined) → 300` cases) to the derived default ceilings (`30` / `512 * MiB`) and rename
    their titles to say "derived ceiling", since they now run with no env vars set.
  - Verify: `npx tsx --test test/extension.test.ts` green; full `npm test` green;
    `npm run check` + `npm run build` + `npm run lint` clean.
  - Files: `extensions/repl-extension.ts`, `test/extension.test.ts`.

## Checkpoint (after T2)

- [ ] Issue acceptance met: with `REPL_MAX_MEMORY_MB=256`, a model-supplied `maxMemory=1024` yields
      `256 * 1_048_576` bytes (never `1024 * MiB`); `REPL_MAX_DURATION_SECS=10` caps `1000` to `10`.
- [ ] Full suite green; `check`/`build`/`lint` clean.

## DoD (from #176, reconciled)

- [ ] Ceilings derived from `limitsConfig()` (`min(specCap, effective value)`), not hardcoded.
- [ ] `maxMemory` byte conversion floored to an integer.
- [ ] Tests pin the tightened-env-var ceiling and the fractional-byte floor.
- [ ] No `src/sandbox.ts` changes; no tool-schema or description changes.
