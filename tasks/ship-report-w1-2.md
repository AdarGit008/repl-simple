# Ship Report — W1-2: `Session.resume` carries what it was suspended with (#38, #84, #26, #47)

Branch: `chunk/w1-2-session-resume-carries` · Base: `main` (`3770e46`) · Commits: `e12820c` (spec),
`043b37d` (RED), `c8c0d9b` (GREEN) · Spec: `tasks/spec-w1-2.md` (D73–D80) · Decision: **GO**

## What was built

1. **The carried-options seam** (`src/session.ts`, D73–D75). A suspension now keeps exactly four
   options — `limits`, `mount`, `maxStdoutBytes`, `maxOutputBytes` — as an explicit `CarriedRunOptions`
   pick, stored at both suspension sites and narrowed again on `load` (so a dump never carries an
   `AbortSignal` serialised as `{}`). `resume()` merges each field **caller-wins**
   (`caller ?? suspended`, maintainer decision 2 / #177 D4) and documents, field by field, what is
   deliberately not carried: `onApproval`, `signal`, `onPrint` (the current invocation's), `inputs`
   (in the snapshot), `scriptName` (feed-time diagnostics only), `lineOffset` (the session's).
   Through `ReplRunner.resume`, which passes `{ onApproval, signal, limits }`, a resumed run now has
   the mount and byte caps the suspended run was given.
2. **Bucket-5 residuals** (D78, D79). A resume whose `signal` is already aborted never consults
   `onApproval` — the call is denied and the sandbox's abort gate reports `aborted` before anything
   runs, matching the extension's own guard. `resumeSuspended` is awaited in `try/catch/finally`: the
   suspension is cleared whatever happens and a throw revokes the call's grants, so a continuation
   that fails to start leaves `isSuspended() === false` and `run()` clean.
3. **The two clocks, documented as measured** (`src/types.ts`, D76; `src/sandbox.ts` comment only).
   `maxDurationSecs` is cumulative across a suspension *and pinned in the snapshot* — a resume can
   neither lift, lower nor reset it; `maxWallClockSecs` restarts on every resume (decision 1). The
   0.0.18-era "suspension resets the sandbox clock" statement is gone. The `#84 untouched` comment in
   `src/sandbox.ts` is replaced by the `LoadSnapshotOptions` audit (#38 "Do" item 3): `printCallback`
   re-attached, `mount` re-supplied, `externalLookup` and `os` unused by design (this loop never
   calls `resumeAuto()` for host functions; OS calls outside the mounts are denied on both sides).
4. **Boundary guards for bucket-2 exit criterion 4** (D80). Tests exactly at the cap — `Truncator`
   bytes and lines, `truncateText`, and both sandbox entry points — that fail under the `>` → `>=`
   mutant at `src/truncate.ts:262`.

No code change in `src/sandbox.ts` (`git diff` non-comment lines: 0). No new dependency.

## Verification evidence

**Gates.** `npm run check` clean · `npm run lint` clean · `npm run test:contained` **1151 tests,
1150 pass, 0 fail, 1 todo** (35.9 s, exit 0) · `npm run coverage` **"All per-file floors met"**, exit 0 —
`src/session.ts` 98.87 (floor 98.73), `src/types.ts` 100.00 (100.00), `src/truncate.ts` 99.74
(floor 100.00; within the instrument's documented one-line tolerance — `scripts/coverage.mjs` records
this exact file measuring 99.74 or 100.00 run to run), `src/sandbox.ts` 97.69 (97.66)
(`coverage:update` not run — W1-5 owns the baseline).

**RED → GREEN.** At `043b37d` against `main`'s `src/`: `test/session.test.ts` **87 tests, 78 pass,
8 fail, 1 todo** — the eight failures are exactly the intended RED set (`:1648` mount round trip,
`:1671` `maxStdoutBytes`, `:1692` `maxOutputBytes`, `:1711` nested re-suspension, `:1739`
dump/load, `:1895` pre-aborted resume asks nobody, `:1919` throwing continuation clears the
suspension, `:1953` throwing continuation revokes grants). At `c8c0d9b`: **86 pass, 0 fail, 1 todo**.
Pins green on `main` by construction: `:1778` and `:1802` (caller-wins direction), `:1817`
(`inputs` via the snapshot), `:1834` (suspended `signal`/`onApproval` not carried), `:2007` (wall
clock per segment), `:2024` (snapshot pins the compute budget). Reproduce: check out `main`'s
`src/` over the branch and run `npx tsx --test test/session.test.ts`.

**The mutant, hand-applied** (reviewer reproduction):

```
sed -i '262s/this.totalBytes > this.maxBytes/this.totalBytes >= this.maxBytes/' src/truncate.ts
npx tsx --test test/truncate.test.ts                          # 36/39 — :349, :369, :380 fail
npx tsx --test --test-name-pattern="exactly at the cap" test/sandbox.test.ts   # 1/4 — :1906, :1915, :1936 fail
git checkout -- src/truncate.ts
sed -i '262s/this.totalLines > this.maxLines/this.totalLines >= this.maxLines/' src/truncate.ts
npx tsx --test test/truncate.test.ts                          # 37/39 — :387, :398 fail
npx tsx --test --test-name-pattern="exactly at the cap" test/sandbox.test.ts   # 3/4 — :1944 fails
git checkout -- src/truncate.ts
```

Before this chunk both mutants left `test/truncate.test.ts` 33/33 and the sandbox truncation tests
green.

**Adversarial probes from the brief.** Pre-aborted `Session.resume` never invokes `onApproval`
(`test/session.test.ts:1895`, asserts `asked === 0`, `errorKind === "aborted"`, tool executions 0).
A `resumeSuspended` that throws (`REPL_MEMORY_CEILING_MB=1` → `SandboxMemoryError`) leaves
`isSuspended() === false`, `resume()` reporting "no suspended execution", and `run()` returning
`ok` with no `discardedSuspension` (`:1919`). A different explicit mount on resume wins (`:1778`).

**Measurements behind D76** (scratchpad probes, 2026-09-08, host shared by ~10 agents):

| Probe | Result |
|---|---|
| burn ≈ 493 ms under `maxDurationSecs: 0.5`, gate, resume, burn | resume → `timeout` **16 ms** in — cumulative |
| control: the same 2 × 3 M iterations in one segment | `timeout` at 504 ms |
| burn ≈ 30 ms under 0.1 s, gate, resume passed `maxDurationSecs: 60`, unbounded loop | `TimeoutError: time limit exceeded: 100.000156ms > 100ms` (×2) — the snapshot's limit governs |
| burn ≈ 250–390 ms under 60 s, gate, resume passed 0.1 s, unbounded loop | ran ~59.6–59.9 s — the resume's tighter limit is inert |
| 1.8 s host nap, gate, 1.8 s nap under `maxWallClockSecs: 3` | `ok` (×3) — per-segment |
| control: both naps in one segment under 3 s | `timeout` at 3001 ms |
| iteration cost, `for … total += i` | 111 ns/iter (brief's measurement) vs 165 ns/iter (now) — 1.5× swing |

**The calibrated todo test** (`test/session.test.ts:2051`), run 10× single-file while the full suite
ran alongside: **9 pass / 1 fail**. It does not meet the brief's 20/20 bar and stays `todo` (D77).

## Residuals as todo tests

- `test/session.test.ts:2051` — "the compute budget is cumulative across a suspension (#38 test 2)".
  Self-calibrating against the sandbox's own clock (0.4 B of compute before the gate, 0.8 B after);
  the only Session-level observable is breach-or-not, so under a 1.5× load swing it cannot be both
  robust and discriminating. Intended approach in its reason string: promote once it passes 20/20
  under `npm run test:contained`. The property itself is established by the measurements above and
  by the load-independent pin at `:2024`.

## Observations outside this chunk's files (recorded for the verifier, not fixed here)

- **Host wall clock vs a Python runaway.** `runInSandbox("while True: …", { limits: { maxDurationSecs: 3,
  maxWallClockSecs: 1 } })` returned at **3075 ms** with the wall-clock message; the race resolves
  at 1 s but the caller gets the result only once the worker's own feed ends. For a host-tool hang
  (worker idle) the return is on time, which is what the existing `the host wall clock` tests cover.
  `src/sandbox.ts` code is frozen for this chunk; belongs with the wave-3 sandbox owner.
- **`ReplRunner.resume`'s re-clamped `limits` are a wall-clock re-clamp only.** The restored feed
  runs under the snapshot's `maxDurationSecs`/`maxMemory`; the resume's values for those two are
  inert (measured above; consistent with #177's own finding). Documented on `RunLimits` and at
  `Session.resume`; no behaviour change.
- **Dump shape.** `suspendedRunOpts` in a dump now holds only the four carried fields (mount host
  paths still persist — coordinate with W2-2). Old dumps with the raw shape load; `load` narrows them.

## Closing-comment drafts (for the orchestrator, after merge)

**#38** — Closed by the W1-2 merge. Test 1 (mounted file readable after suspend/approve/resume):
`test/session.test.ts:1648` (Session, both mechanisms) and `test/sandbox.test.ts:949` (sandbox).
Test 2 (budget not reset by suspension): measured cumulative — 493 ms burn under 0.5 s breached 16 ms
into the resume; the calibrated assertion is `test/session.test.ts:2051` (`todo`, D77); the
load-independent half — the snapshot pins the budget and a resume passed 60 s dies at the original
0.2 s — is `test/session.test.ts:2024`. Test 3 (gated-tool loop cannot run unbounded): the same
`:2024`. `LoadSnapshotOptions` audit recorded at `src/sandbox.ts` (the `resumeSuspended` comment).
Remaining loss documented on `RunSuspended` (`src/types.ts`): mounts and byte caps are handed back by
`Session`; the host wall clock restarts per segment (decision 1).

**#84** — Closed by the W1-2 merge. `suspendedRunOpts` is read (`Session.resume`), narrowed to
`CarriedRunOptions`. Test 1 (limits): `test/session.test.ts:875` (#177). Test 2 (mount): `:1648`.
Test 3 (inputs): `:1817`. Test 4 (`onApproval`/`signal` from the caller): `:1834`, `:1895`. Test 5
(dump/load round trip): `:1739`. Precedence written at `resume()`: caller-wins, `caller ?? suspended`
(decision 2, D74).

**#26** — Exit criteria, evidenced: (1) B7/B8/A12 correct at HEAD — `test/sandbox.test.ts` accumulator
ownership blocks (`:1286`, `:1370`) and the truncation ceiling block (`:1774`), unchanged and green;
(2) `noUnusedParameters` on (`tsconfig.json`, #27); (3) one `printCallback` (`src/sandbox.ts`
`makePrintCallback`); (4) the M11/M12 boundary mutant no longer survives — `test/truncate.test.ts:348`
and `test/sandbox.test.ts:1894`, hand-applied evidence above. #38 closed with this merge.

**#47** — Residual 1 (dialog on a dead call): `test/session.test.ts:1895`. Residual 2 (throwing
resume wedges the session, #50's undelivered DoD): `:1919`, `:1953`. The `src/repl.ts` `resume()`
survivor ledger nit (`:230`, `:233`) is W3-2's and is named there. Exit criteria: no shipped tool
throws out of state (#48); concurrent calls cannot wedge Pi (#49); the full round trip works through
the real extension (#51); a denied `PermissionError` returns a `RunError` and leaves the session usable
(`test/session.test.ts:543`, and now a *throwing* continuation too, `:1919`); Escape distinguishable
from denial (#49's `ui.select`).

## Rollback plan

| Commit | Reverts |
|---|---|
| `c8c0d9b` | the seam, the abort check, the try/finally, the docs, the sandbox comment (the RED tests at `043b37d` fail again) |
| `043b37d` | the tests (revert together with `c8c0d9b`, or the eight RED tests stay red) |
| `e12820c` | the spec |

`git revert c8c0d9b 043b37d e12820c` (newest first) returns to `3770e46`.

## Go / No-Go

**GO.** All four gates green; the eight RED tests turn GREEN on the fix and nowhere else; both
boundary mutants are killed by tests that sit exactly on the cap; no sandbox code touched; no new
dependency; the one timing residual is a `todo` with its measurement recorded.
