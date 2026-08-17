# Verification: Issue #150 — `Repl.resume()` honours an already-aborted signal

Issue: https://github.com/AdarGit008/repl-simple/issues/150 (Bucket 5 — parent #47). Source: PR #147
flight (SPEC Assumption 4); SHIP test-engineer follow-up.
Branch: `issue-150-resume-abort-test` (from `origin/main`). Verified at `4cc0e32`.

## Verdict

**PASS.** The flight delivers exactly what the plan allows: one new killing test
(`test/repl.test.ts:530`) driving `Repl.resume()` — not `Session.resume()` — with an
already-aborted signal, plus the evidence that proves the `signal` field is load-bearing on the
resume path. Every gate was re-checked independently from a fresh context:

- Full suite **947/947** (baseline 946 measured independently at commit `162c02b` — the suite grew
  by exactly one test).
- `npm run check`, `npm run build`, `npm run lint` all exit 0.
- The hand-applied mutants (both the single-field `{ onApproval }` drop **and** the whole-object
  `{}` drop) each make the new test fail 1/1; restored tree is green.
- Mutation report is fresh (mtime 15:02:56 > sweep start 15:02:09, `files == ["src/repl.ts"]`),
  `ObjectLiteral {}` at `src/repl.ts:235` is **Killed**, zero harness deaths.
- Diff vs `origin/main` contains no `src/` change and no committed `reports/`.

## Evidence

### 1. The killing test (machine-read at `test/repl.test.ts:530`)

The new test sits in the `#48` describe block immediately after the #110 test, and:

- drives `runner.resume("abort-rt", approve, controller.signal)` — the `ReplRunner` wiring layer,
  **not** `Session.resume()`;
- aborts the `AbortController` **before** the call (`controller.abort()`) — the escape /
  turn-cancel case (#49);
- asserts the public abort surface `[error: aborted]` (D2 — `Repl.resume()` never throws);
- asserts the file-not-written invariant (`abort-rt.txt` must not exist);
- names **#150** and the `signal`-drop mutant in its comment.

```ts
it("suspend → resume with an already-aborted signal does not run the pending call", async () => {
  const suspendedOut = await runner.run("write('abort-rt.txt', 'v1')", "abort-rt", suspend);
  assert.match(suspendedOut, /requires approval/);
  assert.equal(existsSync(join(cwd, "abort-rt.txt")), false, "suspended means not yet run");

  const controller = new AbortController();
  controller.abort(); // already aborted before resume — the escape/turn-cancel case
  const out = await runner.resume("abort-rt", approve, controller.signal);

  assert.match(out, /\[error: aborted\]/);
  // Also the mutant that drops `signal` from `session.resume({ onApproval, signal })`
  // (#150): without the signal the already-aborted resume approves, and the write
  // lands on disk.
  assert.equal(
    existsSync(join(cwd, "abort-rt.txt")),
    false,
    "an already-aborted resume must not execute the pending gated call",
  );
});
```

The wire under test is unchanged and correct: `src/repl.ts:235` reads
`const result = await live.session.resume({ onApproval, signal });`, and `git diff origin/main`
shows zero `src/` changes.

### 2. RED proven independently — both mutant variants, hand-applied

The flight's primary kill is the single-field mutant Stryker cannot generate (D0). Re-applied
transiently by this verifier, not taken on trust from T1:

```
$ sed -i '235s/session.resume({ onApproval, signal })/session.resume({ onApproval })/' src/repl.ts
$ npx tsx --test --test-name-pattern="already-aborted signal" test/repl.test.ts
✖ suspend → resume with an already-aborted signal does not run the pending call
ℹ tests 1 / fail 1
AssertionError: The input did not match the regular expression /\[error: aborted\]/. Input:
  '[result]\nSuccessfully wrote 2 bytes to abort-rt.txt'
```

With `signal` dropped, the already-aborted resume **approves and executes** — the output is a
successful write, the abort is silently discarded. This is exactly #150's defect class: a gated
side effect runs after the user cancelled it. The test fails 1/1.

The whole-object `{}` mutant (the only one Stryker's `ObjectLiteral` mutator generates) was also
hand-applied and also kills the new test 1/1 — with `{}` the session fails closed (denies), the
output is `PermissionError`, and the `[error: aborted]` match fails:

```
$ sed -i '235s/session.resume({ onApproval })/session.resume({})/' src/repl.ts
$ npx tsx --test --test-name-pattern="already-aborted signal" test/repl.test.ts
ℹ tests 1 / fail 1
```

So the new test independently kills **both** the single-field drop and the whole-object drop at
`src/repl.ts:235`. Restored and re-verified green:

```
$ git restore src/repl.ts && sed -n '235p' src/repl.ts
      const result = await live.session.resume({ onApproval, signal });
$ npx tsx --test --test-name-pattern="already-aborted signal" test/repl.test.ts
ℹ tests 1 / pass 1 / fail 0
$ git diff -- src/repl.ts | wc -l
0
```

**Deviation from SPEC D1's choreography wording:** the SPEC predicted the RED failure lands on the
`existsSync` "must not execute" assertion. Observed: the first failing assertion is the
`[error: aborted]` match, because it precedes the `existsSync` check in the test and the approved
write succeeds. Both assertions independently kill the mutant (the write demonstrably landed —
`Successfully wrote 2 bytes`), so the kill is unaffected; only the predicted *first-failing
assertion* is recorded differently.

### 3. Full suite — independent re-run, corrected baseline

```
$ npm test
ℹ tests 947
ℹ suites 230
ℹ pass 947
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

The baseline was **not** taken from any prior phase's claim. It was measured by this verifier in a
throwaway worktree at the pre-test commit `162c02b` (PLAN), with `node_modules` symlinked from the
main tree:

```
$ git worktree add /tmp/rs2-baseline 162c02b
$ npm test   # in /tmp/rs2-baseline
ℹ tests 946 / pass 946 / fail 0
```

**Corrected-baseline note:** the suite grew by exactly one test, 946 → 947. The `939 → 940`
figures carried in SPEC.md (Assumption 5, Testing-strategy DoD step 3, Success criterion 4) and
`tasks/plan.md` (T1 choreography, checkpoint, DoD item 4, handoff notes) were **stale leftovers
from the #110 flight** — that flight's suite was smaller; the #150 flight started from a 946-test
HEAD. SPEC.md is amended in this commit (Assumptions/DoD now say 946 → 947 and 947/947).
`tasks/plan.md` still carries `940/940` in its DoD/handoff lines: the amendment task scoped the
  correction to SPEC.md, and those lines are recorded here rather than silently left ambiguous.
  **Superseded at `ca792fa`**, which amended plan.md's four `940/940` quotes to `946 → 947` /
  `947/947`. Point-in-time note kept for provenance.

### 4. Static gates — all independently re-run

```
$ npm run check && npm run build && npm run lint
> tsc --noEmit                    exit 0
> tsc -p tsconfig.build.json      exit 0
> biome check --error-on-warnings exit 0   (Checked 49 files, no fixes applied)
```

### 5. Mutation evidence — machine-read from `reports/mutation/mutation.json`

**Freshness (D4), machine-checked:** mtime `2026-08-17 15:02:56 +0300` postdates the sweep start
(15:02:09, recorded in the T2 phase of this flight); `list(json['files'].keys())` is exactly
`["src/repl.ts"]` — the single-file report, not the stale full-tree one.

**Target mutant, machine-read:**

```
line 235 | ObjectLiteral | replacement "{}" | status Killed | testsCompleted 1 | static false
```

**Totals:** 287 mutants — **193 Killed / 60 Survived / 34 Timeout**, 0 NoCoverage / RuntimeError /
CompileError. The 60 Survived and 34 Timeout are the same pre-existing gaps the #110 flight
reported (identical aggregate), all on lines other than 235. They are **not** this flight's
regression and were not touched or re-baselined.

**Harness-death check:**

```
$ node scripts/mutation-guard.mjs --report
mutation-guard: no harness deaths recorded   (exit 0)
```

**Honest caveat about what the sweep executed (recorded as found, not as a violation):**
Stryker's config has `coverageAnalysis: "off"` and `incremental: true`. Under that combination the
incremental differ reuses every mutant result unconditionally
(`mutantCanBeReused` returns `true` when the test runner reports no coverage —
`node_modules/@stryker-mutator/core/dist/src/mutants/incremental-differ.js`, read first-hand). The
15:02 sweep therefore re-ran **zero** mutants: all 193 Killed `statusReason` strings reference the
previous run's sandbox `hybUqk`, while this run's sandbox was `WMtY7e` (grep over
`.stryker-incremental.json`). The report file itself is fresh and the DoD is met as written (fresh
single-file report, `:235` Killed, no new survivor, zero harness deaths), but the `:235` Killed
status is **carried-over evidence from the #110 sweep, not a re-execution against the new test**.
That gap is closed by section 2 above: the new test's kill of both mutant variants at `:235` was
re-proven by hand in this verification. If a re-execution is ever wanted, run the sweep with
`--force`.

### 6. Diff vs `origin/main` — exactly what the plan allows

```
$ git diff origin/main..HEAD --stat
 SPEC.md           | 358 ++++++-----
 tasks/plan.md     | 309 +++++------
 tasks/todo.md     |   8 +-
 test/repl.test.ts |  20 +++
 4 files changed, 311 insertions(+), 384 deletions(-)
```

No `src/` file, no `reports/` file. (`docs/verify-150.md` and the SPEC.md amendment are added by
this verification commit; `reports/` is gitignored, confirmed in `.gitignore:12`.)

The only test change is +20 lines, exactly one new `it(...)` (file-level count 99 → 100 at the
pre-test commit → HEAD), matching the plan's single-test scope.

## Out-of-scope observations (not acted on)

- The 60 Survived / 34 Timeout mutants elsewhere in `src/repl.ts` remain the pre-existing gaps from
  the #110 sweep; this flight neither fixes nor re-baselines them (SPEC Assumption 5).
- `tasks/plan.md` still quotes `940/940` in its DoD and handoff lines — recorded above; the
  amendment task scoped the correction to SPEC.md.
- With `coverageAnalysis: "off"`, future single-file sweeps will keep reusing results unless run
  with `--force` — see the caveat in Evidence 5.

## Closure recommendation

Close #150 as **completed** on this evidence: the killing test drives `Repl.resume()` with an
already-aborted signal, proves the `signal` field is load-bearing on the resume path (both mutant
variants die 1/1), the suite grows 946 → 947, all static gates exit 0, and the mutation report is
fresh with the `:235` mutant Killed and zero harness deaths.

Closure commands (executed by the SHIP phase on a go decision):

```
gh issue comment 150 --body "$(cat docs/verify-150.md-issue-comment.txt)"
gh issue close 150 --reason completed --comment "Closed by killing-test verification — see docs/verify-150.md (#150)."
```
