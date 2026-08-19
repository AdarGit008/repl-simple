# Ship Report — issue #76: RLM answer provenance

## Decision: **GO** ✅

Not high-risk/irreversible (no auth, secrets, migrations, payments, deploys). Security: 0 Critical /
0 High / 0 Medium / 2 Low / 2 Info.

## What was built

| Decision | Item | Landed |
|---|---|---|
| D41 | `RlmResult.answerSource: "submitted" \| "salvaged" \| "synthesised"` (required) | T1 |
| D42 | `"(no answer)"` magic string removed → `""`; `answer` stays required `string` | T1 |
| D43 | `extractBestAnswer` comment fixed to match code | T1 |
| D46 | all four `runRlm` return sites set `answerSource` | T1 |
| D44 | guarded final-synthesis `llmClient.query` at the cap; throw/abort → salvage | T2 |
| D45 | synthesis un-charged against budget | T2 |
| D47 | 5 issue tests + 2 VERIFY-gap tests (abort-during-synthesis, D45 un-charged) | T1/T2/VERIFY |

## Gates

- `npm test` — **1054/1054** · `npm run check` + `npm run build` clean · changed files biome-clean.
- Coverage `src/rlm.ts` **99.15%** ≥ 97.69 floor; all per-file floors met.
- Repo-wide `npm run lint` reports 87 pre-existing errors in untracked `.pi-subagents/` — not from
  this change (CI on committed code is clean).

## Review

Five-axis code review: **Approve**, no Critical/Required findings. See `tasks/review.md`.

## Security audit

**GO.** Synthesis reply treated as untrusted data (returned as `answer`, never executed/eval'd).
No new prompt-injection surface; no secrets. Two Low findings (below).

## Residual risks & post-ship follow-ups (hand to the issue-monitor final report)

1. **Synthesis query not `raceAgainstSignal`-wrapped** (`src/rlm.ts:1034`) — abort-liveness
   consistency; a signal-ignoring client that never settles makes an abort during synthesis never
   return. (reviewer follow-up + security Low #2)
2. **Budget-charging policy for synthesis (D45)** — one un-charged full-context call per capped run
   is a bounded spend bypass; charge it or gate behind opt-in. (reviewer follow-up + security Info)
3. **Cap the synthesized reply** (`src/rlm.ts:1045`) — the raw LLM reply is the only unbounded
   `answer` source; route through `truncateWithSentinels` at a dedicated cap. (security Low #1)
4. **`""`-sentinel contract change** — consumers must read provenance from `status` + `answerSource`,
   not `answer` truthiness/equality. (security Info)

## Rollback

- Pre-merge (now): `main` is still `422174f`; rollback = do not merge /
  `git branch -D issue/76-salvage-provenance`.
- Post-merge: `git revert --no-commit 422174f..HEAD` then commit + push. Low conflict risk (linear
  feature commits touching only `SPEC.md`, `tasks/`, `src/rlm.ts`, `src/types.ts`, `test/*`).
- Verify: `npm test` back to prior count; `grep -rn 'answerSource\|"(no answer)"' src/` empty.

## Close-out actions

- Merge `issue/76-salvage-provenance` into `main` (closes #76).
- #78 becomes unblocked; it consumes `answerSource` verbatim (D41) and adds `status:"error"`.
- File the four follow-ups above (or carry them in #78 + a budget follow-up).
