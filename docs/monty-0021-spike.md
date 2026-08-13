# Monty 0.0.21 — migration spike

**Issue:** #40 · **Timebox:** one working session, stated up front and honoured — all seven questions
plus one added answered inside it. **Date:** 2026-08-13. **Versions:** pinned `0.0.18` vs published
`0.0.21` (`latest`, 2026-08-09).

## Recommendation: migrate

The deciding fact is not on #40's list, because nobody knew it when #40 was written.

**0.0.18 leaks ~41 MB of native memory on every `runInSandbox` call, and the leak is in a
constructor, so it cannot be fixed on 0.0.18.** `probeTypeCheckerGaps()` builds
`new Monty(name, { typeCheck: true })` per candidate; that specific option leaks **6.85 MB per
construction** and no forced GC returns any of it. It is native memory, so V8 never sees it —
`heapUsed` stays flat at ~9 MB, no pressure builds, no heap-limit abort fires, and the process simply
grows until the kernel kills something. On 2026-08-13 that was a worker holding 13.4 GB, which took a
whole tmux pane down with it. **[measured]**

```
0.0.18   60 runs                       -> 2718 MB, linear, GC reclaims nothing
0.0.21   60 type-checked sessions      -> host 53->55 MB, workers 9->16 MB
```

0.0.21 has no analogue to the probe at all: `typeCheckStubs` lets a caller *supply* stubs instead of
discovering gaps by constructing interpreters and catching the failures. The leak does not get fixed
so much as the code that causes it stops existing.

Everything the repo currently carries to survive that leak — the `SandboxMemoryError` guards in
`src/sandbox.ts`, `concurrency: 1` in `stryker.config.json`, `scripts/contained.mjs` — exists only
because of it. Migrating retires all three.

Bucket 1 is done and CI is green on four legs, which is the precondition #40 set: *you do not rewrite
the core of a system without a working test gate.* That gate now exists.

## Method

Each version installed into its own scratch directory; the repo's pinned dependency was never
changed. Every run contained under `systemd-run --user` with a memory ceiling, because the thing
being measured is memory exhaustion. Two independent agents re-ran the two findings that contradict
#40's own premises (§"Corrections"); both confirmed, and their evidence is stronger than the original.

## The seven questions

### 1. Does `feedStart` map onto our suspend/approve model, across a host process boundary?

**Yes.** This was the largest architectural risk and it passed cleanly. Process A ran until a gated
call, serialised, and exited. Process B — a different OS process — restored and resumed. **[measured]**

```
P1 paused on   : sensitive ["data"]        380-byte dump
--- process boundary ---
P2 restored as : FunctionSnapshot sensitive ["data"]
P2 result      : 10-APPROVED
```

`x = 10` was set before the call and survived into the resumed result, so this is genuine state
transfer, not a replay. The dump is 380 bytes.

**Caveat:** a restored `FutureSnapshot` cannot be `resumeAuto()`'d — its pending promises lived in the
previous process — and must be resolved with `resume([...])`. Approval flows that suspend on an
*async* external need that path written explicitly.

### 2. Packaging and platform — better, worse, or the same as the musl gap in #19?

**The same on the native path, and worse by default off it.**

`platformTriple()` hard-codes `linux-${arch}-gnu` and no musl triple is published, so #19's finding
stands unchanged: on Alpine, `npm install` succeeds and the module fails at load.

0.0.21 does bundle a wasm runtime (`dist/worker/monty_wasm_runtime.wasm`) reachable at
`@pydantic/monty/wasm`, which 0.0.18 shipped as the separate optional dependency
`@pydantic/monty-wasm32-wasi`. But it is **broken out of the box**: it imports
`@bjorn3/browser_wasi_shim`, which 0.0.21 declares **only in `devDependencies`**. **[measured]**

```
import("@pydantic/monty/wasm")
  -> ERR_MODULE_NOT_FOUND: Cannot find package '@bjorn3/browser_wasi_shim'
after `npm install @bjorn3/browser_wasi_shim`
  -> wasm feedRun 2+3 -> 5      WASM PATH WORKS in node
```

So an Alpine path exists and works, but only if *we* declare a dependency upstream forgot. That is an
upstream packaging bug worth reporting. It bears on bucket 10: we would carry an explicit dependency
that exists solely to repair someone else's manifest.

### 3. Cost — memory and startup per session, against `A41`'s unbounded session map

**Cheap per session; dangerous in aggregate, for a reason that is ours, not Monty's.** **[measured]**

| concurrent sessions | worker processes | total | last checkout |
|---|---|---|---|
| 1 | 1 | 9 MB | 32 ms |
| 2 | 2 | 17 MB | 29 ms |
| 4 | 4 | 34 MB | 35 ms |
| 8 | 8 | 68 MB | 57 ms |

~8.5 MB and ~30–57 ms per session — cheaper than 0.0.18, which leaked five times that per *call*.

The hazard is exhaustion. `maxProcesses` defaults to the CPU count and **`checkoutTimeout` defaults to
waiting forever**, so with an unbounded session map the first session past the cap hangs silently — no
error, no timeout, no log. With `checkoutTimeout: 2` it rejects cleanly after 2002 ms.

`checkoutTimeout` is **pool-level only**. Verified against `dist/pool.js`, not the docs: `checkout()`
reads `scriptName`, `limits` and the type-check options and nothing else. A caller cannot say "this
request should give up after 5 s"; the only options are one pool-wide value, or separate pools.

### 4. `MontyCrashedError` — what surfaces, and is session state recoverable?

**A crash surfaces cleanly, the pool survives, and the session's state is gone for good.** **[measured]**

```
pre-crash state : PRECIOUS
crash surfaced  : MontyCrashedError timedOut=true | props: [typeName, innerMessage, name, timedOut, exitStatus]
post-crash read : THROWS MontyCrashedError
post-crash dump : THROWS MontyCrashedError      <- state cannot even be salvaged
pool after crash: 42                            <- fresh checkout works
```

This is an **improvement** over 0.0.18, where the equivalent runaway freezes the event loop and needs
SIGKILL of the whole host process — losing everything, not one session. What it costs us is code, not
capability: a failure mode that today kills the process must now be caught, and the model told its
session was lost rather than silently handed a fresh one.

Note the error *class* matters. The in-sandbox limit raises a catchable `MontyRuntimeError`; the
host-side backstop raises `MontyCrashedError` and destroys the session. Any error-kind mapping has to
distinguish them.

### 5. Do the limits still behave?

**Three answers, and they do not all point the same way.**

**(a) The event-loop win is real.** An infinite loop under a 1 s budget raised `MontyRuntimeError` at
1.001 s while the host timer went on ticking — **9 ticks during the hang**. On 0.0.18 the same case
fires zero timers in 12 s and needs SIGKILL. Bucket 3's founding premise genuinely dissolves.
**[measured]**

**(b) The clock inverted, and #40 does not mention it.** 0.0.18's `maxDurationSecs` is a wall clock and
host-suspended time counts against it — a correction #39 records as hard-won. 0.0.21's clock runs only
while the interpreter executes. Same script, same host behaviour (~0.75 s compute, 10 s host
suspension, more compute), as Monty itself reports the elapsed value it measured: **[measured]**

```
0.0.18  ->  time limit exceeded: 10.534380641s > 1s
0.0.21  ->  time limit exceeded:  1.000000017s > 1s   (raised at 11008 ms wall)
```

The falsification control: identical Python costing ~1 ms, the only variable 3 s of host suspension —
and on 0.0.18 that alone breaches. Under 0.0.21, 9 s of wall clock passes cleanly under a 4 s budget.

**(c) The budget is now cumulative and survives a restore.** Two ~1.5 s burns under a 2 s budget: the
first passes, the second breaches 520 ms in. After `dump()` → `loadSession()` into a fresh checkout, it
still breaches at 569 ms. **[measured]** On 0.0.18 `MontySnapshot.load()` resets the clock (#38), so
the limit bounds no whole run. That half of #38 is fixed upstream.

### 6. Does `typeCheckStubs` remove the line-shift?

**Yes, completely.** Stubs are supplied out-of-band rather than prepended to the source, so reported
positions are the user's own. A type error on line 3 of a 3-line snippet: **[measured]**

```
typeCheckFormat: "concise"  ->  user.py:3:10: error[invalid-assignment] ...
```

#77's measured +103-line shift has no mechanism left to arise from. The thrown error also carries a
structured `diagnostics` property, which #39 noted was unreachable on 0.0.18.

### 7. What does `CollectStreams` give us — is stderr separable, is ordering preserved?

**Ordering: yes. Separable in shape, unreachable in practice.** **[measured]**

```
[tool tool(["X"]) fires after 1 stream entry]
entry: {"stream":"stdout","text":"out-1\n"}
entry: {"stream":"stdout","text":"out-2 after tool: Y\n"}
entry: {"stream":"stdout","text":"out-3\n"}
streams seen : stdout
```

Entries are labelled `{stream, text}`, one per `print` including its newline — better than 0.0.18's
per-fragment firing (#69.2) — and the buffer is readable mid-feed, so tool calls can be correlated
against output position. That is what an honest `ToolCallTrace` ordering needs.

But sandboxed Python cannot write to stderr at all:

```
print('x', file=sys.stderr)  ->  TypeError: print() 'file' argument is not supported
sys.stderr.write('x')        ->  AttributeError: '_io.TextIOWrapper' object has no attribute 'write'
import warnings              ->  ModuleNotFoundError: No module named 'warnings'
```

So the `'stderr'` label exists for output Monty itself may emit, not for anything user code can
produce. Do not build a feature on separating them.

### 8. Does the constructor-time type-check leak persist? *(added to #40's DoD 2026-08-13)*

**No** — see the recommendation above. This is the finding that decides the spike.

## Corrections to #40's own premises

Both independently re-verified by separate agents tasked with refuting them.

**1. `MontyOptions.turnTimeout` does not exist in 0.0.21.** Zero matches across every installed file
including binaries; `tsc` rejects it as an excess property; at runtime `Monty.create({turnTimeout: 2})`
is silently ignored — `pool.js` reads exactly seven keys. It is a naming error rather than an invented
feature: `requestTimeout` is documented as a "hard per-turn deadline."

**2. #32 is not superseded — it is more necessary and newly buildable.** With `requestTimeout: 2`,
`maxDurationSecs: 2` and `durationLimitGrace: 1` all armed simultaneously, a host external that never
returns was not interrupted by anything; a host timer won at 8 s. **[measured]** The semantics explain
why: when the sandbox calls out, the worker *has* answered its protocol request, so the host owns the
time from then on. `requestTimeout` measures worker-side latency by construction and structurally
cannot see a stalled host; `maxDurationSecs` and `durationLimitGrace` are both defined on interpreter
execution time, which stops advancing while suspended.

On 0.0.18 `maxDurationSecs` at least bounded wall time as a side effect — too aggressively, killing a
3 s budget with ~1 s of compute. 0.0.21 removes that accident by design, so **nothing in the package
bounds host time at all.** Conversely #32's item 2 rationale inverts: `maxDurationSecs` becomes a clean
compute budget that can be set tight, because a slow `bash("npm test")` no longer eats it.

The one thing 0.0.21 does change is feasibility. #32 notes a host-side timer was unimplementable on
0.0.18 because a runaway froze the event loop. Under worker isolation it is not. **0.0.21 makes #32
item 3 buildable; it does not make it unnecessary.**

## What it costs

1. **A rewrite of `src/sandbox.ts`**, and of stub generation in `src/registry.ts`. Not a version bump.
2. **#32 item 3 still has to be built**, and matters more than before.
3. **musl needs a dependency we declare ourselves** to repair an upstream manifest.
4. **A crash must be surfaced to the model**, since the session is unrecoverable.
5. **`checkoutTimeout` must be set explicitly** on day one, or exhaustion hangs silently.
6. **`0.0.x` offers no stability guarantee.** These semantics may move again.

## Migration plan

Ordered so each step is verifiable against the bucket 1 gate before the next begins.

1. **Pin and declare.** `@pydantic/monty@0.0.21` plus an explicit `@bjorn3/browser_wasi_shim`. Report
   the missing dependency upstream. Re-document the musl position in `docs/`, per #19's DoD.
2. **Pool lifecycle.** One pool per process. Set `checkoutTimeout` and `maxProcesses` explicitly —
   never the defaults. Decide the session-to-worker policy against `A41` before any of it is load-bearing.
3. **Rewrite `runInSandbox`/`resumeSuspended`** onto `checkout()` → `feedStart`/`feedRun`, with the
   suspend/approve round trip in §1 as the acceptance test. Delete the `SandboxMemoryError` guards,
   `concurrency: 1`, and `scripts/contained.mjs` once the leak is provably gone.
4. **Replace stub generation** with `typeCheckStubs`, deleting `probeTypeCheckerGaps()`. Close #68 as
   superseded; keep its per-`cwd` registry half, which is ours.
5. **Build #32 item 3** — the host-side wall clock — now that it is both necessary and possible.
6. **Map the error kinds**, distinguishing catchable `MontyRuntimeError` from session-destroying
   `MontyCrashedError`.
7. **Re-run the #109 mutant set** once the leak is gone, to test whether the flake was memory pressure.

## Issue dispositions

| Issue | Disposition |
|---|---|
| #26 bucket 2 | **Unfreeze, re-scope.** The defects are real; `feedRun` and `CollectStreams` change the mechanism, so re-verify each against 0.0.21 before fixing. |
| #31 bucket 3 | **Premise dissolved, epic survives.** Worker isolation removes the event-loop block. Re-scope around what remains: host-side time, memory, context, attention. |
| #32 | **KEEP — and #40's entry for it is wrong.** Item 3 is not superseded, is now more necessary, and is newly buildable. Item 2's rationale inverts. Item 5 (`maxAllocations`) is indeed gone upstream. |
| #38 | **Fixed upstream, both halves.** `LoadSnapshotOptions.mount` restores mounts; the duration budget now survives a restore. Verify on migration, then close. |
| #64 bucket 8 | **Retained as the acceptance checklist for the migration**, which is what #40 designated it. |
| #66 aliasing | **Fixed upstream**, as #40 recorded. Keep open until a regression test exists on 0.0.21. |
| #67 degraded stubs | **KEEP, re-scoped.** `typeCheckStubs` changes the shape of stub generation; the property — a degraded stub silently stops checking — is ours and does not go away. |
| #68 memoize probes | **Superseded by the migration.** `probeTypeCheckerGaps()` ceases to exist, taking its ~41 MB-per-call leak and ~88 ms with it. Keep the per-`cwd` registry half. |
| #69 conversion/print | **Partly resolved.** Per-fragment firing (#69.2) is fixed — one entry per `print`. The value-conversion losses need re-verifying against 0.0.21 and are probably still ours. |
| #77 line shift | **Item 1 dissolved** — positions are the user's own. Item 2 (sandbox continuity) is unaffected and stays. |
| #84 `suspendedRunOpts` | **Absorbed.** The bug is in code the migration rewrites; carry the property into the new resume path or it returns. |
| #109 flake | **Re-test after migration.** The leak is a credible root cause; if it was, this closes as a consequence rather than needing its own hunt. |
| #19 musl (closed) | **Finding still stands**, plus the new wasm-shim gap. Re-document per step 1. |

## Undetermined

- Whether `requestTimeout`, if enabled, counts host-suspended time. It should not, by its
  documentation, but it was not measured.
- Which release between 0.0.19 and 0.0.21 introduced the clock change.
- Whether the embedded-CPython worker implied by `installDependencies` shares these semantics; every
  result here is against the default sandbox worker.
- Whether the reported execution time excludes worker-IPC round trips or only host callback time —
  below the resolution of these measurements.
- The value-conversion half of #69 (`dict`/`set` → `{}`) against 0.0.21.
