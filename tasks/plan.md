# Implementation Plan: One unreadable entry must not break `repl` (#55)

## Overview

Stop a single unreadable or non-regular `.py` entry under `.pi/code-tools` from bricking every
`repl` call in the project. Two code changes, both small and additive: (1) `loadSavedTools`
gates each entry with `lstat` (regular files only) and wraps the per-entry read, reporting
failures in a new `unreadable` field instead of throwing; (2) `ReplRunner` renders a
`[preamble unreadable]` notice from that field, alongside the existing `limitNotice` and
`refusalNotice`. The session is then always created — recoverable by deleting the bad entry
and starting a new session, no restart.

## Architecture Decisions

- **`unreadable: UnreadableTool[]` on `SavedToolsPreamble`** — `{ file, reason }` per entry:
  `"not a regular file"` for anything `lstat` reports non-regular (directory, FIFO, socket,
  symlink — working or broken), the error message for `lstat`/`readFile` failures (TOCTOU,
  permissions). Additive field; the two existing full-object `deepEqual` assertions in
  `test/toolstore.test.ts` gain `unreadable: []`.
- **`lstat` decides, not exceptions** — the "skip anything that is not a regular file" the
  issue demands is enforced up front. Symlinks never load: a preamble is auto-executed code,
  and a link can point outside the project root. Working symlinks are refused too — one rule.
- **Per-entry `readFile` guard** — TOCTOU (deleted/swapped between `readdir` and `readFile`)
  and permission errors become `unreadable` entries, never throws.
- **Caps and scanning interplay** — unreadable entries consume no `maxFiles` slot, add no
  bytes, and are never scanned (code that cannot load cannot shadow). Entries beyond
  `maxFiles` are neither stat'd nor read — the #54 invariant extends to `lstat`.
- **Refusal (#54) still wins, but reports everything** — an unreadable entry alone never
  refuses the batch; when a shadowing file refuses it, the refusal result still carries the
  `unreadable` entries from the same pass, and the notices compose.
- **`savedToolNames` untouched** — name-only contract (#53); the stat gate lives in the loader.
- **Notice** `[preamble unreadable]` — one-shot via `LiveSession.notice`, names
  control-character-escaped (`escapeNoticeName`), says files are not defined → `NameError`,
  fix/remove + **new session** (a live session's preamble is fixed at creation).

## Task List

### Phase 1: Loader resilience
- [x] Task 1: `loadSavedTools` skips unreadable entries + loader tests
  (toolstore.ts, index.ts, toolstore.test.ts)

### Checkpoint: Loader
- [x] `npx tsx --test test/toolstore.test.ts` green; `npm run check` clean

### Phase 2: Runner wiring
- [x] Task 2: `ReplRunner` renders the unreadable notice + runner tests
  (repl.ts, repl.test.ts)

### Checkpoint: Runner
- [x] `npx tsx --test test/repl.test.ts` green; `npm run check` clean

### Phase 3: Verify and record
- [x] Task 3: full suite + check + lint + build; commit

### Checkpoint: Complete
- [x] `npm test && npm run check && npm run lint && npm run build` all green; tree clean

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Platform variance (FIFO/symlink/`chmod 000` tests) | Med | Skip guards: win32 for symlink+FIFO, `getuid()===0` for permissions — matches existing repo patterns |
| TOCTOU between stat and read | Med | Both `lstat` and `readFile` wrapped; a swapped entry becomes `unreadable`, never a throw |
| Symlink policy change surprises a real workflow | Low | Recorded in spec assumptions; `save_tool` only writes regular files, so the loader's own tools are unaffected |
| `deepEqual` churn from the new field | Low | Grep-driven: every full-object `SavedToolsPreamble` assertion updated in Task 1's RED step |
| Notice wording lies about a reason | Med | "could not be read" is true for every reason; reasons stay on the struct |

## Open Questions

None. Scope boundary with #57 (toolstore registration) and #40 (namespace) recorded in the spec.
