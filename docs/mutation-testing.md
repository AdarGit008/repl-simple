# Mutation testing

**Status:** Re-baselined on Monty 0.0.21, on a coverage-analysing harness · **Issue:** #175 (the
re-baseline) · #24 (the original) · **Tree:** `a32b1a7`

> **The harness changed with this re-baseline, and it is the reason the sweep is possible at all.**
> `testRunner` is now [`tap`](https://stryker-mutator.io/docs/stryker-js/tap-runner/) rather than
> `command`, and `coverageAnalysis` is `perTest` rather than `off`. The `command` runner cannot do
> coverage analysis — Stryker's own configuration reference says so — so every mutant re-ran the
> whole suite: 7269 mutants × 82 s, a **107-hour** sweep that nobody was ever going to run. With
> real per-test-file coverage the same tree measures in **3h12m**. `scripts/mutation-guard.mjs` is
> gone with the runner it existed to compensate for; see
> [The guard, and why it retired](#the-guard-and-why-it-retired).

This document records the full Stryker runs on this repository: the score, what it cost, how to
reproduce it, and the findings the runs turned up that are not about the score at all.

Everything below is marked **[measured]** — reproduced with the numbers given — or **[judgement]** —
reasoned, and stated so you can disagree with it.

---

## The baseline

**79.28%** — 5756 detected of 7263 valid mutants. **[measured]** Measured at `a32b1a7`, node 24,
8-core/23 GB host, `concurrency: 6`, `coverageAnalysis: perTest`, **3h12m**, **zero harness deaths**.
1.70 test files ran per mutant, against 27 in the tree.

| | count |
|---|---|
| Killed | 5663 |
| Timeout | 93 |
| Survived | 1386 |
| NoCoverage | 118 |
| Compile / runtime errors | 9 |

Per file, ascending:

| File | Score | Total | Killed | Timeout | Survived | NoCoverage |
|---|---|---|---|---|---|---|
| `src/bashenv.ts` | **65.49%** | 142 | 93 | 0 | 49 | 0 |
| `src/rlm_tools.ts` | **68.75%** | 48 | 33 | 0 | 15 | 0 |
| `src/sandbox.ts` | **72.68%** | 776 | 543 | 21 | 178 | 34 |
| `src/builtins.ts` | 77.04% | 601 | 461 | 2 | 130 | 8 |
| `extensions/repl-extension.ts` | 77.73% | 907 | 699 | 6 | 185 | 17 |
| `src/repl.ts` | 78.55% | 578 | 435 | 19 | 119 | 5 |
| `src/bridge.ts` | 78.84% | 241 | 190 | 0 | 47 | 4 |
| `src/truncate.ts` | 78.90% | 834 | 634 | 24 | 174 | 2 |
| `src/registry.ts` | 79.01% | 243 | 192 | 0 | 46 | 5 |
| `src/rlm.ts` | 79.90% | 841 | 662 | 10 | 159 | 10 |
| `src/toolstore.ts` | 82.55% | 1100 | 899 | 9 | 168 | 24 |
| `src/session.ts` | 84.50% | 671 | 567 | 0 | 100 | 4 |
| `src/pool.ts` | 89.47% | 38 | 34 | 0 | 4 | 0 |
| `src/pathjail.ts` | 89.74% | 78 | 69 | 1 | 4 | 4 |
| `src/redact.ts` | 91.59% | 116 | 97 | 1 | 8 | 1 |
| `src/budget.ts` | 100% | 34 | 34 | 0 | 0 | 0 |
| `src/preamble.ts` | 100% | 11 | 11 | 0 | 0 | 0 |
| `src/submit_signal.ts` | 100% | 8 | 8 | 0 | 0 | 0 |
| `src/types.ts` | 100% | 2 | 2 | 0 | 0 | 0 |

`src/index.ts` is instrumented but yields 0 mutants — it is a barrel of re-exports with no
mutable expressions. That is correct, not a coverage gap.

**`src/rlm.ts` is no longer the worst file, and is no longer zero.** #24's hand campaign scored it
**0/9**; the last sweep put it at 30.58%; it is now **79.90%**, 662 killed of 841. That closes
#70's "`rlm.ts`'s mutation score is no longer zero" exit criterion. **[measured]**

### 79.28% is not comparable to 58.09%, and neither is a regression

Two things changed at once, and both move the number: the tree grew (2231 → 7269 mutants across
waves 1–3 and the 0.0.21 migration), and the instrument gained coverage analysis. Per Stryker's
configuration reference, `perTest` "does *not* influence the resulting mutation testing score" —
it only skips tests that could not have killed the mutant anyway — so the *instrument* change is
score-neutral by construction. The rise is the tree's, not the harness's. **[judgement]**

The one genuinely new column is **NoCoverage**: 118 mutants in code no test executes at all. The
old `coverageAnalysis: "off"` harness could not distinguish those from survivors, because it never
learned what any test covered. They count against the score exactly as survivors do; they are
listed separately because "untested" and "weakly tested" are different repairs. Concentrated in
`src/sandbox.ts` (34) and `src/toolstore.ts` (24). **[measured]**

### Cross-file kills are the majority, and file-name mapping would have destroyed the number

Worth recording because it was nearly done the other way. `src/pool.ts` scores 89.47%, and its
kills come from **three** test files: `test/pool.test.ts` (9), `test/sandbox.test.ts` (16) and
`test/toolstore.test.ts` (9). A harness that ran only each source file's like-named test — the
obvious way to buy the same speedup without a coverage-analysing runner — would have scored
`pool.ts` at roughly **24%** and reported a testing crisis in one of the better-tested files in the
tree. **[measured]** Stryker's own [#4689](https://github.com/stryker-mutator/stryker-js/issues/4689)
requests exactly that mapping and is closed unimplemented; real coverage is the supported path.

### This supersedes the 58.28% baseline, which was inflated

The first baseline read **58.28%** — 1235 of 2119 at `e556a70`. It was measured with a harness that
counted an OOM-killed test run as a caught mutant, so it credited kills the tests never made. See
[Why the first baseline was wrong](#why-the-first-baseline-was-wrong).

`rlm.ts` is where that shows most plainly: **74/206 then, 63/206 now**, on an identical mutant count
in a file unchanged between the two trees. Eleven kills evaporated when the harness stopped inventing
them — and `rlm.ts` is exactly the file whose mutants change sandbox call counts, hence memory, hence
OOM. Elsewhere the tree genuinely improved: `registry.ts` gained 27 mutants and five points from
#116's memoisation tests, and the tree as a whole gained 112 mutants over nine commits.

### The floor sits just under the baseline

`thresholds.break` is **79**, against a measured 79.28. The 0.28 is rounding room, not drift budget
— the same relationship 58 had to 58.09. If a run comes in under it, treat that as a regression to
explain, not a threshold to lower. **[judgement]**

The floor moved **up** 58 → 79 because the tree's score did. Raising it is the ratchet working; the
history of this file is 57 → 58 → 79, and every step needed a measurement to justify it. **The one
move that needs an explanation in the commit message is a floor going down.**

A caveat this baseline carries that the previous one did not: it was measured in a single run, not
across the 16 that established the old band's reproducibility. The 0.28 is therefore rounding room
on *one* observation. If a re-run lands materially below 79, suspect the band before suspecting the
tests. **[judgement]**

---

## What it costs

**3h12m wall-clock, on one 8-core/23 GB host at `concurrency: 6`.** **[measured]** 7269 mutants,
1.70 test files per mutant.

Coverage analysis is the whole difference, and the arithmetic is worth keeping because it is what
made this sweep possible:

| | `coverageAnalysis: "off"` (command runner) | `perTest` (tap runner) |
|---|---|---|
| Test files per mutant | 27 (all of them) | **1.70** |
| One mutant | ~82 s | ~1.6 s average |
| 7269 mutants, concurrency 2 | **~107 hours** (measured ETA) | — |
| 7269 mutants, concurrency 6 | — | **3h12m** (measured) |

The 107 hours is not an extrapolation: the sweep was started under the old config and Stryker's own
ETA read `~107h 1m` at 16/7269 tested. That is why the runner changed. **[measured]**

Two things bound what is left:

- **`test/sandbox.test.ts` is 34.9 s**, 30% of the suite's serial time, and it covers most of
  `src/`. Its slowest cases are genuinely waiting — pool exhaustion, runaway loops, duration
  budgets — so this is real elapsed time, not waste. Every mutant in every file it covers pays it.
  Making it fast needs injectable clocks through the sandbox's test surface. **[measured]**
- **The box saturates before the cores do.** Raising `concurrency` 2 → 6 moved the ETA 32h → 17h
  (~1.9×, not 3×) with load average at 8.7–11.4 on 8 cores. Above 6 there is nothing left to buy
  here. **[measured]**

Memory is no longer the binding constraint it was: test worker processes measured **~226 MB each**,
6 of them against a 20G ceiling, 4 GB of 23 in use at peak. The 5.6 GB worst-case worker in the
sizing note below was `rlm_loop.ts`, deleted by #78.

**It is still not a laptop job**, and it must not share a host with anything else running the
suite — but a dev box can now do it overnight instead of over a weekend.

### Concurrency is bounded by memory, not cores

This is the non-obvious part, and it caused three failed runs before it was measured.

`npm test` is *already parallel* — node's test runner sizes itself to `os.availableParallelism()`.
Stryker then runs N of those concurrently, so the real process count is
`stryker.concurrency × node's own fan-out`, which oversubscribes any machine. **[measured]**

The config pins node's side with `--test-concurrency=3` so that Stryker's `concurrency` is the only
knob.

### Sizing, after the leak was fixed

This section has been wrong twice, so it is worth stating what changed.

It first gave `concurrency = min(cores / 3, (RAM_GB - 4) / 4.8)`, from a measured ~4.8 GB per
Stryker worker. That formula is what took the 8-core/24 GB box down on 2026-08-13: a worker was
really ~9 GB, because `probeTypeCheckerGaps()` leaked ~41 MB on **every** `runInSandbox` call, so a
worker's footprint grew with how long the run had been going. The kernel's OOM victim that day was a
single worker holding 13.4 GB.

It was then rewritten to claim per-worker memory is not a constant at all and no formula can be
safe. That was an over-correction built on a second error — it asserted the suite peaks the same at
every fan-out, from three data points that all happened to sit past saturation. Measured at
`--test-concurrency=1`, the pre-fix suite peaked at 3965 MB, not ~9 GB. Fan-out mattered the whole
time.

**#68 fixed the leak** by memoising the probes, and the numbers are now unremarkable. **[measured]**

| `--test-concurrency` | full-suite peak RSS | wall |
|---|---|---|
| 1 | 678 MB | 17 s |
| 3 | 996 MB | 8 s |
| default (8 here) | 1615 MB | — |

Compare 9040 MB at default fan-out before the fix.

**Do not size from that table alone — it is the *unmutated* suite.** This section has now been wrong
three times, and the third time was concluding from those numbers that `concurrency: 2` is "roughly
2 GB". A mutant can change what the suite does. Three of them disable the RLM recursion depth guard
and drive a single worker to **5.6 GB** (see [What the fix costs you in
memory](#what-the-fix-costs-you-in-memory)), so two workers reach ~11 GB and a 12G ceiling breaches
— which is exactly what happened on 2026-08-14.

Size the ceiling against the *worst mutant*, not the baseline suite: **~6 GB per worker**, so
`concurrency: 2` wants 20G and a host with the RAM to back it. **[measured]**

### Running it

```sh
npm run mutation
```

That sets `REQUIRE_BRIDGE_TOOLS=1` and wraps Stryker in a transient systemd scope with a hard memory
ceiling (`scripts/contained.mjs`). The scope is a *sibling* of your terminal's, not a child, so a
breach kills the mutation run alone — where an uncontained breach takes down the whole tmux pane,
editor session included, via `DefaultOOMPolicy=stop`. Raise or lower the ceiling with `--limit`:

```sh
node scripts/contained.mjs --limit 20G stryker run
```

There is no longer a `mutation-guard.mjs --report` step: the tap runner records a dead harness as a
RuntimeError rather than a kill, at the runner level. See
[The guard, and why it retired](#the-guard-and-why-it-retired).

`REQUIRE_BRIDGE_TOOLS=1` is in the npm script and not in the runner, which is a change worth
knowing about — the deleted guard used to set it. Invoking `stryker run` by hand without it does
not fail; it *skips* the bridged find/grep tests and scores their mutants as survivors. Export it.

`concurrency` is **6**, sized for an 8-core host. It is committed rather than left to Stryker's
`cpuCount - 1` default because the 79.28% baseline was measured at that value, and a gate figure
should be reproducible from the config that produced it. On a smaller box lower it; memory is not
the constraint it was (~226 MB per worker), cores are.

Containment is skipped automatically where there is no systemd user session (CI, containers), so
the command still works everywhere — it just stops protecting you.

Sharding across machines: split `mutate` into disjoint file sets — mutants are per-file, so the
`files` maps of the JSON reports merge by plain assignment. Give each host a `concurrency` sized by
its own RAM. Overlapping shards would double-count, so any merge script must reject them.

For pull requests, use `--incremental` (the config writes `.stryker-incremental.json`) or scope the
run with `--mutate`. **StrykerJS has no `--since` flag** — that is Stryker.NET's; `npx stryker run
--help` on 9.6.1 lists no such option. **[measured]** A full run belongs on a schedule or on demand.
**A mutation gate nobody can afford to run is not a gate.**

Never assert "sweep exits 0" when the sweep is launched through a pipe
(`contained.mjs … | tail -60`): bash returns the tail's status, and an orphaned run loses the
transcript entirely. Run long sweeps with output tee'd to a log (`nohup … | tee sweep.log` or
equivalent) so an agent death does not strand or silence the run, and read the verdict only from
machine-read statuses in `reports/mutation/mutation.json` — never the terminal. (The
`node scripts/mutation-guard.mjs --report` half of this rule went with the guard in #175; the
file-based half is the half that mattered.) (Observed live on the #110 flight,
2026-08-17: the launching agent died mid-sweep; the verdicts were recoverable only because they
are file-based.)

### Reading the report (freshness first)

The JSON reporter overwrites `reports/mutation/mutation.json` **only when the run finishes**.
During a sweep the previous run's JSON stays on disk. Before extracting any evidence, assert
freshness: mtime must postdate the sweep start **and** `list(json['files'].keys())` must
contain exactly the file(s) mutated. A `files` map with only `src/rlm.ts` while you sweep
`src/repl.ts` is the previous run, not yours (observed live on the #110 flight, 2026-08-17).

### Freshness is not provenance — the `coverageAnalysis: "off"` reuse trap

> **Partly historical since the `perTest` switch, and only partly.** The unconditional-reuse
> mechanism below was specific to `coverageAnalysis: "off"`: the differ could not compare coverage
> because the runner never reported any. Under `perTest` the runner does report it, so that
> particular always-true path no longer applies. **The provenance check below still does** —
> `incremental: true` is still set, a stale `.stryker-incremental.json` still carries statuses
> forward, and a report whose `statusReason` strings cite another run's sandbox token is still
> carried-over evidence. The 79.28% baseline was measured with `incremental: false` and a deleted
> cache, precisely so none of this could apply to it. **[measured]**

With `coverageAnalysis: "off"` and `incremental: true` (the config before #175), a non-`--force`
sweep **re-executes zero mutants**: the incremental differ's `mutantCanBeReused` returns `true`
unconditionally when the test runner reported no coverage
(`@stryker-mutator/core` `dist/src/mutants/incremental-differ.js`). Every `status`,
`statusReason` and `testsCompleted` is carried over from the previous run's cache, while the
report gets a fresh mtime and the right `files` key — the freshness check above passes and the
machine evidence still proves nothing new. Observed on the #150 flight (2026-08-17): 0 of 287
mutants re-ran; all 193 Killed `statusReason` strings embed the previous run's sandbox directory
(`sandbox-hybUqk` × 193 in `.stryker-incremental.json`; the current run's sandbox `WMtY7e` × 0).
Before trusting a report: (a) the SPEC must state which mode the DoD requires — `--force` (true
re-execution; ~2h15m cold for a single-file `--mutate src/repl.ts`) or incremental (fast,
carried-over); and (b) verify provenance, not just freshness — confirm `statusReason` strings cite
the **current** run's sandbox token, and treat a report whose statuses all cite a different token
as carried-over evidence that another proof must close (e.g. a hand-applied RED).

### `REQUIRE_BRIDGE_TOOLS=1` is not optional

The test command sets it. Without `fd` and `rg` present, `test/support/bridge-tools.ts` **silently
skips** the bridged find/grep tests and node reports green. Under mutation testing those mutants
then come back as survivors and the baseline is wrong in the pessimistic direction. The env var
turns the skip into a hard failure. Install with `apt install fd-find ripgrep`. **[measured]** — a
host missing them was caught this way before it could contaminate a shard.

---

## Why the first baseline was wrong

**Stryker's `command` runner scored a mutant on the exit code alone. A test harness killed by the
OOM killer was recorded as a caught mutant.** **[measured]** — this was #109, now fixed.

`command-test-runner.js` reads nothing but the status:

```js
if (exitCode === 0) { TestStatus.Success } else { TestStatus.Failed }   // -> Killed
```

A signal-killed process reports `code === null`, which lands in the `else`. So "a test caught the
mutant" and "the harness died" are the same event, and the *more* memory a run consumed the *better*
the tree appeared to be tested.

That is what moved the score between runs. Mutants **in** `rlm.ts`/`rlm_loop.ts` change loop
iteration counts, hence sandbox call counts, hence memory — and against the ~41 MB/call leak that
#116 later fixed, that reached OOM. Mutants in `bridge.ts` cannot change sandbox call counts, which
is exactly why it reproduced 159/159 and made the instability look like a property of the other two
files. Raising `--test-concurrency` from 3 to 4 raised the pressure, producing nine one-directional
`Survived → Killed` flips in `rlm.ts` and a score of 58.28% against the calmer run's 57.86%.

Demonstrated, not inferred: SIGKILLing the harness *after a fully green suite*, for one chosen
mutant, flips a stably-surviving mutant to `Killed`. **[measured]**

### The guard, and why it retired

**`scripts/mutation-guard.mjs` was deleted in #175.** It existed to compensate for one property of
the `command` runner — that Stryker derives the whole verdict from an exit code — and the `tap`
runner does not have that property, so the guard had nothing left to guard.

tap-runner refuses the verdict at two independent points, both in
`@stryker-mutator/tap-runner/dist/src`:

- `tap-helper.js` — `if (exitCodeResult !== 0 && !tapResult.failedTests.length) throw`. A process
  that exited non-zero while reporting no failed test is an error, not a kill.
- `tap-test-runner.js` — `runFile` reads a temp file the hook writes from `process.on('exit')`. A
  SIGKILLed process never fires `exit`, so the file is absent and `fs.readFile` throws ENOENT.

Either throw lands in `run()`'s catch and becomes `DryRunStatus.Error`, which Stryker records as a
**RuntimeError mutant, not a killed one**. Verified against the real command rather than by reading
it — a test file SIGKILLed mid-run, with a clean run as the control: **[measured]**

| | exit code | signal | temp file | verdict |
|---|---|---|---|---|
| SIGKILL (what the OOM killer sends) | `null` | SIGKILL | absent → ENOENT | **Error** |
| clean run (control) | 0 | — | written | a real verdict |

`exit code null` is exactly what the command runner scored as a killed mutant, and is the whole of
#109. Two earlier attempts at this check were invalid — a relative hook path made the control fail
identically to the kill, then the kill fired after the process had already finished — and the
control is what caught both. A death test without a control proves nothing.

The retired guard's logic, for the record. Node's test runner prints a `fail N` summary
on every genuine outcome, so its absence means the suite did not finish, whatever the exit code says:

| what the run produced | verdict |
|---|---|
| summary, `fail 0` | exit 0 — the mutant survived |
| summary, `fail > 0` | exit 1 — killed, by a real test |
| no summary | retry; if it keeps dying, log it and fail the run |

The first row is the demonstrated failure exactly: a suite that passes and *then* dies is a
surviving mutant. Stryker's command runner has no "measurement failed" channel, only pass and fail,
so an unrecoverable death cannot be given an honest verdict — it goes to
`.stryker-harness-deaths.log` and `npm run mutation` fails on it afterwards.

Both output dialects are accepted: node 24 prints `ℹ fail 0`, node 22 prints TAP's `# fail 0`.
A parser that knew only one would read every run on the other as a harness death.

### It stays fixed only if breaches stay loud

`contained.mjs` had the same defect one layer up. A full run hit the 12G ceiling at 24%, systemd tore
the scope down under `OOMPolicy=stop`, and the wrapper reported **exit 0** — the kill landed on the
scope, not on `systemd-run`, so no signal reached the caller. Forty minutes of dead run looked like a
clean pass. It now names its scope, reads the journal, and sets `OOMPolicy=continue` so one kill no
longer stops everything. **[measured]**

Two layers of this repo's own tooling turned a dead run into a green one. When a measurement can only
report pass or fail, assume the third outcome is being silently folded into one of them, and go
looking for it.

### What the fix costs you in memory

Three mutants disable the RLM recursion depth guard at `rlm_loop.ts:223-227` (the guard now lives in
`src/rlm.ts`, in `onRLMQuery`'s `depth >= maxDepth` branch — #78 deleted `rlm_loop.ts`) — `depth ?? 0`
to `depth && 0`, and the `depth >= maxDepth` comparison to `false` and to `depth < maxDepth`. Each
produces unbounded nested fan-out, and each drives one worker to **5.6 GB against a 667 MB baseline**.
**[measured]** Nothing else bounds that nesting; `maxIterations` bounds iterations *within* a loop.

At `concurrency: 2` two of them together exceed a 12G ceiling, which is what killed the run above.
Size the ceiling for it — 20G was ample — and note this is a standing proof of impact for **#87**
(no global spend budget across nested fan-out): in production that path burns tokens, not RAM.

### Timeouts are a measurement artifact, and are score-neutral here

A contended run produces spurious `Timeout` verdicts. On one 466-mutant shard, a run under CPU
contention with a 37 s budget reported 19 timeouts; the same shard re-run with headroom and an 88 s
budget reported **0**, with an identical survivor count and an **identical 58.15% score** — the 19
resolved to kills. Both `Killed` and `Timeout` count as *detected*, so the artifacts cancelled.
**[measured]**

They are still worth eliminating: the failure mode they *could* cause — a contention timeout masking
a real survivor — inflates the score, and cannot be ruled out by inspection. Sixteen of the 19 were
in `registry.ts`, whose only loop is a bounded `for…of`, and one was in `submit_signal.ts`, a
14-line class with no loop at all. Neither can hang.

Set `timeoutMS` generously (60 s here) and keep the machine off its memory limit.

Both runs in that comparison predate the guard, so some of those "kills" may themselves have been
harness deaths. The conclusion survives it — `Killed` and `Timeout` both count as detected, which is
arithmetic, not measurement — but the 58.15% figure should not be read as a baseline. The guarded
run reported 15 timeouts across the full tree. **[measured]**

**The 0.0.21 re-baseline's 93 timeouts are real, and the distribution is how you can tell.**
Mid-sweep the rate rose from 0.45% to 2.2% and the obvious suspicion was contention. It was wrong.
The finished report puts the timeouts where the slow, genuinely-blocking tests are and nowhere
else: `truncate.ts` 24, `sandbox.ts` 21, `repl.ts` 19 — every one of them covered by
`test/sandbox.test.ts`, whose slowest cases are pool exhaustion, runaway loops and duration budgets
(4.0 s, 3.8 s, 3.0 s, 3.0 s). Against that, **zero** timeouts in `session.ts` (671 mutants),
`bridge.ts` (241), `registry.ts` (243) and `bashenv.ts` (142). Contention scatters roughly
uniformly; it does not spare three files with 1155 mutants between them. The rule this gives you:
**check the per-file distribution before blaming the machine.** **[measured]**

---

## Survivors worth naming

#24 tracked two security-relevant survivors. **Both are now killed** on this tree: **[measured]**

| | Site | #24 | Now |
|---|---|---|---|
| **M9** — `gateMutating: true → false` | `src/repl.ts:95:71` | Survived | **Killed** |
| **M22** — drop `onApproval` from `session.run` | `src/repl.ts:41:44` | Survived | **Killed** |

Both were re-checked on the guarded run rather than carried over — a kill recorded by the old
harness is exactly the kind of claim this document can no longer make on trust. Both hold.

The run found M22's untracked sibling:

> **`src/repl.ts:62` — dropping `onApproval` from `session.resume()` survives.** Filed as **#110**.

`test/session.test.ts` covers `Session.resume({onApproval})` directly and well, but nothing drives
`Repl.resume()` and asserts the callback reaches the session. If that wiring regressed, the mutant
shows the suite would stay green.

Severity is lower than M22's: `src/session.ts:257` resolves a missing callback to `decision = false`
— it fails closed. This breaks the resume feature rather than opening an approval bypass.
**[judgement]**

**Closed 2026-08-17 (PR #147):** a targeted `--mutate src/repl.ts` sweep proved the mutant Killed
on the current tree — the `ObjectLiteral` is now at `src/repl.ts:235` and the `!session` guard at
`:210` (the `:62` cite above is stale since the #48/#59 rewrite); the killing test is
`test/repl.test.ts:517`. Evidence in `docs/verify-110.md`. That sweep also surfaced two **new**
resume-method survivors, tracked under #47:

- `src/repl.ts:230` — `StringLiteral` (the "nothing waiting for approval" message) — Survived.
- `src/repl.ts:233` — `UpdateOperator` (`live.busy--`) — Survived.

**Both closed (W3-2, 2026-09-08), by hand-applied mutants on the current tree** (the #110 closure
had verified only `:210` and `:235`):

- The `UpdateOperator` — `live.busy--` → `live.busy++` in `resumeWithTrace`'s `finally` — is killed
  by `test/repl.test.ts` "a pending suspension is never evicted — the pool exceeds its cap instead"
  (#59): a session whose resume never marks it idle keeps its eviction protection, and the test's
  "the abandoned protection kept the pool over cap" assertion reads `2 !== 1`. **[measured]**
- The `StringLiteral` survived because every assertion matched only the first sentence
  (`/nothing waiting for approval/i`); the M7 test in "every tool answers, in every state (#48)"
  now asserts the second sentence too, so blanking the literal fails it. **[measured]**

**Confirmed by the #175 full sweep (2026-09-10), and it found their sibling.** Both W3-2 closures
hold on a real sweep rather than a hand-applied mutant — in `src/repl.ts`, `live.busy++ → --` at
`:492` and `:575` are **Killed**, and the message `StringLiteral`s at `:563`, `:564` and `:566` are
**Killed**. Of five `UpdateOperator` mutants in the file, four die. The fifth does not:

> **`src/repl.ts:570` — `live.busy++` → `live.busy--` in `resume()` survives.** **[measured]**

It is the increment one line above the killed `finally { live.busy-- }`, and the same eviction
protection the #59 test pins for `run()`. Nothing drives a *resume* long enough to assert the
session is protected while it is in flight. Filed as a todo test in `test/repl.test.ts` per session
decision 9, not as an issue.

The obvious test does **not** kill it, which is why the todo carries the negative result rather
than just an intention. Parking a resume inside `onApproval` and inserting past `maxSessions`
leaves the mutant alive: `evict` skips an entry that is *either* `isSuspended()` *or* `busy > 0`
(`src/repl.ts:806-807`), and a session waiting on approval is still suspended, so `:806` protects
it and `:570` never runs as the deciding guard. The window where `busy` is the only protection
opens **after** approval — suspension cleared, `live.session.resume()` still executing the rest of
the snippet. A pin has to hold the session open *there*. **[measured]** — hand-applied mutant, suite
still green.

Three more equivalent-mutant notes, so nobody re-investigates them:

- `src/repl.ts:95:55`, `{ gateMutating: true } → {}` survives **legitimately**. `src/bridge.ts:209`
  defaults `options.gateMutating ?? true`, so the mutation is semantically identical to the original.
- `src/rlm.ts`, `submitted && result.status === "ok"` → `submitted && true` survives
  **legitimately**. A `SUBMIT` traced `ok: true` means `SubmitSignal` was thrown, and
  `src/sandbox.ts` returns `status: "ok"` on that path without another statement running — so the
  two conditions cannot disagree and no test can separate them. The clause is there to make that
  invariant checkable by the compiler, which is what lets `result.output` be read with no fallback
  for a status that cannot occur (#71). Its sibling mutant on the same line — dropping the
  `c.tool === "SUBMIT"` name check — **is** killed, by
  `test/rlm.test.ts` "does not treat some other tool's success as a submission".
- `src/index.ts` yields 0 mutants because it is a re-export barrel.
