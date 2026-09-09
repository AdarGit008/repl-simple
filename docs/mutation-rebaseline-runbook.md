# Mutation re-baseline runbook (Monty 0.0.21)

**Status:** **Done — #175 closed.** · **Config:** `stryker.config.json` · **Harness:**
`scripts/contained.mjs` (the tap runner reports its own harness deaths) · **Background:**
[`docs/mutation-testing.md`](mutation-testing.md)

> **Last run:** commit `a32b1a7` · 2026-09-10 · 8-core/23 GB dev host · **3h12m** ·
> **79.28%** (5756 detected of 7263 valid, 7269 mutants) · zero harness deaths ·
> `concurrency: 6`, `coverageAnalysis: perTest`, `incremental: false`, fresh cache.
>
> **Most of the procedure below is superseded, and kept because its *reasons* still hold.** The
> sweep no longer needs a 32 GB host, sharding, or a separate harness guard — the run costs three
> hours on an ordinary dev box. What changed and why is in
> [`docs/mutation-testing.md`](mutation-testing.md); what to do now is
> [The procedure, as of #175](#the-procedure-as-of-175). Read the rest for the traps, not the
> commands: the incremental-reuse trap, `REQUIRE_BRIDGE_TOOLS=1`, and provenance-over-freshness are
> all still live, and all still cost you a wrong number if ignored.

## The procedure, as of #175

```bash
rm -f .stryker-incremental.json && rm -rf .stryker-tmp reports
npm run mutation                       # ~3h12m; sets REQUIRE_BRIDGE_TOOLS=1 and contains the run
```

Then verify before believing it, in this order:

1. **It executed.** The progress line must climb from `0%` to `100%` over thousands of mutants. A
   sweep that "finishes" in minutes hit the incremental-reuse trap below — that is the failure this
   runbook was written for, and deleting the cache above is what prevents it.
2. **No skips.** `skipped 0` in the dry run. A skipped bridged test is a survivor scored blind.
3. **The distribution, before the machine.** If timeouts look high, check *where* they are
   (`reports/mutation/mutation.json`) before blaming contention — real hangs cluster in the files
   whose tests block; contention scatters uniformly.
4. **Record the numbers** — [Step 4](#step-4--record-the-numbers) below is unchanged and is the
   part that matters.

Sharding (Step 2) is now only for restarting an interrupted sweep, not for fitting one into a host.

**What this was written to answer, and the answer.** The 58% floor and every per-file score in
`docs/mutation-testing.md` were measured at `b0d298d`, before the 0.0.21 migration rewrote
`src/sandbox.ts`, added `src/pool.ts` and moved Python into worker subprocesses, and before
`src/rlm.ts` absorbed `rlm_loop.ts` (#78). The measurement has now been made: **2231 → 7269
mutants, 58.09% → 79.28%**, floor raised to 79.

The premise that made this a standalone, big-host, out-of-session job was the **107-hour** sweep the
`command` runner implied. That premise is gone: with `coverageAnalysis: perTest` the same tree
measures in three hours on the dev box. The one constraint that survives is the last bullet under
[What you need](#what-you-need) — do not share the host with anything else running the suite.

## What you need

- **[superseded]** ~~A host with **≥ 32 GB RAM**~~ — 23 GB with `concurrency: 6` peaked at 4 GB
  used; a test worker is ~226 MB. The 5.6 GB worker below was `rlm_loop.ts`, deleted by #78. Still
  wanted: a systemd user session (`XDG_RUNTIME_DIR` set, `systemd-run`
  present), so `scripts/contained.mjs` can cap the run. 20G was ample for the last full run at
  `concurrency: 2` (`docs/mutation-testing.md`, "What the fix costs you in memory"); the three
  recursion-guard mutants in `src/rlm.ts` (`onRLMQuery`'s `depth >= maxDepth` branch) each drive one
  worker to **5.6 GB**, and two of them together exceeded a 12G ceiling. Size the ceiling for that,
  and remember every Stryker worker now spawns `monty` workers of its own.
- Node ≥ 22.19 on glibc Linux; `fd` and `rg` installed (`apt install fd-find ripgrep`). The
  **`npm run mutation` script** sets `REQUIRE_BRIDGE_TOOLS=1` (the deleted guard used to), so a host
  without them fails the dry run rather than silently scoring the bridged tools' mutants as
  survivors. Invoking `stryker run` by hand skips that — export it yourself.
- A **fresh clone** at the commit you are baselining (`git rev-parse HEAD` goes into the report),
  `npm ci`, and **no** `.stryker-incremental.json`, `.stryker-tmp/` or `reports/` from anywhere
  else. This is the whole reason the incremental file is in `.gitignore`.
- Nothing else running the suite on that host, for the whole sweep. The harness scores a mutant on
  the test process's exit alone: a harness killed by the OOM killer, or starved into a timeout by a
  sibling suite, was recorded as a *caught* mutant under the old command runner (#109). The tap
  runner no longer makes that mistake — a dead process is an error, not a kill — but contention
  still produces spurious *timeouts*, which do count as detected. Check the per-file distribution
  before trusting a timeout count: real hangs cluster in the files whose tests block.

## Why the incremental cache must be fresh

**Read this for the trap, not for the current config.** `stryker.config.json` had
`coverageAnalysis: "off"` with `incremental: true` when this was written; it is now `perTest`, so
the *unconditional* reuse path below no longer applies — but `incremental: true` is still set and a
stale cache still carries statuses forward, so the rule (delete the file, check provenance) is
unchanged. With `coverageAnalysis: "off"` and `incremental: true`, the
incremental differ's `mutantCanBeReused` answers *true* for every mutant whose source and tests did
not change textually, because the runner reported no coverage to compare — so a sweep against an
existing `.stryker-incremental.json` **re-executes nothing** and reproduces the previous run's
statuses under a fresh timestamp. Observed on the #150 flight (`docs/ship-150.md`): 0 of 287 mutants
re-ran, and every `statusReason` still cited the previous run's sandbox token. A re-baseline against
a stale cache would "measure" the pre-0.0.21 numbers again and call them new.

So: delete the file before you start, and keep the one this sweep produces — it is the artefact the
shards accumulate into (below).

```bash
rm -f .stryker-incremental.json .stryker-harness-deaths.log
rm -rf .stryker-tmp reports
```

## Step 1 — size the run

```bash
REQUIRE_BRIDGE_TOOLS=1 node scripts/contained.mjs --limit 20G stryker run --dryRunOnly
```

`--dryRunOnly` runs the initial (unmutated) test pass and lists the mutant count per file without
executing any mutant. Two numbers come out of it: the **total mutant count** on 0.0.21 (the last
full run had 7269) and the **suite's own duration** under the harness (~88 s for the 27 files).
At `concurrency: 6` with `perTest`, 7269 mutants took 3h12m — about 1.6 s of wall clock per mutant,
against ~82 s under the old `off` harness.

Write the estimate down before starting; a sweep that finishes far faster than it is the
incremental-reuse trap above, not good news.

## Step 2 — shard by `--mutate`, one incremental file

Run the tree in shards, each a `--mutate` glob over one or a few files, **sequentially**, all
writing the same fresh incremental file. Sharding is for restartability, not parallelism: a shard
that dies (OOM, a reboot) is re-run alone, and the shards already recorded in the incremental file
are not repeated — that is the one legitimate use of incremental reuse here, because the cached
statuses come from *this* sweep.

```bash
export REQUIRE_BRIDGE_TOOLS=1
for shard in \
  'src/sandbox.ts' \
  'src/pool.ts,src/session.ts' \
  'src/rlm.ts' \
  'src/rlm_tools.ts,src/registry.ts,src/builtins.ts' \
  'src/repl.ts,src/toolstore.ts,src/bridge.ts,src/bashenv.ts,src/pathjail.ts' \
  'src/truncate.ts,src/redact.ts,src/budget.ts,src/preamble.ts,src/types.ts,src/submit_signal.ts' \
  'extensions/repl-extension.ts'; do
  node scripts/contained.mjs --limit 20G stryker run --mutate "$shard" \
    --incremental --incrementalFile .stryker-incremental.json \
    || { echo "shard $shard failed"; break; }
done
```

> **`scripts/mutation-guard.mjs` no longer exists** (deleted in #175 — the tap runner records a
> dead harness as a RuntimeError at the runner level, so there is nothing left to post-check).
> Drop the `--report` line the loop used to carry after each shard.

Notes on the loop:

- `src/sandbox.ts` and `src/rlm.ts` are the big ones and the memory-hungry ones; they get shards of
  their own so a ceiling breach costs one file's progress.
- A shard whose harness died even once is a shard whose kills are suspect. That check used to be
  `mutation-guard --report`; it is now the `RuntimeError` count in the shard's own report, which
  must be zero for the files it mutated.
- `contained.mjs` exits 137 when the scope was OOM-killed *even if Stryker reported 0* — trust that
  exit code over Stryker's summary (`docs/mutation-testing.md`, "It stays fixed only if breaches
  stay loud").
- Keep `timeoutMS` at its committed 60 s and do not raise `concurrency` above what the memory
  arithmetic allows; timeouts count as *detected* and are score-neutral only when they are real
  timeouts, not contention (`docs/mutation-testing.md`, "Timeouts are a measurement artifact").

## Step 3 — assemble the report

With every shard in the incremental file, one full run reuses them all and writes the combined
HTML and JSON reports:

```bash
node scripts/contained.mjs --limit 20G stryker run --incremental --incrementalFile .stryker-incremental.json
```

This run should execute **zero** mutants and finish in about the suite's own duration — here the
reuse is the intent. Then verify the report before believing it:

1. **Freshness** — `reports/mutation/mutation.json`'s mtime postdates the sweep's start, and
   `list(json['files'].keys())` lists every file in `mutate` (`docs/mutation-testing.md`, "Reading
   the report").
2. **Provenance** — the `statusReason` strings cite sandbox tokens from *this* sweep's shards (each
   shard's `.stryker-tmp/sandbox-XXXXXX` name is in its log), none from any earlier run. A token you
   do not recognise means a stale cache got in.
3. **No harness deaths** — no mutant carries status `RuntimeError` in
   `reports/mutation/mutation.json` for a reason other than a genuine compile/runtime failure in
   the mutated code. (The #175 baseline had 9, all in `src/redact.ts`.)
4. **Skips** — `grep -c "skip" ` over the shard logs is zero; a skipped bridged test is a survivor
   scored blind.

## Step 4 — record the numbers

Everything below is what the next person will look for, in the order they will look:

1. `docs/mutation-testing.md` — replace "The baseline" (score, killed / timeout / survived counts,
   the per-file table), the host and duration line, and the `**[measured]**` tree hash; drop the
   "predates the 0.0.21 migration" banner. Name the survivors worth naming, as the current
   document does (M9, M22, the two `resume` ones), and re-check that every mutant it says is killed
   still is.
2. `stryker.config.json` — `thresholds.break`, set just under the new score the way 58 sits under
   58.09: rounding room, not slack. A lower floor than before is a regression to explain in the
   commit message, not a threshold to move.
3. `README.md`, "Mutation score" — the floor, the baseline, the CPU-hours and the mutant count; delete
   the paragraph saying the baseline is unverified, and the pointer to this runbook with it.
4. This file — a "last run" line at the top: commit, date, host, hours, score.
5. Commit the new `.stryker-incremental.json`? **No.** It stays ignored; attach it to the PR or the
   issue as an artefact if anyone wants to reuse it, with the sandbox tokens it carries.

The verifier of that PR should be able to reproduce every figure from the JSON report and the
shard logs alone; if a number in the docs cannot be found in them, it does not go in.

## What this runbook does not do

- It does not make mutation a CI gate. The run is hours long and memory-bound; it stays on demand,
  and `thresholds.break` is what `npm run mutation` fails on locally.
- It does not fix survivors. Every survivor named in the report is a candidate test to write, filed
  as a todo test in the suite (session decision 9), never as an issue.
- It does not run the mutation harness inside a worktree under `.claude/` or with another checkout
  of this repo active on the host: `contained.mjs` caps one scope, and the OOM arithmetic above
  assumes it is the only one.
