# Todo — issue #166: enforce the D17 sentinel rule when options.systemPrompt is overridden

Source of truth: `SPEC.md` (D67) + `tasks/plan.md`.

- [ ] **T1 — Extract `SENTINEL_RULE`, append to overrides, interpolate into the default (D67)**
  - RED: add failing tests in `test/rlm.test.ts` (extend the "Sentinel contract (D17)" block):
    - **override carries the rule** — run `runRlm` with a custom `systemPrompt` lacking the sentinel
      wording; assert `llm.calls()[0].systemPrompt` contains the D17 rule text and that the caller's
      own prompt text appears **before** the rule text.
    - **default unchanged / no duplication** — a run with no `systemPrompt` still emits a prompt whose
      D17 section is byte-identical to the pre-change default, and the rule appears **exactly once**
      in the default path.
  - Implement (GREEN) in `src/rlm.ts`:
    - Add a module-internal `SENTINEL_RULE` constant holding the D17 bullet verbatim.
    - Interpolate it into `DEFAULT_RLM_SYSTEM_PROMPT` in its current position (second-to-last bullet,
      before "- Be thorough.") — output byte-identical.
    - Resolve the prompt as `options.systemPrompt ? \`${options.systemPrompt}\n${SENTINEL_RULE}\`
      : (await buildSystemPrompt(registry))`.
    - Update the `RlmOptions.systemPrompt` JSDoc to state the rule is always appended (callers need
      not restate it).
  - Verify: `npm test` (full), `npm run check`, `npm run lint` all green; existing tool-naming and
    fresh-sandbox prompt tests unaffected.

## Checkpoint (after T1)

- [ ] All SPEC success criteria met (D67).
- [ ] Full suite, `tsc --noEmit`, and biome clean.

## DoD

- [ ] A caller-supplied `systemPrompt` always carries the D17 sentinel rule (appended after the override).
- [ ] The default prompt output is byte-identical to today (regression-pinned).
- [ ] `RlmOptions.systemPrompt` JSDoc states the always-append contract.
- [ ] Named tests (RED → GREEN) pin both the override and default paths.
- [ ] Out of scope (not touched): #171, #168, #184, #170, #173; `truncateWithSentinels`, sentinel
      constants, shared truncator, public `RlmResult` shapes.
