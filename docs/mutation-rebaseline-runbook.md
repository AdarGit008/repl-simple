# Mutation re-baseline runbook (Monty 0.0.21)

**Status:** Standalone infrastructure work, run out of session · **Issue:** #175 (re-homed from
bucket 11 by session decision 17, 2026-09-08) · **Config:** `stryker.config.json` · **Harness:**
`scripts/mutation-guard.mjs` inside `scripts/contained.mjs` · **Background:**
[`docs/mutation-testing.md`](mutation-testing.md)

The 58% floor (`thresholds.break`) and every per-file score in `docs/mutation-testing.md` were
measured at `b0d298d`, before the Monty 0.0.21 migration rewrote `src/sandbox.ts`, added
`src/pool.ts` and moved Python into worker subprocesses; `src/rlm.ts` has since absorbed
`rlm_loop.ts` (#78) and grown the #165 charge/refusal branches that #175's comment asks to see in
scope. Nobody has measured what any of that did to the mutant population or the score. This is the
procedure for measuring it once, on a machine sized for it, and writing the result down where the
next reader will look.

It is deliberately not a session task: a full sweep is **tens of CPU-hours**, needs more memory
than the development host has to spare, and must not share the machine with anything else that
runs the suite. Do it on a big-memory host with nothing else scheduled, and come back with numbers.

## What you need

- A host with **≥ 32 GB RAM** and a systemd user session (`XDG_RUNTIME_DIR` set, `systemd-run`
  present), so `scripts/contained.mjs` can cap the run. 20G was ample for the last full run at
  `concurrency: 2` (`docs/mutation-testing.md`, "What the fix costs you in memory"); the three
  recursion-guard mutants in `src/rlm.ts` (`onRLMQuery`'s `depth >= maxDepth` branch) each drive one
  worker to **5.6 GB**, and two of them together exceeded a 12G ceiling. Size the ceiling for that,
  and remember every Stryker worker now spawns `monty` workers of its own.
- Node ≥ 22.19 on glibc Linux; `fd` and `rg` installed (`apt install fd-find ripgrep`) — the guard
  sets `REQUIRE_BRIDGE_TOOLS=1`, so a host without them fails the dry run rather than silently
  scoring the bridged tools' mutants as survivors.
- A **fresh clone** at the commit you are baselining (`git rev-parse HEAD` goes into the report),
  `npm ci`, and **no** `.stryker-incremental.json`, `.stryker-tmp/` or `reports/` from anywhere
  else. This is the whole reason the incremental file is in `.gitignore`.
- Nothing else running the suite on that host, for the whole sweep. The harness scores a mutant on
  the test process's exit alone: a harness killed by the OOM killer, or starved into a timeout by a
  sibling suite, is recorded as a *caught* mutant (#109), and `mutation-guard` can only catch the
  deaths it sees. Contention inflates the score in the direction that hides survivors.

## Why the incremental cache must be fresh

`stryker.config.json` has `coverageAnalysis: "off"` and `incremental: true`. In that mode the
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
full run had 2231 valid mutants) and the **suite's own duration** under the harness. The last
calibration was ~55–60 s per mutant pair at `concurrency: 2`, so

    wall-clock hours ≈ mutants × 30 s / 3600 / (concurrency / 2)

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
  node scripts/mutation-guard.mjs --report || { echo "harness deaths in $shard"; break; }
done
```

Notes on the loop:

- `src/sandbox.ts` and `src/rlm.ts` are the big ones and the memory-hungry ones; they get shards of
  their own so a ceiling breach costs one file's progress.
- `scripts/mutation-guard.mjs --report` after every shard: a shard whose harness died even once is
  a shard whose kills are suspect. The deaths log names the mutant; re-run that shard with more
  headroom before moving on.
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
3. **No harness deaths** — `node scripts/mutation-guard.mjs --report` exits 0 and
   `.stryker-harness-deaths.log` is empty.
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
