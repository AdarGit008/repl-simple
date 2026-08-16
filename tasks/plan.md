# Implementation Plan: Restore the unconditional `context` input (#72)

## Overview

Two small, additive changes to `src/rlm.ts`, each driven by its own RED→GREEN pair in
`test/rlm.test.ts`: (1) `runRlm` always builds a merged inputs map whose `context` defaults to
`""`, so the shipped `repl_server.py` preamble type-checks with no caller inputs; (2)
`buildInitialPrompt` announces every input key instead of only `context`. The five issue tests
plus a preview-truncation pin land first (RED), then the two fixes (GREEN), in four commits.

## Architecture Decisions

- **Merge site in `runRlm`** — `{ ...runOptions.inputs, ...options.inputs }`, then
  `context = merged.context ?? ""`. Today's precedence survives; the declaration path
  (`buildTypeCheckStubs` → input names, `feedStart` → values) is already correct and untouched.
- **`buildInitialPrompt(question, inputs)`** — signature change from `(question, context?)`;
  private, so no API surface moves. Iterates the merged map: `context` keeps its legacy header
  and the 5000-char head/tail preview; other keys use `# Input (available as \`name\`)` with
  the same preview treatment; empty values are header-only.
- **Tests are medium, real-sandbox** — the mutation M4 cuts exactly the inputs-forwarding line,
  so only tests that read inputs in a real worker kill it; canned-LLM mocks keep determinism.
- **`REPL_SERVER` load** — `readFileSync` against `repl/repl_server.py`, mirroring
  `test/repl_server.test.ts`, used by the headline integration test.

## Task List

### Phase 1: Input plumbing
- [x] Task 1: RED — load REPL_SERVER + tests 1, 2, 3, 5
  (test/rlm.test.ts)
- [x] Task 2: GREEN — always declare `context` in `runRlm`
  (src/rlm.ts)

### Checkpoint: Plumbing
- [ ] `npx tsx --test test/rlm.test.ts` green; `npm run check` clean

### Phase 2: Prompt announcement
- [x] Task 3: RED — test 4 (every key named) + preview-truncation pin
  (test/rlm.test.ts)
- [x] Task 4: GREEN — announce every input key in `buildInitialPrompt`
  (src/rlm.ts)

### Checkpoint: Announcement
- [ ] `npx tsx --test test/rlm.test.ts` green; `npm run check` clean

### Phase 3: Verify and record
- [x] Task 5: full suite + check + lint + build + coverage + mutation; commit, push, PR

### Checkpoint: Complete
- [ ] All six gates green; branch pushed; PR opened; ship report written

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| M4 not actually killed (tests bypass the site) | Med | Tests deliberately use **no preamble** so the sandbox value can only arrive via `runOpts.inputs`; verified under the mutation run |
| Coverage floors drop (new branches in `rlm.ts`) | Med | Every new branch has a test: default, caller context, non-context key, empty-value header-only, >5000-char preview |
| Mutation harness cannot run in this environment (systemd scope) | Low | Fall back to a plain `stryker run`; record in the ship report |
| Merge collision with the #57 session owning `main` | Low | Branch-only push + PR; no merge into `main` |
| Prompt change breaks an existing test asserting exact prompt text | Low | Grep shows no test asserts the initial prompt shape; suite re-run confirms |

## Open Questions

None.
