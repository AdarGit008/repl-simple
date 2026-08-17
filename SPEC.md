# Spec: #77 — Line numbers are shifted by +~90, and the sandbox is not continuous

Flight: F-77 · Branch: `issue/77-line-offset-continuity` · Base: `791096a` (main, 9.10)

## Objective

Fix the two defects of issue #77 in the RLM loop so that the sandbox experience matches what the
prompts describe:

1. **Line-offset corruption** — `runInSandbox` executes `preamble + "\n" + code`, so syntax errors
   (and runtime traceback frames) report line numbers shifted by the preamble's line count and embed
   excerpt lines from preamble source the model never wrote. The model is asked to fix lines that do
   not exist in its code.
2. **Implied-but-absent continuity** — every RLM iteration runs in a fresh sandbox while the system
   prompt and feedback are written as though the model works in an ongoing session. A model that
   believes iteration 1's variables persist writes iteration 2 assuming them and burns iterations on
   spurious `NameError`s.

Success = the model sees only its own code in diagnostics, with line numbers relative to its code,
and is told the truth about state persistence. The four issue tests (below) pass on shipped
Monty 0.0.21.

## Verified staleness block (re-verify discipline, #74/#144 precedent)

Verified against HEAD `791096a` on 2026-08-17 before planning. #77's body refs:

| #77 body ref | Claim | Verdict @ HEAD |
|---|---|---|
| `rlm.ts:222-224` | rebuilds `preamble + "\n" + code`, feeds `result.error` verbatim | **STALE.** Rebuild now at `src/rlm.ts:563-564`, run at `:567`. The verbatim-feedback half was superseded by #144: `buildFeedback` caps `result.error` at 16 KiB (`src/rlm.ts:343-347`). The cap stays. |
| `rlm.ts:251` | still concatenates `preamble + code` | **STALE location**, defect present: now `src/rlm.ts:563-564` (~90-line RLM preamble prepended). |
| `rlm.ts:227` | fresh `runInSandbox` per iteration | **STALE location**, defect present: call at `src/rlm.ts:567`, loop at `:541`; no `feedRun` anywhere in `src/`; each iteration is a fresh session. H3 remains open. |
| `session.ts:166` | preamble + prior snippets stack | **STALE location.** Stacking site is `Session.run()` at `src/session.ts:296-299` (`parts.push(...this.snippets, code)`). |
| `RunOptions` | Do-item: add `lineOffset` | **Still open** — no `lineOffset` in `src/types.ts`. |
| "+103 lines" | shift figure | **Superseded by #40**: `typeCheckStubs` now travels out-of-band (`src/sandbox.ts:1053-1065`), removing the +13 type-check contribution. Remaining shift ≈ RLM preamble length (~90). The `sandbox.ts:425-435` comment records the type-check half as fixed at HEAD. |
| "runtime errors carry no line info" | | **Superseded by Monty 0.0.21**: `MontyRuntimeError.traceback()` returns structured `Frame[]` (`line`, `endLine`, `column`, `endColumn`, `sourceLine`). Runtime traceback frames ARE affected by the shift. |
| "both plausibly dissolve under #40" | | **Half-true.** `typeCheckStubs` landed — but it removes only the stub-file contribution; the caller-assembled preamble still shifts typing diagnostics (disproved the "typing is line-correct" premise in VERIFY — measured `rlm.py:91:1` for model line 1 — and corrected it in Task 7). `typeCheckFormat: 'json'` did NOT land — `src/sandbox.ts:1067-1073` pins `"full"` with a recorded decision (echo is "the more useful one for a model rewriting its own code"). `feedRun`/continuity did NOT land — no `feedRun` in `src/`. |

## Decisions (autonomous run — assumptions recorded, no clarifying questions)

### D1 — Line-offset correction mechanics

- **Add `lineOffset?: number` to the sandbox `RunOptions`** (`src/types.ts`): the number of lines
  prepended before the caller's code in the assembled script. `0`/absent = no prefix (default,
  behavior unchanged for existing callers).
- **Apply correction in `sandbox.ts`**, the single place that renders diagnostics:
  - **Syntax errors** (raised at parse/compile of the assembled script): subtract `lineOffset` from
    every line number in the rendered diagnostic, and **drop excerpt lines whose line number is
    ≤ `lineOffset`** (prefix source must never reach the model).
  - **Typing errors**: NOT line-correct at HEAD — `typeCheckStubs` removes only the stub-file
    contribution; the caller-assembled preamble still shifts them (measured end-to-end in VERIFY).
    They get the **same correction** as syntax errors (`correctSyntaxErrorText`, Task 7).
    `typeCheckFormat: "full"` stays: the recorded decision at `src/sandbox.ts:1067-1073` stands;
    D4 documents why the `displayDiagnostics('json')` route from #77's "Do" is declined.
  - **Runtime errors**: use `MontyRuntimeError.traceback()` frames when available — subtract
    `lineOffset` from `frame.line`/`frame.endLine`, drop frames with `line ≤ lineOffset` (and their
    `sourceLine` previews), re-render the surviving traceback for feedback. Fall back to the existing
    message path when frames are unavailable.
- **RLM passes `lineOffset`** = the line count of the RLM preamble it prepends (computed from the
  preamble string actually used, never a hardcoded constant). **`Session.run` passes
  `lineOffset`** = preamble + prior-snippet line count (test 3 covers the stacking case).
- #144's 16 KiB `result.error` cap in `buildFeedback` is **preserved** — correction happens upstream
  of the cap; the cap must still hold on corrected text (a correction must not re-open #144).

### D2 — Continuity contract: fresh sandbox per iteration, prompts told the truth

- **True continuity is declined this flight.** `MontyRepl.feed()` (Monty 0.0.21's continuity
  primitive) accepts only `{ mount }` — **no `externalFunctions`, no start/resume loop** (verified in
  `node_modules/@pydantic/monty/index.d.ts`, `FeedOptions`). The sandbox's host-tool bridge
  (`llm_query`, `rlm_query`, `SUBMIT`, Pi read/grep/find/ls, gated bash/edit/write) runs entirely on
  external functions. Making state persist across iterations would require rearchitecting the tool
  bridge or upstream Monty changes — out of scope for a bucket-9 step; recorded for a future issue.
- **Contract: each RLM iteration executes in a fresh sandbox.** No variables, imports, or
  intermediate results persist between iterations. Each snippet must be self-contained; anything
  iteration N+1 needs must be re-declared or recomputed (or carried in the conversation).
- **The system prompt and feedback wording are rewritten to state this contract plainly** — no
  "session", "ongoing", or other continuity-implying wording remains in the RLM-facing text. This is
  the "prompts match reality" branch of #77's Do ("if not [continuous], the prompt says so and a test
  asserts the prompt says so").

### D3 — Prompt-coupling constraint (from #78's template-coupling note)

`DEFAULT_RLM_SYSTEM_PROMPT` (`src/rlm.ts:89-101`) edits **must preserve the section-header literals**
that coupled tests locate: `# Input (available as …`, `Error: `/`\nstdout:`, `# Question\n` /
`\n\n# Context`. Continuity wording is added without touching those literals; the full suite is the
gate (tests 7/8/9 in the RLM suites must stay green).

### D4 — Why `displayDiagnostics('json')` is declined

#77's "Do" suggests structured JSON diagnostics. Declined for typing errors: (a) the shift IS corrected
structurally-not-needed — the "full" render shares the syntax render's ` --> file:line:col` /
`N | excerpt` format, so the line-wise offset correction (Task 7) covers typing without parsing JSON;
(b) the
`"full"` echo is a recorded, argued decision (sandbox.ts:1067-1073) and more useful to a model
rewriting its own code; (c) JSON would require re-implementing a renderer to get model-facing text
back. Structured access IS adopted where it exists and helps: `MontyRuntimeError.traceback()` frames
for runtime errors (D1). Recorded so the json route is not silently skipped.

## Tech Stack

- TypeScript 5.9, Node ≥ 22.19, ESM (`"type": "module"`)
- Monty 0.0.21 (`@pydantic/monty`) — sandbox interpreter (reinstalled via `npm ci` at flight start;
  node_modules had been stale at 0.0.18)
- Tests: `tsx --test` (node:test); coverage: `scripts/coverage.mjs` with floors; mutation: Stryker
  (bounded sweep only); lint/format: biome

## Commands

```
Build:  npm run build
Check:  npm run check          # tsc --noEmit
Test:   npm test               # tsx --test test/*.test.ts (951 tests at baseline)
Cov:    npm run coverage       # floors enforced by coverage-baseline.json
Lint:   npm run lint           # biome check --error-on-warnings
```

## Project Structure

```
src/rlm.ts          RLM loop, preamble assembly, feedback building (consumer of lineOffset)
src/sandbox.ts      runInSandbox, diagnostic rendering (applies lineOffset)
src/session.ts      Session.run — snippet stacking (second consumer of lineOffset)
src/types.ts        RunOptions, RunResult, RunError (lineOffset lives here)
test/rlm.test.ts    RLM loop tests (offset, prompt-contract tests land here)
test/sandbox.test.ts, test/session.test.ts   offset-correction tests land here
docs/               flight docs (verify-77.md, review-77.md, ship-77.md at the end)
tasks/              plan.md, todo.md (this flight)
```

## Code Style

Follow the existing repo style (biome, tabs, single quotes, trailing commas, type-only imports).
The preamble line count must be computed from the preamble string actually used, never hardcoded.
No new dependencies.

## Testing Strategy

RED → GREEN per task; full suite + `npm run check` after every green; coverage floors via
`npm run coverage` must stay green (the instrument's variance — see #105/#113 — must not be used to
excuse a drop). The four #77 tests:

1. **Offset test (syntax)** — a syntax error on line 1 of the model's code is reported as line 1
   when executed through `runInSandbox` with the RLM-style preamble; `lineOffset` corrects the
   number.
2. **No-preamble-source test** — the fed-back diagnostic contains no preamble source: assert the
   absence of a known preamble token (the part a number-only fix misses).
3. **Session stacking test** — the same holds under `Session`, where prior snippets stack:
   diagnostic line numbers are relative to the latest snippet, and no earlier-snippet/preamble
   source appears.
4. **Continuity-contract test** — the RLM system prompt states the fresh-sandbox-per-iteration
   contract; the test asserts the prompt says so (and asserts no continuity-implying wording
   survives). Prompt-section literals from D3 still present (existing tests 7/8/9 remain green).

## Boundaries

- **Always:** run tests + check before finishing a task; commit per task via the orchestrator;
  preserve the #144 error-cap; preserve the `typeCheckFormat: "full"` decision; keep prompt-section
  literals intact.
- **Ask first (N/A this run — autonomous):** adding dependencies, upstream Monty changes.
- **Never:** hardcode the preamble line count; strip the cap; rewrite the whole RLM prompt (only
  the continuity wording); touch unrelated buckets (pool, toolstore, packaging).

## Success Criteria

- [ ] All four tests exist and pass on Monty 0.0.21 (951 baseline + new tests, 0 failures).
- [ ] `npm run check`, `npm run coverage` floors, `npm run lint` green.
- [ ] Corrected diagnostics still flow through #144's 16 KiB error cap.
- [ ] The continuity contract (D2) is documented in the prompt text and in `docs/truncation-policy.md`
      or README where RLM behavior is described (whichever currently describes it — checked in VERIFY).
- [ ] Staleness block posted to issue #77 (done at flight start, below).

## Open Questions

- None blocking. Carried forward to a future issue: true continuity via `MontyRepl.feed` is
  impossible while `FeedOptions` lacks `externalFunctions` — record as a gotcha on #70/#77's thread
  (issue-monitor's final report will place it).
