# Spec: Cap `result.error` and the `question` in the RLM feedback loop — issue #144

Issue: https://github.com/AdarGit008/repl-simple/issues/144 (Bucket 9, child of #70 — filed by the
#74 flight, ship-report residuals 1–2). Continues #74's D1–D6; the new decisions here are D7 and D8.

## Objective

`runRlm` (`src/rlm.ts`) shipped four feedback/conversation caps in #74 (D1–D6), but two message
paths the #74 flight explicitly left as a recorded non-goal (Assumption 7) remain unbounded:

1. **`result.error`.** `buildFeedback` interpolates the error string raw on the `status === "error"`
   path — `src/rlm.ts:313` `let feedback = \`Error: ${result.error}\nstdout: ${stdout}\`;`. A single
   huge Python exception (e.g. `raise ValueError("A" * 10 ** 7)`) flows into one feedback message
   uncapped, bypassing the 256 KiB conversation bound for that iteration and undermining the D1
   feedback-cap guarantee.
2. **`question`.** `buildInitialPrompt` interpolates the question raw — `src/rlm.ts:276`
   `const parts = [\`# Question\n${question}\`];` — and `boundConversation` never drops `messages[0]`
   (it carries the question, inputs and instructions), so an oversized question lives in **every**
   query for the whole run, permanently.

Both are strings (`question: string` in `runRlm`, `error: string` on `RunResult` status `"error"`,
`src/types.ts:164`). Both are bounded by routing through the **shared `truncateText`** (`src/truncate.ts`),
which #74 already imports into `src/rlm.ts` — no new truncation implementation, no `src/truncate.ts` edit.

## Scope

**In scope** (exact files expected to change):

- `src/rlm.ts` — cap `result.error` in `buildFeedback` (D7) and `question` in `buildInitialPrompt`
  (D8), both via the already-imported `truncateText`.
- `test/rlm.test.ts` — two new RED→GREEN tests (8, 9), each also asserting the under-budget no-op.
- `docs/truncation-policy.md` — implementation-record rows for the two new caps, and retire the
  "Truncating `error`" non-goal line (it is now implemented).

**Out of scope** (do not touch):

- `src/truncate.ts` — reused only, never edited (invariant 4: one implementation).
- `src/sandbox.ts`, `src/repl.ts`, `src/builtins.ts`, `src/rlm_loop.ts`, `src/types.ts`,
  `coverage-baseline.json` — untouched, as in #74.
- No new `RlmOptions`/public option — budgets are module constants (Assumption 5, unchanged).
- Summarisation of dropped history, structure-aware `output` elision (#69), input-name validation —
  all still out of scope, as in #74.

## Explicit decisions

> D0–D6 are #74's decisions (`docs/truncation-policy.md` and `SPEC.md` at commit `34da5c5`) and are
> unchanged. D7/D8 extend them.

### D7 — Cap `result.error` in `buildFeedback` (16 KiB, 50/50 head+tail)

The error string is a **single value** — identified by both ends, exactly like `output`: the head of
a Python traceback names the offending frame (the model's own line), the tail names the exception
type and message. So it reuses the value shape, not the `stdout` stream shape:

- Budget: `ERROR_MAX_BYTES = 16 * 1024` (16 KiB) — the same budget as `output`
  (`OUTPUT_MAX_BYTES`), because both are "one value the run surfaced" and the policy already treats
  16 KiB as the value budget.
- Shape: `headRatio: VALUE_HEAD_RATIO` (50/50) via the shared `truncateText`.
- Recovery: a new module constant `ERROR_RECOVERY = "Catch the exception and print the full traceback to see more."`
  (defined in `src/rlm.ts`, alongside `INPUT_PREVIEW_RECOVERY` — the route is real: the model owns
  the Python and can wrap the failing code in `try/except` and print `traceback.format_exc()`).
- Application site: in `buildFeedback`, on the `status === "error"` branch, wrap `result.error`
  before interpolation: `const { text: error } = truncateText(result.error, { maxBytes: ERROR_MAX_BYTES, headRatio: VALUE_HEAD_RATIO, recovery: ERROR_RECOVERY });` then
  `` `Error: ${error}\nstdout: ${stdout}` ``.
- The under-budget normal path is a **marker-free no-op** (a typical `ZeroDivisionError` is far under
  16 KiB), so ordinary error feedback is byte-identical to today.

### D8 — Cap `question` in `buildInitialPrompt` (64 KiB, 50/50 head+tail)

The question is the user's original query and is **never dropped** from `messages[0]`, so its budget
must both bound the worst case and leave every realistic question untouched:

- Budget: `QUESTION_MAX_BYTES = 64 * 1024` (64 KiB) — 4× the `stdout` budget and generous against any
  genuine query (a real question is tens of bytes to a few KiB); sized so that even a maxed initial
  prompt (≤64 KiB question + ≤32 KiB input preview + headers) cannot alone cross the 256 KiB
  conversation bound.
- Shape: `headRatio: VALUE_HEAD_RATIO` (50/50) — the head carries the context, the tail usually
  carries the actual ask.
- Recovery: `QUESTION_RECOVERY = "The question was truncated. Answer from the part shown and state the assumption if ambiguous."`
  — recorded as a deliberate, weaker affordance than the value/input recoveries because the question
  is **not** sandbox-accessible: unlike `output`/inputs, the model cannot slice it in Python. The
  marker's magnitude still tells the model how much was lost.
- Application site: in `buildInitialPrompt`, wrap `question` before the `# Question` header:
  `const { text: q } = truncateText(question, { maxBytes: QUESTION_MAX_BYTES, headRatio: VALUE_HEAD_RATIO, recovery: QUESTION_RECOVERY });`
  then `const parts = [\`# Question\n${q}\`];`.
- The under-budget normal path is a **marker-free no-op** (a real question is under 64 KiB).

### D9 — The single-truncator invariant is preserved (unchanged from #74)

Both new caps go through the **one** imported symbol `truncateText` from `./truncate.js` — the same
symbol `sandbox.ts` imports. No byte measurement, no `Buffer`, no `byteLength` is introduced in
`src/rlm.ts` (test 6's source-level ban holds; byte counts in `src/rlm.ts` continue to use
`TextEncoder`, docs Exception 3).

## Assumptions (recorded — fire-and-forget, no human asked)

1. **Error budget = 16 KiB, value shape.** The issue says "an error-appropriate budget" without a
   number. Chosen to equal `output`'s 16 KiB because an error is a single value surfaced by the run,
   and 50/50 head+tail because a traceback is identified by both ends (first frame + exception
   message).
2. **Question budget = 64 KiB.** The issue says "generous". 64 KiB is far beyond any genuine query
   while still bounding the never-dropped `messages[0]`; a smaller 32 KiB risks cutting a legitimate
   long question, and 64 KiB keeps the initial prompt under 256 KiB even with maxed inputs.
3. **Error recovery names a real route.** The model owns the Python and can print a full traceback;
   unlike `output`, the error's "rest" is reachable by re-running under `try/except`.
4. **Question recovery is a weaker affordance by necessity.** The question is not a sandbox variable,
   so the model cannot slice it; the recovery clause directs it to answer from what is shown and flag
   ambiguity rather than advertising an unreachable route (consistent with the policy's rule: never
   ship a marker naming a recovery route that does not exist).
5. **Budgets are module constants in `src/rlm.ts`, not `RlmOptions`/`types.ts`** — same as #74
   Assumption 5; no public knob.
6. **`error`'s budget applies only on the `status === "error"` path.** `result.error` exists only on
   error results (`src/types.ts:163-165`), and the ok/suspended paths do not interpolate it.

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
src/rlm.ts              → error cap (D7), question cap (D8), two module constants + two recovery strings
test/rlm.test.ts        → tests 8 (error cap) and 9 (question cap)
docs/truncation-policy.md → implementation-record rows; retire the error non-goal
src/truncate.ts         → reused only (truncateText); never edited
```

## Code style

Follow the file's existing voice: sentence-style model messages, JSDoc on every decision, issue
references in comments, no `any`. Reuse the existing `truncateText` import (already present from #74)
and the `VALUE_HEAD_RATIO`/`VALUE_RECOVERY` shape constants; add only the two new module constants
(`ERROR_MAX_BYTES`, `QUESTION_MAX_BYTES`) and the two recovery strings (`ERROR_RECOVERY`,
`QUESTION_RECOVERY`), all in `src/rlm.ts` — nothing in `src/truncate.ts`:

```ts
const { text: error } = truncateText(result.error, {
  maxBytes: ERROR_MAX_BYTES,
  headRatio: VALUE_HEAD_RATIO,
  recovery: ERROR_RECOVERY,
});
```

## Testing strategy

`node:test`, behaviour-first, through the real `runRlm`/`buildFeedback` with the existing
`mockLlmCodeGen` (`test/rlm.test.ts:263`) and a real `ToolRegistry` + real Monty — the suite's
deterministic style. Two new tests (continuing #74's 1–7):

8. **`result.error` capped in feedback (D7).** `buildFeedback` with a synthetic error `RunResult`
   whose `error` is huge returns a feedback string whose `Error: ` section is ≤ 16 KiB and carries the
   truncation marker (`/elided/`) and the error recovery clause. Assert the ceiling via
   `Buffer.byteLength` (tests may use `Buffer`; only `src/rlm.ts` may not) and the marker, not merely
   the ceiling. **No-op assertion:** a small `error` (e.g. `"boom"`) yields feedback byte-identical to
   the pre-change shape — no marker, no `elided`.
9. **`question` capped in the initial prompt (D8).** `runRlm` with a huge `question` produces an
   initial `messages[0].content` whose `# Question` section is ≤ 64 KiB and carries the marker and the
   question recovery clause. **No-op assertion:** a normal question (e.g. `"what is the answer?"`)
   appears whole and marker-free in `messages[0]`.

Both tests must be **RED first** (the source currently interpolates both paths raw), then GREEN after
the fix. The shared-helper invariant (test 6) already pins the single-truncator requirement; no new
source-grep test is needed, but test 6 must keep passing.

Coverage note: `coverage-baseline.json` floors `src/rlm.ts` at **95.94%**. Each new cap's truncation
branch (over/under budget) must be exercised to keep the floor green; do not hand-edit the baseline.

## Boundaries

- **Always:** test before fix (RED → GREEN), full `npm test` before commit, `npm run check` +
  `npm run build` + `npm run lint`, issue-referenced commit message, mark tasks in `tasks/todo.md`.
- **Ask first (record instead — fire-and-forget):** nothing here is high-risk; surprises are recorded
  in the ship report.
- **Never:** write a second truncation implementation; introduce `Buffer`/`byteLength` into
  `src/rlm.ts`; change `MAX_CONVERSATION_BYTES`; hand-edit `coverage-baseline.json`; touch
  `src/truncate.ts`, `src/sandbox.ts`, `src/repl.ts`, `src/builtins.ts`, `src/rlm_loop.ts`,
  `src/types.ts`.

## Success criteria

1. An oversized `result.error` cannot push any iteration's conversation over 256 KiB — the `Error: `
   feedback section is ≤ 16 KiB via `truncateText`, and the 256 KiB conversation bound is intact.
2. An oversized `question` cannot appear uncapped in `messages[0]` — the `# Question` section is
   ≤ 64 KiB via `truncateText`.
3. Both paths are RED→GREEN tested (tests 8 and 9), including the under-budget no-op (small
   error/question pass through byte-identical, marker-free).
4. `truncateText` remains the only truncation implementation (test 6 still passes; no
   `Buffer`/`byteLength` in `src/rlm.ts`).
5. `npm test`, `npm run check`, `npm run build`, `npm run lint`, `npm run coverage` exit 0; mutation
   score does not regress.

## Open questions / risks

1. **Question recovery is weaker than the other affordances.** The question's elided middle is not
   sandbox-recoverable, so the recovery clause directs "answer from the part shown" rather than naming
   a route to the rest. Accepted (Assumption 4); a future issue could pass the full question as an
   input so it becomes sliceable, but that changes the input contract and is out of scope.
2. **Budget numbers are judgement, not measurement.** 16 KiB (error) follows `output`'s prior art;
   64 KiB (question) is sized against the 256 KiB conversation bound. Neither was evaluated against a
   live model.
3. **Double-truncation totals (unchanged from #74).** If a caller raises the sandbox cap above the
   feedback budget and the true error exceeds it, the feedback marker's "total" is the post-sandbox
   size. Only reachable via an explicit caller override; cosmetic.
