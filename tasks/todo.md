# Tasks — Restore the unconditional `context` input (#72)

- [ ] Task 1: RED — load REPL_SERVER + tests 1, 2, 3, 5
  - Acceptance: `REPL_SERVER` const in `test/rlm.test.ts` loaded from `repl/repl_server.py`
    and used; test 1 (shipped preamble, no `inputs` → `ok`), test 2 (`context` readable as
    `""` with no `inputs`), test 3 (caller `context` overrides default), test 5
    (non-`context` input readable) — all four RED against HEAD, each for the documented reason
    (`unresolved-reference` typing error / missing declaration).
  - Verify: `npx tsx --test test/rlm.test.ts` — new tests fail, old tests pass.
  - Files: `test/rlm.test.ts`

- [ ] Task 2: GREEN — always declare `context` in `runRlm`
  - Acceptance: merged inputs map (`runOptions.inputs` ⊕ `options.inputs`) with
    `context` defaulting to `""`; tests 1, 2, 3, 5 green; no other test broken.
  - Verify: `npx tsx --test test/rlm.test.ts`; `npm run check`.
  - Files: `src/rlm.ts`

- [ ] Task 3: RED — test 4 (every key named in the prompt) + preview-truncation pin
  - Acceptance: test 4 asserts `llm.calls()[0]` initial prompt names both `context` and
    `other_data` (content, not message count), RED against HEAD; preview pin asserts the
    >5000-char context renders head+tail and no middle, RED against HEAD (or green if the
    branch already behaves — recorded).
  - Verify: `npx tsx --test test/rlm.test.ts` — new tests fail, others pass.
  - Files: `test/rlm.test.ts`

- [ ] Task 4: GREEN — announce every input key in `buildInitialPrompt`
  - Acceptance: `buildInitialPrompt(question, inputs)` iterates the merged map; `context`
    keeps its legacy header and preview; other keys use `# Input (available as \`name\`)`;
    empty values render header-only; test 4 + preview pin green.
  - Verify: `npx tsx --test test/rlm.test.ts`; `npm run check`.
  - Files: `src/rlm.ts`

- [ ] Task 5: full gates + commit + push + PR
  - Acceptance: `npm test` green; `npm run check` clean; `npm run lint` clean;
    `npm run build` clean; `npm run coverage` floors hold; `npm run mutation` above floor
    (M4 killed); branch pushed; PR opened; ship report written.
  - Verify: `npm test && npm run check && npm run lint && npm run build`; then coverage,
    mutation; `git status` clean.
  - Files: none (verification only)
