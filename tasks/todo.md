# Todo — issue #167: redact `RlmResult.error` before return and nested re-interpolation

Source of truth: `SPEC.md` (D1–D6) + `tasks/plan.md`. Each task is RED-first. One coder per task,
fresh context, one commit per task. After each task the full suite must be green. Do **not** touch
`src/rlm.ts:1093` (the re-interpolation template), do **not** use `truncateWithSentinels`, do **not**
touch `src/repl.ts` / `src/session.ts` / `src/sandbox.ts`, do **not** rewrite the two existing
short-message assertions (`test/rlm.test.ts:880`, `:1104-1115`), do **not** absorb #166 or #171 scope.
Only `src/rlm.ts`, `test/rlm.test.ts`, and `docs/truncation-policy.md` are in scope.

- [x] **T1 — Truncate `RlmResult.error` at the source (D1, D2, D3, D4, D5)**
  - [x] RED — add a new `describe("runRlm() — RlmResult.error redaction (#167)")` block to
    `test/rlm.test.ts` (after the existing `runRlm()` describes, reusing the local `rlmRegistry()`
    helper). Two tests, both RED today:
    1. **Public return is truncated.** Fake `LlmClient.query` throws
       `new Error("A".repeat(64 * 1024) + "UNIQUE-TAIL-SENTINEL")`. Run `runRlm("q", { llmClient,
       registry: rlmRegistry(), maxIterations: 5 })`. Assert `result.status === "error"`;
       `!result.error!.includes("UNIQUE-TAIL-SENTINEL")`; `result.error!.includes("[…")`; and
       `new TextEncoder().encode(result.error!).length <= 1024` plus a small documented tolerance
       for the marker+recovery bytes. Today RED (the full 64 KiB message returns verbatim).
    2. **Nested re-interpolation is truncated.** Mirror the existing nested `rlm_query` test
       (`:855`): the child query throws `new Error("B".repeat(64 * 1024) +
       "NESTED-TAIL-SENTINEL")`; the parent submits `SUBMIT("outer: " + result)`. Assert
       `result.status === "ok"`, `result.answer.startsWith("outer: [rlm_query error: error] ")`,
       and `!result.answer.includes("NESTED-TAIL-SENTINEL")`. Today RED.
  - [x] GREEN — in `src/rlm.ts`, add two named constants beside the feedback-budget constants
    (`FEEDBACK_ERROR_MAX_BYTES` at `:163`, `ERROR_RECOVERY` at `:170`):
    ```ts
    /** Byte ceiling for the RLM-level `RlmResult.error` (LLM provider error, 1 KiB). */
    const RLM_ERROR_MAX_BYTES = 1024;
    /**
     * Recovery clause for a truncated provider error. Deliberately NOT
     * `ERROR_RECOVERY`: an LLM client rejection never touches the sandbox, so
     * "catch the exception and print the full traceback" is inapplicable.
     */
    const RLM_ERROR_RECOVERY = "The full provider error is not surfaced.";
    ```
    Then at the assignment site (`:1188`), replace the raw message:
    ```ts
    error: truncateText(
      err instanceof Error ? err.message : String(err),
      { maxBytes: RLM_ERROR_MAX_BYTES, headRatio: VALUE_HEAD_RATIO, recovery: RLM_ERROR_RECOVERY },
    ).text,
    ```
    Add a one-line JSDoc note to `RlmResult.error` (`:139-142`) that the message is truncated at
    `RLM_ERROR_MAX_BYTES` (1 KiB). Do **not** touch `:1093` or any `systemPrompt`/downgrade block.
  - [x] Verify — `npx tsx --test test/rlm.test.ts` green; full `npm test` green;
    `npm run check` + `npm run build` + `npm run lint` clean. Confirm the two existing
    short-message tests (`:880`, `:1104-1115`) still pass unchanged (D5).
  - Files — `src/rlm.ts`, `test/rlm.test.ts`.

- [ ] **T2 — Record the new surface in the truncation policy (D-spec G4)**
  - No RED test (documentation). In `docs/truncation-policy.md`:
    1. Add an Implementation-record row to the table (`:372-391`):
       `| \`RlmResult.error\` (LLM provider error) | 1 KiB | 50/50 head+tail | #167 |`
    2. Update the Non-goals line (`:342`) — it currently says "the `error` string is now capped
       (16 KiB, #144)" referring only to `RunResult.error`; add a clause distinguishing the
       RLM-level `RlmResult.error` (1 KiB, #167, plain `truncateText`, no sentinel wrap).
    3. Append a short `**#167 (RlmResult.error).**` narrative after the `#145` narrative
       (`:435+`) explaining: the source choke point at `:1188`, the plain-`truncateText` (not
       `truncateWithSentinels`) choice because the public return is an API surface, and the
       deliberate neutral recovery clause (no Python re-run route for an LLM rejection).
  - [ ] Verify — re-read the edited sections for accuracy against the landed code; `npm run check`
    + `npm run build` unaffected (doc-only). No test changes.
  - Files — `docs/truncation-policy.md`.

## Checkpoint (after T2)

- [ ] Issue acceptance met: `RlmResult.error` truncated at 1 KiB on both the public return and the
      nested `[rlm_query error: …]` re-interpolation; short errors pass verbatim.
- [ ] Two new RED-first tests pin the public-return and nested re-interpolation truncation.
- [ ] `docs/truncation-policy.md` records the `RlmResult.error` surface.
- [ ] Full suite green; `check`/`build`/`lint` clean.

## DoD (from #167, reconciled)

- [ ] `RlmResult.error` is truncated at the source (`src/rlm.ts:1188`) with `truncateText` at 1 KiB.
- [ ] The nested `[rlm_query error: …]` re-interpolation (`:1093`) carries the truncated message
      (no edit at `:1093` — it reads the already-bounded `nested.error`).
- [ ] Short messages pass verbatim (existing `:880` / `:1104-1115` tests stay GREEN).
- [ ] No `truncateWithSentinels`; no sentinel leak to the public API return.
- [ ] No changes to `src/repl.ts`, `src/session.ts`, `src/sandbox.ts`; no #166/#171 scope absorbed.
- [ ] Truncation policy updated with the new surface.
