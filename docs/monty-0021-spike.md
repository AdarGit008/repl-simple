# Monty 0.0.21 — migration spike

**Issue:** #40 · **Timebox:** one working session, stated up front and honoured — all seven questions
plus one added answered inside it. **Date:** 2026-08-13. **Versions:** pinned `0.0.18` vs published
`0.0.21` (`latest`, 2026-08-09).

## Recommendation: migrate — for the structural wins, not for the leak

**Correction, 2026-08-13.** The first version of this document made the memory leak its deciding
fact and claimed it "cannot be fixed on 0.0.18 because it lives in a constructor". That was wrong,
and the claim was load-bearing, so it is corrected here rather than quietly edited.

The leak is real and was measured correctly: on 0.0.18, `probeTypeCheckerGaps()` cost ~41 MB per
`runInSandbox` call, 60 calls reached 2718 MB, and forced GC reclaimed none of it. Two things about
it were wrong.

**The mechanism.** It is not the `typeCheck` option. It is a type check that **fails**: **[measured]**

| construction | growth |
|---|---|
| `new Monty('open', {typeCheck: true})` — ty **rejects**, throws | **6.93 MB/iter** |
| `new Monty('len', {typeCheck: true})` — ty resolves, succeeds | 0.13 MB/iter |
| `new Monty('1 + 1', {typeCheck: true})` — succeeds | 0.00 MB/iter |

Every `TY_GAP_CANDIDATES` entry is a gap by definition, so all six throw. That is why the arithmetic
matched (6 × 6.9 ≈ 41) and why the option looked responsible.

**The conclusion.** Because the probe is a pure function over a constant list, memoising it removes
all of the per-call growth — in our own code, on 0.0.18, in ~40 lines. That is #68, which was already
open and already specified exactly this. Measured after the fix: **[measured]**

```
100 trivial runs, RSS      2.7 GB growing   ->   flat at 146 MB
5 trivial runs             464 ms           ->   1 ms
full suite peak            9040 MB          ->   1615 MB
```

So the leak is **not** a reason to migrate. It is our defect, it is fixed, and anyone reading this
document to justify a rewrite on those grounds would be reading a false premise.

**What does justify migrating** is the set of findings below that are structural — unobtainable on
0.0.18 at any effort, because they are properties of how the interpreter is hosted:

1. **A runaway no longer freezes the host.** 0.0.18: zero timer ticks in 12 s, SIGKILL required.
   0.0.21: `MontyRuntimeError` at 1.001 s with 9 host ticks during the hang. This is bucket 3's
   founding premise, and worker isolation dissolves it.
2. **Crash isolation.** A wedged session dies alone and the pool survives; on 0.0.18 the equivalent
   takes the whole host process.
3. **Correct line numbers.** `typeCheckStubs` removes the +13-line type-check prefix contribution
   to #77's shift (the remaining ~90 lines are ours — see the disposition on #77).
4. **One stream entry per `print`**, replacing per-fragment firing (#69.2).
5. **A duration budget that survives a restore**, fixing half of #38.

Those are worth a rewrite of `src/sandbox.ts`. The leak was not.

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

**Worse, and the first version of this document got this dangerously wrong.**

`platformTriple()` hard-codes `linux-${arch}-gnu` and no musl triple is published, so #19's finding
stands unchanged on the native path: on Alpine, `npm install` succeeds and the module fails at load.

0.0.21 bundles a wasm runtime (`dist/worker/monty_wasm_runtime.wasm`) reachable at
`@pydantic/monty/wasm`, where 0.0.18 shipped `@pydantic/monty-wasm32-wasi` as an optional dependency.
It is **broken out of the box** — it imports `@bjorn3/browser_wasi_shim`, which 0.0.21 declares only
in `devDependencies`: **[measured]**

```
import("@pydantic/monty/wasm")
  -> ERR_MODULE_NOT_FOUND: Cannot find package '@bjorn3/browser_wasi_shim'
after `npm install @bjorn3/browser_wasi_shim`
  -> feedRun('2 + 3') -> 5
```

**That "it works" is the trap.** It runs, so it looks like an Alpine path. On Node, `createWorkerPool`
selects `inProcessFactory` — there is no worker process at all. Measured on the wasm entry:
`session.workerPid` is `undefined`; `while True: pass` under a 1 s budget fires **0** host timer ticks
against 9 on the native path; and with no `maxDurationSecs` set, the same loop wedges the host
permanently, `requestTimeout` does nothing (it is threaded only into the browser factory), and SIGKILL
is required. **That is 0.0.18's exact failure mode.**

So on musl there is **no crash isolation, no event-loop survival and no host backstop** — which is to
say the single biggest reason to migrate (§Recommendation, items 1 and 2) does not hold there.
**Bucket 3's premise does not dissolve on musl.** Neither this document's first version nor the
reviewer who found this tested actual Alpine; both measured the wasm path on glibc, and that is the
limit of the claim.

A second upstream packaging defect, found while checking the first: `dist/worker/nodeFactory.js`
spawns `nodeWorkerEntry.**ts**` — though a `.js` exists — with
`execArgv: ['--import', '@oxc-node/core/register']`, another undeclared devDependency. That path is
dead as shipped, which is presumably why the wasm pool runs in-process.

Both defects are worth reporting upstream. For bucket 10 it means carrying an explicit dependency to
repair someone else's manifest, and documenting that Alpine is not merely unsupported but *silently
degraded* if a user reaches for the wasm entry.

**Not answered:** #40 also asks what `npm pack` looks like and what must appear in `files`, and its
acceptance comment adds the `engines` floor. 0.0.21 declares `engines.node >= 20` against our
`>=22.19.0`, so that one is "no change" — the other two remain open.

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
`diagnostics` property — a *formatted string* whose shape you pick at checkout, not structured data;
the d.ts says the checker's structured diagnostics never leave the worker.

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

`sys.stdout.write` and `os.write(2, ...)` fail the same way: it is a **`print()`-only I/O model**,
not a stderr-specific hole. The `'stderr'` label exists for output Monty itself may emit. Do not
build a feature on separating them.

### 8. Does the constructor-time type-check leak persist? *(added to #40's DoD 2026-08-13)*

**No.** 0.0.21 holds flat across 60 type-checked sessions where 0.0.18 reaches 2718 MB.

But this does **not** decide the spike, which is what the first version of this document got wrong.
The leak is ours, it is on the *throwing* path rather than the option, and #68/#116 removes it on
0.0.18 — measured flat at 146 MB over 100 runs. See the recommendation.

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
4. **A crash must be surfaced to the model.** The crashing turn is unrecoverable — `dump()` throws
   too — but this is bounded, not catastrophic: a dump between feeds is 165 bytes, so a
   checkpoint-per-feed policy caps the loss at one turn. It is still strictly better than 0.0.18,
   where the equivalent kills the whole host process.
5. **The no-`await` tool convention constrains which API the rewrite may use** — see plan step 3.
6. **`checkoutTimeout` must be set explicitly** on day one, or exhaustion hangs silently.
7. **`0.0.x` offers no stability guarantee.** These semantics may move again.

## Migration plan

Ordered so each step is verifiable against the bucket 1 gate before the next begins.

1. **Pin and declare.** `@pydantic/monty@0.0.21` plus an explicit `@bjorn3/browser_wasi_shim`. Report
   the missing dependency upstream. Re-document the musl position in `docs/`, per #19's DoD.
2. **Pool lifecycle.** One pool per process. Set `checkoutTimeout` and `maxProcesses` explicitly —
   never the defaults. Decide the session-to-worker policy against `A41` before any of it is load-bearing.
3. **Rewrite `runInSandbox`/`resumeSuspended`** onto `checkout()` → **`feedStart` + host-awaits +
   `snapshot.resume(value)`**, with the round trip in §1 as the acceptance test. Not `feedRun`: under
   `feedRun` + `externalLookup` a promise-returning external hands Python a coroutine
   (`TypeError: unsupported operand type(s) for +: 'coroutine' and 'int'`) and only blocks with an
   explicit `await`, while `renderPythonToolRules()` instructs the model to call tools *without*
   `await`. Either keep that convention and take the `feedStart` path, or change the rule
   deliberately — but the two cannot both stand. The guards and `concurrency: 1` are already
   revisited in #117; `scripts/contained.mjs` stays until the wasm/musl path has a backstop.
4. **Replace stub generation** with `typeCheckStubs`, deleting `probeTypeCheckerGaps()`. Close #68 as
   superseded; keep its per-`cwd` registry half, which is ours.
5. **Build #32 item 3** — the host-side wall clock — now that it is both necessary and possible.
6. **Map the error kinds**, distinguishing catchable `MontyRuntimeError` from session-destroying
   `MontyCrashedError`.
7. **Re-run the #109 mutant set** once the leak is gone, to test whether the flake was memory pressure.

## Issue dispositions

Corrected 2026-08-13 after an adversarial audit; six of the original thirteen were wrong, overstated
or incomplete, and five affected issues had been missed entirely.

| Issue | Disposition |
|---|---|
| #26 bucket 2 | **Not frozen and substantially done** — B7/B8/A12 were fixed and closed by #27, #28, #29 and #36. The original disposition told this issue to re-verify defects that no longer exist; it was written from the body rather than the state. What remains is #38 and the fourth exit criterion (raise the #24 floor), which is blocked on #109. Its FROZEN comment must also be retracted — it asserts `turnTimeout`. |
| #31 bucket 3 | **The CPU ceiling's *severity* is reduced; the epic and all four ceilings survive.** `toResourceLimits` still fails open, and 0.0.21 adds a second fail-open default (`checkoutTimeout` waits forever). Also addresses the dropped-knobs half: `maxAllocations` gone upstream, `durationLimitGrace` new, `maxMemory` unverified on 0.0.21. Retract the `turnTimeout` claim in its FROZEN comment. |
| #32 | **KEEP — and #40's entry for it is wrong twice** (wrong name, wrong conclusion). Item 3 is not superseded, is more necessary, and is newly buildable. Item 1 is *widened*, not unaffected: `checkoutTimeout`/`maxProcesses` are new fail-open defaults in its exact class. Item 2's rationale inverts. Item 6 gains the `MontyRuntimeError`/`MontyCrashedError` split. Item 7 gains two knobs. Item 4's `maxMemory` was verified on 0.0.18 only. Item 5 gone upstream, which #40 gets right. |
| #38 | **Duration budget: fixed upstream, measured. Mounts: unverified.** `LoadSnapshotOptions.mount` exists in the API but was never exercised here — and the sole source for that claim is the same #40 table that invented `turnTimeout`. Do not close on an API's name. Closing also requires **#84**, since mounts are dropped by two mechanisms and fixing one leaves the symptom. The `SnapshotLoadOptions` audit carries over. |
| #64 bucket 8 | **Retained as the acceptance checklist.** Four of five children are dispositioned (#66, #67, #68, #69); **#65 still needs one**. Note the tension: this epic forbids closing a child as fixed-upstream without a test. |
| #65 | **Needs a disposition.** Marked "unknown — must be verified" on #64's checklist; its three causes live in `rlm_tools.ts` and `sandbox.ts`, inside the rewrite. |
| #66 aliasing | **Fixed upstream.** Keep open until a regression test exists on 0.0.21, per #64's rule. Its `print(f)` residual is untested on 0.0.21. |
| #67 degraded stubs | **KEEP, re-scoped.** Path 2 (the probe declaring names `Any`) disappears with the probes; **path 1** — `validatedTypeStub`'s `name: Any = None` fallback — is ours and survives. |
| #68 memoize probes | **Partly superseded — and already partly fixed.** `probeTypeCheckerGaps()` ceases to exist under 0.0.21, but #116 memoised it on 0.0.18 first. **Two components survive:** `probeImportableModules()` (26 throwaway interpreters per `RLMLoop.run()`, DoD test 2 — also memoised in #116) and `ReplRunner.createSession` rebuilding the registry per session, which re-runs `validatedTypeStub`'s leaking constructor per tool (~0.17 MB each, measured). DoD test 4 is not met. |
| #69 conversion/print | **Finding 2 fixed** (one entry per `print`). **Finding 3 is answered by this spike** — no separable stderr — rather than being a new finding. **Finding 1 was already diagnosed** on the issue as ours and version-independent (`formatOutput`'s `String(value)`); the original disposition wrongly re-froze it. Findings 4 (ordering — newly buildable, unblocks #46) and 5 need dispositions. |
| #77 line shift | **Item 1 partly dissolved.** `typeCheckStubs` removes the +13 the prefix contributes; the remaining **~90 lines are ours** — `rlm.ts:202` concatenates the preamble and survives the migration unless the rewrite feeds it separately. This spike's supporting measurement used a 3-line snippet with *no preamble*, so it cannot speak to the residual. **Item 2 is not "unaffected"**: `feedRun` makes continuity achievable, so it becomes a rewrite decision — the same category as #84. |
| #84 `suspendedRunOpts` | **Absorbed, property must be carried.** Note its lines are in `session.ts`, which is not in this document's stated blast radius. |
| #109 flake | **Re-run the 18 mutants now, under #114's containment — do not wait for the migration.** The memory-pressure hypothesis is credible and defeats the issue's "idle machines with memory headroom" premise (evidence is in **PR #114**, not this document). But the `bridge.ts` control as originally argued is inverted: `coverageAnalysis: "off"` runs the whole suite per mutant, so every mutant sees identical pressure. What *is* file-specific is that mutants in `rlm.ts`/`rlm_loop.ts` can change iteration counts, hence sandbox call counts. Note also that the four `Killed ↔ Timeout` flips do **not** move the score; the nine one-directional `Survived → Killed` flips in `rlm.ts` are the ones that do, and remain unexplained. |
| #19 musl (closed) | **Finding stands and gets *worse*** — see §2. Two undeclared-dependency defects, and the wasm fallback silently forfeits crash isolation. |
| Bucket 7 (#58, #59, #61, #62) | **Needs dispositions.** #40's own table says bucket 7 is "dissolved by `feedRun`", #61 is frozen pending #40, and §1 here proves stateful sessions across a process boundary — the finding that settles it. #59 is separately implicated: the unbounded session map meets `maxProcesses` at CPU count and `checkoutTimeout` at forever. |
| #54, #63, #81 | **Named in #40's acceptance checklist, unanswered here.** #54 (`externalLookup` vs host-tool shadowing), #63 (persisted-session approvals vs the new dump), #81 (packaging: the new explicit dependency, and three of four questions still open). |

## Undetermined

- ~~Whether `requestTimeout`, if enabled, counts host-suspended time.~~ **Measured** in
  §Corrections: armed at 2 s against an 8 s host stall, it did not fire. It does not.
- Whether actual **musl/Alpine** behaves as the glibc wasm measurement in §2 suggests. No container
  runtime was used; every platform result here is glibc x64, Node 24.
- `npm pack` / what must appear in `files` (#40 asks; unanswered).
- Which release between 0.0.19 and 0.0.21 introduced the clock change.
- Whether the embedded-CPython worker implied by `installDependencies` shares these semantics; every
  result here is against the default sandbox worker.
- Whether the reported execution time excludes worker-IPC round trips or only host callback time —
  below the resolution of these measurements.
- The value-conversion half of #69 (`dict`/`set` → `{}`) against 0.0.21.
