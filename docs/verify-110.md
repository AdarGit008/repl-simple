# Verification: Issue #110 — `Repl.resume()` forwards `onApproval` to the session

Issue: https://github.com/AdarGit008/repl-simple/issues/110
Branch: `issue-110-resume-onapproval` (from `origin/main` @ `22d2d0e`)

## Verdict

**The defect described by #110 is already resolved on `origin/main`, and the targeted mutation
sweep confirms the mutant is killed.** No production or test change was required; this flight's
deliverable is the evidence below, which supports closing #110.

## Evidence

### 1. The killing test already landed (commit `8ac0a1e`, PR #128)

Commit `8ac0a1e` ("5.1 — Make repl_resume, repl_abandon and repl_reset fail gracefully (#48)"
· PR #128, 2026-08-14) added the test that kills #110's mutant. Its own commit message states the
intent explicitly:

> dropping `onApproval` from `session.resume()` — the survivor filed as #110 — fails 1.

The test is `test/repl.test.ts:517`, *"suspend → resume(approve) runs the pending call"*. It drives
`Repl.resume()` (the wiring layer — **not** `Session.resume()`) and asserts the approved write
reaches disk:

```ts
it("suspend → resume(approve) runs the pending call", async () => {
  const suspendedOut = await runner.run("write('ok.txt', 'v1')", "approve-rt", suspend);
  assert.match(suspendedOut, /requires approval/);
  assert.equal(existsSync(join(cwd, "ok.txt")), false, "suspended means not yet run");
  const out = await runner.resume("approve-rt", approve);
  assert.doesNotMatch(out, /PermissionError/);
  // Also the mutant that drops `onApproval` from `session.resume()` (#110):
  // without the callback the resume denies, and nothing reaches the disk.
  assert.equal(readFileSync(join(cwd, "ok.txt"), "utf8"), "v1");
});
```

If the `onApproval` field were dropped from the `session.resume({ onApproval, signal })` call, the
session would deny (fail closed, `src/session.ts`), and both the `PermissionError` assertion and the
disk assertion would fail — the mutant is killed.

### 2. The `!session` guard is covered in both directions

The issue also asked (DoD item 3) that the guard be covered both ways. On the current tree the guard
is `if (!live) {` at `src/repl.ts:210`:

- `!live` **false** (session exists) → `test/repl.test.ts:492` *"resume on a live session with
  nothing pending answers instead of throwing (M7)"*.
- `!live` **true** (no session) → `test/repl.test.ts:503` *"resume on a session that does not exist
  keeps its friendly message"*.

### 3. Targeted mutation sweep (machine-read verdict)

Command:

```
node scripts/contained.mjs --limit 12G npx stryker run --mutate src/repl.ts
```

The report `reports/mutation/mutation.json` was written `2026-08-17 14:04:39` by this sweep and its
`files` map contains a single key, `src/repl.ts` — confirming it is the fresh single-file report,
not the stale full-tree one that predated the run (mtime `00:14:59`).

Per-mutant statuses at the two target locations (extracted from the JSON, not eyeballed):

```
Killed | BooleanLiteral         | line 210 | repl: "live"
Killed | ConditionalExpression  | line 210 | repl: "true"
Killed | ConditionalExpression  | line 210 | repl: "false"
Killed | BlockStatement         | line 210 | repl: "{}"
Killed | ObjectLiteral          | line 235 | repl: "{}"
```

All five are **Killed**. The issue's target — the `ObjectLiteral` at the now-current
`src/repl.ts:235` (`{ onApproval, signal }` → `{}`) — is killed, and so are all four guard mutants at
the now-current `src/repl.ts:210` (the issue's stale `:57-60` "four survivors").

### 4. Harness-death check

```
$ node scripts/mutation-guard.mjs --report
mutation-guard: no harness deaths recorded
exit=0
```

Zero fatal harness deaths — the score is trustworthy, not a casualty of the OOM/harness-death class
of false positive that #109/#110 exists to prevent.

## Full-file context (out of scope, recorded for honesty)

The same sweep reports `src/repl.ts` as a whole at **287 mutants: 193 Killed, 60 Survived,
34 Timeout**. The 60 survivors and 34 timeouts are all on lines other than 210/235 and are unrelated
to #110's Definition of Done; they are pre-existing gaps belonging to other buckets and were not
touched in this flight.

## Out-of-scope observations (not acted on)

- `Repl.resume()`'s `signal` field is wired but not independently proven by any test (SPEC
  Assumption 4). It is a separate untested path, out of scope for #110.
- The tree-wide mutation floor remains stale post-#40; a single-file sweep confirms #110 and does
  not re-baseline the whole tree (carried from SPEC/plan Open Questions).

## Closure recommendation

Close #110 as **completed** on the single-file evidence. The three DoD items are met:

1. ✅ `ObjectLiteral` at `src/repl.ts:235` is Killed.
2. ✅ The killing test goes through `Repl.resume()`, not `Session.resume()`.
3. ✅ The `!session` guard at `src/repl.ts:210` is covered in both directions.

Closure commands (executed by the SHIP phase on a go decision):

```
gh issue comment 110 --body "$(cat docs/verify-110.md-issue-comment.txt)"
gh issue close 110 --reason completed --comment "Closed by targeted mutation verification — see docs/verify-110.md (#110)."
```
