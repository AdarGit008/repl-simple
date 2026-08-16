# Tasks — Refuse preamble definitions that shadow a host-tool name (#54)

- [x] Task 1: `loadSavedTools` refuses shadowing preambles + loader tests
  - Acceptance: `SavedToolsPreamble.refused: RefusedTool[]` exists (exported); a tool whose code
    binds a name in `hostToolNames` is refused with `{ file: "x.py", symbols: [...] }`; whole
    preamble refused (`preamble ""`, `loaded []`, `skipped []`); all five binding forms caught via
    the loader; non-host names load normally; no `hostToolNames` ⇒ no check; existing full-object
    `deepEqual` assertions updated for `refused: []`.
  - Verify: `npx tsx --test test/toolstore.test.ts`; `npm run check`.
  - Files: `src/toolstore.ts`, `src/index.ts`, `test/toolstore.test.ts`

- [x] Task 2: `ReplRunner` wires live registry names + refusal notice + runner tests
  - Acceptance: trusted session whose preamble shadows `read_file` injects none of it (the real
    jailed `read_file` still resolves); the one-shot notice starts `[preamble refused]`, names the
    file and symbol, and says nothing loaded; benign tools still load in a trusted project
    (regression); a name that is not in the registry loads normally (issue test 3 end-to-end).
  - Verify: `npx tsx --test test/repl.test.ts`; `npm run check`.
  - Files: `src/repl.ts`, `test/repl.test.ts`

- [x] Task 3: record the namespace question on #40; full suite + check + lint + commit
  - Acceptance: a comment on issue #40 records the namespace-isolation question; `npm test`
    green; `npm run check` clean; `npm run lint` clean; each increment committed; tree clean.
  - Verify: `npm test && npm run check && npm run lint`; `gh issue view 40 --comments`.
  - Files: none (verification + GitHub comment only)

- [x] Task 4: review remediation (code-reviewer, security-auditor, test-engineer findings)
  - Acceptance: the HIGH universal-newline bypass is closed (detector splits on `\r`/`\r\n` and
    joins backslash continuations); for-tuple and parenthesized/starred targets are caught;
    reads beyond `maxFiles` are gone (no unreadable-entry regression, no unbounded I/O); notice
    filenames are control-character-escaped and the recovery wording is truthful; trust-change
    after refusal and fix-then-new-session paths are pinned by tests; SPEC/todo record the
    remediation.
  - Verify: `npm test && npm run check && npm run lint && npm run build`.
  - Files: `src/toolstore.ts`, `src/repl.ts`, `test/toolstore.test.ts`, `test/repl.test.ts`,
    `SPEC.md`, `tasks/todo.md`
