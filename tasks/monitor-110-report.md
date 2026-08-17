# Issue-Monitor Report — #110 flight (`issue-110-resume-onapproval`)

Watched: SPEC.md, tasks/plan.md, tasks/todo.md, docs/verify-110.md, docs/review-110.md,
docs/ship-110.md, commit history, process table, `reports/mutation/mutation.json`, issue #110.

**Flight outcome (observed):** targeted sweep `--mutate src/repl.ts` ran 11:49→14:04 (~2h15m,
zero harness deaths); `docs/verify-110.md` (BUILD), `tasks/verify-110.md` (VERIFY re-check,
939/939), `docs/review-110.md` (approve + comment rephrase), `docs/ship-110.md` (GO + fan-out
corrections) all landed; PR #147 squash-merged to `main` 2026-08-17 14:23 local; issue #110
closed with the evidence comment. Branch history was rebuilt mid-flight (commit hashes changed:
`3d617b0`→`07a1d4d` etc.), so any later citation must use final hashes or `origin/main`.

Per discovered item: target issue → exact wording to append → where it should live so a future
flight reads it **before starting**.

---

## Item H (predecessor, confirmed) — stale `reports/mutation/mutation.json` can be misread as the current run's evidence

- **Severity:** HIGH (false-evidence hazard — a verdict read from the wrong run is exactly the
  #109/#110 class of mistake).
- **Source:** predecessor issue-monitor; confirmed by this monitor: the JSON on disk during the
  entire 11:49→14:04 sweep window was the previous run's (`mtime 00:14:59`, `files` map = only
  `src/rlm.ts`). Stryker overwrites it only at run end (14:04:39, `files` = only `src/repl.ts`).
  BUILD/VERIFY/REVIEW all performed the freshness check (single-key `files` map + mtime) — the
  hazard cost nothing this flight *only because the checks were done*.
- **Target:** durable mutation workflow doc `docs/mutation-testing.md` (the repo's mutation
  gotchas ledger; no open issue owns the harness docs).
- **Wording to append (a "Reading the report" gotcha):**
  > The JSON reporter overwrites `reports/mutation/mutation.json` **only when the run finishes**.
  > During a sweep the previous run's JSON stays on disk. Before extracting any evidence, assert
  > freshness: mtime must postdate the sweep start **and** `list(json['files'].keys())` must
  > contain exactly the file(s) mutated. A `files` map with only `src/rlm.ts` while you sweep
  > `src/repl.ts` is the previous run, not yours (observed live on the #110 flight, 2026-08-17).

## Item A — issue #110's DoD line numbers are stale on the current tree

- **Severity:** MED (a future flight reading only the issue body would hunt `:62`/`:57-60` and
  miss the real code).
- **Source:** SPEC Assumption 2; confirmed by monitor grep: mutant is now `src/repl.ts:235`
  (`live.session.resume({ onApproval, signal })`), guard is `:210` (`if (!live)`), plus a second
  D3-parity guard at `:224` (`this.sessions.get(sessionId) !== live`). Even inside this flight a
  line cite drifted (`:220`→`:224`, corrected by the SHIP test-engineer).
- **Target:** issue #110 body (edit the closed issue's body — GitHub allows it; the DoD/comment
  is what future readers see first).
- **Wording to append (top of body, after the Problem section):**
  > **Post-closure note (2026-08-17, PR #147):** the cited locations are stale since the #48/#59
  > rewrite (`8ac0a1e`, PR #128). The mutant is now `src/repl.ts:235` and the `!session` guard is
  > `src/repl.ts:210`; a second D3-parity guard sits at `:224`. The killing test already landed as
  > `test/repl.test.ts:517`. Closed by targeted mutation verification — evidence in
  > `docs/verify-110.md`. Re-read against the current tree, never these line numbers.

## Item B — the defect was already fixed before the flight started ("verification-only")

- **Severity:** MED (rediscovery risk: a future flight would re-implement what `8ac0a1e` did).
- **Source:** SPEC KEY FINDING: killing test landed in `8ac0a1e` (PR #128, 2026-08-14), one day
  after #110 was filed; its comment names #110.
- **Target:** issue #110 body (same post-closure note as Item A, first sentence).
- **Wording:**
  > Resolved on `origin/main` by `8ac0a1e` (PR #128): `test/repl.test.ts:517` "suspend →
  > resume(approve) runs the pending call" drives `Repl.resume()` (the wiring layer) and its
  > comment names #110. Remaining work was verification only — done in PR #147. Do not
  > re-implement.

## Item C — two survivors inside `Repl.resume()` are tracked nowhere (line 230, line 233)

- **Severity:** MED (tracked-gap loss: the issue's original "message string" survivor at old
  `:60` is now killed at `:211`, but a *new* message-string survivor exists at `:230`; closing
  #110 covers only `:210`/`:235`, and a reader could wrongly believe the whole method is clean).
- **Source:** this monitor, machine-read from the 14:04 `mutation.json`:
  `Survived StringLiteral line 230 repl '``'` ("nothing waiting for approval" message) and
  `Survived UpdateOperator line 233 repl 'live.busy--'`. `docs/verify-110.md` mentions the
  60 survivors only in aggregate; no doc enumerates these two.
- **Target:** open issue #47 "Bucket 5 — Suspension and approval" (natural home for
  resume-method gaps) **and** the survivor ledger in `docs/mutation-testing.md`.
- **Wording to append to #47:**
  > From the #110 sweep (PR #147, 2026-08-17): `src/repl.ts` `resume()` still carries two
  > survivors — `StringLiteral` at `:230` (the "nothing waiting for approval" message) and
  > `UpdateOperator` (`live.busy--`) at `:233`. The #110 closure verified only `:210` and `:235`;
  > these two are untracked elsewhere and should be killed or ledgered.

## Item D — `signal` abort-propagation is wired but unproven (follow-up issue owed)

- **Severity:** MED (coverage gap; ship-110.md lists it as a medium follow-up).
- **Source:** SPEC Assumption 4; SHIP test-engineer follow-up.
- **Target:** new issue (or append to #47).
- **Wording:**
  > `Repl.resume()` passes `signal` into `session.resume({ onApproval, signal })`, but no test
  > proves abort propagation on the resume path; the #110 killing test covers `onApproval` only.
  > Add a test that drives `Repl.resume()` with an already-aborted signal and asserts the
  > abort behaviour. Source: PR #147 flight (SPEC Assumption 4).

## Item E — sweep sizing calibration: 30–60 min/59 mutants estimate vs ~2h15m/287 mutants actual

- **Severity:** MED (planning; the REVIEW phase flagged it and deferred the open-issue wording
  to this monitor).
- **Source:** `tasks/plan.md` estimate ("59 valid mutants at the last measured baseline",
  `docs/mutation-testing.md` table row `37 / 59`); actual 14:04 JSON: 287 mutants
  (193 Killed / 60 Survived / 34 Timeout) → ~2h15m at `concurrency: 2`. The baseline table is
  pre-#48/#59 and stale. Predecessor monitor's "worker batches cycle every minute" observation
  was steady-state normal, not a stall.
- **Target:** `docs/mutation-testing.md` (durable home; `tasks/plan.md` is flight-scoped and was
  reverted to #74 state, so the doc is where the next flight will read sizing).
- **Wording to append (next to the baseline table):**
  > **Calibration (2026-08-17, #110 sweep):** the per-file mutant counts in the table above are
  > stale post-#48/#59. A single-file `--mutate src/repl.ts` sweep that day took **~2h15m for
  > 287 mutants** (concurrency 2, ~55–60 s per mutant pair, plus 34 × 60 s timeouts) — not
  > 30–60 min/59 mutants. Before budgeting any sweep, count mutants from a dry run; do not size
  > from this table.

## Item F — "sweep exits 0" is unverifiable when launched through a pipe; the transcript can be lost

- **Severity:** MED (false-pass hazard + lost terminal evidence).
- **Source:** this monitor (process table): the sweep ran as
  `node scripts/contained.mjs --limit 12G npx stryker run --mutate src/repl.ts 2>&1 | tail -60`.
  Bash reports the **last pipe element's** exit status, so exit 0 proves nothing about Stryker;
  when the launching agent died the pipe had no reader and the transcript was discarded. Task 1's
  acceptance "sweep exits 0" was therefore uncheckable from that invocation — the flight survived
  because the authoritative verdicts are `mutation-guard --report` (exit 0, zero fatal deaths)
  and machine-read JSON statuses.
- **Target:** `docs/mutation-testing.md` (command-workflow gotcha) + any future task plan's
  Verify block.
- **Wording to append:**
  > Never assert "sweep exits 0" when the sweep is launched through a pipe
  > (`contained.mjs … | tail -60`): bash returns the tail's status, and an orphaned run loses the
  > transcript entirely. Run long sweeps with output tee'd to a log, and read the verdict only
  > from `node scripts/mutation-guard.mjs --report` plus machine-read statuses in
  > `reports/mutation/mutation.json`.

## Item G (ops, low) — a long sweep must survive its launching agent

- **Severity:** LOW (the BUILD agent detached/died mid-sweep; the sweep was orphaned for over an
  hour and completed unattended; recovery worked because the verdict is file-based, per Item F).
- **Target:** ops note, fold into Item F wording in `docs/mutation-testing.md`:
  > Launch sweeps with `nohup … | tee …` or equivalent so an agent death does not strand or
  > silence the run; the recovery path is the JSON + `--report`, never the terminal.

## What was already recorded by the flight (no rediscovery risk — verify, don't duplicate)

- `docs/verify-110.md`: freshness check (stale 00:14 JSON named explicitly), 287-mutant full-file
  context, `signal` out-of-scope note, stale tree-wide floor note — all on `main` via PR #147.
- `docs/ship-110.md` follow-ups: `signal` test, 60-Survived backlog, stale floor re-baseline,
  plan calibration.
- `scripts/mutation-guard.mjs` already routes its death log to the real repo root (sandbox-copy
  trap documented in-script) and deletes a stale log at dry-run start — the `--report` result is
  trustworthy per run. No new wording needed there.

## Residual risks (after closure)

- The tree-wide mutation floor remains stale post-#40; #110's one-file sweep does not re-baseline
  it (flagged in SPEC/verify/ship; still owed).
- Items C, D, E, F above are advisory and **not yet applied** to their targets — the user owns
  GitHub state; nothing was edited by this monitor.
