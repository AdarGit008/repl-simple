# Spec: Bound message growth in the RLM feedback loop — issue #74

Issue: https://github.com/AdarGit008/repl-simple/issues/74 (Bucket 9, step 4 — parent #70, blocked-by #18/#30).

## Objective

`runRlm` (`src/rlm.ts`) accumulates a conversation of `messages` that grows by two entries per
iteration with **no total ceiling**. The issue reproduces it as a 300 KB print per iteration driving
prompt sizes `[119, 262403, 524687, 786971]` bytes → 1.57 MB across 4 iterations (~390 K tokens).

The issue names three uncapped paths. Verified against HEAD (not the issue's stale line numbers) the
three stand as follows:

1. **`buildFeedback` stdout interpolation.** `buildFeedback` (`src/rlm.ts:234`) interpolates
   `result.stdout` raw, on both the error path (`Error: ${result.error}\nstdout: ${result.stdout}`)
   and the ok path (`\nstdout:\n${result.stdout}`). The issue's "256 KiB per-iteration sandbox cap"
   is **stale**: `stdout` is now capped per run at **32 KiB** by `src/sandbox.ts` (the
   `DispatchAccumulators` `Truncator`, `DEFAULT_MAX_STDOUT = STDOUT_MAX_BYTES`). What is still true:
   there is no feedback-specific budget, and a caller may raise the sandbox cap via
   `runOptions.maxStdoutBytes`, so `buildFeedback` inherits an arbitrary ceiling.
2. **`result.output` interpolation.** The issue's "no cap at all" is **stale**: #34 landed
   (commit `e556a70`) and, per its Exception 2, caps `output` at **16 KiB** where the `RunOk` is
   built — `capOutput` at `src/sandbox.ts:475`, applied at every `RunOk` site (`:793`, `:964`,
   `:1250`) precisely so the RLM loop's bare-`context` case (A23) is covered too. What is still
   true: `buildFeedback` (`Output: ${output}`, `src/rlm.ts:292`) re-interpolates it with no cap of
   its own and no feedback budget.
3. **The message array.** `messages` (`src/rlm.ts:347`) starts with one initial user message and
   then `messages.push` appends the assistant reply (`:413`) and the feedback user message (`:420`)
   every iteration. It never drops or summarises anything. **This is the live headline defect**:
   even with per-run caps in place, cumulative growth is unbounded — 10 iterations × (≤32 KiB stdout
   + ≤16 KiB output) ≈ 480 KiB of feedback alone, plus every LLM reply.

**The compounded-by-#72 diagnostic is resolved at HEAD.** #72 (commit `3e74313`) fixed the
deterministic ~4 KB, 12-error `unresolved-reference` diagnostic by always declaring `context`
(`src/rlm.ts:339`, `runInputs.context = runInputs.context ?? ""`). It is not a live path and is out
of scope here. #72 **did** leave a live deferral recorded on #74: `buildInitialPrompt`
(`src/rlm.ts:195`) renders every input with a per-value 5000-char head/tail preview but **no
aggregate cap** — N large inputs ≈ N×~5 KB of initial prompt. The aggregate policy belongs here
(D6).

## Scope

**In scope** (exact files expected to change):

- `src/rlm.ts` — feedback caps (D1), conversation bound + history-drop notice (D2–D4), initial-prompt
  aggregate cap (D6).
- `test/rlm.test.ts` — the issue's five tests, re-expressed against HEAD (see Testing strategy).
- `docs/truncation-policy.md` — record the RLM feedback/conversation budgets and the chosen
  history-bounding strategy in the implementation-record table (the issue's "document which").

**Out of scope** (do not touch):

- `src/truncate.ts` — the helper is reused, never edited (invariant 4: one implementation).
- `src/sandbox.ts`, `src/repl.ts`, `src/builtins.ts` — already capped by #29/#34.
- `src/rlm_loop.ts` — the legacy loop, slated for deletion by #78.
- `src/types.ts` — no new public option; budgets are module constants (Assumption 6).
- Summarisation of dropped history (D4 defers it), `result.error` truncation (the policy's declared
  non-goal), structure-aware `output` elision (#69), and input-name validation (a hardening note on
  #74, a separate concern).

## Explicit decisions

### D0 — The truncation policy being implemented (from #30)

`docs/truncation-policy.md` is normative and already implemented by #29/#34:

| field | shape | byte budget | marker inside budget? | magnitude? | recovery route? |
|---|---|---|---|---|---|
| `stdout` | head+tail, elided middle, 25/75 | 32 KiB | yes | yes | yes ("Re-run with a narrower print") |
| `output` | head+tail, elided middle, 50/50 | 16 KiB | yes | yes | yes ("Assign the value to a name and slice it") |

One tool result ≤ 48 KiB, two fixed sub-budgets, **no borrowing**. Invariants: budget is a ceiling
*including* the marker; never split a UTF-8 character; prefer not to split a line (SHOULD); one
implementation; markers report **true** totals; truncation must not silence `onPrint`. Marker text
uses pi's `[… N of M elided. RECOVERY …]` vocabulary.

### D1 — Reuse `truncateText` for the feedback caps (the #34 helper)

`buildFeedback` caps `result.stdout` and `result.output` with its own feedback budgets, using the
**same imported symbol** `truncateText` (`src/truncate.ts:384`, re-exported `src/index.ts:132`,
already used by `src/sandbox.ts:479`) — not a third truncation. Budgets equal the policy budgets so
the normal path is a no-op (the sandbox already cut at these values, so content ≤ budget and no
second marker is emitted): `FEEDBACK_STDOUT_MAX_BYTES = STDOUT_MAX_BYTES` (32 KiB, `STDOUT_HEAD_RATIO`
+ `STDOUT_RECOVERY`), `FEEDBACK_OUTPUT_MAX_BYTES = OUTPUT_MAX_BYTES` (16 KiB, `VALUE_HEAD_RATIO` +
`VALUE_RECOVERY`). This makes the feedback budget **independent** of `runOptions.maxStdoutBytes` /
`maxOutputBytes`: a caller who raises the sandbox cap gets a feedback message still bounded at 32/16
KiB. `result.error` stays uncapped (policy non-goal); the conversation budget (D2) is its backstop.

### D2 — Conversation bound: keep first + last N turns, byte-budgeted

The `messages` array is bounded by **`MAX_CONVERSATION_BYTES = 256 * 1024`** (256 KiB) measured as
`Buffer.byteLength` over all `messages[].content`. Strategy (chosen from the issue's menu): **keep the
first message (initial user prompt) + the most recent turns; drop the oldest middle turns in whole
assistant+feedback pairs.** Dropping is whole-turn so a feedback never dangles without its assistant
message. The initial message is never dropped (it carries the question, inputs and instructions). If a
single incoming message alone exceeds the budget (an LLM reply, which the loop cannot truncate
without summarising), keep the initial message + that newest message and accept a temporary
over-budget until it ages out (recorded edge, Assumption 4).

### D3 — Tell the model when history was dropped

Dropping emits a marker message (user role, pi-style ellipsis vocabulary, consistent with the
truncation markers) stating what was dropped and why — e.g.
`[… N earlier turns dropped — conversation bounded at 256KB. The most recent context follows. …]`.
The marker counts toward the budget. Silent truncation is the failure the issue forbids: the model
must know the history it sees is partial, not assume completeness.

### D4 — No summarisation (decided, and why)

Summarising dropped turns is **out of scope**. It needs an extra LLM round-trip per compaction
(latency, cost, a second call the injected `LlmClient` was never shaped for) and is non-deterministic,
which the suite's mutation-resistant determinism requirement rejects. Keeping first + last N loses the
middle detail but is deterministic, cheap and testable. Deferred; the trade-off is documented in
`docs/truncation-policy.md`.

### D5 — Budget values and over-cap behaviour

`FEEDBACK_STDOUT_MAX_BYTES = 32 KiB`, `FEEDBACK_OUTPUT_MAX_BYTES = 16 KiB`,
`MAX_CONVERSATION_BYTES = 256 KiB`. Over-cap behaviour is **truncate for fields** (head+tail + marker,
per D0) and **drop-oldest-turns for the conversation** (D2), never summarise and never silently drop a
field. Justification for 256 KiB: a 6× reduction vs the issue's 1.57 MB/4-iterations, comfortably
fits ~4–5 max-size tool results (48 KiB each) plus code before the first drop, and stays in the same
order as the policy's 48 KiB tool-result ceiling × ~5.

### D6 — Initial-prompt aggregate cap (the #72 deferral)

`buildInitialPrompt` keeps its per-value 5000-char head/tail preview, but the **aggregate** rendered
input section is bounded: pass the inputs section through `truncateText` with an
`INPUT_PREVIEW_MAX_BYTES = 32 * 1024` budget (head+tail, `VALUE_HEAD_RATIO`, a recovery clause that
names the input and says to slice it in Python). This closes the N×~5 KB gap #72 deferred to #74.

## Assumptions (recorded — fire-and-forget, no human asked)

1. Feedback budgets equal the policy budgets (32/16 KiB) rather than a tighter value — keeps one
   declared number per field and makes the normal path a marker-free no-op.
2. `MAX_CONVERSATION_BYTES = 256 KiB` — the issue gives no number; sized against the 48 KiB
   tool-result ceiling and the 1.57 MB repro.
3. History strategy is **keep first + last N**, not summarise and not drop-oldest-only — dropping
   oldest-only would discard the initial prompt/instructions; summarise is deferred in D4.
4. A single over-budget LLM reply is kept and allowed to exceed the budget transiently — the loop
   cannot truncate model output without summarising, which is out of scope.
5. Budgets are module constants, not `RlmOptions` fields — the issue asks for no new public knob, and
   constants keep `src/types.ts` untouched (a configurable budget is a possible follow-up).
6. The initial-prompt aggregate cap uses a 32 KiB budget and flat head+tail — structure-aware input
   elision is not attempted (same flat-cut rule the policy already applies to `output` until #69).
7. `result.error` remains uncapped per-message — the policy already declares it a non-goal; D2 is the
   backstop, and if `error` proves unbounded it is a separate issue.
8. The "shared helper by construction" requirement (issue test 5) is verified by rlm.ts importing
   `truncateText` from `./truncate.js` (the same module `sandbox.ts` imports) plus a source-level
   check that no new truncation logic is defined in rlm.ts — mirroring #34's grep-based DoD.

## Tech stack

TypeScript 5.9 (strict), `node:test` + `node:assert/strict` via `tsx --test`, Biome 2.5.8 (lint +
format), Stryker 9.6.1 (mutation, incremental), `tsc -p tsconfig.build.json` for build. Node >=
22.19.0. No new dependencies.

## Commands

```
Test (focused):  npx tsx --test test/rlm.test.ts
Test (full):     npm test
Type-check:      npm run check
Build:           npm run build
Lint:            npm run lint
Coverage gate:   npm run coverage
Mutation:        npm run mutation        (quality gate; incremental)
```

## Project structure

```
src/rlm.ts              → feedback caps (D1), conversation bound + notice (D2–D3), aggregate input cap (D6)
test/rlm.test.ts        → the issue's five tests, re-expressed against HEAD
docs/truncation-policy.md → implementation-record rows for the feedback/conversation budgets + strategy
src/truncate.ts         → reused only (truncateText); never edited
```

## Code style

Follow the file's existing voice: sentence-style model messages, JSDoc on every decision, issue
references in comments, no `any`. The feedback path reuses the existing helper rather than slicing
bytes by hand:

```ts
import { truncateText, STDOUT_MAX_BYTES, STDOUT_HEAD_RATIO, STDOUT_RECOVERY,
         OUTPUT_MAX_BYTES, VALUE_HEAD_RATIO, VALUE_RECOVERY } from "./truncate.js";

const { text: stdout } = truncateText(result.stdout, {
  maxBytes: FEEDBACK_STDOUT_MAX_BYTES,
  headRatio: STDOUT_HEAD_RATIO,
  recovery: STDOUT_RECOVERY,
});
```

## Testing strategy

`node:test`, behaviour-first, through the real `runRlm` with the existing `mockLlmCodeGen`
(`test/rlm.test.ts:263`) and a real `ToolRegistry` + real Monty — the suite's existing deterministic
style. The five issue tests, re-expressed for HEAD:

1. **The reproduction, re-budgeted.** Four iterations each printing 300 KB (now → 32 KiB `stdout` +
   16 KiB `output` per run under the default caps) keep the **total conversation bytes** passed to
   `llmClient.query` under `MAX_CONVERSATION_BYTES`. The issue's `[119, 262403, 524687, 786971]`
   prompt sizes are the historical baseline from the pre-#29/#34 tree; the regression target is that
   no call's total messages exceed 256 KiB (and the 1.57 MB figure cannot recur).
2. **`result.output` capped in feedback.** `buildFeedback` with a synthetic `RunResult` whose
   `output` is huge returns a feedback string whose `Output:` section is ≤ 16 KiB and carries the
   policy marker — asserted via `truncateText`'s already-tested behaviour (assert the marker, not
   merely the ceiling).
3. **`result.stdout` capped in feedback, independently of the sandbox cap.** `buildFeedback` with a
   synthetic `RunResult` whose `stdout` is huge (or `runRlm` with `runOptions.maxStdoutBytes` raised
   high) yields a feedback `stdout:` section ≤ 32 KiB, even though the sandbox passed more.
4. **The conversation bound is asserted at the boundary.** Enough iterations (or large-enough
   feedback) to cross 256 KiB → the messages sent to the LLM drop the oldest middle turns in whole
   pairs, keep the initial message and the newest turns, and total ≤ budget.
5. **The model is told history was dropped.** After a drop, the messages contain the history-dropped
   marker (D3), and no dangling feedback (pairs are dropped whole).
6. **Shared helper by construction.** `rlm.ts` imports `truncateText` from `./truncate.js` (the same
   symbol `sandbox.ts` uses); a source-level check asserts no hand-rolled truncation exists in
   `rlm.ts` (Assumption 8).
7. **Aggregate input cap (D6).** `runRlm` with several large inputs produces an initial message whose
   input-preview section is ≤ `INPUT_PREVIEW_MAX_BYTES`.

Coverage note: `coverage-baseline.json` floors `src/rlm.ts` at **95.94%**. Every new branch
(feedback caps, the drop loop, the notice, the aggregate cap) must be exercised to keep the floor
green; do not hand-edit the baseline.

## Boundaries

- **Always:** test before fix, full `npm test` before commit, `npm run check` + `npm run build` +
  `npm run lint`, issue-referenced commit message, mark tasks in `tasks/todo.md`.
- **Ask first (record instead — fire-and-forget):** nothing here is high-risk; surprises are recorded
  in the ship report.
- **Never:** write a second truncation implementation; summarise history via the LLM; hand-edit
  `coverage-baseline.json`; touch `src/truncate.ts`, `src/sandbox.ts`, `src/repl.ts` or
  `src/rlm_loop.ts`.

## Success criteria

1. All five issue tests (plus the D6 aggregate test) exist and pass; tests 1–5 are red before their
   fix where applicable.
2. The 1.57 MB reproduction stays bounded: 4 iterations of a 300 KB print never exceed 256 KiB of
   total conversation, and 10 iterations trigger the drop, not unbounded growth.
3. `buildFeedback` caps `stdout` ≤ 32 KiB and `output` ≤ 16 KiB via `truncateText`, independent of
   the sandbox caps.
4. The conversation-bounding strategy (keep first + last N, drop oldest turns whole) is asserted at
   the boundary and documented with its trade-off in `docs/truncation-policy.md`.
5. The model is told when history was dropped (D3 marker present).
6. Exactly one truncation implementation is used by `rlm.ts`, `repl.ts` and `sandbox.ts`
   (verified by construction, not by duplicated behaviour).
7. `npm test`, `npm run check`, `npm run build`, `npm run lint`, `npm run coverage` exit 0; mutation
   score does not regress.

## Open questions / risks

1. **Double-truncation totals (invariant 5).** If a caller raises the sandbox cap above the feedback
   budget *and* the true output exceeds the sandbox cap, the feedback cap re-truncates an
   already-truncated value, so its marker's "total" is the post-sandbox size, not the true total. Only
   reachable via an explicit caller override; cosmetic, not a correctness failure. Recorded rather
   than solved.
2. **Single over-budget LLM reply.** Kept and allowed to exceed the budget transiently (Assumption 4);
   unbounded model output remains a residual risk unless summarisation lands later.
3. **Budget numbers are judgement, not measurement** — 256 KiB conversation / 32 KiB input-preview
   follow the policy's prior-art range but were not evaluated against a live model.
4. **`error` stays uncapped per-message** — policy non-goal; if a runaway `error` string appears it
   needs its own issue.
