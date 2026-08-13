# Mutation testing

**Status:** Baseline measured · **Issue:** #24 (Bucket 1, step 6) · **Tree:** `e556a70`

This document records the first full Stryker run on this repository: the score, what it cost, how to
reproduce it, and the two findings the run turned up that are not about the score at all.

Everything below is marked **[measured]** — reproduced on this tree at `e556a70`, with the numbers
given — or **[judgement]** — reasoned, and stated so you can disagree with it.

---

## The baseline

**58.28%** — 1235 detected of 2119 valid mutants. **[measured]**

| | count |
|---|---|
| Killed | 1206 |
| Timeout | 29 |
| Survived | 884 |
| NoCoverage | 0 |
| Compile / runtime errors | 0 |

Per file, ascending:

| File | Score | Detected / valid |
|---|---|---|
| `src/rlm.ts` | **35.92%** | 74 / 206 |
| `extensions/repl-extension.ts` | **40.26%** | 31 / 77 |
| `src/bridge.ts` | **41.51%** | 66 / 159 |
| `src/registry.ts` | 56.69% | 72 / 127 |
| `src/rlm_loop.ts` | 58.38% | 108 / 185 |
| `src/toolstore.ts` | 61.18% | 93 / 152 |
| `src/truncate.ts` | 61.43% | 223 / 363 |
| `src/repl.ts` | 62.71% | 37 / 59 |
| `src/sandbox.ts` | 63.40% | 246 / 388 |
| `src/session.ts` | 68.97% | 120 / 174 |
| `src/builtins.ts` | 71.35% | 127 / 178 |
| `src/rlm_tools.ts` | 71.74% | 33 / 46 |
| `src/types.ts` | 100% | 2 / 2 |
| `src/submit_signal.ts` | 100% | 3 / 3 |

`src/index.ts` is instrumented but yields 0 mutants — it is a barrel of re-exports with no
mutable expressions. That is correct, not a coverage gap.

`rlm.ts` being last is consistent with #24's hand campaign, which scored it **0/9**.

### The floor is set below the baseline, deliberately

`thresholds.break` is **57**, not 58.28. This is not slack for future regressions — it is the
measured reproducibility band of the suite itself. See
[The suite is not deterministic](#the-suite-is-not-deterministic): re-scoring the same tree from an
independent run yields **57.86%**. A floor at the measured score fails CI on unchanged code.

Raise the floor when #91 lands and the band collapses. **[judgement]**

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
knob. Then size it by **RAM, not cores**:

| | per Stryker worker |
|---|---|
| CPU | ~3.0 cores |
| **RAM** | **~4.8 GB peak** |

A 20-core / 30 GB machine fits 6 workers by CPU but only 4 by memory — and at 6 it drove the box
into swap (`si` ~600k, throughput down 3.5×). Memory binds first on every machine we tried.
**[measured]**

```
concurrency = min(cores / 3, (RAM_GB - 4) / 4.8)
```

### Running it

Full run, on a machine you are not using:

```sh
npx stryker run
```

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

## The suite is not deterministic

**18 mutants change verdict between runs of an identical tree.** **[measured]**

Two independent runs at `e556a70`, differing only in `--test-concurrency` (3 vs 4):

| File | Mutants | Agree | **Differ** |
|---|---|---|---|
| `src/bridge.ts` | 159 | 159 | **0** |
| `src/rlm.ts` | 206 | 197 | **9** |
| `src/rlm_loop.ts` | 185 | 176 | **9** |

`bridge.ts` reproducing 159/159 is what makes this a finding rather than noise: the instability is
specific to `rlm.ts` and `rlm_loop.ts`.

These are `Killed ↔ Survived` flips, which move the score. `rlm.ts`'s nine are all one direction
(Survived → Killed) and cluster at lines 40–129; `rlm_loop.ts`'s go both ways. Scoring the tree from
one run gives 58.28%, from the other **57.86%**.

This is direct evidence for **#91**. `test/support/bridge-tools.ts` already records the symptom —
*"it made two runs of an identical tree disagree"* — and these are the coordinates:

| File | Line:col | Mutator | Run A | Run B |
|---|---|---|---|---|
| `rlm.ts` | 40:24 | MethodExpression | Survived | Killed |
| `rlm.ts` | 53:23 | BlockStatement | Survived | Killed |
| `rlm.ts` | 54:28 | StringLiteral | Survived | Killed |
| `rlm.ts` | 60:47 | ObjectLiteral | Survived | Killed |
| `rlm.ts` | 79:7 | ConditionalExpression (×2) | Survived | Killed |
| `rlm.ts` | 128:7 | ConditionalExpression | Survived | Killed |
| `rlm.ts` | 128:25 | StringLiteral | Survived | Killed |
| `rlm.ts` | 129:12 | StringLiteral | Survived | Killed |
| `rlm_loop.ts` | 86:9, 89:9, 146:11 | ConditionalExpression | Killed | Survived |
| `rlm_loop.ts` | 146:29, 204:23 | StringLiteral, LogicalOperator | Killed | Timeout |
| `rlm_loop.ts` | 208:32, 212:15, 305:38 | BlockStatement, StringLiteral, ConditionalExpression | Timeout | mixed |
| `rlm_loop.ts` | 293:7 | StringLiteral | Survived | Killed |

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

---

## Survivors worth naming

#24 tracked two security-relevant survivors. **Both are now killed** on this tree: **[measured]**

| | Site | #24 | Now |
|---|---|---|---|
| **M9** — `gateMutating: true → false` | `src/repl.ts:95:71` | Survived | **Killed** |
| **M22** — drop `onApproval` from `session.run` | `src/repl.ts:41:44` | Survived | **Killed** |

The run found M22's untracked sibling:

> **`src/repl.ts:62` — dropping `onApproval` from `session.resume()` survives.**

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
