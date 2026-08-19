# Spec: RLM answer provenance — salvage, synthesis, and the `(no answer)` magic string — issue #76

## Objective

Fix four defects in `runRlm`'s answer-extraction path (`src/rlm.ts`) so every answer a `RlmResult`
carries is truthful about where it came from, and a caller can trust `answer` instead of guessing.

Parent #70 (Bucket 9) · Blocked-by #18 (CLOSED) · Blocks #78.
Issue: https://github.com/AdarGit008/repl-simple/issues/76

The four defects (from the issue):

1. `extractBestAnswer`'s comment claims errors are consulted; no branch reads `result.error`.
2. Salvaged values carry no provenance — a stray debug `print` is returned as the final answer,
   indistinguishable from a real one.
3. `"(no answer)"` is a magic string — a model submitting that literal text is indistinguishable
   from a failed run.
4. There is no final synthesis pass — on exhausting the iteration cap the loop returns a salvaged
   fragment instead of asking the LLM to summarise across the transcript it already has.

Success looks like: `RlmResult` carries an `answerSource` field on every return path, the magic
string is gone, and a guarded synthesis pass runs at the iteration cap.

## Scope

| In scope | Out of scope (flag) |
|---|---|
| Add `answerSource` provenance field to `RlmResult`; set it at all four return sites | Completing `RlmResult` with its remaining fields (#78) |
| Remove the `"(no answer)"` magic string; represent "no answer" as `answer: ""` | Adding `"error"` to `RlmResult.status` (#78 item 5) |
| Guarded final-synthesis pass at the `max_iterations` cap | Deleting `rlm_loop.ts` / converging on `runRlm` (#78) |
| Fix `extractBestAnswer`'s comment to match its code | Killing `maxIterations` M1 mutation (#78) |
| The five issue tests, incl. a property test over all exit paths | SUBMIT / `RunOk.output` contract (#65) |
| | Splitting `"salvaged"` into output-vs-stdout sources (not required by #76) |
| | Charging the synthesis call against the spend budget (D45: un-charged) |

## Explicit decisions

### D41 — Provenance field: `answerSource` on `RlmResult`

Add a required, non-optional field to `RlmResult`:

```ts
/** Where `answer` came from. Present on every returned answer (#76). */
answerSource: "submitted" | "salvaged" | "synthesised";
```

- `"submitted"` — the model's code called `SUBMIT` (the `status:"ok"` path).
- `"salvaged"` — best-effort extraction from completed iterations via `extractBestAnswer`
  (successful output first, then stdout).
- `"synthesised"` — the new cap-time synthesis pass (D44).

`#78` consumes this field name and shape verbatim (its Do item 6: "Include the provenance field
#76 introduces"). The name is fixed now so #78 does not rename it.

### D42 — Remove the magic string; `answer: ""` for "no answer"

Delete the `return "(no answer)";` line. Keep `answer: string` **required** (do not make it
optional — that would ripple through every consumer). When nothing is salvageable,
`extractBestAnswer` returns `""`, and the caller distinguishes "no answer" via
`status` + `answerSource`, not a sentinel string.

The mechanical breakage is one assertion: `test/rlm.test.ts:3437` (`answer === "(no answer)"` for
the zero-budget, empty-iterations case) becomes `answer === ""` with `answerSource === "salvaged"`.

### D43 — Comment agrees with code (no error consultation)

`extractBestAnswer` does **not** consult `result.error` and will not gain that behaviour here
(error consultation would be scope creep; provenance is the real fix). Fix the comment to describe
what the code actually does:

```ts
// Last successful non-"None" output, else last non-empty stdout
```

`docs/actionable-items.md` A22 flags the disagreement; this resolves it for `rlm.ts`.

### D44 — Guarded final synthesis pass at the iteration cap

At the `max_iterations` cap (return Site 4, `src/rlm.ts:1016-1024`), before falling back to
`extractBestAnswer`, make ONE extra LLM call over the existing transcript:

```ts
const synthesized = await options.llmClient.query(
  systemPrompt,
  [...messages, { role: "user", content: FINAL_SYNTHESIS_PROMPT }],
  options.signal,
);
```

- On success: `answer = synthesized`, `answerSource = "synthesised"`, `status = "max_iterations"`.
- On throw (LLM error) or abort: fall back to `extractBestAnswer(iterations)` with
  `answerSource = "salvaged"` — never throw out of `runRlm` for a failed synthesis.
- `FINAL_SYNTHESIS_PROMPT` is a new module constant: instructs the model to give the single best
  available answer to the original question from the transcript above, as plain text (no code, no
  commentary). The synthesis reply is treated like any assistant reply (the existing reply cap
  applies if the loop already caps replies).

### D45 — Synthesis is a single un-charged best-effort call

The synthesis call is **not** charged against the spend budget. Rationale: it is bounded to exactly
one call, the budget already governs the investigation iterations, and the issue specifies nothing
about budget here. A budget-aware charging policy is a follow-up if #78 or a budget issue wants it.

### D46 — Every return site sets `answerSource`

The four `runRlm` return sites are wired as follows:

| Site | `status` | `answerSource` |
|---|---|---|
| 1 — aborted helper (`:875`) | `aborted` | `salvaged` |
| 2 — budget exhausted (`:894`) | `budget_exhausted` | `salvaged` |
| 3 — SUBMIT / ok (`:979-987`) | `ok` | `submitted` |
| 4 — max iterations (`:1016-1024`) | `max_iterations` | `synthesised` (D44 success) else `salvaged` |

The pre-existing direct-answer path (prose answer without code → wrapped as `SUBMIT(answer)` →
exits through Site 3) counts as `"submitted"` — it genuinely flows through the SUBMIT/ok path.
`"synthesised"` is reserved for D44's cap-time pass.

### D47 — Testing strategy (RED-first, coverage floor, bounded mutation)

Follow the repo's established discipline (D40): write the five issue tests RED, then implement.
Run the `src/rlm.ts` coverage floor (97.69) and a bounded mutation sweep over the changed sites
only. Changed sites: the `extractBestAnswer` body, the four return sites, and the new synthesis
branch.

## Assumptions (recorded — fire-and-forget, no human asked)

1. `answerSource` is the provenance field name (`"submitted" | "salvaged" | "synthesised"`). No
   split of `"salvaged"` into output-vs-stdout, because the issue names one salvage category and
   the 5 tests need only three values.
2. `answer` stays a required `string`; "no answer" is `answer: ""`, not an optional field.
3. The direct-answer → wrapped-SUBMIT path is `"submitted"`, not `"synthesised"`.
4. The synthesis call is un-charged against budget (D45).
5. Abort during the synthesis call falls back to salvage (`status` stays `max_iterations`), because
   the loop already reached the cap; #75's abort handling governs the loop itself, not the post-cap
   synthesis.
6. The synthesis reply is not additionally normalised beyond what existing LLM replies already get.

## Tech stack

- TypeScript, `@pydantic/monty` 0.0.21 (native binary + worker processes).
- Tests: `node:test` via `tsx --test`; assertions `node:assert/strict`.
- Type check / build: `tsc`. Lint / format: Biome. Mutation: Stryker via `scripts/contained.mjs` +
  `scripts/mutation-guard.mjs`. Coverage: custom V8 per-file script vs `coverage-baseline.json`.

## Commands

```bash
npx tsx --test test/rlm.test.ts          # focused (all rlm changes)
npm test                                  # full suite
npm run check                             # tsc --noEmit
npm run build                             # tsc -p tsconfig.build.json
npm run lint                              # biome check --error-on-warnings
npm run coverage                          # coverage floor gate
# bounded mutation over changed sites only (see docs/mutation-testing.md)
node scripts/contained.mjs --limit 12G stryker run --mutate "src/rlm.ts:<ranges>"
```

## Project structure

```text
src/types.ts     → RlmResult (D41), answerSource union
src/rlm.ts       → extractBestAnswer (D42/D43), synthesis pass (D44), four return sites (D46)
test/rlm.test.ts → the five issue tests (D47)
```

## Code style

Match the existing `src/rlm.ts` style: JSDoc block comments on interfaces, `//` for inline
rationale, British spelling (`synthesised`), string-literal unions for discriminated statuses.
New module constant `FINAL_SYNTHESIS_PROMPT` lives in `src/rlm.ts` near the other prompt constants.

## Testing strategy

| Test | Pins | Kind |
|---|---|---|
| cap with only a debug `print` → marked `salvaged`, not `submitted` | `answerSource === "salvaged"` | RED |
| submitting literal `"(no answer)"` distinguishable from failed run | `status`/`answerSource` differ | RED |
| synthesis runs at cap, result marked `synthesised` | `answerSource === "synthesised"`, synth reply used | RED |
| failing synthesis falls back to salvage, no throw | `answerSource === "salvaged"`, run returns | RED |
| property: every exit path carries a valid `answerSource` | all 5 sites | RED |

The `LlmClient` in tests must be able to throw on the synthesis call (the (N+1)th `query`). Existing
`test/rlm.test.ts` mocks support canned reply arrays; extend one to inject a rejection.

## Boundaries

**Always:** tests RED before code; run the full suite + `npm run check` + `npm run build` after
each task; keep `answerSource` on every new return path (the property test enforces it); update
SPEC.md before changing a decision.

**Never:** make `answer` optional (D42); introduce a new sentinel/magic string; charge the synthesis
call to budget (D45); do #78's work (`RlmResult` completion, `status:"error"`, M1 kill,
`rlm_loop.ts` deletion); change the SUBMIT / `RunOk.output` contract (#65).

## Success criteria

1. `RlmResult.answerSource` is required and set at all four return sites (D41, D46).
2. No `"(no answer)"` literal remains in `src/` (D42); `test/rlm.test.ts:3437` asserts `""`.
3. `extractBestAnswer`'s comment agrees with its code (D43).
4. The synthesis pass runs at the cap, is marked `synthesised`, and falls back to salvage on
   failure without throwing (D44).
5. All five issue tests pass (D47).
6. `npm test`, `npm run check`, `npm run build`, `npm run lint` clean; `src/rlm.ts` coverage ≥ 97.69.

## Open questions / risks

1. **Synthesis reply cap** — if the loop already caps assistant replies, the synth reply flows
   through it (Assumption 6). The coder verifies; if not capped, leave uncapped (single bounded call).
2. **`answer: ""` on abort/budget sites when nothing is salvageable** — the property test pins this;
   consumers printing `answer` now see `""` where the magic string was. Flagged to the issue-monitor
   so #78 and any consumer-facing docs note it.
3. **Mockability of a throwing `LlmClient`** — the existing test mock must be extended; if it cannot
   throw cleanly, the coder records the technique used.
