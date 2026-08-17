# Spec: Prove `Repl.resume()` honours an aborted signal — issue #150

Issue: https://github.com/AdarGit008/repl-simple/issues/150 (Bucket 5 — parent #47). Source: PR #147
flight (SPEC Assumption 4); SHIP test-engineer follow-up.

## Objective

`Repl.resume()` passes `signal` into `session.resume({ onApproval, signal })` (`src/repl.ts:235`),
but no test proves abort propagation on the resume path. The #110 killing test
(`test/repl.test.ts:517`, *"suspend → resume(approve) runs the pending call"*) drives `Repl.resume()`
with an `approve` callback and **no signal** — it proves `onApproval` is forwarded, not `signal`.

The gap is a single-field drop, not the whole object. Stryker 9.6.1's `ObjectLiteral` mutator yields
**only** the empty object `{}` (verified at
`node_modules/@stryker-mutator/instrumenter/src/mutators/object-literal-mutator.ts`:
`yield types.objectExpression([])`), so a mutant that drops only `signal`
(`{ onApproval, signal }` → `{ onApproval }`) is **not generated** by the mutation suite and would
survive: the resumed call would be approved and executed with no abort observed. `signal` is the
user's Escape / turn-cancel (#49); if the resume path silently dropped it, an already-aborted resume
would run a gated side effect (`bash`/`write`/`edit`) the user had already cancelled.

**This is a proof-of-wiring flight, not a fix flight.** The wiring is already correct: `run` and
`resume` both thread `signal` through, and `resumeSuspended` (`src/sandbox.ts:1113`) already
early-returns `runError("aborted", "execution aborted", acc)` when `runOpts.signal.aborted` is set,
*before* the approval replay executes the suspended tool call. The deliverable is a killing test that
proves the `signal` field is load-bearing on the resume path, so a future single-field drop fails the
suite.

## Scope

**In scope** (exact files expected to change):

- `test/repl.test.ts` — one new test driving `Repl.resume()` with an already-aborted signal.
- `SPEC.md`, `tasks/plan.md`, `tasks/todo.md` — this flight's artifacts (rotated per house convention).
- `docs/verify-150.md`, `docs/review-150.md`, `docs/ship-150.md` — evidence + review + ship reports.

**Out of scope** (do not touch):

- `src/repl.ts`, `src/session.ts`, `src/sandbox.ts` — the wiring is already correct; the whole-object
  `ObjectLiteral` `{}` mutant at `src/repl.ts:235` is already Killed by the #110 test. **No
  production code change.** (The single-file sweep `--mutate src/repl.ts` is run *read-only* for
  evidence.)
- `extensions/*`, `src/rlm.ts`, `src/rlm_loop.ts` — unrelated.

## Explicit decisions

### D0 — The mutant to kill is the single-field drop, proven by hand-application

The conceptual mutant is `{ onApproval, signal }` → `{ onApproval }` (dropping only `signal`). Stryker
cannot generate it (see Objective). It is therefore proven by the **hand-apply prove-it** technique
already used on the #110 flight: temporarily edit `src/repl.ts:235` to `session.resume({ onApproval })`,
run the new test, observe it fail, restore the file, observe it pass. The targeted mutation sweep is a
*regression* check (confirm the whole-object `{}` mutant stays Killed and no new survivor appears), not
the primary kill.

### D1 — Test shape

Inside the existing `describe("ReplRunner — every tool answers, in every state (#48)")` block in
`test/repl.test.ts`, immediately after the #110 test at `:517`, add one test:

```ts
it("suspend → resume with an already-aborted signal does not run the pending call", async () => {
  const suspendedOut = await runner.run("write('abort-rt.txt', 'v1')", "abort-rt", suspend);
  assert.match(suspendedOut, /requires approval/);
  assert.equal(existsSync(join(cwd, "abort-rt.txt")), false, "suspended means not yet run");

  const controller = new AbortController();
  controller.abort(); // already aborted before resume — the escape/turn-cancel case
  const out = await runner.resume("abort-rt", approve, controller.signal);

  assert.match(out, /\[error: aborted\]/);
  assert.equal(
    existsSync(join(cwd, "abort-rt.txt")),
    false,
    "an already-aborted resume must not execute the pending gated call",
  );
});
```

This proves both halves of the issue's "abort behaviour": the abort is *surfaced* at the public layer,
and the pending call is *not executed* (no disk write). It uses the existing fixtures (`runner`,
`makeTempDir`, `suspend`, `approve`) — no new helpers.

### D2 — "AbortError" at the public layer is the `aborted` result string, not a throw

`Repl.resume()` is documented "never throws" (`src/repl.ts:198`, #48) — every model-believable state
returns a sentence. The abort therefore surfaces as `[error: aborted]\nexecution aborted` (produced by
`formatOutcome` in `src/repl.ts:655` from `errorKind: "aborted"`). A thrown `AbortError` would only be
observable one layer down at the `Session`/sandbox boundary, which the DoD explicitly does **not** test
(it says drive `Repl.resume()`, not `Session.resume()`). Assert the public string, not an exception.

### D3 — No production change; RED is exercised via the hand-applied mutant

Because the wiring is already correct, the new test is expected to be **GREEN on first run**. That is
the correct outcome and is recorded, not "fixed around". The RED step is exercised the only honest way:
hand-apply the single-field mutant (D0), confirm the new test fails 1/1 with the exact "must not
execute" assertion (the file is written, `existsSync` returns true), then restore and confirm green.
This is the same prove-it discipline the #110 ship report records for its own mutant.

### D4 — Mutation-report freshness gotcha (from `tasks/monitor-110-report.md` Item H)

`reports/mutation/mutation.json` is overwritten **only when the run finishes**; during a sweep the
previous run's JSON stays on disk (observed live on the #110 flight: mtime `00:14:59`, `files` map =
only `src/rlm.ts`, for the whole 11:49→14:04 `src/repl.ts` sweep). Before extracting any evidence,
assert freshness: mtime must postdate the sweep start **and** `list(json['files'].keys())` must be
exactly `["src/repl.ts"]`. A `files` map with any other/extra key is the previous run, not this one.

## Assumptions (recorded — fire-and-forget, no human asked)

1. The single-field mutant is represented by hand-editing `src/repl.ts:235` to
   `session.resume({ onApproval })` — Stryker cannot generate it (D0).
2. The abort surface asserted is the `[error: aborted]` result string, not a thrown `AbortError` (D2).
3. The new test lives in `test/repl.test.ts` in the #48 describe block next to the #110 test, reusing
   the existing `runner`/`cwd`/`suspend`/`approve` fixtures — no new helpers, no new imports beyond
   the already-imported `join`/`existsSync`.
4. The targeted sweep is single-file `--mutate src/repl.ts` (as #110), not the full tree; it is a
   regression check and does **not** re-baseline the tree-wide floor.
5. The suite grows by exactly one test: 939 → 940. The 60-Survived / 34-Timeout mutants in
   `src/repl.ts` on other lines are pre-existing, out of scope, and expected to remain unchanged.
6. File name for the pending-call write is `abort-rt.txt` (session id `abort-rt`), matching the house
   `approve-rt` / `deny-rt` naming.

## Tech stack

TypeScript 5.9 (strict), `node:test` + `node:assert/strict` via `tsx --test`, Biome 2.5.8, Stryker
9.6.1 (incremental, `ObjectLiteral` mutator verified above), `tsc -p tsconfig.build.json`. Node >=
22.19.0. No new dependencies.

## Commands

```
Test (focused):  npx tsx --test test/repl.test.ts
Test (full):     npm test
Type-check:      npm run check
Build:           npm run build
Lint:            npm run lint
Mutation (targeted, evidence):  node scripts/contained.mjs --limit 12G npx stryker run --mutate src/repl.ts
Harness-death report:           node scripts/mutation-guard.mjs --report
```

## Project structure

```
test/repl.test.ts   → the one new killing test (D1)
SPEC.md / tasks/*    → this flight's artifacts
docs/{verify,review,ship}-150.md → evidence + review + ship reports
src/repl.ts         → read-only; the wire under test (no edit, except the transient hand-applied mutant for RED)
```

## Code style

Match the file's existing voice: sentence-style assertions with a trailing reason string, issue numbers
in comments (`#150`), `describe`/`it` from `node:test`, `assert` from `node:assert/strict`. The new test
mirrors the #110 test directly above it in the same describe block — same `write` + `suspend` +
`existsSync` idiom, plus an `AbortController` aborted before `resume`.

## Testing strategy

`node:test`, behaviour-first, through the real `ReplRunner` (`test/repl.test.ts`) — the suite's existing
deterministic style. Exactly one new test:

1. **Abort propagation on the resume path (the kill).** Suspend a `write` pending call, abort a fresh
   `AbortController` *before* `resume`, call `runner.resume("abort-rt", approve, controller.signal)`.
   Assert `[error: aborted]` is surfaced **and** the file was never written. This kills the
   single-field `{ onApproval }` mutant: without `signal`, the call approves and the write lands, so
   the `existsSync(...) === false` assertion fails 1/1.

Verification sequence (executed by the BUILD/VERIFY phases, recorded here as DoD):

1. **GREEN (expected):** `npx tsx --test test/repl.test.ts` — the new test passes on the unmodified
   tree.
2. **RED (prove-it):** hand-edit `src/repl.ts:235` to `session.resume({ onApproval })`, run the focused
   test, confirm the new test fails 1/1 with the `existsSync` assertion (file written). Restore the
   file, confirm green again.
3. **Regression:** `npm test` — 940/940.
4. **Static:** `npm run check` && `npm run build` && `npm run lint` — all exit 0.
5. **Mutation (evidence):** `node scripts/contained.mjs --limit 12G npx stryker run --mutate src/repl.ts`;
   then freshness-check `reports/mutation/mutation.json` (D4) and confirm the `ObjectLiteral` at
   `src/repl.ts:235` is **Killed** (whole-object `{}` mutant — already killed by #110, must remain so)
   and no new survivor appears at that line.
6. **Harness-death check:** `node scripts/mutation-guard.mjs --report` → `mutation-guard: no harness
   deaths recorded`, exit 0.

## Boundaries

- **Always:** focused test before committing, full `npm test` before commit, `npm run check` + `npm run
  build` + `npm run lint`, issue-referenced commit message (`150 — … (#150)`), mark tasks in
  `tasks/todo.md`.
- **Ask first (record instead — fire-and-forget):** nothing here is high-risk; surprises are recorded in
  the ship report.
- **Never:** edit `src/repl.ts`/`src/session.ts`/`src/sandbox.ts` as a *permanent* change (only the
  transient hand-applied mutant for the RED step, always restored); hand-edit `coverage-baseline.json`;
  change the mutation thresholds; treat the full-tree mutation floor as this flight's gate.

## Success criteria

1. One new test exists in `test/repl.test.ts`, drives `Repl.resume()` (not `Session.resume()`), and
   passes on the unmodified tree — proving the `signal` field is wired end-to-end.
2. The hand-applied single-field mutant (`{ onApproval }`, dropping `signal`) makes that test fail 1/1
   with the exact no-write assertion, and is restored.
3. The targeted `--mutate src/repl.ts` sweep keeps the `ObjectLiteral` `{}` mutant at `src/repl.ts:235`
   Killed, with a fresh single-file report and zero harness deaths.
4. `npm test` (940/940), `npm run check`, `npm run build`, `npm run lint` all exit 0.
5. The evidence chain (RED/GREEN/mutation/harness-death) is recorded in `docs/verify-150.md` with the
   mutation-report freshness check stated (D4).

## Open questions / risks

1. **The sweep is slow.** A single-file `--mutate src/repl.ts` sweep took ~2h15m on the #110 flight
   (`docs/mutation-testing.md`). The plan must budget for it and rely on incremental state
   (`.stryker-incremental.json`) to keep it bounded. If the sweep is impractical in this flight's window,
   the hand-applied prove-it (RED) is the primary evidence and the sweep is a confirmatory regression
   check recorded in the ship report as pending.
2. **60-Survived / 34-Timeout mutants elsewhere in `src/repl.ts`** are pre-existing and out of scope;
   the ship report must not let them read as this flight's regression.
