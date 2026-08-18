# Spec: Abort returns what it completed — issue #75

## Objective

Make `runRlm` return what an aborted run completed, instead of throwing `DOMException("AbortError")`
out of the loop and discarding every finished iteration. Add an `AbortSignal` to `LlmClient.query`
so implementations can actually cancel the in-flight LLM request (and stop being billed). Remove the
per-iteration listener leak on the caller's signal. Surface a mid-sandbox-run abort as a partial
iteration rather than swallowing it.

Issue body: <https://github.com/AdarGit008/repl-simple/issues/75> · Parent #70 · Blocked by #18.

## Scope

| In scope | Out of scope (flag) |
|---|---|
| `src/rlm.ts` — loop abort returns, LLM-query abort catch, post-run abort check, `isAbortError`, budget report | `resumeSuspended`'s identical listener pattern → #150/#33 (recorded, not touched) |
| `src/types.ts` — `LlmClient.query` signal param, `RlmResult.status` union, JSDoc | `rlm_loop.ts` (converged into #78; delete deferred) |
| `src/sandbox.ts` — remove `runInSandbox`'s leaked `onAbort` listener in a `finally` | `src/repl.ts`, `src/session.ts`, `src/builtins.ts`, `src/truncate.ts`, `extensions/` |
| `test/rlm.test.ts` — 6 tests (5 issue tests + flip 5.3.10), mock signal recording | `test/sandbox.test.ts`, `test/types.test.ts` (no change — see guard note) |

`src/types.ts`'s `LlmClient` change is an interface change — **flag on #78** (which is reshaping
these types anyway) per the issue's Do list.

## Explicit decisions

### D30 — Return `{ status: "aborted" }` instead of throwing (loop-top + LLM query)

The loop-top abort check (`src/rlm.ts:858-861`) and the LLM-query abort (via `raceAgainstSignal`,
`src/rlm.ts:878-880`) both **return** an aborted `RlmResult` rather than throw. A local `aborted()`
builder inside `runRlm` keeps the three return sites identical:

```ts
const aborted = (): RlmResult => ({
  status: "aborted",
  answer: extractBestAnswer(iterations),   // rlm.ts:553, unchanged
  iterations,
  ...(budget ? { budget: budgetReport(budget, false) } : {}),
});
```

The LLM step wraps the query in a try/catch: an abort (from `raceAgainstSignal`'s safety-net
rejection or from a client that honours the signal and rejects) → `return aborted()`; any other
rejection re-throws unchanged (a real LLM error must not be misreported as an abort).

### D31 — Add `"aborted"` to `RlmResult["status"]`

`src/types.ts:323` union becomes `"ok" | "max_iterations" | "budget_exhausted" | "aborted"`. JSDoc
updated to say an aborted run returns the best-effort salvage, not a throw. `answer` is
`extractBestAnswer(iterations)` — last successful `output`, else last `stdout`, else `"(no answer)"`.
Zero completed iterations → `answer === "(no answer)"`, which is the honest report for a run the user
cancelled before anything landed.

### D32 — `LlmClient.query` gains an `AbortSignal` parameter (interface change)

`src/types.ts:237-243` becomes `query(systemPrompt, messages, signal?: AbortSignal)`. `runRlm` passes
`options.signal` (`src/rlm.ts:878-880`). The JSDoc states the contract: implementations that support
cancellation should honour `signal`; the loop still races against it as a safety net for clients that
ignore it. Blast radius is `test/rlm.test.ts`'s two mocks (`:303`, `:2052`) — the first records the
signal, the second is structurally assignable (fewer params) and stays as-is.
`test/types.test.ts:343` `{ query: async () => "" }` remains assignable (TS allows fewer params) —
verified at `npm run check`, not edited. **Flag the interface change on #78** (issue Do list).

### D33 — Fix the per-iteration listener leak (root cause is `sandbox.ts`)

The measured leak ("8 after 8 iterations, each retaining that run's stdout") is **not**
`raceAgainstSignal` — that helper removes its listener on settle (`rlm.ts:488-496`). It is
`runInSandbox`'s `onAbort` (`src/sandbox.ts:1180-1186`): added to the caller's signal with
`{ once: true }` and **never removed** on the normal (non-abort) path, so every RLM iteration — one
`runInSandbox` call each — leaves one listener whose closure retains `acc` (and therefore stdout).

Fix mirrors `withHostDeadline`'s own `finally` (`sandbox.ts:873`): wrap `runInSandbox`'s body in a
`finally` that removes `onAbort` when a signal was attached. No behaviour change on the abort path —
the listener still fires during the run and `acc.aborted` is still polled — it is only *removed*
afterwards. `resumeSuspended` has the identical pattern (`sandbox.ts:1272-1278`); it is **out of
scope** here (the RLM loop errors on suspension, never resumes) and is flagged to #150/#33, whose
resume-abort surface owns it.

### D34 — A mid-sandbox-run abort surfaces the partial iteration

The sandbox already returns `{ status: "error", errorKind: "aborted", stdout, calls }` with partial
results when a signal aborts mid-run (dispatch-loop `acc.aborted` check + `withHostDeadline`'s
250 ms grace race). Today the loop records that iteration and then *feeds it back and continues* —
the "Do" list's last item is to surface it instead.

Change: after recording the iteration (`src/rlm.ts:907-914`, before the SUBMIT check), add

```ts
if (options.signal?.aborted) return aborted();
```

This one check covers every mid-iteration abort: mid-sandbox-run (`errorKind:"aborted"`, partial
`stdout`/`calls` now included in `iterations` and hence salvageable), abort racing a completed run,
and abort-during-feedback. Combined with the loop-top check (D30) it makes the abort semantics
exhaustive:

| Abort arrives | Returned | `iterations` |
|---|---|---|
| before iteration N | `aborted` (loop-top) | N completed |
| during LLM query of N | `aborted` (catch) | N completed (N never ran) |
| during sandbox run of N | `aborted` (post-run) | N+1 (incl. partial) |
| racing a completed N | `aborted` (post-run) | N+1 (completed) |

The SUBMIT check (rlm.ts:917-937) now runs only when the signal is **not** aborted, so an abort wins
over a same-tick SUBMIT — the answer is still preserved through salvage either way. The `buildFeedback`
`errorKind:"aborted"` branch (`rlm.ts` ~line 600) becomes unreachable via `runRlm`'s loop and stays
as defensive-only; recorded, not removed.

### D35 — Abort detection and budget semantics

The LLM-query catch checks `options.signal?.aborted` alone — every abort source (loop-top, the
`raceAgainstSignal` rejection, a client honouring the signal) leaves `signal.aborted` true, so there is
no second predicate to invent. Any other rejection re-throws: a real LLM error must not be misreported
as an abort (D30). (An earlier `isAbortError` helper was removed after the mutation sweep showed it was
dead code — `signal.aborted` always short-circuited it — and it added six unkilled mutants for no
observable behaviour.)

An aborted `RlmResult` reports the budget (when configured) with `limited: false` — abort is a caller
action, not budget exhaustion, and `RlmBudgetReport.limited` stays "true only for `budget_exhausted`".

## Assumptions (recorded — fire-and-forget, no human asked)

1. **Abort wins over a same-tick SUBMIT** (D34). The answer is preserved via salvage; only the status
   differs. Reversing this (return `"ok"` if SUBMIT landed first) is a one-line reorder if a human
   prefers it.
2. **`"(no answer)"` is the right zero-iteration salvage.** `extractBestAnswer` already returns it; no
   new string, no new magic value (the #76 salvage-provenance work is out of scope and unaffected).
3. **`resumeSuspended` stays out of scope.** Its leak is real but belongs to the resume-abort surface
   (#150 landed, #33 open). Touching it here risks the F-77/`#150` resume-path invariants for zero
   RLM benefit.
4. **Listener-count test uses an instance-level add/remove spy** on the (never-fired) signal; `{once}`
   auto-removal never triggers because the signal is not aborted in that test, so the counter is exact.
5. **Mid-run-abort test (issue test 5) reuses the proven abort mechanism** — `runOptions.onPrint` or a
   registry tool that aborts on first call (cf. `test/sandbox.test.ts:1370` "abortingTool"). Exact
   snippet chosen at RED; no Python-timing dependence (the `withHostDeadline` grace race bounds it).

## Tech stack

TypeScript 5.9 (strict), `node:test` + `node:assert/strict` via `tsx --test`, Biome 2.5.8, Stryker
9.6.1 (bounded sweep), `tsc -p tsconfig.build.json`. Node >= 22.19.0. No new dependencies.

## Commands

```
Test (focused):  npx tsx --test test/rlm.test.ts
Test (full):     npm test
Type-check:      npm run check
Build:           npm run build
Lint:            npm run lint
Coverage gate:   npm run coverage
Mutation:        npm run mutation        (bounded sweep over changed sites; docs/mutation-testing.md)
```

## Project structure

```
src/rlm.ts           → D30 (aborted builder + catch), D34 (post-run check), D35 (isAbortError)
src/types.ts         → D31 (status union + JSDoc), D32 (LlmClient.query signal + JSDoc)
src/sandbox.ts       → D33 (runInSandbox finally-removal; ~1180-1186)
test/rlm.test.ts     → 6 tests: flip 5.3.10 + 5 issue tests; mockLlmCodeGen records signal
```

## Code style

Existing `src/rlm.ts` voice: sentence-style comments, JSDoc on every decision, issue references, no
`any`. The `aborted()` builder is a local closure so the three return sites stay identical. The
`sandbox.ts` fix is a three-line `finally` mirroring `withHostDeadline` (`:872-873`) — same comment
discipline ("a listener left on a caller-owned signal outlives every run that shares it").

## Testing strategy

`node:test`, behaviour-first, through real `runRlm` with `mockLlmCodeGen` + a real `ToolRegistry` +
real Monty. The first six tests are **RED at HEAD** (the issue's DoD demands "red before the fix");
F and G were added at VERIFY stage to close the mutation survivors the sweep exposed:

| Test | Pins | Kind |
|---|---|---|
| flip 5.3.10 (`rlm.test.ts:564`) — abort via `onIteration` resolves, does not reject | D30 | **RED** (HEAD throws) |
| A — abort at iteration 2 of 5 → `status:"aborted"`, 2 iterations, no throw | D30, D31 | **RED** |
| B — best-available answer salvaged (`x = 42` on iteration 0, abort → answer `"42"`) | D30, D31 | **RED** |
| C — 8 iterations leave 0 abort listeners on the signal (instance spy) | D33 | **RED** (HEAD leaves 8) |
| D — `query` receives the signal; a client that rejects on abort is observed cancelling | D32, D35 | **RED** |
| E — abort mid-sandbox-run surfaces partial `errorKind:"aborted"` iteration; run returns `"aborted"` | D34 | **RED** |
| F — already-aborted signal → `"aborted"`, 0 iterations, 0 queries, 0 budget charged, `limited:false` | D30, D35 | **kills M2** (loop-top is the only pre-query site) |
| G — a non-abort LLM error re-throws, not misreported as aborted | D30, D35 | **kills `if(true)`** in the catch |

Coverage: `coverage-baseline.json` floors `src/rlm.ts` at **97.69%** and `src/sandbox.ts` at
**97.65%** (never hand-edit). The new branches (catch path, post-run check, the `finally`) must be
exercised to hold the floor.

Mutation: bounded sweep over the changed sites. **M2** (`rlm.ts:870` loop-top check → `if (false)`)
is killed by test F (the only pre-query abort site); the post-run check is uniquely pinned by test E,
the loop's catch by tests D/G. Verified: all **22** changed-site mutants are detected (21 Killed + 1
Timeout, 0 Survived); `rlm.ts`'s file score rose 58.66 → 64.53.

## Boundaries

- **Always:** RED before GREEN, full `npm test` before commit, `npm run check` + `npm run build` +
  `npm run lint`, coverage gate, issue-referenced commit messages, mark tasks in `tasks/todo.md`,
  every decision recorded in this SPEC or the ship report.
- **Never:** edit `src/truncate.ts`; introduce `Buffer`/`byteLength` into `src/rlm.ts` (source or
  comments — the existing `test/rlm.test.ts` source ban); hand-edit `coverage-baseline.json`; touch
  `src/rlm_loop.ts`, `src/repl.ts`, `src/session.ts`, `src/builtins.ts`, `extensions/`; edit
  `resumeSuspended` (D33 flags it, doesn't touch it); run git commands (the orchestrator owns git).

## Success criteria

1. **D30:** abort (loop-top and mid-query) returns `RlmResult`, never throws `AbortError`; a
   non-abort LLM rejection still re-throws.
2. **D31:** `RlmResult["status"]` includes `"aborted"`; salvage is `extractBestAnswer(iterations)`.
3. **D32:** `llmClient.query(systemPrompt, messages, signal)` compiles; the mock records the signal;
   #78 flagged in the ship report/issue comment.
4. **D33:** test C green — 0 abort listeners after 8 iterations; no behaviour change on the abort
   path (sandbox abort tests stay green).
5. **D34:** test E green — mid-run abort returns `"aborted"` with the partial iteration (partial
   `stdout`/`calls` intact) included and salvageable.
6. **D35:** the single catch site checks `options.signal?.aborted` only; a non-abort rejection
   re-throws (test G); aborted `RlmResult.budget.limited === false` (test F).
7. **Gates:** `npm test` ×2 deterministic, `npm run check` + `npm run build` + `npm run lint` exit 0,
   `npm run coverage` green (rlm.ts ≥ 97.69, sandbox.ts ≥ 97.65), bounded mutation sweep shows M2
   dead and no regression.
8. **Scope:** no file outside the in-scope list is touched.

## Open questions / risks

1. **Abort-wins-over-SUBMIT ordering** (Assumption 1) — a human may prefer `"ok"` when a SUBMIT
   landed before the abort check; one-line reorder, answer unchanged.
2. **`resumeSuspended` leak** (D33) — real, identical, left for #150/#33; a future flight must add the
   same `finally`. Recorded here so it is not "discovered" again.
3. **Interface change timing** (D32) — `LlmClient.query`'s new param is breaking for embedders; #78 is
   the designated convergence point to land it in the public contract. Until #78, the param is
   optional and back-compatible at the type level (fewer-arg implementations still assign).
4. **`buildFeedback`'s `aborted` branch becomes loop-unreachable** (D34) — kept for defence; a
   coverage-mutation may flag it if the sweep widens beyond the changed sites. If so, record, don't
   delete (it is the only honest message for a future non-loop caller).
5. **Mid-run-abort test determinism** (Assumption 5) — the `withHostDeadline` 250 ms grace race bounds
   any non-yielding Python loop, so the test cannot hang; the exact snippet is chosen at RED to keep it
   fast (< 1 s).
