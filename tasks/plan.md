# Implementation Plan: STOP-SHIP A33 → A34 → A35 → A36 → A37

Source of truth: `SPEC.md` (AS1–AS7, per-item success criteria) + `docs/actionable-items.md`.
Stacked in dependency order on branch `stop-ship-a33-a37`.

## Overview

Close the five STOP-SHIP items in strict order. Each is one coder dispatch, one RED→GREEN test, and
one orchestrator commit. A33 first (it changes what `result.stdout` and the abort flag contain, so
every later item's experiments and tests read correct state). A36 step 1 (guard resumes) before step 3
(enable suspend). A37 last (it is the deepest change and depends on the registry/session state being
correct from A33–A36).

## Architecture Decisions

- **D1 — One item = one task = one commit.** No task mixes two STOP-SHIP items. Rollback is per-item.
- **D2 — `DispatchAccumulators` as single mutable owner (A33).** `printCallback` and `onAbort` write
  into the struct; the struct's fields are read everywhere. Delete the now-dead `maxStdout`/
  `printCallback` params and enable `noUnusedParameters` so the next such extraction fails loudly.
- **D3 — Jail-first, gate-second (A35).** Reuse `builtins.read_file`'s `realpath`-checked helper for
  the bridged reads; add `gateReads` to `BridgeOptions`. Gate `http_get` + SSRF defence-in-depth
  (per-hop IP validation, `redirect: "manual"`, timeout).
- **D4 — Default 30 s timeout, plumbed signal (A34).** `toResourceLimits` fills defaults; the signal
  threads extension → `ReplRunner` → `RunOptions.signal`.
- **D5 — Suspension via three-way select, guarded first (A36).** Wrap the three prologue resumes in
  `MontyRuntimeError` catches; catch no-suspension in `ReplRunner.resume`; then enable suspend with
  `ctx.ui.select` (approve/deny/decide-later → `"suspend"`) and widen `Session.resume`'s `decision`.
- **D6 — Approval-gated preamble, hash-keyed (A37).** Per-file content-hash approval with a per-hash
  memory; refuse shadowing host-tool names; `try`-wrap the read loop; cap size/count; `.pi/` in
  `.gitignore`; register `createToolStoreTools`.

## Task List

### Phase 1: Foundation — A33

- [ ] **Task A33** — Fix the `runDispatchLoop` accumulator desync
  - Acceptance: `DispatchAccumulators` single mutable owner; dead `maxStdout`/`printCallback` params
    deleted; `noUnusedParameters` on and `check` clean.
  - Verify: `npm test`, `npm run check`, `npm run build`, `npm run lint`; RED test
    (`print` after a loop-dispatched tool call on both entry points; mid-run abort during async tool)
    fails at HEAD, green after.
  - Files: `src/sandbox.ts`, `test/sandbox.test.ts`, `tsconfig.json`.

### Phase 2: Cancellation — A34

- [ ] **Task A34** — Default timeout + plumb the abort signal
  - Acceptance: `toResourceLimits` defaults (30 s + `maxMemory`); signal threads extension →
    `ReplRunner.run/resume` → `RunOptions.signal`; tool params exposed with caps.
  - Verify: `npm test`, `npm run check`, `npm run build`, `npm run lint`; RED test (`while True: pass`
    → `TimeoutError` `RunError` within default budget, process responsive).
  - Files: `src/sandbox.ts`, `src/repl.ts`, `src/types.ts`, `extensions/repl-extension.ts`,
    `test/repl.test.ts`.
  - Depends on: A33.

### Phase 3: Egress — A35

- [ ] **Task A35** — Close the read and egress surface
  - Acceptance: bridged reads jailed to `cwd` (or gated, `gateReads` option added); `http_get` gated +
    SSRF defences; exfil snippet prompts or fails.
  - Verify: `npm test`, `npm run check`, `npm run build`, `npm run lint`; RED test asserts both halves
    of the exfil chain.
  - Files: `src/bridge.ts`, `src/builtins.ts`, `src/types.ts`, `test/bridge.test.ts` (and/or
    `test/builtins.test.ts`).
  - Depends on: A33 (A34 optional; order fixed by SPEC).

### Phase 4: Suspension — A36

- [ ] **Task A36** — Guard the prologue resumes, then make suspension reachable
  - Acceptance: three prologue resumes wrapped; no-suspension caught in `ReplRunner.resume`;
    three-way `ctx.ui.select` returning `"suspend"`; `Session.resume` `decision` widened; `sessionId`
    named in the suspended branch.
  - Verify: `npm test`, `npm run check`, `npm run build`, `npm run lint`; RED test
    (deny-with-uncaught-`PermissionError` → `RunError`, session usable; suspend→resume→approve round
    trip).
  - Files: `src/sandbox.ts`, `src/session.ts`, `src/repl.ts`, `src/types.ts`,
    `extensions/repl-extension.ts`, `test/repl.test.ts`, `test/session.test.ts`.
  - Depends on: A33 (steps 1–2 independent of 3–4; all in one task, ordered internally).

### Phase 5: Preamble supply chain — A37

- [ ] **Task A37** — Stop auto-executing `.pi/code-tools` unreviewed
  - Acceptance: hash-keyed approval gate; shadowing refused; `createToolStoreTools` registered; read
    loop `try`-wrapped; `.pi/` in `.gitignore`; size/count capped.
  - Verify: `npm test`, `npm run check`, `npm run build`, `npm run lint`; RED test (hostile
    `.pi/code-tools/x.py` does not execute without approval; unreadable entry does not break session).
  - Files: `src/repl.ts`, `src/session.ts`, `src/registry.ts` (and/or `src/toolstore.ts`),
    `src/index.ts`, `.gitignore`, `test/repl.test.ts`.
  - Depends on: A33–A36.

## Checkpoints

### Checkpoint: after A33
- [ ] RED test fails at HEAD, green after; full suite green; `check`/`build`/`lint` clean.

### Checkpoint: after A33 + A34
- [ ] Busy-loop `repl` returns `TimeoutError` `RunError`; process responsive; suite + gates green.

### Checkpoint: after A33–A35
- [ ] Exfil snippet prompts or fails; suite + gates green.

### Checkpoint: after A33–A36
- [ ] Suspend → resume → approve round trip works; deny path returns `RunError`; suite + gates green.

### Checkpoint: complete (after A33–A37)
- [ ] Hostile preamble does not auto-execute; suite + gates + coverage floors green; ready for Phase 4
  verify / Phase 5 review.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Line drift in `docs/actionable-items.md` | Coder mislocates the change | Locate by symbol/context (AS6); coder reads actual files |
| A34 before A33 makes abort dead | Wasted work | Order fixed A33→A34 (AS1) |
| A36 step 3 before step 1 wedges sessions | Data loss | Internal order enforced (AS2) |
| A37 approval UI in headless run | No one to click | Hash-keyed approval defaults to refuse; tests assert no auto-execute (AS5) |
| `noUnusedParameters` flags pre-existing dead params | `check` breaks on unrelated files | Enable after deleting the A33 params; if other files break, scope the fix to silence only truly-dead params or record a follow-up |

## Open Questions

None — ambiguities recorded as SPEC assumptions AS1–AS7.
