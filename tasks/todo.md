# Tasks — issue #75: abort returns what it completed

Branch `issue-75-abort-iterations` from `main` `8529f24`. DEFINE (SPEC D30–D35) done. RED → BUILD →
VERIFY → REVIEW → SHIP. Single writer, strict sequence.

- [x] **T1 — RED: six tests** (flip 5.3.10 + issue tests A–E; `mockLlmCodeGen` records signal)
      — all fail at HEAD; kills-M2 candidate A.
- [x] **T2 — D30/D31: return aborted (loop-top + query catch), `"aborted"` status union**
- [x] **T3 — D32: `LlmClient.query(systemPrompt, messages, signal?)` + pass-through**
- [x] **T4 — D33: `runInSandbox` finally-removal of the leaked `onAbort` listener**
- [x] **T5 — D34: post-run abort check surfaces the partial iteration**
- [x] **T6 — VERIFY: full gates ×2 (1045/1045) + bounded mutation sweep (M2 dead; 22/22 changed-site mutants detected)**
- [x] **T7 — REVIEW (`tasks/review.md`) + SHIP (`tasks/ship-report.md`) + #78 flag on the interface change**

## Checkpoint (after T5)
- [x] Six tests green; `npm test` ×2 deterministic (1043/1043); `check`/`build`/`lint`/`coverage` all exit 0.

## DoD (from #75)
- [x] All five issue tests exist, red before the fix, green after.
- [x] M2 no longer survives.
- [x] `LlmClient.query` accepts a signal; interface change noted on #78.
- [x] Listener count returns to zero — asserted (test C), not assumed.
