# Issue-Monitor Report — #150 flight (`issue-150-resume-abort-test`)

Watched: SPEC.md, tasks/plan.md, tasks/todo.md, docs/verify-150.md, docs/review-150.md,
docs/ship-150.md, docs/verify-150.md-issue-comment.txt, commit history (`git log
origin/main..HEAD`), PR #151 state, issue #150 state, `reports/mutation/mutation.json`,
`.stryker-incremental.json`, `stryker.config.json`, `node_modules/@stryker-mutator/core`
(incremental-differ source), `src/session.ts` / `src/sandbox.ts` (resume path).

**Flight outcome (observed, final):** 9 commits on the branch
(`e37e664` SPEC → `162c02b` PLAN → `ae056aa` test → `1210600`/`4cc0e32` BUILD → `aa14e30` VERIFY
→ `0f687fb`/`ca792fa` REVIEW → `d69eb42` SHIP). PR #151 squash-merged to `main` as `8d1f9eb` at
2026-08-17 12:39:25Z; issue #150 closed at 12:39:33Z with the evidence comment
(byte-matches `docs/verify-150.md-issue-comment.txt`). The remote branch was deleted after the
merge (ref pruned). All four flight docs are on `main` via PR #151.

**Task-brief discrepancy (recorded, not a finding):** the brief said "PR #151 is in auto-merge to
main". Machine state at observation: `autoMergeRequest: null`, `mergeStateStatus: BLOCKED` (CI
checks in progress). No auto-merge was ever set; the merge landed seconds after the last check
went green. Treat "CI-gated merge" as the operative policy, not auto-merge.

Per discovered item: target issue/doc → exact wording to append → where it should live so a
future flight reads it **before starting**.

---

## Item 1 — `coverageAnalysis: "off"` + incremental reuse: a non-`--force` sweep re-executes zero mutants and a "fresh" report can carry over 100% of the statuses

- **Severity:** HIGH (false-evidence hazard — machine evidence that looks fresh proves nothing new).
- **Source:** docs/verify-150.md §5 "Honest caveat about what the sweep executed" + this monitor's
  first-hand read of `@stryker-mutator/core`
  (`dist/src/mutants/incremental-differ.js:265-270`: `mutantCanBeReused` returns `true`
  unconditionally when `testCoverage.hasCoverage` is false — which is always the case under
  `stryker.config.json:9` `"coverageAnalysis": "off"` — unless `--force` is passed).
- **Machine-confirmed:** the 15:02 sweep re-ran 0 of 287 mutants; `.stryker-incremental.json`
  contains the previous run's sandbox token `hybUqk` on 193 lines and the current run's `WMtY7e` on
  0 lines; a Killed `statusReason` embeds the path `.stryker-tmp/sandbox-hybUqk/...`. The report
  file itself passed the D4 freshness gate (mtime 15:02:56 > sweep start, `files ==
  ["src/repl.ts"]`) — freshness is not provenance.
- **Why it matters:** the `:235` Killed status in the DoD evidence was carried-over #110 evidence,
  not a re-execution against the new test. Cost: the gap had to be closed by hand-applied RED
  re-proven **four times** (BUILD, VERIFY, REVIEW, SHIP) — real duplicated effort — and a future
  flight trusting the freshness gate alone would silently pass a DoD with zero new executions.
- **Target:** `docs/mutation-testing.md` — the durable mutation gotchas ledger; no open issue owns
  the harness docs (same precedent as #110 monitor Item H, which this extends: Item H stopped a
  stale file from a *previous finished run*; this trap survives the freshness check).
- **Wording to append (new subsection directly after "Reading the report (freshness first)"):**
  > ### Freshness is not provenance — the `coverageAnalysis: "off"` reuse trap
  >
  > With `coverageAnalysis: "off"` and `incremental: true` (this repo's config), a non-`--force`
  > sweep **re-executes zero mutants**: the incremental differ's `mutantCanBeReused` returns `true`
  > unconditionally when the test runner reported no coverage
  > (`@stryker-mutator/core` `dist/src/mutants/incremental-differ.js`). Every `status`,
  > `statusReason` and `testsCompleted` is carried over from the previous run's cache, while the
  > report gets a fresh mtime and the right `files` key — the freshness check above passes and the
  > machine evidence still proves nothing new. Observed on the #150 flight (2026-08-17): 0 of 287
  > mutants re-ran; all 193 Killed `statusReason` strings embed the previous run's sandbox
  > directory (`sandbox-hybUqk` × 193 in `.stryker-incremental.json`; the current run's sandbox
  > `WMtY7e` × 0). Before trusting a report: (a) the SPEC must state which mode the DoD requires —
  > `--force` (true re-execution; ~2h15m cold for a single-file `--mutate src/repl.ts`) or
  > incremental (fast, carried-over); and (b) verify provenance, not just freshness — confirm
  > `statusReason` strings cite the **current** run's sandbox token, and treat a report whose
  > statuses all cite a different token as carried-over evidence that another proof must close
  > (e.g. a hand-applied RED).
- **Also add to every future flight's SPEC DoD mutation step (one line):**
  > Mutation step N: name the mode — `--force` (re-execution) or incremental (cache reuse). If
  > incremental, the provenance check (statusReason sandbox token == this run's sandbox) is part
  > of the DoD, and any carried-over status needs a closing hand-applied proof.

---

## Item 2 — Stale absolute test counts carried between flights (939 → 940 → real baseline 946 → 947)

- **Severity:** MED (two amendment commits spent on a checkable number; initial VERIFY had to
  re-measure before trusting any count).
- **Source:** docs/verify-150.md §3 "Corrected-baseline note" (the `939 → 940` figures in the
  #150 SPEC Assumption 5 / DoD / success criterion and tasks/plan.md T1 / DoD / handoff were stale
  leftovers from the #110 flight — that suite was smaller; #150's true baseline was 946).
  Plan.md's four `940/940` quotes were fixed at `ca792fa`; SPEC.md at the same commit.
- **Why it matters:** the invariant (suite grows by exactly one) is what the DoD needs; absolute
  counts copied between flights decay within one flight and force mid-flight amendment commits.
- **Target:** the SPEC/plan template convention (pipeline-owned; the repo has no SPEC-authoring
  doc). Repo-side carrier: this report (merged via the house monitor-report PR pattern) + every
  future test-adding issue body's DoD.
- **Wording to append:**
  > Suite-count DoD must state the invariant, never absolute numbers: "the suite grows by exactly
  > one test, with the baseline **re-measured at the pre-change HEAD of this flight** — never
  > carried forward from a previous flight's SPEC or issue body." Absolute figures copied between
  > flights went stale within one flight on #150 (inherited `939 → 940`, true baseline `946 →
  > 947`; two amendment commits were spent correcting SPEC.md and tasks/plan.md).

---

## Item 3 — RED prediction wording: predict "fails 1/1, both assertions kill", not which line fires

- **Severity:** LOW (cost a deviation note + a SPEC amendment; the kill itself was unaffected).
- **Source:** docs/verify-150.md §2 "Deviation from SPEC D1's choreography wording" (SPEC predicted
  the `existsSync` "must not execute" assertion fires first; observed: the `[error: aborted]` match
  at `test/repl.test.ts:539` fires first, because it precedes the `existsSync` check and the
  approved write succeeds); docs/review-150.md Correctness minor; SPEC amended at `ca792fa` to
  "first on the `[error: aborted]` match" (now on `main`).
- **Why it matters:** assertion order in the authored test determines which assertion reports
  first under the mutant — a fragile thing to encode as a prediction. The durable claim is that
  the mutant dies 1/1 with both assertions independently killing. The amended SPEC still encodes
  a first-firing prediction; encode the invariant, record the observation after the run.
- **Target:** same home as Item 2 (SPEC/plan template + test-adding issue bodies).
- **Wording to append:**
  > Phrase the RED prediction as the invariant both assertions prove, not the line that will fire:
  > "the mutant makes the new test fail 1/1 — both assertions kill independently (the observed
  > first failure goes in the verify doc after the run; do not predict it in the SPEC)." #150:
  > the SPEC predicted the `existsSync` failure; the `[error: aborted]` match fired first —
  > harmless to the kill, but it cost a deviation note and an amendment commit.

---

## Item 4 — UX: `Session.resume` resolves `onApproval` before the abort gate — a pre-aborted resume can flash a dead approval dialog

- **Severity:** LOW (no side effect runs; fail-closed unaffected; pure UX polish).
- **Source:** docs/ship-150.md follow-up #2 (security-auditor INFO #1). Verified by this monitor
  from source: `src/session.ts:379-380` awaits `runOpts.onApproval(...)` **before** calling
  `resumeSuspended`, whose abort gate (`src/sandbox.ts:1133`, `if (runOpts.signal.aborted)
  acc.aborted = true` → early `runError("aborted")`) fires only afterwards.
- **Target:** open issue #47 "Bucket 5 — Suspension and approval" (epic, `bug`, `bucket-5`) — as a
  candidate child item, not a DoD line.
- **Wording to append to #47:**
  > From the #150 flight (PR #151, security-auditor INFO #1): `Session.resume` resolves
  > `runOpts.onApproval` (`src/session.ts:379-380`) before `resumeSuspended` runs its abort gate
  > (`src/sandbox.ts:1133`). A pre-aborted resume therefore still fires the approval callback — a
  > dead dialog flash for an already-cancelled call (no side effect runs; fail-closed unaffected).
  > UX-polish candidate for a bucket-5 child: check `runOpts.signal?.aborted` before invoking
  > `onApproval`.

---

## Item 5 — Flight ops: `gh pr create` fails on unpushed branches ("Head sha can't be blank"); base-branch protection CI-gates the merge

- **Severity:** LOW (ops).
- **Source:** flight ops (driver-reported; no repo artifact records it). Machine-observed half:
  PR #151 sat `BLOCKED` with `autoMergeRequest: null` while CI checks were in progress and merged
  (squash, manual) at 12:39:25Z — 12 seconds after the evidence comment's target doc was already
  on the branch. The ship-150.md execution order ("merge first, so the comment's docs link
  resolves") is only executable once CI is green.
- **Target:** pipeline docs (out of repo); no repo issue owns flight ops.
- **Wording to append (pipeline playbook, SHIP section):**
  > Push the branch **before** `gh pr create` (unpushed branches fail with "Head sha can't be
  > blank"). The base branch requires CI checks, so plan the merge for after they go green (or set
  > auto-merge explicitly) — and put the closure comment **after** the merge when it links merged
  > artifacts.

---

## Item 6 — Flight ops: subagent foreground-worker launches abort (fallback: agent tool)

- **Severity:** LOW (ops).
- **Source:** flight ops (driver-reported; no repo artifact records it). This flight fell back to
  the agent tool when the foreground-worker launch aborted; phase artifacts landed regardless.
- **Target:** pipeline docs (out of repo); no repo issue owns flight ops.
- **Wording to append (pipeline playbook, worker section):**
  > Foreground-worker launches can abort mid-flight; the working fallback is the agent tool.
  > Design phases so a fallback loses no machine-verifiable state (artifacts and JSON evidence are
  > the recovery path — same principle as the mutation sweep's file-based verdicts).

---

## Already recorded by the flight itself (no rediscovery risk — verify, don't duplicate)

- `docs/verify-150.md`: the incremental-reuse caveat (§5), corrected baseline (§3), RED deviation
  (§2), out-of-scope notes — all on `main` via PR #151.
- `docs/ship-150.md` follow-ups #1/#2/#3: the `--force` vs incremental question, the
  onApproval-before-abort UX item, the ~2h15m-cold / ~44s-incremental sizing asymmetry.
- `docs/review-150.md`: the two minor doc-consistency findings (SPEC RED wording, plan.md
  `940/940`) and the line-cite nits.
- This flight's SPEC D4 already carried the #110 monitor Item H freshness check — the predecessor
  loop worked; Item 1 above is the *extension* (provenance) that Item H alone cannot catch.

## Residual risks (after closure)

- `docs/mutation-testing.md` "Reading the report (freshness first)" still does not carry the
  provenance trap (Item 1) — a future flight following only the freshness gate can be fooled by a
  fresh-but-reused report.
- Issue #47 does not yet carry the Item 4 UX candidate.
- Items 2 and 3 exist only in flight artifacts + this report until the driver applies them to the
  SPEC/plan template and future issue bodies.
- Items 5 and 6 live nowhere durable in-repo; they need the pipeline playbook.

## Notes for the driver

- Closure sequence observed complete and correct: merge `8d1f9eb` → evidence comment (matches
  `docs/verify-150.md-issue-comment.txt`) → close with `--reason completed`. The comment lists the
  docs as code spans, not hyperlinks — the ship-150.md "merge first so the link resolves" premise
  applied only weakly; no action needed.
- All six candidate items from the brief were verified: 1-4 are artifact-backed (machine-read
  this pass); 5-6 are flight-ops items with no repo artifact — recorded above with that caveat.
