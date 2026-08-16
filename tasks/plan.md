# Implementation Plan: Refuse preamble definitions that shadow a host-tool name (#54)

## Overview

Stop a trusted project's preamble from silently replacing a host tool. The scan reuses
`findShadowingBindings` (#56) and the `ToolStoreOptions.hostToolNames` option; the refusal withholds
the whole preamble and tells the model what to fix, mirroring the shipped #53 pattern. Two code
changes, both small and additive: (1) `loadSavedTools` refuses shadowing files at load time,
(2) `ReplRunner` feeds the live registry's names in and renders the refusal notice.

## Architecture Decisions

- **`refused: RefusedTool[]` on `SavedToolsPreamble`** — `{ file, symbols }` per offending file.
  Non-empty ⇒ `preamble === ""`, `loaded === []`, limits not evaluated (whole-preamble refusal).
  Additive field; the two existing `deepEqual` assertions in `test/toolstore.test.ts` gain
  `refused: []`.
- **Scan in `loadSavedTools`, not `ReplRunner`** — the loader reads each file, so attribution to
  "`x.py` defines `read_file`" is natural there, and #57/#55 reuse the same loader.
- **Reserved names via the existing `ToolStoreOptions.hostToolNames`** — same list, second gate.
  Its JSDoc widens from "save_tool refuses…" to both write- and load-time.
- **`ReplRunner.createSession` passes `registry.list().map(t => t.name)`** — the live registry,
  never a hardcoded list (issue test 5).
- **Refusal notice** `[preamble refused]` — one-shot via `LiveSession.notice`, names every
  offending file and symbol, states nothing loaded, says what to fix. Sibling of
  `untrustedNotice`/`limitNotice`.

## Task List

### Phase 1: Loader refusal
- [ ] Task 1: `loadSavedTools` refuses shadowing preambles + loader tests
  (toolstore.ts, index.ts, toolstore.test.ts)

### Phase 2: Runner wiring
- [ ] Task 2: `ReplRunner` wires the live registry names and renders the refusal notice
  + runner tests (repl.ts, repl.test.ts)

### Phase 3: Record, verify
- [ ] Task 3: record the namespace question on #40; full suite + check + lint + commit

### Checkpoints

#### Checkpoint: after Task 2
- [ ] All five issue tests pass (loader-level and runner-level)
- [ ] `npx tsx --test test/toolstore.test.ts test/repl.test.ts` green; `npm run check` clean

#### Checkpoint: complete
- [ ] `npm test` green; `npm run check` clean; `npm run lint` clean
- [ ] Namespace question recorded on #40
- [ ] All increments committed; working tree clean

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Detector misses a binding form (false negative) | Med | Best-effort by documented contract (#56); the namespace fix on #40 is the structural answer |
| Detector over-refuses (false positive, e.g. a string containing `def read_file` at line start) | Low (UX) | Conservative direction is the safe one; false positives refuse loudly, never silently execute |
| Refusal leaves a trusted project without its benign tools | Med | Whole-refusal is the issue's explicit demand; the notice says so and names the fix |
| New `refused` field breaks existing full-object assertions | Low | Only two `deepEqual` assertions; updated in Task 1 (additive change) |
| Registry names drift from a hardcoded list | Med | Names come from `registry.list()`; a future registry change is automatically covered |
| Notice not read (one-shot) | Low | Same mechanism and one-shot contract as #53's withheld notice |

## Open Questions

None blocking. #55 (unreadable entries) and #57 (registration) remain out of scope.
