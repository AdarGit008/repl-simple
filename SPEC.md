# Spec: repl_resume must re-apply the suspended run's clamped limits, and the extension-layer signal forwarding must be pinned — issue #177

## Objective

A `repl` call that suspends on a gated (approval-requiring) tool carries its clamped resource
limits into the suspension, but `repl_resume` silently drops them: the resumed transcript re-runs
under the sandbox **defaults** (`limitsConfig()` — 30 s / 512 MiB by default), not the limits the
original call was granted. It is "safe direction" (more restrictive, never more permissive) but
asymmetric, and it means a resumed run can be governed by limits that differ from what the model was
told it had.

Second gap: the extension's `repl_resume` **does** forward the abort `signal` to `ReplRunner.resume`,
but no test proves it — every `repl_resume.execute(...)` test passes `undefined`. The deeper
`ReplRunner`→`Session`→sandbox signal path is already proven (#150 "abort-rt"), so the only unpinned
hop is extension→`ReplRunner`.

Success looks like: a resumed run honours the **same clamped limits the original `repl` call was
granted** (which are already derived from `limitsConfig()` via #176's `clampModelLimits`, so they
round-trip through the derived ceiling automatically — 30 s / 512 MiB by default, never 300 s /
1024 MiB), and a test pins that `repl_resume.execute` forwards the abort signal to
`ReplRunner.resume`.

Issue: https://github.com/AdarGit008/repl-simple/issues/177.
Parent bucket: #31 (Bucket 3 — Resource containment). Siblings: #176 (just merged — the derived
ceilings), #178 (same test file), #84 (owns the *broader* `suspendedRunOpts` merge — see D3).

## Current state (fact base — verified by scout, 2026-08-19)

| Fact | Value |
|---|---|
| `extensions/repl-extension.ts:354-377` | `repl_resume` schema = `{ sessionId? }` only. `execute` calls `r.resume(params.sessionId ?? "default", makeOnApproval(ctx, signal), signal)` — **no `limits` arg**. |
| `extensions/repl-extension.ts:338-347` | `repl` `execute` calls `r.run(code, sid, onApproval, signal, clampModelLimits(params.maxDurationSecs, params.maxMemory))` — the symmetric path that *does* supply clamped limits. |
| `extensions/repl-extension.ts:135-155` | `clampModelLimits` always returns a `RunLimits` object (never `"unbounded"`). |
| `src/repl.ts:218-253` | `ReplRunner.resume(sessionId, onApproval?, signal?, limits?)` — **already forwards** `limits` (and `signal`) via `live.session.resume({ onApproval, signal, limits })` at `:250`. The gap is one layer up. |
| `src/repl.ts:185-196` | `ReplRunner.run` → `session.run(code, { onApproval, signal, limits })` — identical object shape to resume. |
| `src/session.ts:366` | `Session.run` persists `this.suspendedRunOpts = runOpts` — the raw `{ onApproval, signal, limits }`. So the clamped limits are **already stored**. |
| `src/session.ts:389-472` | `Session.resume` builds `wrappedRunOpts = { ...runOpts, lineOffset, onApproval: gate(...) }` (`:435-439`) and **never reads `suspendedRunOpts` back**. Only serialization (`dump` `:542` / `load` `:610`) reads it. |
| `src/sandbox.ts:752-762` | `toResourceLimits(limits)` fills *unset* knobs from `limitsConfig()` (`??`). With `limits === undefined`, every knob falls back to `limitsConfig()` (30 s / 512 MiB / 300 s wall-clock). |
| `src/sandbox.ts:1313,1319` | `resumeSuspended` consumes `runOpts?.limits` for both `toResourceLimits(...)` and `hostDeadlineAt(...)`. |
| `src/types.ts:96-161` | `RunLimits` (all-optional knobs) and `RunOptions` (`limits?: RunLimits | "unbounded"`, plus `signal`, `onApproval`, `inputs`, `mount`, `maxStdoutBytes`, `maxOutputBytes`, `scriptName`, `lineOffset`). `resume` reuses `RunOptions`. |
| `test/repl.test.ts:2170` ("D7 test 3") | Already pins `ReplRunner.resume` forwards `{ onApproval, signal, limits }` to `session.resume`. Not the gap. |
| `test/repl.test.ts:530-548` (#150 "abort-rt") | Already proves `ReplRunner.resume` → sandbox signal. Not the gap. |
| `test/extension.test.ts:602+` | `repl_resume` tests (describe "suspension is reachable (#51)") all drive `execute` with `signal === undefined`, params `{ sessionId }` only. **No signal/limits pin.** |
| `test/session.test.ts` | No `Session.resume` test asserts limits or signal reach the sandbox. |

**Root cause (one line):** `Session.resume` reconstructs its options purely from the caller's
`runOpts` and discards the persisted `suspendedRunOpts.limits`. The extension cannot fix this — it
holds no record of the original clamp (it derives from the model's knobs at `repl` time and doesn't
retain them), so "forward the original limits" is only expressible at the `Session` layer.

## Scope

| In scope | Out of scope |
|---|---|
| `src/session.ts` — `Session.resume` re-applies `suspendedRunOpts.limits` when the caller supplied none | `src/sandbox.ts` (`limitsConfig`/`toResourceLimits`/`resumeSuspended`) — the `??` defaulting is the sandbox's correct contract |
| `test/session.test.ts` — prove resumed runs inherit the suspended (clamped) limits | `extensions/repl-extension.ts` — **no schema change** under the chosen fix (D1); no new model-suppliable knobs |
| `test/extension.test.ts` — pin that `repl_resume.execute` forwards the abort signal to `ReplRunner.resume` | `src/repl.ts` — `ReplRunner.resume` already forwards limits/signal (D7 test 3 covers it) |
| A tightened `REPL_MAX_MEMORY_MB` surviving into `resume` (test) | #84's broader merge (mount/inputs/scriptName/maxStdoutBytes) — see D3 |
| | #178's `runWithLimits` comment chore (separate issue) |

## Explicit decisions

### D1 — Option B: re-apply the suspended run's persisted clamped limits at the `Session` layer (not a schema change)

The fix is:

```ts
const wrappedRunOpts: RunOptions = {
  ...runOpts,
  limits: runOpts?.limits ?? this.suspendedRunOpts?.limits,
  lineOffset: this.prefixLineCount(),
  onApproval: this.makeApprovalGate(runOpts?.onApproval, willReplayKey),
};
```

`Session.resume` merges `suspendedRunOpts.limits` in when the caller did not supply `limits`.
`onApproval` and `signal` still come from the caller (they are deliberately **not** recovered from
the suspension — a stale/aborted signal must not be reused, and the approval callback must be the
fresh one).

**Why Option B over Option A** (expose `maxDurationSecs`/`maxMemory` on the `repl_resume` schema):
- The acceptance criterion is *"a resumed run honours the limits granted to the original `repl`
  call."* Only Option B honours the **original** grant. Option A would let the model *re-supply*
  limits on resume — a different grant, and a new attack surface the model doesn't need.
- The extension **cannot** forward the original limits: `clampModelLimits` runs at `repl` time and
  its output is not retained by the extension. The only durable record of the original grant is
  `Session.suspendedRunOpts`, which `Session.run` already wrote (`session.ts:366`).
- No schema change → no new model-suppliable knobs, no tool-description churn.
- Minimal diff: one merge field in `Session.resume`.

The title's "at the extension layer" describes where the asymmetry is *visible* (the `repl` vs
`repl_resume` execute bodies), not where the fix lives. The signal-forwarding half of the issue **is**
at the extension layer (see D2). This is a recorded, deliberate reading; the go/no-go at Phase 6 is
the human's chance to veto it.

### D2 — Signal forwarding is a test-only gap at the extension layer

`repl_resume.execute` already forwards `signal` (`extensions/repl-extension.ts:371-375`), and the
deeper hop is proven (#150). The deliverable is a test that drives `repl_resume.execute` with a real
`AbortSignal` (or stubs `ReplRunner.prototype.resume` to capture the signal — mirroring the
`runWithLimits` helper) and asserts the signal reaches `ReplRunner.resume`.

### D3 — Scope boundary with #84 (recorded, no conflict)

#84 ("`suspendedRunOpts` is saved, restored, and never used", OPEN, bucket-11) owns the *broader*
merge of `suspendedRunOpts` into `Session.resume` — `limits`, `mount`, `inputs`, `maxStdoutBytes`,
`scriptName`. #177 takes **only the `limits` field**, which is the single field its acceptance
requires. It deliberately does **not** absorb `mount`/`inputs`/`scriptName`/`maxStdoutBytes`. When
#84 lands it will generalise this same seam; this flight notes that hand-off in its close-out so #84
does not redo or conflict with it.

### D4 — Precedence: caller-supplied limits win, else suspended limits (`??`)

`runOpts?.limits ?? this.suspendedRunOpts?.limits`. In the only real path today (`repl_resume` → no
limits), the suspended limits apply. An embedder calling `ReplRunner.resume` with explicit `limits`
keeps the existing contract (explicit arg honoured). `"unbounded"` is a truthy string and is carried
through `??` unchanged. (Whether the suspended value should *always* win — #84's stated preference —
is left to #84; #177 does not need it.)

### D5 — Limits are already derived ceilings — the #176 D6 coupling is satisfied structurally

`clampModelLimits` (which already reads `limitsConfig()` per #176) produces the values persisted into
`suspendedRunOpts.limits`. Re-applying them on resume therefore inherits the **derived** ceilings
(`min(MAX_MODEL_DURATION_SECS, limitsConfig().maxDurationSecs)` = 30 s, and
`min(MAX_MODEL_MEMORY_MIB, limitsConfig().maxMemory / BYTES_PER_MIB)` = 512 MiB by default) with no
re-hardcoding of 300/1024 anywhere in this flight. A tightened `REPL_MAX_MEMORY_MB` flows through the
same clamp at `repl` time and is therefore preserved on resume.

### D6 — Env discipline in tests (inherited from #176/#178)

`limitsConfig()` reads `process.env` at call time. Any test that exercises limits across a
suspend/resume boundary must snapshot/clear/restore `REPL_MAX_DURATION_SECS` / `REPL_MAX_MEMORY_MB`
(the `before`/`after` pattern in `test/extension.test.ts:207-231`). The extension test file is run
sequentially; a stub on `ReplRunner.prototype.resume` (the `runWithLimits`-style pattern) must
restore in `finally`, and is safe only under that sequential assumption (which is #178's separate
chore).

## Commands

```
Focused:  npx tsx --test test/session.test.ts            # Session-layer limits-inheritance tests
Focused:  npx tsx --test test/extension.test.ts          # extension-layer signal-forwarding pin
Test:     npm test                                        # tsx --test test/*.test.ts
Type:     npm run check                                   # tsc --noEmit
Build:    npm run build                                   # tsc -p tsconfig.build.json
Lint:     npm run lint                                    # biome; scope to src extensions test
```

## Project structure (this flight)

```
src/session.ts               → the fix: Session.resume merges suspendedRunOpts.limits (one field)
src/sandbox.ts               → NOT modified (limitsConfig/toResourceLimits/resumeSuspended are the sandbox contract)
src/repl.ts                  → NOT modified (already forwards limits/signal)
extensions/repl-extension.ts → NOT modified (no schema change under D1)
test/session.test.ts         → NEW: resumed run inherits suspended clamped limits (+ tightened-env survival)
test/extension.test.ts       → NEW: repl_resume forwards the abort signal to ReplRunner.resume
```

## Code style

Follow the existing files: 2-space indent, double quotes, JSDoc on exported functions, `_`-prefixed
unused fixed-arity params, numeric separators (`1_048_576`). Do not introduce a new abstraction for a
single `??` merge field; the change should read as one obvious line in `Session.resume`.

## Testing strategy (TDD, RED first)

Test level: **integration at the `Session` seam for the limits fix**; **unit (seam) at the extension
for the signal pin**. The `ReplRunner`→`Session` hop is already covered (D7 test 3) — do not re-prove
it.

Assertions (RED before GREEN):

1. **Resumed run inherits the suspended limits.** Suspend a `Session` run granted explicit limits
   (e.g. `{ maxDurationSecs: 5 }` or a memory value below the default), then `resume` **without**
   limits and assert the resumed execution was governed by the suspended limits, not
   `limitsConfig()` defaults. The observation mechanism (a below-default `maxDurationSecs` that
   times out on resume, a seam/spy, or a serialisation assertion on `suspendedRunOpts`) is chosen by
   the planner and pinned by the coder's RED test.
2. **Tightened `REPL_MAX_MEMORY_MB` survives into resume.** With `REPL_MAX_MEMORY_MB=256`, a run
   clamped to 256 MiB suspends; its resume still honours 256 MiB (never the 512 MiB default). Env
   saved/restored.
3. **`repl_resume` forwards the abort signal.** Stub `ReplRunner.prototype.resume` (or drive
   `repl_resume.execute` with a real `AbortSignal`), assert the signal reaches `ReplRunner.resume`.
   Restore the prototype in `finally`.
4. Unchanged: resume with an explicit `limits` still honours the explicit value (D4 precedence);
   `onApproval`/`signal` come from the caller (already proven, must not regress).

## Boundaries

- **Always:** RED first; run the focused test then the full suite + `check` + `build` + `lint`
  (scoped to `src extensions test`) before declaring a task done; save/restore `REPL_*` env and
  restore stubbed prototypes in `finally`.
- **Ask first / Never (autonomous — no live ask):** do not touch `src/sandbox.ts`, `src/repl.ts`,
  `extensions/repl-extension.ts`, or any file beyond `src/session.ts`, `test/session.test.ts`,
  `test/extension.test.ts`. Do not change the `repl_resume` schema or its tool description. Do not
  absorb #84's broader merge (mount/inputs/scriptName/maxStdoutBytes). Do not re-hardcode 300/1024.

## Success criteria

- `Session.resume` re-applies `suspendedRunOpts.limits` when the caller supplied none; explicit
  caller limits still win.
- A resumed run honours the limits granted to the original `repl` call (derived ceilings, 30 s /
  512 MiB by default — never 300 s / 1024 MiB).
- A test pins `repl_resume.execute` forwarding the abort signal to `ReplRunner.resume`.
- A tightened `REPL_MAX_MEMORY_MB` survives into `resume` (tested).
- Full suite green; `check`/`build`/`lint` clean.

## Assumptions (recorded)

1. **Option B is the intended reading** (see D1) — the fix lives in `Session.resume`, not the
   extension schema. Recorded; veto point is the Phase 6 go/no-go.
2. **The resumed run may keep the caller's `signal`/`onApproval`** (fresh, not recovered from the
   suspension) — only `limits` is recovered. This matches #84's stated policy and #150's proof.
3. **The `Session`-level limits test may assert via an observable sandbox effect** (e.g. a
   below-default `maxDurationSecs` that the resumed run times out on) rather than a spy, since
   `resumeSuspended` is a module import. The planner pins the exact mechanism.

## Open questions

None blocking. (The broader `suspendedRunOpts` merge precedence — whether suspended limits should
*always* win over an embedder's explicit limits — is #84's, not this flight's.)
