# Mutation testing

**Status:** Baseline re-measured on a guarded harness · **Issue:** #24 (Bucket 1, step 6) ·
**Tree:** `b0d298d`

This document records the full Stryker runs on this repository: the score, what it cost, how to
reproduce it, and the findings the runs turned up that are not about the score at all.

Everything below is marked **[measured]** — reproduced with the numbers given — or **[judgement]** —
reasoned, and stated so you can disagree with it.

---

## The baseline

**58.09%** — 1296 detected of 2231 valid mutants. **[measured]** Measured at `b0d298d`, node 22.23.2,
6-core/30 GB host, `concurrency: 2`, 140 minutes, **zero harness deaths**.

| | count |
|---|---|
| Killed | 1281 |
| Timeout | 15 |
| Survived | 935 |
| NoCoverage | 0 |
| Compile / runtime errors | 0 |

Per file, ascending:

| File | Score | Detected / valid |
|---|---|---|
| `src/rlm.ts` | **30.58%** | 63 / 206 |
| `extensions/repl-extension.ts` | **40.26%** | 31 / 77 |
| `src/bridge.ts` | **41.51%** | 66 / 159 |
| `src/truncate.ts` | 59.78% | 217 / 363 |
| `src/rlm_loop.ts` | 60.21% | 115 / 191 |
| `src/toolstore.ts` | 61.18% | 93 / 152 |
| `src/registry.ts` | 61.69% | 95 / 154 |
| `src/repl.ts` | 62.71% | 37 / 59 |
| `src/sandbox.ts` | 63.17% | 295 / 467 |
| `src/session.ts` | 68.39% | 119 / 174 |
| `src/builtins.ts` | 71.35% | 127 / 178 |
| `src/rlm_tools.ts` | 71.74% | 33 / 46 |
| `src/types.ts` | 100% | 2 / 2 |
| `src/submit_signal.ts` | 100% | 3 / 3 |

`src/index.ts` is instrumented but yields 0 mutants — it is a barrel of re-exports with no
mutable expressions. That is correct, not a coverage gap.

`rlm.ts` being last is consistent with #24's hand campaign, which scored it **0/9**.

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

`thresholds.break` is **58**. The old floor of 57 was not slack for regressions — it was the
reproducibility band of a broken instrument, and it cost a real point of gate strength. With the
instrument fixed the band collapses: 63 pinned mutants held identical verdicts across 16 runs
spanning two hosts, node 22 and 24, `--test-concurrency` 1/3/4 and Stryker `concurrency` 1 and 2.
**[measured]**

58 rather than 58.09 leaves 0.09 for rounding, not for drift. If a run comes in under it, treat that
as a regression to explain — not a threshold to lower. **[judgement]**

---

## What it costs

**~32.9 CPU-hours for a full run.** **[measured]**

The command runner re-runs the whole suite per mutant, and `coverageAnalysis` is `off` (the command
runner cannot report per-test coverage), so there is no test filtering to win back. The cost is
therefore fixed:

| | |
|---|---|
| One full suite run | **55.9 CPU-seconds** (426 tests) |
| Mutants | 2119 |
| Total | 2119 × 55.9 s ≈ **32.9 CPU-hours** |

Measured wall-clock, sharded across two machines:

| Host | Cores | Mutants | Wall |
|---|---|---|---|
| srv1 | 6 | 466 | 64 min |
| srv2 | 20 | 1653 | 216 min |

**Do not run this on a laptop or a dev box you are using.** The first attempt on an 8-core/24 GB
machine took it down.

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

That wraps Stryker in a transient systemd scope with a hard memory ceiling
(`scripts/contained.mjs`), and runs `mutation-guard.mjs --report` afterwards so a run that scored any
mutant from a dead harness fails instead of printing a number. The scope is a *sibling* of your
terminal's, not a child, so a breach kills the mutation run alone — where an uncontained breach takes
down the whole tmux pane, editor session included, via `DefaultOOMPolicy=stop`. Raise or lower the
ceiling with `--limit`:

```sh
node scripts/contained.mjs --limit 20G stryker run
```

`concurrency` is **2**, which needs a ~20G ceiling and a host with the RAM behind it — see the sizing
note above. On a smaller box drop to `concurrency: 1` rather than lowering the ceiling; a breach now
fails loudly, but a run that fails at 24% is still two wasted hours.

Containment is skipped automatically where there is no systemd user session (CI, containers), so
the command still works everywhere — it just stops protecting you.

Sharding across machines: split `mutate` into disjoint file sets — mutants are per-file, so the
`files` maps of the JSON reports merge by plain assignment. Give each host a `concurrency` sized by
its own RAM. Overlapping shards would double-count, so any merge script must reject them.

For pull requests, use `--incremental` (the config writes `.stryker-incremental.json`) or
`--since`. A full run belongs on a schedule or on demand. **A mutation gate nobody can afford to
run is not a gate.**

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

### The guard

`scripts/mutation-guard.mjs` is the test command now. Node's test runner prints a `fail N` summary
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

Three mutants disable the RLM recursion depth guard at `rlm_loop.ts:223-227` — `depth ?? 0` to
`depth && 0`, and the `depth >= maxDepth` comparison to `false` and to `depth < maxDepth`. Each
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

Two more equivalent-mutant notes, so nobody re-investigates them:

- `src/repl.ts:95:55`, `{ gateMutating: true } → {}` survives **legitimately**. `src/bridge.ts:209`
  defaults `options.gateMutating ?? true`, so the mutation is semantically identical to the original.
- `src/index.ts` yields 0 mutants because it is a re-export barrel.
