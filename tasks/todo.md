# Tasks — Restore the unconditional `context` input (#72)

- [x] Task 1: RED — load REPL_SERVER + tests 1, 2, 3, 5
  - Acceptance: `REPL_SERVER` const in `test/rlm.test.ts` loaded from `repl/repl_server.py`
    and used; test 1 (shipped preamble, no `inputs` → `ok`) and test 2 (`context` readable as
    `""` with no `inputs`) RED against HEAD with the documented `unresolved-reference` typing
    error; tests 3 (caller `context` overrides default) and 5 (non-`context` input readable)
    green against HEAD — regression guards whose job is failing under the M4 mutant, not
    under HEAD.
  - Verify: `npx tsx --test test/rlm.test.ts` — 9.2.1/9.2.2 fail, all pre-existing tests pass.
  - Files: `test/rlm.test.ts`

- [x] Task 2: GREEN — always declare `context` in `runRlm`
  - Acceptance: merged inputs map (`runOptions.inputs` ⊕ `options.inputs`) with
    `context` defaulting to `""`; tests 1, 2, 3, 5 green; no other test broken.
  - Verify: `npx tsx --test test/rlm.test.ts`; `npm run check`.
  - Files: `src/rlm.ts`

- [x] Task 3: RED — test 4 (every key named in the prompt) + preview-truncation pin
  - Acceptance: test 4 asserts `llm.calls()[0]` initial prompt names both `context` and
    `other_data` (content, not message count), RED against HEAD; preview pin asserts the
    >5000-char context renders head+tail and no middle, green against HEAD (pin).
  - Verify: `npx tsx --test test/rlm.test.ts` — 9.2.5 fails, 9.2.6 passes.
  - Files: `test/rlm.test.ts`

- [x] Task 4: GREEN — announce every input key in `buildInitialPrompt`
  - Acceptance: `buildInitialPrompt(question, inputs)` iterates the merged map; `context`
    keeps its legacy header and preview; other keys use `# Input (available as \`name\`)`;
    empty values render header-only; test 4 + preview pin green.
  - Verify: `npx tsx --test test/rlm.test.ts`; `npm run check`.
  - Files: `src/rlm.ts`

- [x] Task 6: review remediation (fan-out Required/Medium findings)
  - Acceptance: 9.2.5 asserts the exact `# Context`/`# Input` headers; new 9.2.7 (empty
    `context` header-only, no empty fence); new 9.2.8 + 9.2.9 pin `runOptions.inputs`
    precedence; 9.2.6 pins the exact-5000 boundary; `runInputs` built once (dead `?? {}`
    removed); `RlmOptions.inputs` JSDoc + README document the LLM-disclosure contract;
    SPEC/todo RED wording corrected.
  - Verify: `npx tsx --test test/rlm.test.ts`; `npm run check`; `npm run lint`.
  - Files: `test/rlm.test.ts`, `src/rlm.ts`, `src/types.ts`, `README.md`, `SPEC.md`,
    `tasks/todo.md`

- [x] Task 5: full gates + commit + push + PR
  - Acceptance: `npm test` green; `npm run check` clean; `npm run lint` clean;
    `npm run build` clean; `npm run coverage` floors hold; `npm run mutation` above floor
    (M4 killed); branch pushed; PR opened; ship report written.
  - Verify: `npm test && npm run check && npm run lint && npm run build`; then coverage,
    mutation; `git status` clean.
  - Files: none (verification only)
