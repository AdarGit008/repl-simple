# Spec: #87 — No global spend budget across nested RLM fan-out

Flight: F-87 · Branch: `issue/87-rlm-budget` · Base: `e796174` (main, 9.10)

## Objective

Give the RLM loop a **shared, observable spend budget** so that a tree of nested
investigations (once it exists) competes for one pool instead of each branch getting a fresh,
uncoordinated allowance. Today the three existing limits compose into a product, not a ceiling:

- `maxIterations` bounds **one** loop (`src/rlm.ts:510`),
- `maxDepth`/`depth` bounds a tree's **height** (`src/rlm_loop.ts:33-38`, not present in `runRlm`),
- #74's conversation bound caps **one** conversation's growth (`src/rlm.ts:426`).

None counts total spend. The fix is a shared budget object threaded through every LLM call, with
degrade-on-exhaustion (return the best available answer, marked budget-limited) and consumption
reported on `RlmResult`.

## Verified staleness block (re-verify discipline, #74/#144/#77 precedent)

Issue #87's body references, re-verified against HEAD `e796174` by the Step-0 issue-monitor scan
before planning:

| #87 body ref | Claim | Verdict @ HEAD |
|---|---|---|
| "nested RLM fan-out" / `rlm_query` spawns nested RLM | the fan-out to budget exists | **STALE as stated.** Nesting (`maxDepth`/`depth`, `rlm_query` → nested `RLMLoop`) exists **only** in `src/rlm_loop.ts:33-38,212-251` (the object #78 deletes). `runRlm` (`src/rlm.ts`) has **no** nesting, `rlm_query`, `maxDepth`, or `createRLMTools` usage. |
| "Blocked by: #78 — nesting does not exist until #78 step 4" | blocker | **CONFIRMED.** #78 is open and blocked by #75, #76 (the other four of #71-#76 are closed). Neither RLM path is reachable from the shipped extension (`extensions/repl-extension.ts` registers only `repl`/`repl_resume`/`repl_reset`/`repl_abandon`). |
| "Report consumption in `RlmResult`" | field to add | **CONFIRMED open.** `RlmResult` at `src/types.ts:283-289` has only `status: "ok" \| "max_iterations"`, `answer`, `iterations`. |
| "Tokens are the most portable and the easiest to test" | unit choice | **Recorded decision below (D2).** Reconciles `docs/truncation-policy.md:340` Non-goal "Token-based budgets. Bytes are cheap, deterministic and tokenizer-independent." |
| `docs/actionable-items.md` A7 `[H8]` / `docs/REVIEW.md` §5 H8 | source of the finding | **CONFIRMED.** `docs/actionable-items.md:253` and `docs/REVIEW.md:498`. |

## Decisions (autonomous run — assumptions recorded, no clarifying questions)

### D1 — Scope: the budget mechanism lands in `runRlm` now; the fan-out *wiring* waits for #78

#87 is blocked on #78 because the nesting it budgets does not exist in `runRlm`. This flight
**does not port nesting** — that is #78's scope, and porting it here would create a merge conflict
with the convergence #78 is planning (the issue-monitor's whole mandate is that work is not
rediscovered or duplicated). Instead:

- Build the shared budget object as a first-class, independently testable module, and wire it into
  `runRlm` at the single-loop level (budget option → charge every LLM call → degrade on exhaustion
  → report consumption).
- Prove the **shared-pool semantics** — the crux of the issue (test 2) — through a shared
  `SpendBudget` instance passed to *multiple* `runRlm` calls: the second call sees the first's
  spend, because both mutate the same object. A caller-driven fan-out (two `runRlm` invocations
  sharing one budget) is exactly the "siblings share one pool" property, testable today without
  `rlm_query`.
- When #78 step 4 ports nesting, the wiring is one line: the `rlm_query` handler passes the same
  `SpendBudget` instance into the nested `runRlm` call. This flight records that hand-off in the
  final issue-monitor report so #78 does not rediscover it.

### D2 — Budget unit: **estimated tokens, derived from UTF-8 bytes**

`estimateTokens(text) = ceil(utf8Bytes(text) / 4)`, where `utf8Bytes` is measured with
`TextEncoder` (never `Buffer.byteLength` — see D8). Reasoning recorded, per #87's "say why":

- **Tokens** are the portable unit callers and models actually think in, and the one #87 names.
  Currency needs per-model pricing that drifts; wall time is non-deterministic and untestable.
- **Estimated, not counted**, because repl-simple has no tokenizer and must not gain one — the
  `LlmClient` is injected precisely to keep this library LLM-agnostic (`src/types.ts:145-158`). A
  real tokenizer would add a dependency and per-model variance.
- **Byte-derived, so deterministic and tokenizer-independent**, which is exactly the property
  `docs/truncation-policy.md`'s Non-goal defends. This is a *reconciliation*, not an override:
  truncation remains byte-based; the spend budget is a separate, higher-level control whose
  estimator preserves determinism by deriving from UTF-8 bytes. The `/4` constant is a documented
  approximation (≈4 bytes/token for typical English code/prose), pinned by test so callers can
  predict their own cost.

### D3 — Budget API shape

- New module `src/budget.ts`:
  - `estimateTokens(text: string): number` — the deterministic estimator (exported, so callers
    managing a budget can predict cost, and tests can recompute it).
  - `class SpendBudget` — a **shared, mutable** budget object:
    - `constructor(limit: number)` — rejects non-finite or negative `limit`.
    - `get limit`, `get consumed`, `get remaining` — observability.
    - `tryCharge(tokens: number): boolean` — `false` (and no charge) when `tokens < 0` or the
      charge would exceed `limit`; otherwise adds to `consumed` and returns `true`.
  - Both exported from `src/index.ts`.
- `RlmOptions.budget?: number | SpendBudget` (`src/types.ts`):
  - `number` → a fresh per-run `SpendBudget` (default behavior for the common single-run case).
  - `SpendBudget` instance → used and mutated **in place**; siblings passing the same instance
    share one pool. `consumed` therefore reflects the pool's cumulative spend, not one run's.
- `RlmResult` (`src/types.ts`) gains:
  - `status: "ok" | "max_iterations" | "budget_exhausted"` (additive union member).
  - `budget?: RlmBudgetReport` where `RlmBudgetReport = { limit: number; consumed: number;
    limited: boolean }`. Present **only** when a budget was configured.

### D4 — Charge and degrade semantics (`src/rlm.ts`)

- Before each LLM call, compute `cost = estimateTokens(systemPrompt) + Σ estimateTokens(m.content)`
  over the messages the call will actually send. Charge happens **before** the call so the run never
  overspends (a call that fits is charged in full; the abort path throws and reports nothing, so a
  pre-charge on an aborted call is moot).
- If `!budget.tryCharge(cost)`: **degrade, never throw** — return
  `{ status: "budget_exhausted", answer: extractBestAnswer(iterations), iterations,
  budget: { limit, consumed, limited: true } }`.
- On the normal `"ok"` (SUBMIT) and `"max_iterations"` returns, attach
  `budget: { limit, consumed, limited: false }` when a budget is configured — the budget is always
  reported, `limited` distinguishes the stopping cause.

### D5 — No budget configured ⇒ behaviour unchanged (issue test 5)

When `RlmOptions.budget` is omitted, `status` stays `"ok" | "max_iterations"`, `budget` is absent,
and no charge/limit logic runs. The budget must never become a mandatory ceiling that surprises
existing callers.

### D6 — Validation

`budget: number` must be finite and `>= 0` (thrown otherwise, in `SpendBudget`'s constructor).
`0` is well-defined: nothing may run, so the loop degrades immediately with `budget.limited: true`
and `iterations: []` — a legitimate, testable degenerate case. `SpendBudget` instances are used as
passed (their constructor already validated them).

### D7 — `RlmResult` coordination (no collision with open siblings)

The additions are **additive**: a new union member `"budget_exhausted"` and an optional `budget`
field. They compose with — and do not block or conflict with — #75 (adds `"aborted"` status),
#76 (adds provenance), and #78 step 6 (completing `RlmResult`'s fields). Recorded so those flights
do not rediscover the shape.

### D8 — Token estimator lives in `src/budget.ts`, not `rlm.ts`

Test 6 (`test/rlm.test.ts:1382-1383`) asserts `src/rlm.ts` must not reference `Buffer` or
`byteLength` (it must never hand-roll byte truncation). `estimateTokens` lives in `src/budget.ts`
and uses `TextEncoder`; `rlm.ts` imports it and never measures bytes itself. The full-suite gate
re-asserts this.

## Worked example (DoD — pre-fix worst case vs post-fix ceiling)

Pre-fix: `maxDepth = 3`, branching factor `B = 5`, `maxIterations = 10`. The tree has
`1 + 5 + 25 + 125 = 156` nodes; each runs up to 10 LLM calls ⇒ **≈1,560 LLM calls**, each growing
with the conversation (bounded per-conversation at 256 KiB by #74, but **nothing bounds the sum**).
Depth is height, not spend; the worst case is the *product* of three limits none of which was chosen
with the others in mind.

Post-fix: a single shared budget `B_total` caps the **total** tokens across all 156 nodes. When it
is exhausted, every outstanding branch degrades to its best-effort answer (marked budget-limited)
rather than throwing. The ceiling is `B_total` — a bound, not another limit to multiply — up to the
granularity of one call (a call that fits is charged in full).

Fresh-sandbox overhead (F-77/#77 note): every iteration re-declares its imports and variables, so
per-iteration token cost includes that re-declaration, and offset-corrected tracebacks shape the
feedback text each iteration feeds back. A caller sizing `B_total` must factor both.

## Tech Stack

TypeScript (ESM, `node >= 22.19.0`), `@pydantic/monty` 0.0.21 (sandbox), `typebox` (extension
schemas), `tsx` (test runner), `node:test` + `node:assert/strict` (tests), Biome (lint/format),
Stryker (mutation), `@earendil-works/pi-coding-agent` (extension host). No LLM dependency — the
`LlmClient` is injected.

## Commands

```
Test:            npm test
Typecheck:       npm run check
Build:           npm run build
Lint:            npm run lint
Format:          npm run format
Coverage:        npm run coverage        # floors in coverage-baseline.json
Mutation:        npm run mutation         # Stryker + mutation-guard
```

## Project Structure

```
src/rlm.ts        → runRlm — the canonical RLM loop (budget wired here)
src/budget.ts     → SpendBudget + estimateTokens (NEW this flight)
src/types.ts      → RlmOptions.budget, RlmResult.status + budget report
src/index.ts      → public exports (SpendBudget, estimateTokens re-exported)
test/rlm.test.ts  → runRlm integration tests (5 issue tests + budget behavior)
test/budget.test.ts → SpendBudget + estimateTokens unit tests (NEW)
docs/             → policy docs (truncation-policy.md untouched this flight)
tasks/            → plan.md, todo.md, flight reports
```

## Code Style

Follow the existing `src/rlm.ts` conventions: JSDoc on every non-obvious decision, `// ── Section ──`
banners, constants in UPPER_SNAKE with a doc comment stating the ceiling and why. Example (budget):

```ts
// ── Spend budget ──────────────────────────────────────────────
/** Deterministic token estimate: UTF-8 bytes ÷ 4, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / BYTES_PER_TOKEN);
}
```

Biome-enforced; run `npm run lint` before reporting.

## Testing Strategy

`node:test` + `assert/strict`, one test file per source module. The mock LLM
(`test/rlm.test.ts` `mockLlmCodeGen`) records `{ systemPrompt, messages }` per call, which is what
lets test 4 recompute consumption and assert it equals the recorded prompts' `estimateTokens` sum.

Issue #87's five tests, mapped to this flight's scope:

1. **Budget stops the loop, not depth** — a single `runRlm` with a small budget stops at fewer
   iterations than `maxIterations` when the budget exhausts (`status: "budget_exhausted"`,
   `budget.limited: true`). The multi-branch fan-out version waits for #78's nesting port (D1).
2. **Siblings share one pool** — two `runRlm` calls sharing one `SpendBudget` instance: the second
   sees the first's spend (its `budget.consumed` includes the first's charges; a budget sized for
   one run leaves the second `budget.limited`). Plus a unit test: two chargers on one `SpendBudget`
   compete for the same `remaining`.
3. **Exhaustion degrades, never throws** — a budget too small for even the first call returns a
   result (not an exception), marked `budget.limited`, with a best-effort answer.
4. **Consumption reported and matches the mock** — `result.budget.consumed === Σ estimateTokens`
   over every recorded call that actually ran (before exhaustion).
5. **No budget ⇒ unchanged** — omitting `budget` yields `status` in `"ok" | "max_iterations"`, no
   `budget` field, and no change to existing assertions.

Plus `test/budget.test.ts` unit tests: estimator determinism (incl. empty string → 0), `tryCharge`
refuses overspend and negative, `remaining`/`consumed`/`limit` observability, constructor rejects
non-finite/negative, and shared-instance semantics (the D1 crux, in isolation).

Coverage floors and mutation score stay green (existing `npm run coverage` / `npm run mutation`
gates). The full suite currently passes at 986 tests (F-77 baseline) — the flight adds, not removes.

## Boundaries

- **Always:** write the failing test first (RED) then the minimal code (GREEN); run `npm test`,
  `npm run check`, `npm run lint` (and `npm run coverage` where named) before reporting each task;
  one task per commit.
- **Ask first:** nothing — this run is autonomous (assumptions recorded in Decisions).
- **Never:** port nesting into `runRlm` (that is #78's scope, D1); use `Buffer`/`byteLength` in
  `src/rlm.ts` (D8); change the byte basis of `docs/truncation-policy.md`; add a tokenizer or any
  new runtime dependency; commit secrets; use `git add -A` (stage exactly the reported paths).

## Success Criteria

- [ ] All five issue tests pass (D4/D5 mapping above), plus the `test/budget.test.ts` unit tests.
- [ ] `npm test`, `npm run check`, `npm run lint` green; coverage floors and mutation score green.
- [ ] `RlmResult` reports `{ limit, consumed, limited }`; `budget_exhausted` is a real, reachable
      status; `"ok"`/`"max_iterations"` carry `limited: false` when a budget is configured.
- [ ] No budget configured ⇒ existing behavior byte-for-byte unchanged (test 5).
- [ ] The budget unit (estimated tokens) and its reasoning are recorded here (D2), and the worked
      example above is ready to append to issue #87 (final issue-monitor report carries it).

## Open Questions

- **Nesting port (deferred to #78).** The actual `rlm_query` fan-out wiring into `runRlm` — one
  line: pass the shared `SpendBudget` into the nested `runRlm` — lands with #78 step 4. This flight
  leaves it out and records the hand-off.
- **Provenance (#76).** The budget-limited answer's provenance is a plain `status` +
  `budget.limited` flag here; #76's richer provenance field will label it further when it lands.
- **Estimator constant.** `/4` bytes-per-token is an approximation; if a future flight adopts a real
  tokenizer, `estimateTokens` is the single swap point.
