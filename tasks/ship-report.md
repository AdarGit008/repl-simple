# Ship Report — issue #33: Plumb signal and limits through the extension and ReplRunner

## Decision: **GO** ✅

Not high-risk or irreversible (library + extension change; no auth, secrets, migrations, payments,
deploys; the change only *narrows* what the model can do). Security: **0 Critical / 0 High /
1 Medium / 1 Low / 2 Info**. The single Medium is a least-privilege/config-integrity issue, bounded
by the spec's own caps and the host wall clock in any default deployment — acceptable to ship
provided it is filed as a follow-up (below).

## What was built

| Decision | Item | Landed |
|---|---|---|
| D2 | `ReplRunner.run`/`resume` accept `limits?: RunLimits \| "unbounded"` and forward verbatim | T1 |
| D3 | `clampModelLimits` helper + clamped `maxDurationSecs`/`maxMemory` (300 s / 1024 MiB) on `repl` | T2 |
| D4 | Abort = transcript rollback (side effects persist) — documented + pinned | T3 |
| D7 t1 | End-to-end abort-between-gated-calls test (side-effect counter) | T4 |
| D5/D6 | Scope-boundary description sentence + `_signal` rationale | T5 |
| — | Biome fix + D6 description test + clamp edge cases | VERIFY |

## Gates

- `npm test` — **1041/1041 pass** · `npm run check` + `npm run build` clean · `npx biome check
  src extensions test` clean (repo-wide `npm run lint` has 87 pre-existing errors in untracked
  `.pi-subagents/*.json`, not from this flight).

## Review & audit

- Five-axis code review: **Approve**, 0 Critical / 0 Important, 3 Suggestions.
- Security audit: **GO** — 0 Critical / 0 High / 1 Medium / 1 Low / 2 Info. Verified the model can
  never reach `"unbounded"`, never exceed 300 s / 1024 MiB, and every malformed input degrades to
  the fail-safe default.

## Rollback

- **Pre-merge (now):** branch is unmerged; rollback = do not merge, or
  `git branch -D issue/33-plumb-signal-limits`. `main` is still `5e57e57`.
- **Post-merge:** `git revert --no-commit a934fbd..41a5d7d` then commit (linear 7-commit range);
  or `git revert -m 1 <merge>` if squashed. Verify `npm test` back to 1039 pre-flight baseline.

## Residual risks & post-ship follow-ups

1. **[Medium/security] Clamp ceilings ignore `REPL_MAX_DURATION_SECS` / `REPL_MAX_MEMORY_MB`** —
   an operator who tightens those env vars to bound per-worker resources is silently bypassed; a
   prompt-injected model can still request the fixed 300 s / 1024 MiB caps. Derive the ceiling as
   `min(specCap, envDefault)` and integerize the memory bytes.
2. **[Low] Fractional `maxMemory`** yields non-integer/sub-byte byte counts to Monty — floor to an
   integer (fold into #1).
3. **[Info] `repl_resume` forwards no `limits`** — resumed runs re-apply sandbox defaults; safe
   direction (more restrictive, never more permissive) but asymmetric. Expose the two knobs on
   `repl_resume`, or persist the suspended run's clamped limits in `Session`.
4. **[Info] Test helper monkey-patches `ReplRunner.prototype.run`** — add a sequential-assumption
   comment if the suite is ever parallelised.
5. **Issue-body updates** (from the initial scan): the body's signal-half line refs are stale; the
   DoD "No `_signal` remains" needs rescoping to the abortable tools; record the
   "transcript-rollback, side-effects-persist" semantics so a future flight doesn't misread
   "rolled back".

## Close-out actions

- Merge `issue/33-plumb-signal-limits` into `main` (closes #33, a bucket-3 step; unblocks #35).
- File the follow-ups above; update #33's body (stale line refs, `_signal` DoD rescope, D4
  semantics) per the issue-monitor's final report.
