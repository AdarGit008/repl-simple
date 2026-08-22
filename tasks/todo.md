# Todo — issue #195: early-return the synthesis pass on an already-aborted signal

Source of truth: `SPEC.md` (A1–A5, D1–D4) + `tasks/plan.md`. Only `src/rlm.ts` and
`test/rlm.test.ts` are in scope.

- [ ] **T1 — Early-return the synthesis pass (D1–D4)**
  - [ ] RED — a test in `test/rlm.test.ts` asserting zero synthesis `llmClient.query` calls and
        zero charge when `options.signal` is already aborted at the synthesis pass. Fails at HEAD.
  - [ ] GREEN — insert the early-return guard in `src/rlm.ts` before the `tryCharge`, mirroring the
        D64 refusal shape (`status: "max_iterations"`, `answer: extractBestAnswer(iterations)`,
        `answerSource: "salvaged"`, `iterations`), budget field conditional per A2.
  - [ ] Move/update any existing assertion that pins a call count through an aborted synthesis (A5).
  - Files — `src/rlm.ts`, `test/rlm.test.ts`.

- [ ] **Checkpoint**
  - [ ] RED verified against HEAD (test fails before the guard).
  - [ ] `npm test` green; `npm run check`, `npm run build`, `npm run lint` clean;
        `npm run coverage` floors met.
