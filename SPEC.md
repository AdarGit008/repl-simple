# Spec: Converge on `runRlm` and delete `rlm_loop.ts` — issue #78

## Objective

Make `runRlm` (`src/rlm.ts`) the **single** RLM implementation and delete `rlm_loop.ts`
(`RLMLoop`), which duplicates it. The merged `runRlm` carries the **union** of both implementations'
capabilities — a registry-built prompt, RLM-tool construction with a name-collision guard, nesting
with a `maxDepth` downgrade, `status:"error"`, and the `answerSource` provenance #76 added — while
`RLMLoop` disappears.

Parent #70 (Bucket 9) · Blocked-by #71–#76 (all CLOSED) · **Last step in Bucket 9**.
Issue: https://github.com/AdarGit008/repl-simple/issues/78

Success looks like: `grep RLMLoop src/` returns nothing; one RLM entry point (`runRlm`); the prompt
names every registered tool; nesting and the collision check work; `status:"error"` exists; M1 and
M21 no longer survive mutation; the README documents one entry point.

## Current state (fact base, verified 2026-08-19)

| Fact | Value |
|---|---|
| `src/rlm.ts` | 1061 lines; exports `DEFAULT_RLM_SYSTEM_PROMPT`, `CodeExtraction`, `extractPythonCode`, `extractDirectAnswer`, `buildFeedback`, `runRlm`. Internals: `FINAL_SYNTHESIS_PROMPT` (:345), `buildInitialPrompt` (:521, static, no registry). 2 `llmClient.query` sites (:918 loop, :1034 synthesis), both pass `signal`. |
| `src/rlm_loop.ts` | 368 lines; exports `RlmMessage`, `RLMLoopOptions`, `RLMLoopResult`, `RLMLoop`, `getReplPreamble`. `buildSystemPrompt` (private) renders `renderTypeStubs()` + `renderPythonToolRules(probeImportableModules())` + names `llm_query`/`rlm_query`/`SUBMIT`. Collision check in constructor (:76–85). Nesting via `maxDepth`/`depth` (default 1/0). `getReplPreamble` at :354. |
| `src/types.ts` | RLM types still live here: `LlmClient`, `RlmIteration`, `RlmOptions`, `RlmResult` (status `ok\|max_iterations\|budget_exhausted\|aborted`; `answerSource` 3-way). Mid-file `import type { ToolRegistry } from "./registry.js"` (:228) + `SpendBudget` (:229) — the layering inversion. |
| `src/index.ts` | Exports **both** `RLMLoop` block (:116–121) and `runRlm` block (:127–133). |
| Tests | `test/rlm.test.ts` = 95 `it()`, `test/rlm_loop.test.ts` = 55 `it()`. Nesting / depth / collision / RLMLoop-prompt-content / F-77 `lineOffset` cases exist **only** in `rlm_loop.test.ts`. |
| Extension | `extensions/repl-extension.ts` references **neither** `runRlm` nor `RLMLoop` — RLM is not reachable from the shipped tool today. |
| Coverage floors | `src/rlm.ts` 97.69 · `src/rlm_loop.ts` 98.36. |
| Mutation | `thresholds: { high: 100, low: 0, break: 58 }`. |

## Scope

| In scope | Out of scope (flag to issue-monitor) |
|---|---|
| Delete `rlm_loop.ts`; make `runRlm` the single entry point (D48, D56) | `RlmStep` / `RlmProgressEvent` structured trajectory — no in-repo spec defines them (D54) |
| Move RLM types out of `types.ts`; fix the layering inversion (D49) | Question-as-input re-homing (#145 carry-forward) — deferred to a follow-up (Assumption 6) |
| Registry-built prompt: port `buildSystemPrompt` + sentinel + F-77 wording (D50) | Charging the synthesis call to budget (already D45 un-charged) |
| RLM-tool construction + name-collision guard in `runRlm` (D51) | SUBMIT / `RunOk.output` contract (#65) |
| Nesting + `maxDepth` downgrade + parent-context inheritance (D52) | True RLM sandbox continuity via Monty `FeedOptions` (#154) |
| `status:"error"` for an `llmClient` throw (D53) | `RLMLoop`-specific `RlmMessage`/`trace` shapes (die with the class, D56) |
| Move `getReplPreamble` to `src/preamble.ts` (D55) | |
| Fold `rlm_loop.test.ts` cases into `rlm.test.ts` (D56) | |
| Defaults: `maxIterations`→10, `scriptName`→`"rlm.py"` (D58) | |
| README documents one entry point (D59) | |

## Explicit decisions

### D48 — `runRlm` is canonical; `rlm_loop.ts` is deleted

Keep `runRlm` (shorter, better-structured, its gaps are small) and delete `RLMLoop` and its file.
No deprecation shim — the issue calls for deletion, and the README will document the one entry
point (D59). `grep RLMLoop src/` must return nothing.

### D49 — RLM types move into `rlm.ts`; layering inversion removed

Move `LlmClient`, `RlmIteration`, `RlmOptions`, `RlmResult` (and `RlmBudgetReport` if it is
RLM-only) from `src/types.ts` into `src/rlm.ts`. Delete the mid-file
`import type { ToolRegistry } from "./registry.js"` / `import type { SpendBudget } from "./budget.js"`
from `types.ts` (the inversion: `types.ts` → `registry.js`). Re-export the moved types from
`src/index.ts` unchanged, so the public import surface does not break. `types.ts` keeps the
non-RLM types it owns.

### D50 — Prompt is built from the real registry (port `buildSystemPrompt`)

The merged system prompt replaces `runRlm`'s static `buildInitialPrompt` path and renders the live
registry, as `RLMLoop.buildSystemPrompt` does today:

- `await registry.renderTypeStubs()` → "Available Tools" section (`"(standard Python only)"` fallback).
- `await probeImportableModules()` + `renderPythonToolRules(...)` → "Python Rules" section.
- Names **all three** RLM tools — `llm_query`, `rlm_query`, `SUBMIT` — and carries the
  "do not define your own" rule (D51 makes them real).

The merged prompt **must carry verbatim**:

1. **F-77 fresh-sandbox wording** — the "fresh sandbox per iteration / no state carries over"
   sentences from `DEFAULT_RLM_SYSTEM_PROMPT` (test 4 in `rlm.test.ts` pins the wording and the
   *absence* of continuity-implying words). `RLMLoop`'s prompt never had this; it must now.
2. **D17 sentinel-authentication rule** — the full truncated-view / marker-grant / history-drop
   paragraph from `DEFAULT_RLM_SYSTEM_PROMPT` (test 17(c) pins its prose). Omitting it silently
   disables marker-authentication while `truncateWithSentinels` still wraps.

**Template-coupling inventory (#145):** any rewording updates every pinned literal in the same
commit — `256.0KB`, `\nstdout:` + `> ` prefix, `# Question\n` / `# Context` boundary, the
`# Input (available as \`…\` variable)` header + `/inputs elided/` marker, the
`\n\nWrite Python code to answer the question.` trailer, the sentinel literals, the three D27
sentences, and the F-77 wording. Tests 10/12/23/24 self-derive sizes and are robust.

### D51 — RLM tools are constructed in `runRlm`, with the collision guard

`runRlm` builds its RLM tools via `createRLMTools` (already in `src/rlm_tools.ts`) and merges them
into the registry it passes to the sandbox. Port `RLMLoop`'s **name-collision check**: if the caller's
registry already has `llm_query`, `rlm_query`, or `SUBMIT`, throw
`runRlm: tool 'X' conflicts with user registry. Remove it — the loop provides its own RLM tools.`
(adapt the message's prefix). Validate `maxIterations >= 1` and `maxDepth >= 0` likewise.

### D52 — Nesting, `maxDepth` downgrade, parent-context inheritance

`runRlm` gains `maxDepth?` (default 1) and `depth?` (default 0) on `RlmOptions`. The `rlm_query`
tool:

- **At the limit** (`depth >= maxDepth`): downgrade to a single `llm_query` call — no sandbox, no
  nested loop — returning `[rlm_query downgraded at max depth N]\nQuery: …\nContext: …`.
- **Otherwise**: spawn a nested `runRlm` with `depth: depth + 1`; on the nested `status:"ok"`
  return its `answer`; otherwise return `[rlm_query error: <status>] <error>`.

**Parent-context inheritance (A26, M16):** the nested loop must not be blind to what its parent
already knows. The child's `context` is the parent loop's own context merged with the explicit
`context` argument `rlm_query(query, context?)` was called with — so a sub-investigation inherits
the surrounding question, not only the sub-query string. (Concretely, in `RLMLoop` today the child
gets only the explicit `context` arg; the inheritance is what this decision adds.)

### D53 — `status:"error"` is a result, not an exception

Add `"error"` to `RlmResult["status"]`. A **non-abort** rejection from the main loop's
`llmClient.query` (the :918 call site) returns `{ status:"error", error: <msg>, answer:
extractBestAnswer(iterations) ?? "", answerSource:"salvaged", iterations, budget? }` instead of
throwing out of `runRlm`. Abort stays the separate `"aborted"` path (#75). The synthesis call's
existing throw→salvage fallback (D44) is unchanged.

### D54 — `RlmResult` completion (scoped)

`RlmResult` gains `error?: string` (populated on `status:"error"`, D53) alongside the existing
`status`, `answer`, `answerSource`, `iterations`, `budget?`. The `answerSource` field #76
introduced is consumed **verbatim** (D41) — no rename. **`RlmStep` / `RlmProgressEvent` are
deferred**: no in-repo spec defines their shape (verified — the only references are
`docs/actionable-items.md` A24), so inventing them would be pure invention. Flag to issue-monitor
as a follow-up.

### D55 — `getReplPreamble` moves to `src/preamble.ts`

Create `src/preamble.ts` and move `getReplPreamble` there (it currently lives in
`rlm_loop.ts:354`, the file being deleted). The `repl/repl_server.py` path resolution
(`join(dirname(fileURLToPath(import.meta.url)), "..", "repl", "repl_server.py")`) is unchanged by
the move — same `src/` depth. `loadSavedTools` stays in `src/toolstore.ts` (its natural home; moving
it ripples through toolstore tests for no functional gain — Assumption 3). `getReplPreamble` is
re-exported from `index.ts`.

### D56 — Delete `rlm_loop.ts`; fold its tests; update the barrel

Delete `src/rlm_loop.ts` and `test/rlm_loop.test.ts`. Remove from `src/index.ts`: `RLMLoop`,
`RLMLoopOptions`, `RLMLoopResult`, `RlmMessage` (public API removal — README updated in D59).
`getReplPreamble` is re-exported from its new home (D55).

Fold into `test/rlm.test.ts` (against `runRlm`) the cases that exist nowhere else:
**nesting** (spawn, `rlm_query` at max depth downgrades to `llmQuery`, default depth 0, nested +
`llm_query` compose), **name-collision** (throws on each of the three names, no-throw for unrelated),
**prompt content** (names tools), and the **F-77 `lineOffset`** pair (model's line 1 reported as
line 1; no preamble source leaked). `runRlm` already has its own parallel `lineOffset` describe —
keep both consistent or fold into one.

### D57 — Legibility: deletion removes the duplicate; no further rename

The transposed-letter confusion (`repl`/`rlm`) is resolved by deleting the second RLM
implementation. No additional file rename is applied: `repl.ts` = session REPL, `rlm.ts` = RLM loop,
`rlm_tools.ts` = RLM tool factories, `repl_server.py` = the Python preamble. A rename would churn
every import and risk the pinned `scriptName` default (`"rlm.py"`, D58) and the diagnostic-regex
coupling — not worth it. Residual `repl`/`rlm` transposition flagged to issue-monitor.

### D58 — Defaults pin behaviour; kill M1 and M21

- No `maxIterations` → **10** iterations (kills **M1**).
- `scriptName` defaults to **`"rlm.py"`** (kills **M21**).
- `maxDepth` default 1, `depth` default 0 (D52).

### D59 — README documents one entry point

`README.md` drops `RLMLoop` as a documented API and documents `runRlm` as the single RLM entry
point (lines 36–52, 137–138, 153 today). Keep the `rlm_query` / `SUBMIT` / `llm_query` tool table,
now described as the tools available *inside* `runRlm`.

### D60 — Testing, coverage, mutation

- **RED-first** for the seven issue tests (below), then implement (repo discipline D40/D47).
- Coverage: `src/rlm.ts` floor 97.69 holds. **Delete the `src/rlm_loop.ts` floor entry** from
  `coverage-baseline.json` (a floor for a deleted file is a hard error), and run `coverage:update`
  for any new file (`src/preamble.ts`).
- Mutation: bounded sweep over `src/rlm.ts` changed sites; confirm M1/M21 killed; report the new
  per-file score (was "0 of 9").

## Assumptions (recorded — fire-and-forget, no human asked)

1. **"Complete `RlmResult`" (issue Do item 6) is scoped to D53 + D54** (add `"error"` status +
   `error?: string`, keep `answerSource`). `RlmStep`/`RlmProgressEvent` are deferred because no
   in-repo spec defines them; inventing a public shape is scope creep.
2. **Issue DoD item 5 is stale.** "The mis-titled `test/rlm.test.ts:716-741`" is, in the current
   tree, the boundary between two correctly-titled abort tests (scout-verified), and `runRlm` has
   no suspension (that is the session `ReplRunner`'s concept). Reframed intent: **every `runRlm`
   status branch — `ok` / `max_iterations` / `budget_exhausted` / `aborted` / `error` — has a
   genuine test.** The "suspended" wording is treated as an issue-body error.
3. **`loadSavedTools` stays in `toolstore.ts`** (D55); only `getReplPreamble` moves.
4. **No further rename** beyond deleting `rlm_loop.ts` (D57).
5. **`RlmMessage` is removed** with `rlm_loop.ts` — a public-API removal the README reflects (D59).
6. **Question-as-input re-homing (#145 carry-forward) is deferred** to a dedicated follow-up issue.
   It changes the input contract and is not required by any of the seven tests; doing it inside #78
   would destabilise the template-coupled tests. Flagged to issue-monitor.
7. **Adopted-from-#74 input-name validation** (`/^[A-Za-z_][A-Za-z0-9_]*$/`) is applied at the input
   merge site (the #78 body carries this note explicitly; it hardens the unescaped interpolation).

## Tech stack

TypeScript; `@pydantic/monty` 0.0.21 (native + workers). Tests: `node:test` via `tsx --test`,
`node:assert/strict`. `tsc` (check/build), Biome (lint/format), Stryker (mutation), custom V8
coverage vs `coverage-baseline.json`.

## Commands

```bash
npx tsx --test test/rlm.test.ts          # focused
npm test                                  # full suite
npm run check                             # tsc --noEmit
npm run build                             # tsc -p tsconfig.build.json
npm run lint                              # biome check --error-on-warnings
npm run coverage                          # coverage floor gate
npm run coverage:update                   # re-baseline (preamble.ts is new; drop rlm_loop.ts)
node scripts/contained.mjs --limit 12G stryker run --mutate "src/rlm.ts"
```

## Project structure

```text
src/types.ts      → non-RLM types only (D49 removes the RLM block + inversion imports)
src/rlm.ts        → RLM types (D49) + runRlm + registry-built prompt (D50) + tools/nesting (D51/D52)
src/rlm_tools.ts  → createRLMTools (unchanged)
src/preamble.ts   → getReplPreamble (new, D55)
src/toolstore.ts  → loadSavedTools (unchanged)
src/rlm_loop.ts   → DELETED (D56)
src/index.ts      → barrel updated (D49/D55/D56)
test/rlm.test.ts  → + nested/collision/prompt/lineOffset cases (D56), + 7 issue tests (D60)
test/rlm_loop.test.ts → DELETED (D56)
coverage-baseline.json → drop rlm_loop.ts, add preamble.ts
README.md         → one entry point (D59)
```

## Code style

Match `src/rlm.ts`: JSDoc on interfaces, `//` inline rationale, British spelling (`synthesised`),
string-literal unions for statuses. `runRlm` gains the prompt-building helper (ported
`buildSystemPrompt`) near `buildInitialPrompt`; the merged prompt lives near the other prompt
constants.

## Testing strategy

| Test | Pins | Kind |
|---|---|---|
| 1. merged prompt **names every registered tool** | content, not length (H10/H11) | RED |
| 2. nesting works; `maxDepth` downgrades to `llmQuery` at the limit | nested answer / downgrade string | RED |
| 3. name-collision check fires on `llm_query`/`rlm_query`/`SUBMIT` | throw message | RED |
| 4. `llmClient` throw returns `status:"error"`, not an exception | result shape + `error` | RED |
| 5. every kept `rlm_loop.test.ts` case passes against `runRlm` | ported suite green | RED |
| 6. no `maxIterations` → 10 iterations | kills M1 | RED |
| 7. `scriptName` defaults to `"rlm.py"` | kills M21 | RED |

Plus the reframed status-branch coverage (Assumption 2): `ok` / `max_iterations` /
`budget_exhausted` / `aborted` / `error` each have a genuine test.

## Boundaries

**Always:** RED before code; run the full suite + `npm run check` + `npm run build` after each
task; keep `answerSource` on every new return path; keep the sentinel rule and F-77 wording verbatim
(D50); update the template-coupled test literals **in the same commit** as the prompt change.

**Never:** introduce a new sentinel/magic string; change the SUBMIT / `RunOk.output` contract (#65);
charge the synthesis call to budget (D45); invent `RlmStep`/`RlmProgressEvent` shapes (D54); leave a
dangling `rlm_loop.ts` import.

## Success criteria

1. `grep RLMLoop src/` returns nothing; `runRlm` is the single RLM entry point (D48, D56).
2. The merged prompt names every registered tool and carries the F-77 + D17 wording (D50).
3. Nesting, `maxDepth` downgrade, parent-context inheritance, and the collision check work (D51/D52).
4. `status:"error"` returns a result, not an exception; `answerSource` survives verbatim (D53/D54).
5. `getReplPreamble` lives in `src/preamble.ts`; `rlm_loop.ts` and its test are gone (D55/D56).
6. All seven issue tests + the folded `rlm_loop` cases pass (D60).
7. M1 and M21 no longer survive; `rlm.ts` mutation score > "0 of 9".
8. `npm test`, `npm run check`, `npm run build`, `npm run lint` clean; coverage floors met (incl.
   new `preamble.ts`, minus deleted `rlm_loop.ts`).

## Open questions / risks

1. **Template-coupling churn** — the prompt rework (D50) touches many pinned literals; the coder
   must update them all in the same commit or the suite goes red on test 17/19/21 etc. Highest-risk
   area of the flight.
2. **Parent-context inheritance shape** — `RLMLoop` models context as `run(task, context?)`;
   `runRlm` as `options.inputs.context`. The coder defines the merge precisely and pins it with a
   test (D52).
3. **`RlmMessage` removal** — deleting a public type could break consumers; the README + barrel are
   updated, and the removal is surfaced in the ship report (D56/D59).
4. **Coverage floor for `preamble.ts`** — a new source file without a floor fails the gate; the
   coder runs `coverage:update` in the same change (D60).
5. **Mutation baseline is stale** (predates 0.0.21) — treat absolute scores as directional; the
   concrete kills are M1/M21 (D58/D60).
