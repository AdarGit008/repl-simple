# Spec: Bound and signal-race the llm_query / rlm_query-downgrade / synthesis LLM calls — issue #171

## Objective

Three of `runRlm`'s five provider calls were second-class. The main loop bounds its question and
its input previews before they reach a prompt, and races its own `llmClient.query` against the
caller's signal. `llm_query`, the `depth >= maxDepth` downgrade of `rlm_query`, and the #76
synthesis pass did neither.

Two consequences, one per half:

- **Unbounded interpolation.** `prompt`, `query` and `context` are strings the *model* wrote, and
  each lands in a user message verbatim. A runaway generation ships the lot to the provider. Worse,
  nothing neutralised them: a model could plant a `[TRUNCATED VIEW BEGIN]` / `[TRUNCATED VIEW END]`
  pair, and the sub-LLM — reading under the same system prompt that tells it to trust elision
  markers between sentinels (D17) — would take a fabricated summary as authentic.
- **No abort race.** On the two tool paths this is not a termination bug: the sandbox ends an
  aborted run on its own. It is a *trace* bug. `ABORT_SETTLE_GRACE_MS` exists so the dispatch loop
  can report the tool call that was in flight, and only "a run parked in a tool that will not
  return" is cut off without that report (`src/sandbox.ts:776-788`). An un-raced `llm_query` against
  a provider that never answers is exactly that run — so the caller is told nothing ran, while the
  call really did run, really did reach the provider, and really was charged (D62). On the synthesis
  pass it *is* a termination bug: the pass runs after the loop and outside the sandbox, so there is
  no next loop-top check and no sandbox cut-off. Un-raced, it is the one call from which an aborted
  run can never return.

Success looks like: every model-written string reaching a provider is bounded and sentinel-
authenticated at the main loop's own ceilings; every one of the five provider calls is raced; the
budget charges what is actually sent; and an abort during any of the three leaves a complete
result.

Issue: https://github.com/AdarGit008/repl-simple/issues/171.
Source: #78 (RLM convergence) review suggestion + #76 residual risk 1.
Stacked on #189/#190 (PR #193), which touches the same two call sites.

## Assumptions (recorded — autonomous run)

- **A1 — The ceilings are borrowed, not invented.** The ask *is* a question, so `llm_query`'s
  prompt and the downgrade's query take `QUESTION_MAX_BYTES` / `QUESTION_RECOVERY`. The downgrade's
  context is one value, so it takes `INPUT_PREVIEW_VALUE_MAX_BYTES`. No new byte budget is minted.
- **A2 — The synthesis messages are already bounded.** `boundConversation` caps the transcript and
  `FINAL_SYNTHESIS_PROMPT` is a constant, so the synthesis pass needs the race and nothing else.
- **A3 — The nested (non-downgraded) `rlm_query` needs nothing.** Its query goes through the
  child's own `buildInitialPrompt` question bound, and its context is a real sandbox input whose
  preview is bounded there.

## Decisions

- **D1 — Bound with `truncateWithSentinels`, not `truncateText`.** The recipient is an LLM under a
  system prompt carrying the D17 rule, so a truncated view must be authenticated. The wrap is also
  what neutralises a forged sentinel in the value — the security half of this change, and it
  applies under budget too, where no truncation happens at all.
- **D2 — Two budgets on the downgrade, not one.** A single shared ceiling would let a huge query
  starve the context, or let a huge context ride the question's much larger allowance.
- **D3 — Value shape (50/50 head+tail), not head-only.** The goal is to keep the ask legible from
  both ends. Head-only is the *redaction* shape and belongs to the provider-error path.
- **D4 — A new `DOWNGRADE_CONTEXT_RECOVERY`.** `INPUT_PREVIEW_RECOVERY` says the value is a named
  Python variable to slice; at the downgrade there is no sandbox, so that route does not exist
  (policy Q3). It mirrors `QUESTION_RECOVERY` instead.
- **D5 — Bound before charging.** The charge is a before-the-call price on what the call will cost
  (D62). Pricing the raw prompt once a ceiling exists bills a run for tokens it never sends, and can
  refuse a call that would have fitted.
- **D6 — The `?? "(none)"` rendering is preserved exactly.** An omitted context still renders the
  placeholder; an empty one still renders empty. The placeholder is what distinguishes "no context"
  from "empty context" for the sub-LLM.
- **D7 — No abort branch in the two tool-path catches.** An abort arrives as a `DOMException`, which
  is an `Error` whose 25-byte message the redaction passes through untouched, with the original on
  `cause`. The sandbox sees the same `RuntimeError` either way, so a `if (signal.aborted) throw err`
  branch would be code no test could distinguish from its absence.

## Non-goals

- The synthesis pass still charges and still calls the provider when the signal is *already*
  aborted at entry; the race rejects the result rather than preventing the call. Same shape as the
  main loop, which relies on a loop-top check instead. Filed separately rather than widened here.
- The unbounded growth of `merged` context across nesting depth, and #191/#192.
