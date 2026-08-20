# Spec: Redact `RlmResult.error` before returning it and before it is re-interpolated into nested feedback — issue #167

## Objective

`RlmResult.error` carries the raw `llmClient` error message (`err.message`) to two consumers:

1. the **public return** — `status: "error"` result handed to the API caller; and
2. the **nested-feedback re-interpolation** — `[rlm_query error: <status>] <error>` (line 1093),
   which feeds the parent loop's sandbox variable `result`, and from there reaches the model's
   prompt.

Provider error text can carry request context the caller never intended to round-trip into a
model-visible prompt: prompt snippets, request IDs, retry hints. The fix is to truncate/sanitize the
message at a small cap **at the source** so both consumers get the bounded form.

Success looks like: a short provider error (`"boom"`, `"child llm failure"`) survives byte-for-byte;
a huge provider error is truncated to a small cap on both the public `RlmResult.error` and the
nested `[rlm_query error: …]` re-interpolation; no request-context tail reaches the model.

Issue: https://github.com/AdarGit008/repl-simple/issues/167.
Source: #78 (RLM convergence) security audit — Low. Parent bucket: #41 (Bucket 4 — Security
perimeter). Siblings touching the same file: #166 (sentinel rule under `systemPrompt` override),
#171 (signal-race + truncate the downgrade interpolation — a different code block).

## Corrected understanding (pre-build, vs. the issue-monitor initial scan)

The initial scan (gotcha G1) claimed the two existing tests — `test/rlm.test.ts:880`
(`"outer: [rlm_query error: error] child llm failure"`) and `test/rlm.test.ts:1104-1115`
(`result.error === "boom"`) — "pin verbatim unredacted behavior and will break". **They will not.**
Both messages are far under the cap (`"boom"` = 4 bytes, `"child llm failure"` = 17 bytes), and
`truncateText` is a byte-identical no-op under budget. Under D3/D5 those two tests remain GREEN
and are deliberately **not rewritten** — they become the "short message passes verbatim" pins.
The RED step is instead two **new** long-message tests (public return; nested re-interpolation).
The monitor's "must be updated" wording is superseded by this finding; it is re-flagged to the
monitor in the Phase 6 report.

## Current state (fact base — verified by orchestrator, 2026-08-20)

| Fact | Value |
|---|---|
| `src/rlm.ts:1187-1188` | `return { status: "error", error: err instanceof Error ? err.message : String(err), … }` — raw, unredacted. The only assignment site of `RlmResult.error`. |
| `src/rlm.ts:1093` | `` : `[rlm_query error: ${nested.status}] ${nested.error ?? ""}`; `` — the only *read* of `RlmResult.error` in the repo (confirmed by grep). |
| `src/rlm.ts:139-142` | `RlmResult.error?: string` — JSDoc: "Populated on `status: "error"` (D53); the nested `rlm_query` error branch reads it (D52)." Needs a redaction note. |
| `src/rlm.ts:356-371` | `truncateWithSentinels(value, {maxBytes, headRatio, recovery})` — module-private; wraps in `[TRUNCATED VIEW BEGIN/END]` sentinels iff truncated (D17 marker auth). |
| `src/rlm.ts:163` | `FEEDBACK_ERROR_MAX_BYTES = 16 * 1024` — caps the **sandbox** `RunResult.error` inside `buildFeedback`; a *different* field (`RunResult.error` vs `RlmResult.error`), not reusable here. |
| `src/rlm.ts:170` | `ERROR_RECOVERY = "Catch the exception and print the full traceback to see more."` — semantically wrong for an LLM client error (no Python to re-run). |
| `src/truncate.ts:384` | `truncateText(text, opts) → { text, truncated }` — the shared truncator; "the only place that cuts" (invariant 4). Imported into `rlm.ts` at line 7-8. |
| `src/truncate.ts:47` | `VALUE_HEAD_RATIO = 0.5` — head ratio for value-shape truncation. |
| `test/rlm.test.ts:880` | Pins short nested error verbatim: `"outer: [rlm_query error: error] child llm failure"`. Stays GREEN under D5. |
| `test/rlm.test.ts:1104-1115` | Pins short return verbatim: `result.error === "boom"` (issue test 4). Stays GREEN under D5. |
| `test/rlm.test.ts:1948-1990` | Caps `RunResult.error` (sandbox) in `buildFeedback` — template only, not this field. |
| `docs/truncation-policy.md:372-391` | "Implementation record" table — no `RlmResult.error` row. `:342` Non-goals says "the `error` string is now capped (16 KiB, #144)" — that is `RunResult.error`, not `RlmResult.error`. |

## Scope

| In scope | Out of scope |
|---|---|
| `src/rlm.ts` — truncate `RlmResult.error` at the assignment site (`:1188`), plus two new constants and a JSDoc note | `truncateWithSentinels` at `:1093` (sentinel-wrap of the *re-interpolation* is rejected — see D2) |
| `test/rlm.test.ts` — two new long-message tests (public return; nested re-interpolation) | Rewriting the existing short-message tests (`:880`, `:1104-1115`) — they stay GREEN (D5) |
| `docs/truncation-policy.md` — Implementation-record row + Non-goals line + a short narrative | `src/repl.ts` / `src/session.ts` / `src/sandbox.ts` — the `RunResult.error` path is a different field |
| | #166 (sentinel auth under `systemPrompt` override) — record, don't implement |
| | #171 (signal-race + truncate the downgrade `Query:`/`Context:` interpolation at `:1040-1065`) — different block, don't absorb |

## Explicit decisions

### D1 — Redact at the source (single choke point)

Apply truncation where `RlmResult.error` is **assigned** (`src/rlm.ts:1188`), not where it is
consumed (`:1093`). The two consumers are exactly (1) the public return and (2) `nested.error` at
`:1093` — one choke point covers both, and the re-interpolation reads the already-bounded value.
No edit at `:1093`; its interpolation template is unchanged.

### D2 — Plain `truncateText`, not `truncateWithSentinels`

The public `RlmResult.error` is an API surface, not a model-facing prompt. `truncateWithSentinels`
emits `[TRUNCATED VIEW BEGIN/END]` authentication sentinels (D17) that would leak meaningless
marker text to API callers. Use the shared `truncateText` (invariant 4) directly.

**Recorded consequence:** the model-facing nested error therefore carries an *unauthenticated*
`[… N of M …]` elision marker (no sentinel wrap). This is accepted: D17's marker authentication
concerns forged markers in attacker-controlled text, and the goal here is size + request-context
redaction, not marker authentication. Tightening that is #166's scope, not this flight's.

### D3 — Cap = `RLM_ERROR_MAX_BYTES = 1024` (1 KiB)

A "small cap" per the issue, distinct from the 16 KiB `FEEDBACK_ERROR_MAX_BYTES` (sandbox
`RunResult.error`). 1 KiB keeps a useful provider-error prefix (rate-limit/overloaded messages are
short) while dropping long retry-hint/request-body tails. `headRatio` reuses `VALUE_HEAD_RATIO`
(0.5) — value shape. Recorded as an assumption; veto point is the Phase 6 go/no-go.

### D4 — Recovery clause is neutral, not `ERROR_RECOVERY`

`ERROR_RECOVERY` ("Catch the exception and print the full traceback") tells the model to re-run
Python under `try/except` — impossible for an LLM provider rejection, which never touches the
sandbox. A new constant `RLM_ERROR_RECOVERY = "The full provider error is not surfaced."` serves
both audiences: for the API caller it is plain fact; for the model it is honest (an LLM rejection
is not something the model's code can fix). It only renders inside the `[… …]` marker when
truncation actually fires.

### D5 — Short messages pass verbatim; existing tests are not rewritten

`truncateText` is byte-identical under budget. `"boom"` and `"child llm failure"` are far under
1 KiB, so `test/rlm.test.ts:880` and `:1104-1115` stay GREEN and become the "short message passes
verbatim" pins. Do not rewrite their assertions; the RED tests are the two new long-message tests.

### D6 — The sentinel-forged-marker concern is #166's, not this flight's

A forged `[TRUNCATED VIEW BEGIN]` inside a provider error would pass through `truncateText`
un-neutralised. `truncateWithSentinels` neutralises such text; plain `truncateText` does not. This
is the same class of gap as #166 (D17 only lives in `DEFAULT_RLM_SYSTEM_PROMPT`), and is
deliberately out of scope here. Record, don't implement.

## Commands

```
Focused:  npx tsx --test test/rlm.test.ts              # the two new long-message tests
Test:     npm test                                      # tsx --test test/*.test.ts
Type:     npm run check                                 # tsc --noEmit
Build:    npm run build                                 # tsc -p tsconfig.build.json
Lint:     npm run lint                                  # biome; scope to src test
```

## Project structure (this flight)

```
src/rlm.ts                    → the fix: RLM_ERROR_MAX_BYTES + RLM_ERROR_RECOVERY constants; truncate at :1188; JSDoc note on RlmResult.error
src/truncate.ts               → NOT modified (truncateText is reused as-is)
test/rlm.test.ts              → NEW: two long-message truncation tests (public return; nested re-interpolation)
docs/truncation-policy.md     → NEW: Implementation-record row + Non-goals line + short narrative
```

## Code style

Follow the existing file: 2-space indent, double quotes, JSDoc on exported/notable declarations,
numeric separators (`16 * 1024`). Do not introduce a new abstraction or a new exported helper for a
single truncation call — the change should read as one obvious line at `:1188` plus two named
constants next to the existing feedback-budget constants.

## Testing strategy (TDD, RED first)

Test level: unit/integration at the `runRlm` public seam (the existing `runRlm()` describe blocks
already drive `runRlm` with a fake `LlmClient`, e.g. the `:1104` "issue test 4" and `:855` nested
test).

RED tests (both must fail against current code, which returns/interpolates the full message):

1. **Public return is truncated.** A fake `LlmClient` whose `query` throws
   `new Error("A".repeat(64 * 1024) + "UNIQUE-TAIL-SENTINEL")`. Run `runRlm("q", { llmClient, registry,
   maxIterations: 5 })`. Assert `result.status === "error"`; `result.error` does **not** contain
   `"UNIQUE-TAIL-SENTINEL"`; `result.error` contains an elision marker (`[…`); and
   `new TextEncoder().encode(result.error!).length <= 1024` (or a small documented tolerance equal
   to the marker + recovery bytes). Today this is RED (the full 64 KiB message comes back).
2. **Nested re-interpolation is truncated.** Mirror the `:855` nested test: the child `rlm_query`
   throws `new Error("B".repeat(64 * 1024) + "NESTED-TAIL-SENTINEL")`; the parent
   `SUBMIT("outer: " + result)`. Assert `result.answer` starts with `"outer: [rlm_query error: error] "`
   and does **not** contain `"NESTED-TAIL-SENTINEL"`. Today RED.

GREEN: one line at `:1188` wraps the message in `truncateText(…, { maxBytes: RLM_ERROR_MAX_BYTES,
headRatio: VALUE_HEAD_RATIO, recovery: RLM_ERROR_RECOVERY }).text`, plus the two constants.

Regression pins that must stay GREEN: `test/rlm.test.ts:880` (short nested error verbatim) and
`:1104-1115` (short return verbatim) — D5.

## Boundaries

- **Always:** RED first; run the focused test then the full suite + `check` + `build` + `lint`
  (scoped to `src test`) before declaring a task done.
- **Ask first / Never (autonomous — no live ask):** do not edit `src/rlm.ts:1093` (the
  re-interpolation template), do not use `truncateWithSentinels` for this fix, do not touch
  `src/repl.ts`/`src/session.ts`/`src/sandbox.ts`, do not rewrite the two existing short-message
  assertions, do not absorb #166's sentinel-auth or #171's downgrade-interpolation scope.

## Success criteria

- `RlmResult.error` is truncated at 1 KiB (head 50%, neutral recovery) at the assignment site.
- The nested `[rlm_query error: …]` re-interpolation carries the truncated message.
- Short provider errors pass verbatim (existing `:880` and `:1104-1115` tests stay GREEN).
- Two new RED-first tests pin the public-return and nested re-interpolation truncation.
- `docs/truncation-policy.md` records the new surface (Implementation record + Non-goals).
- Full suite green; `check`/`build`/`lint` clean.

## Assumptions (recorded)

1. **Cap = 1 KiB** (D3) — "small cap" is interpreted as 1024 bytes; 16 KiB is rejected as it is the
   *sandbox* error budget, a different surface. Veto point: Phase 6 go/no-go.
2. **Plain truncateText, not sentinel-wrap** (D2) — the public return must not leak sentinels.
3. **Single choke point at `:1188`** (D1) — no `:1093` edit; `nested.error` is read post-truncation.
4. **Neutral recovery clause** (D4) — no Python re-run route exists for an LLM error.
5. **Existing short-message tests are not rewritten** (D5) — they remain the verbatim-under-cap pins.

## Open questions

None blocking. (Whether the model-facing nested error should be sentinel-wrapped for D17 parity is
deferred to #166/#171 — out of this flight's scope, recorded in D2/D6.)
