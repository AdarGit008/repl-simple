# Implementation Plan: Register the toolstore tools (#57)

## Overview

Register `createToolStoreTools` in `ReplRunner.createSession` so the model can inspect and remove
the preamble that auto-executes before its code. Make `list_saved_tools` / `read_tool` honest about
what the session actually loaded (withheld #53, refused #54, skipped/unreadable #55), and wire the
live registry's names into the #54/#56 shadowing gates. Source of truth: `SPEC.md`.

## Architecture Decisions

- **Order in `createSession`:** build bridge+builtin registry → compute `hostToolNames` (live
  registry + `TOOLSTORE_TOOL_NAMES`) → load preamble (trusted) or read names (untrusted) → build
  `PreambleStatus` from the outcome → create toolstore tools with `hostToolNames` + `preambleStatus`
  → add to registry. The toolstore's own names must be in the load-time list *before* the tools
  exist (a preamble `def save_tool` would shadow the registered tool).
- **Static snapshot, honest messages.** `PreambleStatus` is a per-session snapshot (5 sets +
  `trusted` flag). The tools derive every answer from it plus the current disk state; nothing
  mutable is tracked, and the save/delete messages carry the "new sessions" semantics.
- **Additive, back-compatible.** `preambleStatus?` on `ToolStoreOptions`; absent → today's behavior.
  Existing tests must pass untouched.

## Task List

### Phase 1: Toolstore foundation (unit-tested)

- [ ] Task 1: `TOOLSTORE_TOOL_NAMES` + `PreambleStatus` type + `preambleStatus` option
  - Acceptance: const exported and equal to the four names `createToolStoreTools` returns (pinned by
    test); `ToolStoreOptions.preambleStatus?: PreambleStatus`; type exported from `src/index.ts`.
  - Verify: `npx tsx --test test/toolstore.test.ts`; `npm run check`.
  - Files: `src/toolstore.ts`, `src/index.ts`, `test/toolstore.test.ts`

- [ ] Task 2: `list_saved_tools` reports loaded state
  - Acceptance: with `preambleStatus`, output is the sorted union of disk + loaded names, plain for
    loaded, `[not loaded: …]` per category (withheld / limit / refused / refused-whole / unreadable /
    saved-after-start), `[loaded in this session — file deleted; gone from new sessions]` for
    deleted-but-loaded; `(no saved tools)` when empty; without the option, output unchanged.
  - Verify: new unit tests red→green; `npx tsx --test test/toolstore.test.ts`; `npm run check`.
  - Files: `src/toolstore.ts`, `test/toolstore.test.ts`

- [ ] Task 3: `read_tool` honesty + non-regular-file refusal
  - Acceptance: `lstat` first — non-regular file → `OSError` refusal (never a read); untrusted →
    `PermissionError` refusal with no read; refused/skipped/unreadable → source with
    `# NOTE: not loaded in this session …` header; loaded/plain/missing unchanged.
  - Verify: new unit tests red→green; `npx tsx --test test/toolstore.test.ts`; `npm run check`.
  - Files: `src/toolstore.ts`, `test/toolstore.test.ts`

- [ ] Task 4: `save_tool` / `delete_tool` honest messages
  - Acceptance: save → "loads in new sessions — the current session's preamble is unchanged";
    delete → "gone from new sessions; the current session keeps any copy it loaded". Existing
    `includes`-based assertions keep passing.
  - Verify: updated unit tests red→green; focused test; `npm run check`.
  - Files: `src/toolstore.ts`, `test/toolstore.test.ts`

### Checkpoint: Foundation
- [ ] `npx tsx --test test/toolstore.test.ts` green; `npm run check` clean

### Phase 2: ReplRunner wiring (integration-tested)

- [ ] Task 5: register the tools in `createSession` with live `hostToolNames` + `PreambleStatus`
  - Acceptance: all four tools resolve inside `repl` in a trusted session (list/read/delete/save
    work); load-time `hostToolNames` includes bridge+builtin+toolstore names; `PreambleStatus` built
    from the load outcome (or from `savedToolNames` when untrusted).
  - Verify: new integration tests red→green; `npx tsx --test test/repl.test.ts`; `npm run check`.
  - Files: `src/repl.ts`, `test/repl.test.ts`

- [ ] Task 6: notice text updates (untrusted / refusal)
  - Acceptance: `[preamble withheld]` notice keeps the NameError sentence and gains
    `list_saved_tools()`/`read_tool()` guidance; `[preamble refused]` notice points at
    `read_tool()`/`delete_tool()`; existing `/^\[preamble (withheld|refused)\]` and `/NameError/`
    assertions still pass.
  - Verify: updated notice assertions; `npx tsx --test test/repl.test.ts`; `npm run check`.
  - Files: `src/repl.ts`, `test/repl.test.ts`

- [ ] Task 7: end-to-end integration tests — list honesty, delete→new session, save_tool gate
  - Acceptance: `list_saved_tools()` inside `repl` annotates withheld/refused/unreadable exactly as
    executed; delete→list→read→new-session flow demonstrated; `save_tool` denies with no file
    written and refuses shadowing code against live host names.
  - Verify: new integration tests red→green; `npx tsx --test test/repl.test.ts`; `npm run check`.
  - Files: `test/repl.test.ts`

### Checkpoint: Wiring
- [ ] `npx tsx --test test/repl.test.ts` green; `npm run check` clean

### Phase 3: Docs

- [ ] Task 8: README + docs/project-trust.md
  - Acceptance: README toolstore section states the tools resolve in every session, lists load
    honesty, save_tool gating; project-trust.md "What this does not cover" no longer claims
    `save_tool` is ungated or that `list_saved_tools` misleads in untrusted projects.
  - Verify: read-through; `npm run lint`.
  - Files: `README.md`, `docs/project-trust.md`

### Checkpoint: Complete
- [ ] `npm test` green; `npm run check` clean; `npm run lint` clean
- [ ] All five issue tests exist and pass; README accurate
- [ ] Ready for review (Phase 5)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Notice text changes break extension/repl tests | Med | Existing tests assert prefixes and `/NameError/` only — verified by grep before editing; full suite after Task 6 |
| `read_tool` exposes the FIFO-hang / symlink-escape hazards | High | `lstat` refusal before any read (Task 3), unit-tested |
| Registering tools changes type-stub surface inside `repl` | Low | Stubs render from the same `ToolRegistry`; existing sandbox tests cover stub rendering |
| List format drift between spec and implementation | Med | Format pinned by unit tests per category |

## Open Questions

None blocking — see SPEC.md "Assumptions".
