# Spec: Issue #110 — Prove `Repl.resume()` forwards `onApproval` to the session (verification + closure)

Issue: https://github.com/AdarGit008/repl-simple/issues/110
Branch: `issue-110-resume-onapproval` (from `origin/main` @ `22d2d0e`)

---

## KEY FINDING (read first)

The defect #110 describes **appears already resolved on `origin/main`** by commit
`8ac0a1e` ("5.1 — Make repl_resume, repl_abandon and repl_reset fail gracefully (#48)" · PR #128),
which landed 2026-08-14 — **one day after** #110 was filed (2026-08-13).

The test that kills #110's mutant already exists and passes:

- `test/repl.test.ts:517` — `"suspend → resume(approve) runs the pending call"` drives
  `Repl.resume("approve-rt", approve)` (the wiring layer, not `Session.resume()`) and asserts the
  approved `write('ok.txt', 'v1')` reaches disk. Its own comment names #110: *"Also the mutant that
  drops `onApproval` from `session.resume()` (#110): without the callback the resume denies, and
  nothing reaches the disk."*

All three Definition-of-Done items are satisfied on the current tree (verified by running the tests
below — 3/3 pass). The remaining work is therefore **verification, not implementation**: confirm via
a targeted mutation run that the mutant is killed on *this* tree, confirm the guard is covered in
both directions, and if — and only if — a survivor is found, add the minimal regression test.

## Objective

**What:** Close the test gap where dropping `onApproval` from the `session.resume({ onApproval, signal })`
call in `Repl.resume()` would let the mutation suite stay green — a "broken feature, not a bypass"
regression (the approval flow fails closed: a missing callback → deny, per `src/session.ts:379-382`).

**Who:** Future maintainers of `src/repl.ts`; the mutation gate (`npm run mutation`) that must catch
this class of wiring regression.

**Success:** The mutation gate kills the `ObjectLiteral` mutant at `src/repl.ts:235`; the `!session`
guard at `src/repl.ts:210` is demonstrably covered in both directions; the evidence is recorded so
#110 can be closed without rediscovery.

## Tech Stack

- TypeScript (strict), ESM (`"type": "module"`), Node `>=22.19.0`
- Test runner: `node:test` via `tsx` (`npx tsx --test`)
- Mutation testing: Stryker 9.6.1 (`command` runner wrapped by `scripts/mutation-guard.mjs`)
- Sandbox: `@pydantic/monty` 0.0.21 (Python-in-WASM)

## Commands

```
Focused test:  npx tsx --test test/repl.test.ts
Full suite:    npm test
Type check:    npm run check
Build:         npm run build
Lint:          npm run lint
Coverage:      npm run coverage
Mutation (full):            npm run mutation
Mutation (targeted, repl):  node scripts/contained.mjs --limit 12G npx stryker run --mutate src/repl.ts
```

The targeted mutation command is the authoritative check for this issue. `--mutate src/repl.ts`
limits Stryker to the one file that contains the mutation target. Containment is automatic (skips
where there is no systemd user session). Do **not** run a full `npm run mutation` for this issue —
the whole-tree sweep costs ~33 CPU-hours (`docs/mutation-testing.md`); the target is one file.

## Project Structure

```
src/repl.ts          → ReplRunner: the pool + run/resume/abandon/reset public API (mutation target)
src/session.ts       → Session: per-session run/resume, approval gate, fail-closed deny
test/repl.test.ts    → drives ReplRunner (the wiring layer) — where the fix already lives
test/session.test.ts → drives Session directly (5+ resume({onApproval}) call sites, NOT the wiring)
docs/mutation-testing.md  → mutation workflow, M22/M22-sibling history, harness caveats
scripts/mutation-guard.mjs, scripts/contained.mjs → mutation harness + memory containment
stryker.config.json  → mutate globs, thresholds.break=58, concurrency=2, incremental
tasks/plan.md, tasks/todo.md → plan + task list (this flight)
```

## Code Style

Follow the existing test style in `test/repl.test.ts`: `node:test` `describe`/`it` with
`before`/`after` building a `ReplRunner` over a `mkdtempSync` tmp dir; helper callbacks
`approve`/`deny`/`suspend` return `Promise<ApprovalDecision>`; assertions use
`assert.match`/`assert.doesNotMatch` for output text and `readFileSync`/`existsSync` for the disk
side effect. A representative pattern (already in the file):

```ts
it("suspend → resume(approve) runs the pending call", async () => {
  const suspendedOut = await runner.run("write('ok.txt', 'v1')", "approve-rt", suspend);
  assert.match(suspendedOut, /requires approval/);
  assert.equal(existsSync(join(cwd, "ok.txt")), false, "suspended means not yet run");
  const out = await runner.resume("approve-rt", approve);
  assert.doesNotMatch(out, /PermissionError/);
  assert.equal(readFileSync(join(cwd, "ok.txt"), "utf8"), "v1");
});
```

## Testing Strategy

- **Level:** integration — drive `ReplRunner.resume()` (the public wiring), not `Session.resume()`.
- **Location:** `test/repl.test.ts` (only if a gap is found; see Boundaries).
- **The existing killing test:** `test/repl.test.ts:517` goes through `Repl.resume()` and asserts the
  approved write reaches disk. If the `onApproval` field were dropped, `Session.resume()` would deny
  (fail closed) and both `assert.doesNotMatch(out, /PermissionError/)` and the disk assertion fail —
  the mutant is killed.
- **Guard coverage (both directions):**
  - `!live` true → `test/repl.test.ts:503` "resume on a session that does not exist keeps its friendly message".
  - `!live` false → `test/repl.test.ts:492` "resume on a live session with nothing pending answers instead of throwing (M7)".
- **Mutation verification:** targeted Stryker run on `src/repl.ts`; the mutant of interest is the
  `ObjectLiteral` at `src/repl.ts:235` (`{ onApproval, signal }` → `{}`). It must be `Killed`.
  `docs/mutation-testing.md` documents the harness: a "no summary" run is a harness death, never a
  verdict; `Killed`/`Timeout` both count as detected.

## Boundaries

- **Always:** run the focused test and the targeted mutation run before concluding; record file:line
  evidence; keep the spec as the source of truth.
- **Ask first / flag:** closing issue #110 (the user/orchestrator owns GitHub state — recommend, do
  not close); any change to `src/*.ts` production code (only permitted if a survivor is found and
  the test cannot be made to kill it otherwise).
- **Never:** add a redundant "test that cannot fail" (this repo purged those in #23); edit
  `src/session.ts`; run a full-tree `npm run mutation` for this single-file target; remove or weaken
  an existing failing test.

## Assumptions

1. **The fix already landed and is sufficient.** Evidence: `git log -S "#110"` shows commit
   `8ac0a1e` (PR #128) added the killing test; `8ac0a1e` is an ancestor of `origin/main`; the three
   relevant tests pass on the current branch (3/3, verified). Rationale: the issue was filed against
   tree `bc7acc2` (its "Source" link); the tree has since gained #48/#51/#59 resume coverage.
2. **The mutation target moved.** The issue cites `src/repl.ts:62`; on the current tree the
   equivalent call is `src/repl.ts:235` (`{ onApproval, signal }`) and the `!session` guard is
   `src/repl.ts:210` (the method was rewritten for #48/#59). The DoD is read against these current
   locations, not the stale ones.
3. **"Verification-only" is the correct build shape.** Because the DoD is already met, the pipeline's
   BUILD phase reduces to running the targeted mutation and acting only if it surfaces a survivor.
   No production code is presumed necessary; this is stated, not silently assumed.
4. **`signal` is out of scope.** The issue's mutant is specifically the `onApproval` wiring. The
   existing killing test proves `onApproval` reaches the session; it does not independently prove the
   `signal` field matters, and that is not part of #110's DoD, so no new test is added for it.

## Success Criteria (testable)

1. Targeted mutation run (`--mutate src/repl.ts`) reports the `ObjectLiteral` mutant at
   `src/repl.ts:235` as **Killed** (not `Survived`, `NoCoverage`, or a harness death).
2. The killing test is `test/repl.test.ts:517`, which goes through `Repl.resume()`, not
   `Session.resume()`.
3. The `!session` guard at `src/repl.ts:210` is covered in both directions (evidence: tests at
   `:503` and `:492` pass).
4. If criterion 1 fails (survivor), a minimal regression test is added in `test/repl.test.ts` that
   makes it fail; otherwise **zero production/test edits** — the diff is the spec, plan, todo, and a
   verification report only.
5. A verification report records the evidence (mutation JSON excerpt, test names, commit `8ac0a1e`)
   and recommends closing #110.

## Open Questions

- **Should #110 be closed now, or is a fresh full-tree re-baseline required first?** The existing
  killing test is sufficient to close the *wiring* gap, but `docs/mutation-testing.md` notes the
  whole-tree mutation baseline is stale post-#40. A one-file targeted run confirms #110 specifically;
  it does not re-baseline the tree. This is a user/orchestrator decision — flagged, not assumed.
- **Is `Repl.resume()`'s `signal` wiring worth its own test?** Out of scope for #110 (see Assumption
  4), but it is a genuine, separate untested path if any later issue wants it.
