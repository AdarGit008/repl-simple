# Tasks — Register the toolstore tools (#57)

- [x] Task 1: `TOOLSTORE_TOOL_NAMES` + `PreambleStatus` type + `preambleStatus` option
  - Acceptance: const exported and equal to the four names `createToolStoreTools` returns (pinned by test); `ToolStoreOptions.preambleStatus?: PreambleStatus`; type exported from `src/index.ts`.
  - Verify: `npx tsx --test test/toolstore.test.ts`; `npm run check`.
  - Files: `src/toolstore.ts`, `src/index.ts`, `test/toolstore.test.ts`

- [x] Task 2: `list_saved_tools` reports loaded state
  - Acceptance: with `preambleStatus`, output is the sorted union of disk + loaded names, plain for loaded, `[not loaded: …]` per category, `[loaded in this session — file deleted; gone from new sessions]` for deleted-but-loaded; `(no saved tools)` when empty; without the option, output unchanged.
  - Verify: new unit tests red→green; `npx tsx --test test/toolstore.test.ts`; `npm run check`.
  - Files: `src/toolstore.ts`, `test/toolstore.test.ts`

- [x] Task 3: `read_tool` honesty + non-regular-file refusal
  - Acceptance: `lstat` first — non-regular file → `OSError` refusal (never a read); untrusted → `PermissionError` refusal with no read; refused/skipped/unreadable → source with `# NOTE: not loaded in this session …` header; loaded/plain/missing unchanged.
  - Verify: new unit tests red→green; `npx tsx --test test/toolstore.test.ts`; `npm run check`.
  - Files: `src/toolstore.ts`, `test/toolstore.test.ts`

- [x] Task 4: `save_tool` / `delete_tool` honest messages
  - Acceptance: save → "loads in new sessions — the current session's preamble is unchanged"; delete → "gone from new sessions; the current session keeps any copy it loaded". Existing `includes`-based assertions keep passing.
  - Verify: updated unit tests red→green; focused test; `npm run check`.
  - Files: `src/toolstore.ts`, `test/toolstore.test.ts`

- [x] Task 5: register the tools in `createSession` with live `hostToolNames` + `PreambleStatus`
  - Acceptance: all four tools resolve inside `repl` in a trusted session; load-time `hostToolNames` includes bridge+builtin+toolstore names; `PreambleStatus` built from the load outcome (or from `savedToolNames` when untrusted).
  - Verify: new integration tests red→green; `npx tsx --test test/repl.test.ts`; `npm run check`.
  - Files: `src/repl.ts`, `test/repl.test.ts`

- [x] Task 6: notice text updates (untrusted / refusal)
  - Acceptance: `[preamble withheld]` notice keeps the NameError sentence and gains `list_saved_tools()`/`read_tool()` guidance; `[preamble refused]` notice points at `read_tool()`/`delete_tool()`; existing prefix/NameError assertions still pass.
  - Verify: updated notice assertions; `npx tsx --test test/repl.test.ts`; `npm run check`.
  - Files: `src/repl.ts`, `test/repl.test.ts`

- [x] Task 7: end-to-end integration tests — list honesty, delete→new session, save_tool gate
  - Acceptance: `list_saved_tools()` inside `repl` annotates withheld/refused/unreadable exactly as executed; delete→list→read→new-session flow demonstrated; `save_tool` denies with no file written and refuses shadowing code against live host names.
  - Verify: new integration tests red→green; `npx tsx --test test/repl.test.ts`; `npm run check`.
  - Files: `test/repl.test.ts`

- [x] Task 8: README + docs/project-trust.md
  - Acceptance: README toolstore section states the tools resolve in every session, lists load honesty, save_tool gating; project-trust.md "What this does not cover" no longer claims `save_tool` is ungated or that `list_saved_tools` misleads in untrusted projects.
  - Verify: read-through; `npm run lint`.
  - Files: `README.md`, `docs/project-trust.md`

- [x] Task 9: live trust callback — tools follow inert trust flips
  - Acceptance: `ToolStoreOptions.isTrusted` consulted by `read_tool` refusal and the list's withheld bucket; trusted→untrusted (no preamble) refuses reads, untrusted→trusted stops refusing; rebuild path pinned.
  - Verify: integration tests red→green; `npx tsx --test test/repl.test.ts`; `npm run check`; `npm run lint` (exit code).
  - Files: `src/toolstore.ts`, `src/repl.ts`, `test/repl.test.ts`, `test/toolstore.test.ts`

- [x] Task 10: filename escaping — no forged annotations
  - Acceptance: `escapeNoticeName` exported from toolstore (C0/DEL/C1/bidi); applied to list names, untrusted/limit notices; non-identifier names rendered quoted.
  - Verify: unit tests red→green; focused test; check; lint.
  - Files: `src/toolstore.ts`, `src/repl.ts`, `test/toolstore.test.ts`, `test/repl.test.ts`

- [x] Task 11: read_tool fd-open — close the TOCTOU
  - Acceptance: single open with `O_NOFOLLOW|O_NONBLOCK`, `fstat` on fd, trust refusal before open; FIFO/symlink/dir refused without a read; loader read uses the same fd pattern.
  - Verify: unit tests red→green (FIFO refusal, symlink refusal); focused test; check; lint.
  - Files: `src/toolstore.ts`, `test/toolstore.test.ts`

- [x] Task 12: content identity — a changed file is not "loaded"
  - Acceptance: loader records size+mtime per loaded file; `read_tool`/`list_saved_tools` annotate changed-but-loaded files (`the session runs the earlier copy`).
  - Verify: unit tests red→green; focused test; check; lint.
  - Files: `src/toolstore.ts`, `src/repl.ts`, `test/toolstore.test.ts`

- [x] Task 13: toolsDir containment — refuse a symlinked tools dir
  - Acceptance: save/delete/list/read resolve the real tools dir and throw PermissionError when it escapes the real root; normal dirs unaffected.
  - Verify: unit tests red→green (symlinked dir for each tool); focused test; check; lint.
  - Files: `src/toolstore.ts`, `test/toolstore.test.ts`

- [x] Task 14: shadowing detector — walrus + module metaprogramming
  - Acceptance: walrus targets recorded; top-level `exec`/`eval`/`globals()`/`vars()`/`__dict__[`/`setattr(`/`import *` refuse all reserved names; consumer wording "defines" → "binds"; JSDoc corrected.
  - Verify: unit + load-time integration tests red→green; focused test; check; lint.
  - Files: `src/toolstore.ts`, `src/repl.ts`, `test/toolstore.test.ts`, `test/repl.test.ts`

- [x] Task 15: wording — "new sessionId", sessions-created-after
  - Acceptance: notices say `repl` with a new `sessionId`; save/delete messages say "sessions created after this one"; a doc note that tool results are cached snapshots.
  - Verify: updated assertions; focused tests; check; lint.
  - Files: `src/repl.ts`, `src/toolstore.ts`, `test/repl.test.ts`, `test/toolstore.test.ts`

- [x] Task 16: remaining integration gaps + full verification
  - Acceptance: limits-skip integration test; untrusted read-refusal + delete via repl; `npm test`, `npm run check`, `npm run build`, `npm run lint` all clean (exit codes verified).
  - Verify: full suite; check; build; lint.
  - Files: `test/repl.test.ts`
