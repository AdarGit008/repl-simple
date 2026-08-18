# Ship report — issue #75: abort returns what it completed

Branch `issue-75-abort-iterations` from `main` `8529f24`. Single writer, autonomous flight.

## Decision: GO

No high-risk or irreversible work (loop-control change + a `finally` cleanup + an optional interface
param; no auth/secrets/migrations/payments/deploys/deps).

## What was built

| Decision | Item | Landed |
|---|---|---|
| D30 | Abort returns `{status:"aborted", answer: extractBestAnswer(iterations), iterations}` at three sites (loop-top, query catch, post-run) instead of throwing | T2 + T5 |
| D31 | `RlmResult["status"]` + `"aborted"`; salvage = `extractBestAnswer` | T2 |
| D32 | `LlmClient.query(systemPrompt, messages, signal?)`; loop passes `options.signal` (interface change → **flag #78**) | T3 |
| D33 | `runInSandbox` removes its leaked `onAbort` listener in a `finally` (root cause of "8 listeners after 8 iterations") | T4 |
| D34 | Post-run abort check surfaces the partial mid-sandbox-run iteration | T5 |
| D35 | Catch checks `options.signal?.aborted` only; non-abort rejections re-throw; aborted budget `limited:false` (dropped the dead `isAbortError` after the sweep) | T2 |

Tests: flip 5.3.10 + issue tests A–E (RED at HEAD) + F/G (added at VERIFY to close sweep survivors).
Suite grew 1043 → 1045.

## Gates

- Suite **1045/1045 ×2 deterministic** · `tsc --noEmit` + build + lint clean · coverage floors met
  (rlm.ts 98.52, sandbox.ts 97.66).
- Bounded mutation sweep (`--mutate` changed sites): **22/22 changed-site mutants detected** (21 Killed
  + 1 Timeout). **M2 dead.** `rlm.ts` file score 58.66 → 64.53. Remaining 61 rlm.ts survivors are
  pre-existing `boundConversation` mutants (unrelated).

## Review

REQUEST CHANGES → 1 Important (misattributed "kills M2" comment in test A + SPEC.md) fixed; code
approved. Suggestions recorded (same-tick race note applied; loose-cast and test-E timing noted).

## Close-out actions (applied by orchestrator)

- **#78 flag (issue comment):** `LlmClient.query` now takes an optional `signal?: AbortSignal`
  (`src/types.ts`); `runRlm` passes `options.signal` so implementations can actually cancel an
  in-flight request. Back-compatible (fewer-arg implementations still assign). Flagging per #75's Do
  list — #78 reshapes these types anyway.
- **#75 closing comment:** all DoD items done — 5 tests red→green (plus F/G), M2 dead, interface
  change noted on #78, listener count returns to zero (asserted by test C).
- **#150/#33 note:** `resumeSuspended` (`src/sandbox.ts:1272-1278`) has the identical `onAbort`
  listener leak fixed for `runInSandbox` here; it is deliberately out of #75 scope and left for the
  resume-abort surface (#150 landed, #33 open).

## Rollback

Pure code: revert per-task commits (T1/T2/T3/T4/T5 separable); < 5 min, no infra.
