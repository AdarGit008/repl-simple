# Spec: Plumb signal and limits through the extension and ReplRunner — issue #33

## Objective

Make the shipped `repl` tool actually honour a user cancel and bound its own resource use. The
issue's "signal" half is **already done** (verified — see fact base); the real remaining work is
(1) forward `limits` through `ReplRunner`, (2) expose **clamped** limits as `repl` tool parameters,
(3) decide/document/assert what abort does to session state, and (4) reconcile the issue's stale
DoD items against HEAD.

Parent #31 (Bucket 3) · Blocked-by #27 (CLOSED) · Sibling #32 (CLOSED).
Issue: https://github.com/AdarGit008/repl-simple/issues/33

Success looks like: `ReplRunner.run/resume` forward `limits`; the `repl` tool exposes
`maxDurationSecs`/`maxMemory` with a hard clamp (the model can ask for more, never unbounded); a
cancel in Pi's UI stops later host-tool calls; the session-state-after-abort behaviour is
documented and test-pinned; the four issue tests exist and pass.

## Current state (fact base, verified 2026-08-19)

| Fact | Value |
|---|---|
| `src/repl.ts` `ReplRunner.run` (:175) | signature `(code, sessionId = "default", onApproval?, signal?)`; forwards `{ onApproval, signal }` to `session.run` (:184). **`limits` is not accepted.** |
| `src/repl.ts` `ReplRunner.resume` (:204) | signature `(sessionId, onApproval?, signal?)`; forwards `{ onApproval, signal }` to `session.resume` (:235). **`limits` is not accepted.** |
| `extensions/repl-extension.ts` | `repl` (:257) and `repl_resume` (:287) already use `signal` (underscore removed) and pass it through. `repl_reset` (:312) and `repl_abandon` (:362) still declare `_signal` — both synchronous, non-abortable. |
| `src/types.ts` `RunLimits` (:71–83) | optional `maxDurationSecs`, `maxMemory` (bytes), `maxWallClockSecs`, `gcInterval`, `maxRecursionDepth`. `maxAllocations` deliberately absent (un-enforced). |
| `src/types.ts` `RunOptions.limits` (:122) | `RunLimits \| "unbounded"`. |
| `src/sandbox.ts` defaults (:695–703) | `maxDurationSecs = 30`, `maxMemory = 512 MiB`, `maxWallClockSecs = 300`. `limitsConfig()` + `toResourceLimits()` fill unset knobs (fail-safe on omission, #32). |
| `Session.run`/`resume` | already accept full `RunOptions` incl. `signal` + `limits`; nothing deeper needs to change. |
| Abort semantics today | `Session.run` pushes the snippet on `status:"ok"` **only**; `aborted` (and every other non-ok) hits the "drop snippet, don't update cache" branch (`session.ts:342–343`). Host-tool side effects that ran before the abort persist. Un-documented, un-tested. |
| Tests | `test/repl.test.ts:530` (pre-aborted resume), `test/extension.test.ts:508` (abort settles the dialog) — **neither** aborts *between* pause points after ≥1 host call. No clamp test, no limits-forwarding test, no state-after-abort test. |

## Scope

| In scope | Out of scope |
|---|---|
| `ReplRunner.run`/`resume` accept + forward `limits` (D2) | Making `while True: pass` cancellable — pure-Python loops yield no pause points; bounded only by `maxDurationSecs` (#32). |
| Expose **clamped** `maxDurationSecs`/`maxMemory` on the `repl` tool (D3) | Exposing `maxWallClockSecs`/`gcInterval`/`maxRecursionDepth` to the model (D3) |
| Decide + document + assert session-state-after-abort (D4) | Rollback of host-tool side effects (impossible — side effects persist, D4) |
| End-to-end abort test through the extension path (D7 test 1) | Signal plumbing itself (already shipped, D1) |
| Scope-boundary sentence in the `repl` description (D6) | #35 (approval-dialog spam) — separate issue, blocked on this one |
| `_signal` DoD reconciliation (D5) | |

## Explicit decisions

### D1 — The signal half is already shipped; do not redo it

`ReplRunner.run`/`resume` and the `repl`/`repl_resume` tools already thread `signal` end to end
(#49/#75/#150). The issue body's line references (`repl-extension.ts:61`, `repl.ts:41`) are stale.
This flight adds only what is missing: `limits`, the clamp, and the abort-semantics pinning.

### D2 — `ReplRunner.run`/`resume` accept `limits` and forward it

Append `limits?: RunLimits | "unbounded"` as the last parameter of both `run` and `resume`, and
forward it into the `RunOptions` passed to `session.run`/`session.resume` (which already accept it).
The library keeps the full `RunLimits | "unbounded"` range — `"unbounded"` is a legitimate
*library* escape hatch; it is the **extension** (the model boundary) that must never offer it. No
defaults change here: omission stays fail-safe via `limitsConfig()` (#32).

### D3 — Clamp at the model boundary; expose only two knobs

The `repl` tool gains two optional numeric parameters — `maxDurationSecs` and `maxMemory` (MiB, see
below) — and **nothing else**. `maxWallClockSecs`, `gcInterval`, and `maxRecursionDepth` are not
model-exposable. A model-supplied limit is clamped, never trusted:

| Param | Clamp | Invalid → |
|---|---|---|
| `maxDurationSecs` | `min(v, 300)` when `Number.isFinite(v) && v > 0` | omit (sandbox default 30) |
| `maxMemory` (MiB) | `min(v, 1024)` when `Number.isFinite(v) && v > 0`; converted `* 1_048_576` to bytes | omit (sandbox default 512 MiB) |

- **Upper bound only** — a shorter/smaller request is always safe and is honoured; the clamp is a
  ceiling, not a floor. The caps are `MAX_MODEL_DURATION_SECS = 300` (the wall-clock default — the
  model can never out-run the host-side fail-safe) and `MAX_MODEL_MEMORY_MIB = 1024` (2× default).
- The clamp lives in `extensions/repl-extension.ts` (the model boundary) as a small pure helper so
  it is unit-testable in isolation; `ReplRunner` stays a faithful library and never clamps.
- The extension builds a `RunLimits` object and passes it through `ReplRunner.run`; it never emits
  `"unbounded"`.

### D4 — Abort rolls back the transcript only, not host-tool side effects

Pin the behaviour that already exists: an aborted run drops its snippet from the transcript (the
run is "as if it never ran" for later snippets — its variable bindings are not visible to a later
`repl` call), but any host-tool side effect that executed *before* the abort (a file written, a
`bash` command run) persists. Document this in `ReplRunner.run`'s JSDoc and assert the
transcript-rollback half with a test (side-effect persistence is documented, not asserted — it is
the sandbox's contract, and a test that a write persisted would be testing the filesystem, not this
change).

### D5 — The `_signal` DoD is rescoped, not force-fitted

`repl`/`repl_resume` already consume `signal` (the original defect). `repl_reset`/`repl_abandon`
are synchronous and non-abortable — a signal is genuinely meaningless there, and `noUnusedParameters`
is enabled, so the `_`-prefixed name is the correct lint-idiomatic marker for an unused fixed-arity
parameter. Decision: **keep `_signal` on those two**, add a one-line comment explaining why, and the
close-out updates the issue DoD from "No `_signal` remains" to "No `_signal` remains on the
abortable tools (`repl`, `repl_resume`)".

### D6 — Write the scope boundary into the `repl` tool description

Append to the `repl` tool's `description` (in `extensions/repl-extension.ts`) one sentence to the
effect of: *"Cancelling stops the run between tool calls; a pure-Python loop with no pause points
runs until the duration limit (`maxDurationSecs`)."* So "cancel does not stop an infinite loop" is
documented behaviour, not a surprise (issue DoD item 4).

### D7 — Testing (RED-first)

Four tests, per the issue (refined against HEAD):

| # | Test | Pins |
|---|---|---|
| 1 | Abort **mid-run through the real extension path** — after ≥1 host tool call returns, abort; assert later host calls never ran via a side-effect counter (not the returned status) | signal stops dispatch between pause points |
| 2 | A model-supplied limit **above the cap is clamped** (both `maxDurationSecs`→300 and `maxMemory`→1024), not honoured | D3 clamp |
| 3 | `limits` **and** `signal` actually reach `RunOptions` — a `ReplRunner`-layer test with a stub `Session` that fails if either field is dropped | M22-class guard (the dropped-`onApproval` mutation passed the suite) |
| 4 | **Session state after abort** — an aborted run's bindings are invisible to a later `repl` call in the same session (transcript rollback) | D4 |

Plus: full suite green, `npm run check` + `npm run build` clean, and the existing abort tests keep
passing (they are not replaced).

## Assumptions (recorded — fire-and-forget, no human asked)

1. **The signal half is done** — verified fact (D1), treated as an assumption only in that the issue
   body says otherwise; the spec overrides the stale body.
2. **Only `maxDurationSecs` and `maxMemory` are model-exposable** (D3). `maxWallClockSecs` stays a
   host-side fail-safe the model cannot touch; `gcInterval`/`maxRecursionDepth` are tuning knobs,
   not safety caps.
3. **Caps** are `300` s and `1024` MiB (D3) — chosen so the model can ask for a longer budget for a
   genuinely slow computation but can never exceed the wall-clock fail-safe nor double the memory
   default. The coder verifies the exact default constants against `sandbox.ts` during
   implementation; the caps themselves are fixed by this spec.
4. **Clamp is upper-bound only** (D3). A request for *less* than default is honoured, not raised.
5. **"Rolled back" means the transcript** (D4), never side effects.
6. **`maxMemory` is exposed in MiB** and converted to bytes at the boundary — the sandbox default
   and `RunLimits` speak bytes, but MiB is the unit a model reasons in and matches
   `DEFAULT_MAX_MEMORY_MB`.
7. **`ReplRunner` remains a faithful library** (D2/D3) — no clamping, no `"unbounded"` removal at
   the library layer; the clamp is the extension's job.

## Tech stack

TypeScript; `@pydantic/monty` 0.0.21 (native + workers). Tests: `node:test` via `tsx --test`,
`node:assert/strict`. `tsc` (check/build), Biome (lint/format), Stryker (mutation), custom V8
coverage vs `coverage-baseline.json`.

## Commands

```bash
npx tsx --test test/repl.test.ts test/extension.test.ts   # focused
npm test                                                   # full suite
npm run check                                              # tsc --noEmit
npm run build                                              # tsc -p tsconfig.build.json
npm run lint                                               # biome check --error-on-warnings
npm run coverage                                           # coverage floor gate
```

## Project structure

```text
src/repl.ts                → ReplRunner.run/resume gain `limits` + JSDoc (D2, D4)
src/types.ts               → unchanged (RunLimits already complete)
src/sandbox.ts             → unchanged (defaults + toResourceLimits already there, #32)
extensions/repl-extension.ts → clamp helper + two params + description sentence + `_signal` comment (D3, D5, D6)
test/repl.test.ts          → tests 3, 4 (D7)
test/extension.test.ts     → tests 1, 2 (D7)
```

## Code style

Match `src/repl.ts` and `extensions/repl-extension.ts`: JSDoc on public params, `//` inline
rationale, string-literal messages. The clamp helper is a small exported pure function
(`clampModelLimits(maxDurationSecs?: unknown, maxMemoryMiB?: unknown): RunLimits`) next to the
other extension helpers, so `test/extension.test.ts` can call it directly. No new dependencies.

## Testing strategy

RED before code. Test 3 stubs `Session` (the existing test suite already has a
`makeMockLlm`/stub precedent) and asserts the `RunOptions` object `session.run`/`resume` receives
carries `limits` and `signal`. Tests 1/2/4 exercise the real `ReplRunner` + extension path where
possible, or the nearest boundary that makes the assertion genuine (never a self-deriving
tautology). Every new test must fail against HEAD before its task's implementation lands.

## Boundaries

**Always:** RED before code; full suite + `npm run check` + `npm run build` after each task; keep
the clamp ceiling fixed (300 s / 1024 MiB) — no silent weakening; the extension never emits
`"unbounded"`.

**Never:** make `while True: pass` cancellable (out of scope, D1); expose
`maxWallClockSecs`/`gcInterval`/`maxRecursionDepth` to the model; clamp at the library layer
(ReplRunner); introduce a new dependency; change the sandbox's fail-safe defaults (#32).

## Success criteria

1. `ReplRunner.run`/`resume` accept `limits` and forward it into `RunOptions` (D2) — test 3 proves it.
2. The `repl` tool exposes `maxDurationSecs`/`maxMemory` clamped to 300 s / 1024 MiB (D3) — test 2 proves it.
3. An abort between pause points stops later host-tool calls (D7 test 1); the scope boundary is in the description (D6).
4. Session-state-after-abort is documented and pinned (D4) — test 4.
5. `_signal` remains only on the two synchronous, non-abortable tools, with a rationale comment (D5).
6. Four issue tests + full suite green; `npm run check` + `npm run build` clean.

## Open questions / risks

1. **`repl_resume` limits** — the issue's Do says both `run` *and* `resume` accept limits. A resumed
   run replays the transcript under a fresh worker and re-derives defaults; forwarding the caller's
   `limits` on resume is symmetric and cheap. The spec does it for both. If a future flight finds a
   reason resume must not re-clamp, that is a scope change.
2. **Clamp test location** — test 2 pins the clamp helper directly and the tool param above-cap
   behaviour through `execute`; if the extension's `execute` path is heavy to drive in-test, the
   coder may split it (helper unit test + one param-through test) and records that split in the task
   summary.
3. **Side-effect persistence assertion** — deliberately *not* tested (D4). Recorded here so a future
   flight does not "discover" it as a gap and write a filesystem test.
