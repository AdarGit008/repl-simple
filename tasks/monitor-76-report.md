# Monitor Final Report — flight #76 (RLM answer provenance)

issue-monitor persona, final dispatch. Read-only. Flight: branch `issue/76-salvage-provenance`,
HEAD `442a4b2`, 5 commits `422174f..HEAD`. Result: `RlmResult.answerSource`
(`submitted|salvaged|synthesised`), `"(no answer)"` removed → `""`, guarded un-charged cap-time
synthesis. 7 tests · 1054/1054 · `src/rlm.ts` 99.15% ≥ 97.69 · review Approve · security GO.

## 1. #76 close-out (comment + DoD wording)

Post a close-out comment on #76 (model on `tasks/close-out-75-issue-comment.txt`) recording:
- `answerSource` is required + non-optional, 3-value union (D41), set at all 4 return sites (D46).
- `"(no answer)"` removed; `extractBestAnswer` returns `""`; `answer` stays required `string`;
  consumers read `status` + `answerSource`, not `answer` truthiness.
- `extractBestAnswer` comment fixed (D43) — now `src/rlm.ts:562` (issue said `:104`).
- Guarded synthesis pass (D44) with `FINAL_SYNTHESIS_PROMPT` (`src/rlm.ts:345`); never throws.
- Synthesis deliberately un-charged (D45) — charging-policy handed to #87.
- DoD all met; security 0/0/0/2 Low/2 Info → four follow-ups (§3).

Also mark `docs/actionable-items.md` A22 (~line 551) PARTIAL → DONE (its four "Remaining:" clauses
are exactly the four defects #76 fixed).

## 2. #78 handoff (now unblocked) — append a flag comment

#78 must consume `answerSource` VERBATIM (name + shape, do not rename/optionalize). `answer` stays
required `string`; "no answer" = `""`. #76 deliberately did NOT do #78's: `status:"error"`,
`RlmResult` completion / RLM-type move, `maxIterations` M1 kill, `rlm_loop.ts` deletion. Preserve
provenance semantics at `src/rlm.ts:420` (direct-answer contract) and `:936`; a rebuilt
`buildSystemPrompt` must carry `FINAL_SYNTHESIS_PROMPT`.

## 3. Four follow-ups — routing

(a) **Synthesis query not `raceAgainstSignal`-wrapped** (`src/rlm.ts:1034-1037`) → **#78** (one-line
consistency fix; keep Assumption 5 semantics).
(b) **Budget-charging policy for synthesis (D45 spend bypass)** → **#87** (decide charge vs opt-in);
one-line note on #76's close-out pointing at #87.
(c) **Cap the synthesized reply** (`src/rlm.ts:1045`, raw LLM reply = only unbounded answer source)
→ **#78** (route through `truncateWithSentinels` at a dedicated cap; D18 cap bounds only the
conversation copy, not `answer`).
(d) **`""`-sentinel contract** → **#78** + **#70** (consumers must read `status`+`answerSource`,
never `answer` truthiness/equality; `answerSource` is now public type surface).

## 4. Cross-issue gotchas

1. `answerSource` is exported public type surface (`src/types.ts:334`); behavioral change for
   consumers → carry on #78 + #70.
2. `.pi-subagents/` (untracked) causes 87 Biome errors in `npm run lint`; CI on committed code is
   clean → add `.gitignore`/scope-lint note on #70 or a hygiene issue.
3. Line-number drift corroborated (#77): #76's "comment at :104" is now `src/rlm.ts:562`; the
   direct-answer/synthesis comments are `:420`/`:936` → append to #77's ledger.
4. `rlm_tools.test.ts:250` anticipated this flight; its empty-answer precondition is now satisfied
   (live invariant, not a TODO).
5. `docs/actionable-items.md` A20 (:533) and A22 (:555) still quote `"(no answer)"` → A22 DONE,
   A20 one-line correction on #70.

## Bottom line

Highest leverage: (1) #76 close-out comment; (2) #78 flag comment (field name + out-of-scope +
comment sites); (3) four follow-ups routed (a)→#78, (b)→#87, (c)→#78, (d)→#78+#70; (4) `.pi-subagents/`
lint note on #70 + line-drift on #77. None blocks the #76 merge itself.
