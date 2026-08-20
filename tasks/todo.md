# Todo — issue #184: redact provider errors on the llm_query / downgraded-rlm_query tool paths

Source of truth: `SPEC.md` (D1–D7) + `tasks/plan.md`. Each task is RED-first. One coder per task,
fresh context, one commit per task. After each task the full suite must be green. Do **not** touch
`buildFeedback`'s `VALUE_HEAD_RATIO`; do **not** touch `src/repl.ts` / `src/session.ts` /
`src/sandbox.ts` / `src/truncate.ts`; do **not** use `truncateWithSentinels` for the provider
message; do **not** rewrite the two #167 short-message tests; do **not** absorb #171/#182/#166
scope. Only `src/rlm.ts`, `test/rlm.test.ts`, and `docs/truncation-policy.md` are in scope.

- [x] **T1 — Truncate provider errors at the two tool paths (D1–D7)**
  - [x] RED — add a new `describe("runRlm() — tool-path provider-error redaction (#184)")` block to
    `test/rlm.test.ts`, reusing the local `rlmRegistry()` helper (`new ToolRegistry([])`). Three
    tests, all RED today:
    1. **llm_query path is truncated.** Inline fake `llmClient.query`: call 1 returns
       `` ```python\nllm_query("hello")\nSUBMIT("done")\n``` ``; later calls throw
       `new Error("A".repeat(64 * 1024) + "TAIL-SECRET-REQID")`. Run
       `runRlm("q", { llmClient, registry: rlmRegistry(), maxIterations: 1 })`. Assert
       `iterations.length === 1`; `!iterations[0].result.error!.includes("TAIL-SECRET-REQID")`; and
       `!buildFeedback(iterations[0].result).includes("TAIL-SECRET-REQID")`. Today RED (raw 64 KiB
       message reaches both surfaces).
    2. **Downgrade path is truncated.** Same fake; run with `maxDepth: 1, depth: 1`; call 1 returns
       `` ```python\nresult = rlm_query("q", "c")\nSUBMIT(result)\n``` ``. Same two assertions.
       Today RED.
    3. **Short message passes verbatim (regression pin).** Tool call throws `new Error("boom")`;
       assert `iterations[0].result.error!.includes("boom")`. Green stays green after the fix
       (`truncateText` is a no-op under budget).
  - [x] GREEN — in `src/rlm.ts`, add a module-private helper beside the RLM provider-error
    constants (`RLM_ERROR_MAX_BYTES` at `:187`, `RLM_ERROR_RECOVERY` at `:193`):
    ```ts
    /** Head-only truncation of a provider rejection before it surfaces as a sandbox RuntimeError. */
    function redactProviderError(err: unknown): string {
      return truncateText(
        err instanceof Error ? err.message : String(err),
        { maxBytes: RLM_ERROR_MAX_BYTES, headRatio: HEAD_ONLY_RATIO, recovery: RLM_ERROR_RECOVERY },
      ).text;
    }
    ```
    Wrap the two `llmClient.query` calls (`:1087-1091` in `onLLMQuery`; `:1111` in the downgrade
    branch) in `try { return await llmClient.query(...) } catch (err) { throw new
    Error(redactProviderError(err)); }`. Do **not** touch the `tryCharge` blocks or the budget
    markers. Do **not** touch `buildFeedback`.
  - [x] Verify — `npx tsx --test test/rlm.test.ts` green; full `npm test` green;
    `npm run check` + `npm run build` clean; `npx biome check src extensions test` clean. Confirm
    the two #167 short-message tests still pass unchanged.
  - [x] Phase 5 review fix: short-message pin now asserts no-truncation (recovery clause absent)
  - [x] Phase 4 coverage gaps closed (String(err) branch + positive truncation shape)
  - Files — `src/rlm.ts`, `test/rlm.test.ts`.

- [x] **T2 — Record the two tool-path surfaces in the truncation policy**
  - No RED test (documentation). In `docs/truncation-policy.md`:
    1. Add an Implementation-record row to the table for the `llm_query` and downgraded-`rlm_query`
       provider-error surfaces (1 KiB, head-only, #184).
    2. Append a short `**#184 (tool-path provider errors).**` narrative after the `#167` narrative
       explaining: the two source choke points (`onLLMQuery`, downgrade branch), the plain-
       `truncateText` (not `truncateWithSentinels`) choice because the message becomes a sandbox
       `RuntimeError`, head-only per D7, and the reused neutral recovery clause.
  - [x] Verify — re-read the edited sections for accuracy against the landed code; `npm run check`
    + `npm run build` unaffected (doc-only). No test changes.
  - Files — `docs/truncation-policy.md`.

## Checkpoint (after T2)

- [x] Issue acceptance met: both tool paths truncated head-only at 1 KiB before the sandbox
      `RuntimeError`; `iterations[].result.error` bounded/redacted; short messages verbatim.
- [x] Two RED-first tests pin the llm_query and downgrade paths; one regression pin for short
      messages.
- [x] `docs/truncation-policy.md` records the two surfaces.
- [x] Full suite green; `check`/`build`/scoped-`lint` clean.

## DoD (from #184, reconciled)

- [x] Provider errors on the `llm_query` and downgraded-`rlm_query` paths are truncated at the
      source (head-only, ≤ 1 KiB) before they surface as a sandbox `RuntimeError`.
- [x] `iterations[].result.error` for these paths is bounded/redacted, not raw.
- [x] RED test: a request-context marker at the very end does not reach the model prompt via
      `buildFeedback`, nor the caller via `iterations[].result.error`.
- [x] Short provider errors pass verbatim (regression pin).
- [x] No `truncateWithSentinels`; no change to `buildFeedback`'s `VALUE_HEAD_RATIO`.
- [x] No changes to `src/repl.ts`, `src/session.ts`, `src/sandbox.ts`, `src/truncate.ts`;
      no #171/#182/#166 scope absorbed.
- [x] Truncation policy updated with the two new surfaces.
