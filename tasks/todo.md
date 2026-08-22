# Todo — issue #171: bound and race the three remaining provider calls

Source of truth: `SPEC.md` (D1–D7) + `tasks/plan.md`. Stacked on PR #193 (#189/#190), which owns
the same two tool-path call sites. Do **not** mint a new byte budget (A1); do **not** use
`truncateText` for the interpolations (D1 — the sentinel wrap is the security half); do **not**
touch `buildInitialPrompt`, `boundConversation`, `src/sandbox.ts` or `src/truncate.ts`; do **not**
change the `?? "(none)"` rendering (D6); do **not** absorb the already-aborted synthesis charge,
#191 or #192. Only `src/rlm.ts`, `test/rlm.test.ts` and `docs/truncation-policy.md` are in scope.

- [x] **T1 — Bound the two tool-path prompts (D1–D6)**
  - [x] RED — six tests in a new `describe("runRlm() — tool-path prompt bounds and abort race
    (#171)")`: the 64 KiB ceiling with its sentinel wrap and elision marker; an ordinary prompt
    passing through byte-identically; a forged `[TRUNCATED VIEW …]` pair neutralised under budget;
    the downgrade's two budgets holding independently; `Context: (none)` preserved; and the charge
    priced on the bounded prompt rather than the raw one. Four RED, two green-by-design.
  - [x] GREEN — `src/rlm.ts`: add `DOWNGRADE_CONTEXT_RECOVERY` plus the tool-path budget note after
    `QUESTION_RECOVERY`; `boundedPrompt` in `onLLMQuery` and `boundedQuery` / `contextText` in the
    downgrade branch, all via `truncateWithSentinels`; the charge reads the bounded string.
  - Files — `src/rlm.ts`, `test/rlm.test.ts`.

- [x] **T2 — Race the three calls (D7)**
  - [x] MEASURE FIRST — the obvious abort test is vacuous on the two tool paths (the sandbox's own
    cut-off ends the run either way). Established by 4 runs each way that the deterministic,
    load-bearing difference is the dispatch trace, and that a *synchronous* abort while the call is
    in flight makes it deterministic. Table in `tasks/plan.md`.
  - [x] RED — four tests: the in-flight `llm_query` surviving in `calls[]`; the same for the
    downgraded `rlm_query`; the synthesis pass terminating at all (the only test in the file with
    an explicit `timeout`, because its RED state is a hang); and abort-listener balance across two
    `llm_query` calls. Three RED, one green-by-design.
  - [x] GREEN — `raceAgainstSignal` around all three `llmClient.query` calls. No abort branch in
    the catches (D7).
  - Files — `src/rlm.ts`, `test/rlm.test.ts`.

- [x] **Checkpoint**
  - [x] RED verified against the PR-#193 head: 7 of 10 red, 3 green by design.
  - [x] `npm test` 1092/1092 (+10); `npm run check`, `npm run build`, `npm run lint` clean;
    `npm run coverage` — all per-file floors met.

- [x] **T3 — Record the three surfaces in the truncation policy**
  - [x] Three Implementation-record rows (`llm_query` prompt 64 KiB; downgraded-`rlm_query` query
    64 KiB; downgraded-`rlm_query` context 5 KiB — all 50/50 head+tail, all #171).
  - [x] A `**#171 (the two tool-path prompts).**` narrative: the D17 forgery hole the raw paths
    left open, why two budgets rather than one, why a value cut rather than a redaction cut, why
    `DOWNGRADE_CONTEXT_RECOVERY` is not `INPUT_PREVIEW_RECOVERY`, and why the bound precedes the
    charge.
  - [x] In passing: the #184 narrative's `new Error(redactProviderError(err))` now also names the
    `sandboxProviderError` spelling #190 gave it.
  - Files — `docs/truncation-policy.md`.
