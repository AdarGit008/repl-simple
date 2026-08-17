# Tasks — Serialize session creation and bound the session pool (#59)

- [x] Task 1: `inflight` single-flight creation (D1–D3) + issue tests 1–3 (TDD: RED → GREEN)
  - Acceptance: `Promise.all` of two runs on one id leaves both variables alive; the counter seam
    shows `createSession` called once; a rejected creation is removed from `inflight` and the next
    call on that id succeeds; a session the map no longer holds is never returned (D3).
  - Verify: `npx tsx --test test/repl.test.ts`; `npm test`; `npm run check`; `npm run build`;
    `npm run lint`.
  - Files: `src/repl.ts`, `test/repl.test.ts`

- [ ] Task 2: LRU cap + eviction + suspension protection (D4–D6, D9) + issue tests 4 and 6
  - Acceptance: `ReplRunnerOptions.maxSessions` and `REPL_MAX_SESSIONS` env with stated precedence
    and default 32; touch on run/resume/abandon; oldest non-suspended session evicted, never the
    just-inserted id; suspended sessions skipped (pool exceeds cap rather than drop a pending
    approval); `liveSessionCount()` reports the map size.
  - Verify: focused tests; `npm test`; `npm run check`; `npm run build`; `npm run lint`.
  - Files: `src/repl.ts`, `test/repl.test.ts`

- [ ] Task 3: `reset()` removes the entry (D7–D8) + issue test 5 + update the two existing tests
  - Acceptance: after reset the entry is gone — count drops, `resume` answers the no-session
    sentence, next `run` recreates fresh; `ResetOutcome` unchanged; reset during an in-flight
    creation reports `existed: false`.
  - Verify: focused tests; `npm test`; `npm run check`; `npm run build`; `npm run lint`.
  - Files: `src/repl.ts`, `test/repl.test.ts`

- [ ] Task 4: README records the cap and eviction policy
  - Acceptance: default cap 32 + override knobs named; LRU rule; refuse-to-evict-suspended rule;
    reset removes the session; `maxSessions` on `ReplRunnerOptions`; no claim the code does not
    implement.
  - Verify: read-through against `src/repl.ts`; `npm run lint`.
  - Files: `README.md`

- [ ] Checkpoint: Complete — `npm run coverage` green; `npm run mutation` score holds; review + ship
