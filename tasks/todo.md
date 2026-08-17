# Tasks — Verify issue #110: `Repl.resume()` forwards `onApproval` (verification + closure)

Branch: `issue-110-resume-onapproval` · Source of truth: `SPEC.md` · Plan: `tasks/plan.md`

- [ ] **Task 1: Targeted mutation sweep of `src/repl.ts` and read the verdict**
  - Acceptance: sweep exits 0 and `node scripts/mutation-guard.mjs --report` shows zero fatal
    harness deaths; `reports/mutation/mutation.json` shows the `ObjectLiteral` mutant at
    `src/repl.ts:235` as `Killed`/`Timeout`, and every mutant at line `210` (the `if (!live)`
    guard) as `Killed`/`Timeout` — no `Survived`/`NoCoverage` in either direction; the status
    excerpt is captured for the report.
  - Verify:
    - `node scripts/contained.mjs --limit 12G npx stryker run --mutate src/repl.ts`
    - `node scripts/mutation-guard.mjs --report`
    - `python3 -c "import json; d=json.load(open('reports/mutation/mutation.json')); f=d['files']['src/repl.ts']; [print(m['status'], m['mutatorName'], m['location']['start']['line']) for m in f['mutants'] if m['location']['start']['line'] in (210,235)]"`
  - Files: none committed (`reports/mutation/*`, `.stryker-incremental.json` are gitignored)
  - Depends on: none

- [ ] **Checkpoint: evidence captured** — trustworthy verdict; `:235` and `:210` both detected;
      decide: survivors → Task 2, else skip to Task 3

- [ ] **Task 2 (CONDITIONAL — only if Task 1 found a survivor): add the minimal regression test**
  - Acceptance: new test drives `Repl.resume()` (not `Session.resume()`); previously-surviving
    mutant flips to `Killed`/`Timeout` on a fresh sweep; no redundant "test that cannot fail"; no
    `src/session.ts` edit; no production `src/*.ts` change unless unavoidable.
  - Verify:
    - `npx tsx --test test/repl.test.ts` (green)
    - re-run Task 1 sweep after `rm -f .stryker-incremental.json` (or `--force`) and confirm the flip
    - `npm run check` and `npm run lint` (test file changed)
  - Files: `test/repl.test.ts` (only if triggered)
  - Depends on: Task 1 (survivor found)

- [ ] **Task 3: Verification report `docs/verify-110.md`**
  - Acceptance: records issue link, commit `8ac0a1e` (PR #128), the killing test
    `test/repl.test.ts:517`, the exact sweep command, the status excerpt for lines 210 and 235, the
    `--report` result, and a closure recommendation.
  - Verify: read-through against `reports/mutation/mutation.json` (excerpts match the raw file);
    confirm no other files changed.
  - Files: `docs/verify-110.md`
  - Depends on: Task 1 (and Task 2 if triggered)

- [ ] **Task 4: Closure mechanics (recorded for SHIP, not executed here)**
  - Acceptance: the `gh` commands are recorded verbatim in `docs/verify-110.md`:
    - `gh issue comment 110 --body "$(cat docs/verify-110.md-issue-comment.txt)"`
    - `gh issue close 110 --reason completed --comment "Closed by targeted mutation verification — see docs/verify-110.md (#110)."`
  - Files: none new (recorded in `docs/verify-110.md`)
  - Depends on: Task 3

- [ ] **Checkpoint: Complete** — `docs/verify-110.md` full; focused test + check/build/lint green
      (only if a test/source file changed); closure commands recorded and flagged for SHIP
