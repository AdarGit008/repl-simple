# Tasks — One unreadable entry must not break `repl` (#55)

- [x] Task 1: `loadSavedTools` skips unreadable entries + loader tests
  - Acceptance: `UnreadableTool` exported (`{ file, reason }`); `SavedToolsPreamble.unreadable`
    exists; a directory named `dir.py` is skipped with reason `"not a regular file"` and the
    call succeeds (issue test 1 at loader level); other entries still load (issue test 2); a
    broken symlink and a FIFO are skipped, not fatal (issue test 5); a `chmod 0o000` file is
    skipped with the error message as reason; unreadable entries consume no `maxFiles` slot;
    entries beyond `maxFiles` are neither stat'd nor read (stay `skipped`); a refusal still
    reports `unreadable` from the same pass; removal of the bad entry loads normally on the
    next call (issue test 4 at loader level); the two full-object `deepEqual` assertions gain
    `unreadable: []`.
  - Verify: `npx tsx --test test/toolstore.test.ts`; `npm run check`.
  - Files: `src/toolstore.ts`, `src/index.ts`, `test/toolstore.test.ts`

- [x] Task 2: `ReplRunner` wires the unreadable notice + runner tests
  - Acceptance: a trusted session with `dir.py` beside a good tool runs `1 + 1` to `[result]`
    and the good tool resolves — the exact reproduction, fixed end to end (issue tests 1-2);
    the one-shot notice starts `[preamble unreadable]`, names `dir.py`, says `NameError`, and
    appears on the first call only (issue test 3); after removing `dir.py`, a new session
    loads the tools normally with no notice — no restart (issue test 4); the session that
    skipped the entry keeps working.
  - Verify: `npx tsx --test test/repl.test.ts`; `npm run check`.
  - Files: `src/repl.ts`, `test/repl.test.ts`

- [x] Task 3: full suite + check + lint + build; commit
  - Acceptance: `npm test` green; `npm run check` clean; `npm run lint` clean;
    `npm run build` clean; each increment committed; tree clean.
  - Verify: `npm test && npm run check && npm run lint && npm run build`.
  - Files: none (verification only)
