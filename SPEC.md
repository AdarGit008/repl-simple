# Spec: Derive the model-boundary clamp ceilings from the operator's limits — issue #176

## Objective

The `repl` tool's model-facing clamp ceilings are hardcoded constants —
`MAX_MODEL_DURATION_SECS = 300` and `MAX_MODEL_MEMORY_MIB = 1024` — in
`extensions/repl-extension.ts`. The sandbox reads operator-tunable env vars
(`REPL_MAX_DURATION_SECS` / `REPL_MAX_MEMORY_MB`) through `limitsConfig()`, but because
`toResourceLimits` fills only *unset* knobs with `??`, any value the extension supplies **wins
over** the operator's env var. An operator who tightens `REPL_MAX_MEMORY_MB=256` to bound per-worker
resources is silently bypassed: a prompt-injected model can still request the fixed 1024 MiB / 300 s
caps — a 4×/10×+ amplification with no wall-clock analog to catch the memory half.

Success looks like: the model-boundary clamp ceiling is **derived from the same source as the sandbox
default** (`limitsConfig()`), so the operator's knob is a true ceiling rather than a default the
model can override; the `maxMemory` byte conversion is integerized (no fractional/sub-byte counts
reach Monty); and a tightened env var is honoured end-to-end.

Parent #31 (Bucket 3 — Resource containment). Issue:
https://github.com/AdarGit008/repl-simple/issues/176. Sibling from the same #33 ship report: #177
(resume limits — must reuse the derived ceilings, not re-hardcode), #178 (test helper in the same
file).

## Current state (fact base, verified 2026-08-19)

| Fact | Value |
|---|---|
| `extensions/repl-extension.ts:87-89` | `MAX_MODEL_DURATION_SECS = 300`, `MAX_MODEL_MEMORY_MIB = 1024`, `BYTES_PER_MIB = 1_048_576` — hardcoded ceilings. |
| `extensions/repl-extension.ts:101-104` | `clampCeiling(value, cap)` — upper-bound-only, `Math.min(value, cap)`, omits non-positive-finite. |
| `extensions/repl-extension.ts:115-121` | `clampModelLimits(maxDurationSecs?, maxMemoryMiB?)` — exported; `:119` does `memoryMiB * BYTES_PER_MIB` (unfloored → `0.1` MiB yields `104857.6` bytes). |
| `src/sandbox.ts:710-718` | `limitsConfig()` (exported) returns `{ maxDurationSecs, maxMemory (bytes), maxWallClockSecs }` from `envInt("REPL_MAX_DURATION_SECS", 30)`, `envInt("REPL_MAX_MEMORY_MB", 512) * 1_048_576`, `envInt("REPL_MAX_WALL_CLOCK_SECS", 300)`. |
| `src/sandbox.ts:754-761` | `toResourceLimits()` fills unset knobs with `??` from `limitsConfig()` — so an extension-supplied value wins over the env var. The root cause. |
| `test/extension.test.ts:176-204` | `clampModelLimits` unit tests pin the **fixed** caps: `(10_000, undefined) → {maxDurationSecs: 300}`, `(undefined, 2048) → {maxMemory: 1024*MIB}`, `(300, 1024) → {300, 1024*MIB}`, `(301, undefined) → {maxDurationSecs: 300}`, `(undefined, 0.5) → {maxMemory: 524288}`. These four fixed-cap assertions encode the #33 decision that #176 reverses. |
| `test/extension.test.ts:210-283` | "the repl tool passes clamped limits (never 'unbounded')" — already asserts the tool forwards `clampModelLimits` output to `ReplRunner.run`; the boundary wiring is proven. |
| #33 `SPEC.md` (now replaced) | Asserted the caps are **fixed** by spec ("300 s / 1024 MiB, the caps themselves are fixed"). #176 overturns that; this file replaces it. |

## Scope

| In scope | Out of scope |
|---|---|
| Derive the two clamp ceilings from `limitsConfig()` at the model boundary (`extensions/repl-extension.ts`) | Touching `src/sandbox.ts` `toResourceLimits`/`limitsConfig` (the `??` fill is the sandbox's correct defaulting contract) |
| Integerize the `maxMemory` byte conversion (floor) | Exposing `maxWallClockSecs`/`gcInterval`/`maxRecursionDepth` to the model (unchanged — see #33) |
| Tests: env-var ceiling, duration ceiling, fractional-byte floor, updated fixed-cap tests | #177 (resume forwards limits) — separate sibling; must consume the derived ceilings when done |
| Reconcile the four stale fixed-cap unit tests | #178 (monkey-patch comment) — separate chore |

## Explicit decisions

### D1 — The ceiling is `min(specCap, limitsConfig() effective value)` (Option A)

The fix is exactly the shape the issue prescribes:

```ts
const cfg = limitsConfig();
const durationCap = Math.min(MAX_MODEL_DURATION_SECS, cfg.maxDurationSecs);
const memoryCapMiB  = Math.min(MAX_MODEL_MEMORY_MIB,   cfg.maxMemory / BYTES_PER_MIB);
```

`clampModelLimits` clamps each model knob against the **derived** cap instead of the hardcoded
constant. `MAX_MODEL_DURATION_SECS`/`MAX_MODEL_MEMORY_MIB` remain as the absolute upper bound (so a
*raised* operator knob is still spec-capped); `limitsConfig()` supplies the operator's configured
value, or the sandbox default when unset.

**Recorded consequence (deliberate):** this changes the *default* model ceiling. With no env vars
set, `limitsConfig()` returns the sandbox defaults (30 s / 512 MiB), so the model ceiling becomes
**30 s / 512 MiB** rather than the #33 fixed 300 s / 1024 MiB. The model's `maxDurationSecs` /
`maxMemory` knobs become effectively *reduce-only* under defaults: a model can no longer request
more compute or memory than the sandbox would grant anyway. This is the intended, security-correct
posture — the model must never be able to out-ask the operator's configured bound — and it is the
whole point of #176. An operator who wants the model to get more raises the env var, and the
spec caps (300 s / 1024 MiB) still bind that raised value.

This is a deliberate reversal of #33's "caps are fixed at 300/1024" decision; the #33 `SPEC.md`
that asserted that is superseded by this file.

### D2 — Integerize the byte conversion with `Math.floor`

`maxMemory` reaches Monty as a byte count. `memoryMiB * BYTES_PER_MIB` can produce a fractional
value (`0.1` MiB → `104857.6`). Floor it: `Math.floor(memoryMiB * BYTES_PER_MIB)`. The clamp runs
first (so the value is already ≤ an integer cap); flooring only affects sub-MiB fractional inputs,
which otherwise leak a non-integer byte count verbatim.

### D3 — `clampModelLimits` becomes env-aware; tests own the env

`clampModelLimits` now reads `process.env` via `limitsConfig()` at call time, so it is no longer a
strictly pure function. Its JSDoc must say so. Tests that exercise the ceilings must set
`REPL_MAX_DURATION_SECS` / `REPL_MAX_MEMORY_MB` **and restore them** (save-and-restore in
`try/finally` or a `before`/`after` hook) so no state leaks to later tests in the file. `tsx --test`
runs each test file in its own process, so cross-file leakage is not a concern; intra-file
sequential execution is.

### D4 — The fix is entirely at the model boundary

`src/sandbox.ts` is not modified: `limitsConfig()` and the `??` defaulting in `toResourceLimits` are
the sandbox's correct contract (fill *unset* knobs from the operator/env). The bug is that the
*extension* hands the model's explicit value through in a way that overrides that contract. The fix
makes the extension stop trusting the model above the operator's bound, so `ReplRunner` (a faithful
library) never receives a value the operator forbade.

### D5 — Import path

`limitsConfig` is already exported from `src/sandbox.ts` and the extension already imports from
`../src/*.js` (e.g. `ReplRunner` from `../src/repl.js`, which transitively imports sandbox). Add
`import { limitsConfig } from "../src/sandbox.js";`. No new dependency, no new module boundary.

### D6 — Cross-issue guard

`#177` (repl_resume forwards limits) must consume the **same derived ceilings** — it must not
re-introduce hardcoded 300/1024. Note this in the close-out so #177's flight reads it. The new
env-var test lives in `test/extension.test.ts`, where #178's `runWithLimits` monkey-patch helper
also lives; the new tests do not touch `ReplRunner.prototype` and are unaffected by it.

## Commands

```
Focused:  npx tsx --test test/extension.test.ts
Test:     npm test                    # tsx --test test/*.test.ts
Type:     npm run check               # tsc --noEmit
Build:    npm run build               # tsc -p tsconfig.build.json
Lint:     npm run lint                # biome check --error-on-warnings
```

## Project structure (this flight)

```
extensions/repl-extension.ts   → the model boundary; ceilings + clampModelLimits live here
src/sandbox.ts                 → limitsConfig()/toResourceLimits(); NOT modified
src/types.ts                   → RunLimits; NOT modified
test/extension.test.ts         → clampModelLimits unit tests + "passes clamped limits" boundary test
```

## Code style

Follow the existing file: 2-space indent, double quotes, JSDoc on exported functions, `_`-prefixed
unused fixed-arity params, numeric separators (`1_048_576`). Keep the `clampCeiling` helper; do not
introduce a new abstraction unless the derived-caps computation reads clearer factored into a small
named helper — three similar lines beat a premature abstraction (incremental-implementation Rule 0).

## Testing strategy (TDD)

Test level: **unit** — `clampModelLimits` is a pure-ish boundary function; the sandbox is not driven.
The existing `describe("repl extension — clampModelLimits", …)` block is the home. The "passes
clamped limits" block already proves the tool forwards the result to `ReplRunner.run`, so unit
coverage of `clampModelLimits` plus that existing passthrough assertion satisfies the issue's
"reaches the sandbox as 256 MiB" acceptance.

New/reworked assertions (RED before GREEN):

1. **Operator memory env is the ceiling.** With `REPL_MAX_MEMORY_MB=256`, `clampModelLimits(undefined, 1024)` → `{ maxMemory: 256 * BYTES_PER_MIB }`, never `1024 * BYTES_PER_MIB`.
2. **Operator duration env is the ceiling.** With `REPL_MAX_DURATION_SECS=10`, `clampModelLimits(1000, undefined)` → `{ maxDurationSecs: 10 }`, never `300`.
3. **Default ceiling is the sandbox default, not the spec cap.** No env vars → `clampModelLimits(10_000, undefined)` → `{ maxDurationSecs: 30 }` and `clampModelLimits(undefined, 2048)` → `{ maxMemory: 512 * BYTES_PER_MIB }` (replaces the stale `300`/`1024` assertions; renames their titles to say "derived ceiling").
4. **Fractional memory is floored.** `clampModelLimits(undefined, 0.1)` → `{ maxMemory: 104857 }` (was `104857.6`). `(undefined, 0.5)` stays `{ maxMemory: 524288 }`.
5. Unchanged passthrough cases: valid-below-cap values honoured (`(5, 128)`, `(300, 1024)` under a *raised* env still spec-capped), invalid → `{}`.

## Boundaries

- **Always:** run the focused test then the full suite + `check` + `build` + `lint` before declaring a task done; RED first; save/restore env in tests.
- **Ask first / Never:** (autonomous flight — no live ask) do not touch `src/sandbox.ts`, `ReplRunner`, or any file beyond `extensions/repl-extension.ts` and `test/extension.test.ts`; do not change the tool schema or descriptions.

## Success criteria

- `clampModelLimits` clamps against `min(specCap, limitsConfig() effective value)`, not a hardcoded constant.
- The `maxMemory` byte conversion is `Math.floor(memoryMiB * BYTES_PER_MIB)`.
- With `REPL_MAX_MEMORY_MB=256`, a model-supplied `maxMemory=1024` yields `256 * BYTES_PER_MIB` bytes; with `REPL_MAX_DURATION_SECS=10`, `maxDurationSecs=1000` yields `10`. (Issue acceptance.)
- The four stale fixed-cap assertions are updated to the derived ceilings; full suite green; `check`/`build`/`lint` clean.

## Assumptions (recorded)

1. **Option A (D1) is the intended reading** of "derive each ceiling from the same source as the sandbox default" — the default model ceiling tightens from 300 s / 1024 MiB to 30 s / 512 MiB. This is the security-correct posture and the issue's literal code. Recorded as a deliberate behavior change, visible to review.
2. **`maxDurationSecs` is compared against `limitsConfig().maxDurationSecs` (compute seconds), not `maxWallClockSecs`.** Both the model knob and `limitsConfig().maxDurationSecs` are compute-seconds (Monty interpreter time), so the comparison is apples-to-apples; the 300 s wall-clock value was #33's conflation and is deliberately not used as the duration ceiling.
3. **No `limitsConfig()` API change** — it already returns exactly what is needed (`maxDurationSecs`, `maxMemory` in bytes); bytes → MiB is recovered by `/ BYTES_PER_MIB`.

## Open questions

None blocking. (The resume-limits question #33 left open is owned by #177, not this flight.)
