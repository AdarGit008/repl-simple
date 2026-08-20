# Spec: Redact provider errors on the `llm_query` and downgraded-`rlm_query` tool paths — issue #184

## Objective

`onLLMQuery` and the `depth >= maxDepth` downgrade branch of `rlm_query` call
`llmClient.query(...)` directly with no truncation. A provider rejection there throws out of the
tool into the sandbox as a Python `RuntimeError`, whose raw message reaches two surfaces:

1. `buildFeedback` → `RunResult.error` (16 KiB, `VALUE_HEAD_RATIO` 50/50 → **tail retained**) —
   model-visible; and
2. `result.iterations[].result.error` (raw/uncapped) — caller-visible.

This is the same request-context leak class as #167, on the adjacent `RunResult.error`/sandbox
surface (#167 explicitly scoped it out). The fix is a single choke point per tool path: truncate
the provider error **head-only at the source** (≤ 1 KiB) before it surfaces as a sandbox
`RuntimeError`. Both consumers then read the bounded form.

Success looks like: a short provider error (`"boom"`) survives byte-for-byte; a huge provider error
is truncated head-only on both the model-visible `buildFeedback` output and the caller-visible
`iterations[].result.error`; no request-context tail reaches the model or the caller.

Issue: https://github.com/AdarGit008/repl-simple/issues/184.
Source: #167 flight security audit — Medium (pre-existing, out of #167's scope).
Siblings touching the same file: #166 (D17 sentinel rule under `systemPrompt` override),
#171 (signal-race + truncate the downgrade interpolation — a different concern), #182 (spend gaps,
in flight).

## Assumptions (recorded — autonomous run, no clarifying questions)

- **A1 — Cap reuse.** Reuse `RLM_ERROR_MAX_BYTES = 1024` (1 KiB) as the ceiling. This is the same
  provider-error class as #167's `RlmResult.error`; a distinct constant would split one rule across
  two names for no gain.
- **A2 — Head-only.** Reuse `HEAD_ONLY_RATIO` (= 1), per #167 D7 and the "redaction cuts are
  head-only" rule in `docs/truncation-policy.md`. Do **not** reuse `VALUE_HEAD_RATIO` (0.5) — it
  retains the request-context tail.
- **A3 — Recovery reuse.** Reuse `RLM_ERROR_RECOVERY` ("The full provider error is not surfaced.").
  Neutral for both the model and the caller; `ERROR_RECOVERY` (catch-the-exception-and-print-the-
  traceback) is semantically wrong for an LLM rejection (no Python to re-run).
- **A4 — Re-throw a plain `Error`.** `src/sandbox.ts` already maps any non-`HostToolError` tool
  throw to a Python `RuntimeError` carrying `err.message` verbatim. Re-throwing
  `new Error(truncatedMessage)` preserves those `RuntimeError` semantics while bounding the message.
  Tool-path abort-vs-error semantics are unchanged (out of scope — #171 owns signal-racing).
- **A5 — Leave `buildFeedback`'s shape alone.** The `VALUE_HEAD_RATIO` 50/50 split there is correct
  for *sandbox* tracebacks (the tail holds the final exception line). The provider error is already
  head-only-truncated before it enters `RunResult.error`, so `buildFeedback` can no longer retain
  provider request-context — the thing it used to retain is gone at the source.
- **A6 — Budget ordering unchanged.** `tryCharge` still runs before the query (#185 D62/D63); a
  refusal still returns the marker, and a post-charge rejection is truncated then re-thrown (the
  charge is not refunded, same as today). No change to the shared-pool semantics.

## Current state (fact base — verified on main `a64b3e7`)

| Fact | Location | Value |
|---|---|---|
| `llm_query` provider call | `src/rlm.ts:1087-1091` (`onLLMQuery`) | `await llmClient.query(...)` — no try/catch, raw on throw |
| downgraded-`rlm_query` provider call | `src/rlm.ts:1111` (`onRLMQuery`, `depth >= maxDepth` branch) | `await llmClient.query(...)` — no try/catch, raw on throw |
| Tool throw → sandbox error | `src/sandbox.ts` (~1116-1118, tool-execute catch) | non-`HostToolError` → `RuntimeError` with `err.message` verbatim |
| Model-visible leak | `src/rlm.ts:786-789` (`buildFeedback`) | `truncateWithSentinels(result.error, { maxBytes: FEEDBACK_ERROR_MAX_BYTES, headRatio: VALUE_HEAD_RATIO, recovery: ERROR_RECOVERY })` — 16 KiB 50/50 → tail retained |
| Caller-visible leak | `src/rlm.ts:1276-1281` (iteration record) | `iterations.push({ index, code, result, llmResponse })` — `result.error` stored raw |
| Reusable cap | `src/rlm.ts:187` | `RLM_ERROR_MAX_BYTES = 1024` |
| Reusable recovery | `src/rlm.ts:193` | `RLM_ERROR_RECOVERY = "The full provider error is not surfaced."` |
| Head-only ratio | `src/truncate.ts:50` (imported at `src/rlm.ts:16`) | `HEAD_ONLY_RATIO = 1` |
| Shared truncator | `src/truncate.ts:384` | `truncateText(text, opts) → { text, truncated }` — "the only place that cuts" (invariant 4) |
| #167 precedent | `src/rlm.ts:1234-1240` | `RlmResult.error` already truncated `{ maxBytes: RLM_ERROR_MAX_BYTES, headRatio: HEAD_ONLY_RATIO, recovery: RLM_ERROR_RECOVERY }` |

## Scope

| In scope | Out of scope |
|---|---|
| `src/rlm.ts` — wrap both provider calls in try/catch and re-throw a head-only-truncated message (plus a small shared helper) | `truncateWithSentinels` wrap of the interpolated query/context (#171) |
| `test/rlm.test.ts` — two new RED-first tests (llm_query path; downgrade path) + one short-message regression pin | Changing `buildFeedback`'s `VALUE_HEAD_RATIO` (A5) |
| `docs/truncation-policy.md` — record the two tool-path surfaces | Signal-racing the tool calls (#171); #182 spend gaps; #166 sentinel rule |
| Reuse of the three existing constants (A1-A3) | New constants |

## Architecture Decisions

- **D1 — Source choke points (two).** Truncate at the `onLLMQuery` call site and at the
  `depth >= maxDepth` downgrade call site. One edit per path bounds *both* consumers
  (`buildFeedback` model-visible and `iterations[].result.error` caller-visible) because the
  sandbox `RuntimeError` is built from the re-thrown message.
- **D2 — Plain `truncateText`, not `truncateWithSentinels`.** The message becomes a Python
  `RuntimeError` in the sandbox; D17 sentinels would leak into both the model prompt and a
  caller-facing `RunResult.error`. `truncateText`'s unauthenticated `[…` marker is accepted
  (same trade-off as #167 D2).
- **D3 — Cap = `RLM_ERROR_MAX_BYTES` (1 KiB).** Reused, not re-declared (A1).
- **D4 — Shape = head-only (`HEAD_ONLY_RATIO`).** The tail is exactly where request-context /
  retry-hints / request-IDs live (A2, #167 D7).
- **D5 — Recovery = `RLM_ERROR_RECOVERY`.** Reused; neutral for both audiences (A3).
- **D6 — Re-throw a plain `Error`.** Preserves existing `RuntimeError` semantics (A4); no
  `HostToolError`/abort reclassification.
- **D7 — Shared helper.** Extract a module-private `redactProviderError(err: unknown): string`
  beside the RLM provider-error constants, returning `truncateText(...).text`. Two identical
  try/catch blocks would drift; the helper keeps the rule in one place. Both call sites wrap
  `await llmClient.query(...)` in `try { return await ... } catch (err) { throw new Error(redactProviderError(err)); }`.

## Commands

- Build: `npm run build`
- Typecheck: `npm run check`
- Lint: `npm run lint` (repo-wide has pre-existing `.pi-subagents/*` errors — scope to `src` +
  `extensions` + `test` via `npx biome check src extensions test`)
- Focused test: `npx tsx --test test/rlm.test.ts`
- Full suite: `npm test`

## Testing Strategy

Framework: `node:test` via `tsx --test` (`npm test` runs `test/*.test.ts`). Tests live in
`test/rlm.test.ts` alongside the existing `runRlm()` describes, reusing the local `rlmRegistry()`
helper (`new ToolRegistry([])`) and a custom `LlmClient` fake (the `mockLlmCodeGen` helper cannot
throw on a specific call, so the new tests use a small inline fake that returns code on the
code-gen call and throws on the tool call).

Two RED-first tests (both RED today — the raw 64 KiB message reaches both surfaces):

1. **llm_query path.** Fake `llmClient.query`: call 1 returns
   `` ```python\nllm_query("hello")\nSUBMIT("done")\n``` ``; subsequent calls throw
   `new Error("A".repeat(64 * 1024) + "TAIL-SECRET-REQID")`. Run
   `runRlm("q", { llmClient, registry: rlmRegistry(), maxIterations: 1 })`. Assert
   `iterations.length === 1`, `!iterations[0].result.error!.includes("TAIL-SECRET-REQID")`, and
   `!buildFeedback(iterations[0].result).includes("TAIL-SECRET-REQID")`.
2. **Downgrade path.** Same fake; run with `maxDepth: 1, depth: 1`; call 1 returns
   `` ```python\nresult = rlm_query("q", "c")\nSUBMIT(result)\n``` ``. Same two assertions.

Plus one **short-message regression pin**: the tool call throws `new Error("boom")`; assert
`iterations[0].result.error` includes `"boom"` (byte-identical, not truncated — `truncateText` is
a no-op under budget).

## Boundaries

- **Always:** RED before GREEN; run the focused test then the full suite; `check` + `build` + scoped
  lint clean; one commit per task.
- **Ask first (recorded as assumptions here — no live questions in this autonomous run):** cap size,
  recovery wording, helper extraction.
- **Never:** touch `buildFeedback`'s `VALUE_HEAD_RATIO`; touch `src/repl.ts` / `src/session.ts` /
  `src/sandbox.ts` / `src/truncate.ts`; absorb #171/#182/#166 scope; use `truncateWithSentinels`
  for the provider message; rewrite the two #167 short-message tests (`test/rlm.test.ts` ~:880,
  ~:1104-1115).

## Success Criteria

- [ ] Provider errors on the `llm_query` and downgraded-`rlm_query` paths are truncated at the
      source (head-only, ≤ 1 KiB) before they surface as a sandbox `RuntimeError`.
- [ ] `iterations[].result.error` for these paths is bounded/redacted, not raw.
- [ ] RED test: a request-context marker at the very end does not reach the model prompt via
      `buildFeedback`, nor the caller via `iterations[].result.error` (both paths).
- [ ] Short provider errors pass verbatim (regression pin).
- [ ] Full suite green; `check` / `build` / scoped `lint` clean.
- [ ] `docs/truncation-policy.md` records the two tool-path surfaces.

## Open Questions

None blocking (issue body's gotcha is answered by D4/A2).
