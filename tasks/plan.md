# Implementation Plan: Serialize session creation and bound the session pool (#59)

## Overview

Fix the two defects in `ReplRunner`'s session pool (`src/repl.ts`): the concurrent-creation race
that silently drops one of two sessions (both report success), and the unbounded, never-evicting
`Map` keyed by model-supplied ids. Decisions D1–D10 in `SPEC.md` are the source of truth; this plan
only orders the work and states risks.

## Architecture Decisions

- **Single-flight creation (`inflight` map)** — the promise is stored before awaiting, removed on
  success and on failure; trust-change rebuilds share the same path (D1, D2).
- **LRU by Map insertion order** — touch = delete+set on every retrieval from `run`/`resume`/
  `abandon`; `reset` removes (D4, D7).
- **Refuse-to-evict suspended sessions** — skip suspended candidates; exceed the cap rather than
  drop a pending approval. The decision is recorded in code and in the README (D6).
- **Cap 32 by default**, overridable by `ReplRunnerOptions.maxSessions` > `REPL_MAX_SESSIONS` env
  (D5). Public `liveSessionCount()` diagnostic because the DoD demands asserting the map size (D9).
- **Test seams via runtime patch only** — the createSession counter is an own-property wrapper in
  the test; no production hooks (D10).
- **Stale-reference revalidation loop** in `getOrCreateSession` so a session evicted/rebuilt while
  the trust check awaited is never returned (D3).

## Task List

### Phase 1: In-flight creation (the race)

- [ ] Task 1: `inflight` single-flight creation — RED: issue tests 1–3; GREEN: D1–D3
  - Acceptance: concurrent `run`s on one id join one creation — both variables survive (test 1);
    the counter seam shows `createSession` called once (test 2); a rejected creation is removed
    and the next call succeeds (test 3); rebuilds share the flight (covered by an existing
    trust-flip test); no session the map no longer holds is returned (D3).
  - Verify: `npx tsx --test test/repl.test.ts` (red → green); `npm test`; `npm run check`; `npm run
    build`; `npm run lint`.
  - Files: `src/repl.ts`, `test/repl.test.ts`

### Phase 2: The bounded pool

- [ ] Task 2: LRU cap + eviction + suspension protection — RED: issue tests 4 and 6; GREEN: D4–D6, D9
  - Acceptance: `maxSessions` option and `REPL_MAX_SESSIONS` env exist with the stated precedence;
    touch on run/resume/abandon; eviction picks the oldest non-suspended session and never the one
    just inserted; suspended sessions are skipped — the pool temporarily exceeds the cap rather
    than drop a pending approval; `liveSessionCount()` reports the map size.
  - Verify: focused tests red → green; `npm test`; `npm run check`; `npm run build`; `npm run lint`.
  - Files: `src/repl.ts`, `test/repl.test.ts`

### Phase 3: Reset evicts

- [ ] Task 3: `reset()` removes the entry — RED: issue test 5 + update the two existing tests that
  pinned the old contract; GREEN: D7, D8
  - Acceptance: after reset the entry is gone (`liveSessionCount()` drops, `resume` answers the
    no-session sentence, the next `run` recreates fresh); the extension-facing `ResetOutcome`
    contract is unchanged (`existed`, revoked grants); reset racing an in-flight creation reports
    `existed: false` and the creation lands after it.
  - Verify: focused tests red → green; `npm test`; `npm run check`; `npm run build`; `npm run lint`.
  - Files: `src/repl.ts`, `test/repl.test.ts`

### Checkpoint: Code complete
- [ ] Six issue tests + updated contract tests green; full suite green; check/build/lint green

### Phase 4: Documentation

- [ ] Task 4: README records the cap and eviction policy
  - Acceptance: the README names the default cap, the override knobs (`maxSessions`,
    `REPL_MAX_SESSIONS`), the LRU rule, the refuse-to-evict-suspended rule, and that `reset`
    removes the session; `maxSessions` documented on `ReplRunnerOptions` in the API section; no
    claim survives that the code does not implement.
  - Verify: read-through against `src/repl.ts`; `npm run lint`.
  - Files: `README.md`

### Checkpoint: Complete
- [ ] All SPEC.md success criteria met; `npm run coverage` green (repl.ts floor holds); mutation
  score does not regress (`npm run mutation`); ready for review

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Test 1 intermittently green (creation window too narrow to race) | Med | Trusted project with several preamble files widens the window (real file reads); test 2's counter is deterministic and pins the mechanism even if 1 flips |
| Existing tests pin the old reset contract | Med | Updated in Task 3 deliberately (D7), never deleted silently |
| New lines in `src/repl.ts` drop its coverage floor | Med | Every branch of the new code is driven by the six tests; run `npm run coverage` locally before shipping |
| Mutants in the new pool logic survive | Med | Tests assert state and map size (issue DoD); run `npm run mutation` (incremental) at the checkpoint |
| D3 revalidation loop spins under adversarial interleaving | Low | Each iteration awaits an async boundary; loop is not busy — a second pass resolves |
| Suspended-session over-cap becomes unbounded | Low | Self-limiting: each suspension demands user attention; protection ends when the session is no longer suspended |
| `reset` vs in-flight creation ordering surprises the model | Low | D8 records the semantics; sequential execution mode (#49) removes intra-message races |

## Open Questions

None — the five recorded assumptions in SPEC.md are the answers.
