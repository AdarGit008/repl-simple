# Ship Report — STOP-SHIP A33–A37 (verification-only flight)

Branch: `stop-ship-a33-a37` · Date: 2026-08-22 · Decision: **GO**

## What happened

The task was to stack A33 → A34 → A35 → A36 → A37 on a fresh branch. On dispatch of the first coder,
we discovered the work was **already landed on `main`**: `docs/actionable-items.md` (the finding source)
was written at commit `dfc1136`, and 76 commits since then closed every STOP-SHIP item. This flight
therefore became **verification-only** — no new implementation was required or produced.

## Commit map (item → merged commit)

| Item | Landed as |
|------|-----------|
| A33 accumulator desync | `cef2782` (#27) |
| A34 default limits + signal | `30b2d2b` (#32) + `08985c5` (#179) |
| A35 read jail + http_get SSRF | `e7bc7da` (#43) + `cb6e35d` (#42) |
| A36 guarded resumes + reachable suspend | `b7e223c` (#36), `dc170ea` (#51), `8ac0a1e` (#48), `4709f57` (#49), `43d06ce` (#129) |
| A37 preamble trust gate + toolstore | `198384f` (#53), `4232cc7` (#54), `0e93978` (#55), `10c536c` (#57), `4c7662c` (#56) |

## Verification evidence

- **Phase 4 (test-engineer):** `npm test` green — 1095 tests / 250 suites / 0 failures. `npm run
  coverage` green, all per-file floors met (98.46% vs 97.84 baseline). Every A33–A37 acceptance test
  present and passing. Gaps are low/medium defensive or environment-gated branches only.
- **Phase 5 (code-reviewer):** REQUEST CHANGES, one Important finding — the SPEC (faithfully
  reproducing the stale `actionable-items.md`) described a per-file content-hash approval model for
  A37, but the code uses a project-trust gate. **Reconciled** in `SPEC.md` AS5/A37 (project-trust is
  the accepted mechanism; residual recorded). No Critical findings.
- **Phase 6 (security-auditor):** merged the two reports; Critical 0, High 0, Medium 1 (R1), Low 1
  (R2). **NO-GO blocker present: NO.**

## Residual risks (recorded, not hidden)

- **R1 (Medium, A37):** once a project is trusted, a later-added/rewritten `.pi/code-tools/*.py`
  auto-executes with no new prompt (TOFU/supply-chain). Default is untrusted (`() => false`); trust is
  an explicit human decision. Follow-up: emit a `[preamble changed]` notice using the existing
  `PreambleFileIdentity` machinery (hash-pin + re-confirm on manifest change only, no per-session
  fatigue).
- **R2 (Low, A35):** `http_get` DNS-rebinding TOCTOU — validates resolved IPs, then hands `fetch` the
  hostname. Documented accepted risk in `docs/http-egress.md`. Follow-up: pin the connection to the
  validated address once `undici` is a dependency; interim: "two-lookups-agree" or
  "ever-private-never-blocked" hardening. Default is `requiresApproval: true` (empty allowlist).

## Rollback plan

No new code is being merged. The three commits on this branch are documentation only
(`SPEC.md`/`tasks/plan.md`/`tasks/todo.md` reconciliation + this report). Rollback = delete the branch
or revert these three doc commits; `main` is untouched.

The STOP-SHIP code fixes themselves are already on `main` as 15+ independently-revertable commits (the
map above). Any future regression reverts to the specific item commit without disturbing the others.

## Go / No-Go

**GO.** All five STOP-SHIP items are closed and verified; the suite and coverage floors are green; the
code review and security audit found no Critical/High finding; both residuals sit behind explicit,
default-off human decisions and are recorded as follow-ups (R1, R2).

No PR is opened: there is no code to merge. The doc-only branch can be merged (to persist the
reconciliation and residual record) or discarded at the operator's discretion. Recommend filing R1 and
R2 as follow-up issues against buckets 6 (preamble) and 4 (security perimeter) respectively.
