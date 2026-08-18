# Ship report — flight F-145 (issue #145 "9.11 — Post-ship RLM message-growth polish")

Branch: `issue-145-rlm-polish` · 24 commits ahead of `origin/main` (base `791096a`; origin/main
advanced to `e796174` — F-77 — during the flight, intentionally not rebased; merge strategy: resolve
planning-doc collisions per SPEC/plan, code union is disjoint from F-77's session/types work).

## Decision: GO

No high-risk or irreversible work in this flight (no auth, secrets, migrations, payments, deploys,
dependency changes — auditor-confirmed). Doubt-driven risk check: the only flagged risk class is
prompt-steering residuals inside a defense-in-depth mechanism; the real security boundary (sandbox +
approval-gated registry) is untouched.

## What was built (D10–D27)

| Decision | Item | Landed |
|---|---|---|
| D10 | drop-marker label derived from `MAX_CONVERSATION_BYTES` via `formatSize` | T4 + test 5 regex / test 6 grep |
| D11/D16 | test 5 parity + last-role + dropped-turn count (completed-turns scope, build-corrected) | T2 |
| D12 | O(n²)→O(n) running byte total in `boundConversation`, byte-identical | T10, guarded by tests 1/4/5/24 |
| D13 | boundary guard tests 10–13 (exact-at, no-hang, just-under, error stdout cap) | T1 |
| D14 | honest TextEncoder framing (src token-ban safe, docs may name Buffer) | T11 |
| D15 | per-value 5 KiB input previews + block-level aggregate elision (fence-split) | T5 + test 14 |
| D17 | sentinel-delimited truncation markers + system-prompt rule (7 call sites) | T6 + test 17 |
| D18 | assistant-reply cap 256 KiB, raw `llmResponse` preserved | T7 + test 16 |
| D19 | error-line `> ` quoting, real `\nstdout:` unforgeable | T8 + test 18 |
| D20 | input-name regex + 35-keyword denylist at the merge choke point | T9 + test 15 |
| D21 | cap-strength pins (composition, boundary pairs, 50/50 shape) | T3, tests 19–21 |
| D22 | `ERROR_MAX_BYTES` → `FEEDBACK_ERROR_MAX_BYTES` | T10 |
| D23 | `questionText` binding + docs:390 whole-table sentence | T12 |
| D24 | question-as-input follow-up — deferred, recorded (needs a home) | SPEC |
| D25 | bounded mutation strategy, honestly recorded | VERIFY |
| D26 | item 8 + absorbed-6b — **BLOCKED** (F-77-era code absent from branch base; remain open on #145) | recorded |
| D27 | sentinel-rule marker grant scoped to the system's marker (audit Medium) | T19 |

## Gates (VERIFY rounds 1–5)

- Suite: **967/967 ×2 deterministic**, zero flakes (final round; grew 963→967 through T13–T19).
- Static: `tsc --noEmit`, `tsc build`, biome lint — clean.
- Coverage: all 16 per-file floors met; `src/rlm.ts` **98.65%** vs 95.94% floor; baseline untouched.
- Mutation: bounded sweep over changed call sites (D25), guard **PASS**; all named-site survivors
  killed across rounds (C1/C2 by test 24; M4/M5 + three D27 prose pins by test 17(c)); rlm.ts-only
  61.9% population, **non-comparable** to #144's 89.6% (different populations — recorded, see
  monitor report §1.5).

## Review / audit fan-out

- **code-reviewer (Phase 5):** REQUEST CHANGES at review time — 0 Critical, 4 Important (I1–I4:
  sentinel-rule vs drop-marker incoherence, rule miswording, sentinel-token forgery residual, keyword
  gap) — **all fixed in T15**, plus suggestions S1/S2/S4/S5 landed and S3/S6–S8 recorded with routing.
- **test-engineer (Phase 4 + rounds):** all gates green; H1–H3/M4/M5/L1 closed (T13/T16); C1/C2
  killed (T14); D27 pins live (round 5).
- **security-auditor (Phase 6):** 0 Critical, 0 High, 1 Medium (marker grant inside authentic pairs
  + docs overclaim), 3 Low, 3 Info — Medium **fixed in T19 (D27)**; Low/Info routed (#77/#78/#87/#145
  close notes). Verdict: nothing blocks GO.

## Rollback plan

- **Trigger:** post-merge regression in RLM runs (the extension is the consumer; `runRlm` behavior is
  the blast radius).
- **Steps:** (1) `git revert <merge-commit>` on main (each task is one commit, so bisect to the
  offending task is possible); (2) verify with `npm test`; (3) if a single task is at fault, revert
  only that commit.
- **Time to rollback:** < 5 min (single repo, no infra).
- **No data migrations, no schema, no persisted state changes** — rollback is purely code.

## Residual risks (non-blocking, all routed — exact wording in tasks/monitor-report.md)

1. Item 8 (`Session.prefixLineCount` O(n²)) + absorbed-6b rename — **remain open on #145**; fix
   post-merge on main (F-77-era code; blocked on this branch, verified).
2. Marker-shaped text inside authentic sentinel pairs — steering-only residual; sandbox remains the
   boundary; docs Exception 5 now records it honestly.
3. D19 ok-branch `Output:` forgery — recorded, → #77/#78.
4. Question-as-input follow-up (D24) — needs a home (#78 or dedicated) before #145 closes.
5. S3/S5/S7/S8 (silent-drop insurance, custom-systemPrompt rule loss, unquoted() drift, file growth)
   — recorded with routing.
6. Merge collision with F-77 (`e796174`): planning-doc overlap only per review; code union disjoint
   — but F-77 rewrote `src/session.ts`/`src/sandbox.ts`/`src/rlm.ts` lineOffset wiring; the merge must
   run the full suite after resolution. No rebase was attempted by design (recorded decision).

## Open-issues recommendations

Delegated to the monitor's final report (`tasks/monitor-report.md` — advisory): #145 closing record
(§1.1–1.7), #77 ledger corroboration (§2), #78 convergence constraints (§3), #87 budget inputs (§4),
#70 epic status (§5), #69 scope update (§6), three new-issue candidates (§7), and process hygiene
notes (§8). Apply before closing #145.
