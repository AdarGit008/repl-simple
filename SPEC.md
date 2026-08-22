# Spec: Early-return the synthesis pass when the signal is already aborted — issue #195

Issue: https://github.com/AdarGit008/repl-simple/issues/195
Source: #171 ship report, post-ship follow-up 1 (`tasks/ship-report.md`, Low). Stacked on #171
(PR #194), which landed the race.

## Objective

The cap-time synthesis pass in `runRlm` (`src/rlm.ts`) is wrapped in `raceAgainstSignal` (#171),
but the `llmClient.query(systemPrompt, synthesisMessages, options.signal)` promise is constructed
as an *argument* to that wrapper. So when the signal is already aborted when the pass is reached,
the provider is still called — the full transcript leaves the process — and the budget is still
charged, for a synthesis whose result is then thrown away.

The main loop does not have this bug: it has a loop-top
`if (options.signal?.aborted) return aborted();` before its charge. The synthesis pass sits after
the loop and has no equivalent.

**Success looks like:** when `options.signal?.aborted` is already true at the synthesis pass, `runRlm`
returns a salvaged result *without* calling the provider and *without* charging the budget, and the
caller-observable result shape is unchanged from what the aborted-synthesis catch already produces
today.

## Assumptions (recorded — autonomous run)

- **A1 — Same observable shape.** The early return reuses the D64 budget-refusal branch's exact
  shape: `status: "max_iterations"`, `answer: extractBestAnswer(iterations)`, `answerSource:
  "salvaged"`, `iterations` preserved. This is what the aborted-synthesis catch already lands on
  (`src/rlm.ts`, final fall-through return), so a caller cannot tell the difference — only the
  provider call and the charge disappear.
- **A2 — Budget field is conditional.** The guard sits *outside* the existing `if (budget && …)`
  block, so `budget` may be `undefined`. It therefore renders the budget with
  `...(budget ? { budget: budgetReport(budget, false) } : {})`, matching the final fall-through
  salvage's conditional `...(report ? … : {})` rather than the D64 refusal's unconditional field.
- **A3 — Guard placement.** The guard goes before the charge (`tryCharge`). Building the local
  `synthesisMessages` array is harmless (no provider call, no charge) and may occur before or after
  the guard; the invariant is only "before the charge".
- **A4 — "Already aborted" is entry-time.** The scope is the signal state when the synthesis pass is
  entered (after the loop). An abort that lands *during* `llmClient.query` is #171's race and is
  already handled; it is out of scope here.
- **A5 — The test pins call count + charge.** The observable behaviour that changes is (a) zero
  `llmClient.query` synthesis calls and (b) zero charge through an already-aborted synthesis. The
  test asserts these. Per the issue's "Check while implementing" note, if an existing test pins a
  call count through an aborted synthesis, that assertion is updated to reflect the removed call.

## Decisions

- **D1 — Early return, no call, no charge.** When `options.signal?.aborted` at the synthesis pass,
  return immediately, mirroring the D64 refusal branch. The provider is never handed the transcript
  and `tryCharge` is never reached.
- **D2 — No new status or provenance values.** Reuse `status: "max_iterations"` and
  `answerSource: "salvaged"`; do not mint a new `RlmResult["status"]` value or new `answerSource`.
- **D3 — Budget reported uncharged.** `budgetReport(budget, false)` reports the budget as of the
  abort point, with no synthesis charge folded in.
- **D4 — TDD.** RED first: a test that fails at HEAD because the provider is called and the budget
  is charged. Then the minimal guard.

## Non-goals

- The race itself (`raceAgainstSignal` wrapping) — landed in #171.
- The equivalent question for the two tool paths (`llm_query` and the max-depth `rlm_query`
  downgrade) — their charge sits inside a tool the sandbox aborts anyway; explicitly out of scope
  per the issue.
- The main loop's already-aborted behaviour — it has its own loop-top check and is unchanged.
- `docs/truncation-policy.md` — this is a control-flow change, not a truncation change; no policy
  row or narrative is owed.
- Sibling issues #191, #192, #173, #170.

## Commands

- Full suite: `npm test` (runs `tsx --test test/*.test.ts`)
- Focused test: `npx tsx --test test/rlm.test.ts`
- Build: `npm run build` (`tsc -p tsconfig.build.json`)
- Type check: `npm run check` (`tsc --noEmit`)
- Lint: `npm run lint` (`biome check --error-on-warnings`)
- Coverage: `npm run coverage`

## Project Structure

- `src/rlm.ts` — implementation (the synthesis pass; only the early-return guard changes)
- `test/rlm.test.ts` — the RED test and any assertion moved per A5

## Testing Strategy

- Framework: Node's built-in test runner via `tsx` (`node:test`).
- One new test (or a focused extension of the existing synthesis-abort describe block) asserting
  zero synthesis calls and zero charge through an already-aborted synthesis.
- The existing "abort during synthesis folds into salvage" test must remain green.
- Full suite + `check` + `build` + `lint` must be clean; coverage floors must hold.

## Boundaries

- **Always:** RED first; run the full suite and the static gates before reporting done; follow the
  module's existing conventions (`extractBestAnswer`, `budgetReport`, the D64 refusal shape).
- **Ask first (recorded, not asked — autonomous run):** new dependencies; changing the public
  `RlmResult`/`RlmOptions` type surface; touching anything outside `src/rlm.ts` + `test/rlm.test.ts`.
- **Never:** touch the two tool paths, the main-loop loop-top check, or the `raceAgainstSignal`
  wrapper; no `git add -A`; no changes to `docs/`.

## Success Criteria

- [ ] **S1 (RED):** a test asserting zero synthesis `llmClient.query` calls and zero charge when the
      signal is already aborted fails against HEAD.
- [ ] **S2 (GREEN):** the early-return guard makes it pass.
- [ ] **S3 (no regression):** `npm test` green; `npm run check`, `npm run build`, `npm run lint`
      clean; `npm run coverage` floors met.
- [ ] **S4 (unchanged shape):** the aborted-synthesis result still reports
      `status: "max_iterations"`, `answerSource: "salvaged"`, and the salvaged answer, and the
      existing abort-during-synthesis test stays green.
