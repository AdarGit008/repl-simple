# Spec: STOP-SHIP — A33 → A34 → A35 → A36 → A37

Source of truth for findings: `docs/actionable-items.md` (v2, commit `dfc1136`) and `docs/REVIEW.md`.
Stacked, in this order, on one branch / one PR. These five gate everything: until they land, the
`repl` tool corrupts its own output, cannot be cancelled, and exfiltrates without a prompt.

## Objective

Close the five STOP-SHIP items so the shipped `repl` extension is safe to run against untrusted
input:

- **A33** — the `runDispatchLoop` accumulator desync drops stdout after the first tool call, lies
  about `stdoutTruncated`, and makes mid-run abort a no-op.
- **A34** — `repl` has no default timeout and no plumbed abort signal, so `while True: pass` blocks
  the Node event loop and needs `SIGKILL`.
- **A35** — the bridged read tools (`read`/`grep`/`find`/`ls`) and `http_get` let sandboxed Python
  exfiltrate arbitrary host files with zero prompts.
- **A36** — three unguarded prologue resumes can wedge a session; two of the four shipped tools
  (`repl_abandon`, `repl_resume`) are non-functional because suspension is unreachable.
- **A37** — `.pi/code-tools/**/*.py` is auto-executed as a preamble on every run with full host-tool
  access and no approval; a cloned repo is a code-execution delivery vector.

**Success looks like:** each item's acceptance criteria (below) is met by a RED→GREEN test, the full
suite + static gates are green, and the Phase 6 security audit finds no remaining Critical/High
finding on the five items.

## Assumptions (recorded — autonomous run)

- **AS1 — Order is fixed:** A33 → A34 → A35 → A36 → A37, per `docs/actionable-items.md` "Suggested
  order". A34's abort half is dead until A33 lands (the abort flag is one of the desynced fields), so
  A33 must precede A34.
- **AS2 — A36 internal order:** A36 step 1 (guard the prologue resumes) MUST precede A36 step 3
  (enable suspend) — otherwise we convert a dead code path into a session-wedging one. Steps 1 and 2
  are independent of 3 and 4 and may land first.
- **AS3 — Default timeout is 30 s.** A34 "suggest 30" is taken as the default `maxDurationSecs`.
- **AS4 — A35 strategy is jail-first, gate-second.** Bridged read tools are jailed to `cwd` using the
  existing `realpath`-checked helper (deterministic, no prompt fatigue); `http_get` is gated behind
  approval *and* hardened against SSRF (A45's defence-in-depth). A `gateReads` option is added so
  callers can choose gate-over-jail.
- **AS5 — A37 approval model.** Preamble inclusion is approval-gated per file content-hash (prompt
  once per hash, remember the decision). Default on a fresh clone is refuse: a hostile
  `.pi/code-tools/x.py` must NOT execute without an explicit approval. Host-tool names shadowed by
  preamble definitions are refused. Total preamble size and file count are capped.
- **AS6 — Line numbers are indicative.** `docs/actionable-items.md` line numbers are from commit
  `dfc1136` and may have drifted (a recurring gotcha in this repo). Coders locate by symbol and
  context, not by trusting the printed line.
- **AS7 — `npm test` is the source of truth for the suite.** The repo runs `tsx --test test/*.test.ts`
  via `npm test`; there is no coverage-floor failure unless `npm run coverage` reports a breach.

## Commands

- Full suite: `npm test` (runs `tsx --test test/*.test.ts`)
- Focused test: `npx tsx --test test/<file>.test.ts`
- Build: `npm run build` (`tsc -p tsconfig.build.json`)
- Type check: `npm run check` (`tsc --noEmit`)
- Lint: `npm run lint` (`biome check --error-on-warnings`)
- Coverage: `npm run coverage` (floors enforced by `scripts/coverage.mjs`)

## Project Structure

- `src/sandbox.ts` — the dispatch loop, `DispatchAccumulators`, resource limits, prologue resumes (A33, A34, A36)
- `src/repl.ts` — `ReplRunner`, session creation, the `.pi/code-tools` preamble read (A34, A36, A37)
- `src/session.ts` — session state, approval cache/grants, suspend/resume (A36, A37)
- `src/bridge.ts` — bridged host tools incl. `read`/`grep`/`find`/`ls`, `gateMutating` (A35)
- `src/builtins.ts` — `http_get`, `read_file`, the `realpath` jail helper (A35)
- `src/types.ts` — `RunOptions`, `SessionOptions`, approval/suspension types (A34, A36)
- `src/index.ts` / `src/registry.ts` / `src/toolstore.ts` — registry and tool store wiring (A37)
- `extensions/repl-extension.ts` — the four shipped Pi tools, approval dialog (A34, A36)
- `tsconfig.json` — type-check program, `noUnusedParameters` (A33)
- `.gitignore` — add `.pi/` (A37)
- `test/*.test.ts` — tests; each item adds a RED test in the matching file

## Code Style

Follow existing module conventions exactly. No new abstraction without a third use site. The D64/D17
sentinel and truncation helpers are canonical — reuse, do not re-implement. Type boundaries stay
explicit (no gratuitous `any`/`unknown`/casts). Run `npm run lint` before reporting done.

## Testing Strategy

Node's built-in test runner via `tsx` (`node:test`). Per item, one RED test (or a focused extension of
an existing describe block) that fails at HEAD and passes after the fix:

- A33 → `test/sandbox.test.ts`: `print` after a loop-dispatched tool call, on both entry points;
  abort fired mid-run during an async tool.
- A34 → `test/repl.test.ts` (or `test/sandbox.test.ts`): `repl` with a busy-loop returns a
  `TimeoutError` `RunError` within the default budget and the process stays responsive.
- A35 → `test/bridge.test.ts` / `test/builtins.test.ts`: the exfil snippet (`read('/etc/hostname')`
  + `http_get`) either prompts or fails; assert both halves.
- A36 → `test/repl.test.ts` / `test/session.test.ts`: deny-with-uncaught-`PermissionError` returns a
  `RunError` and leaves the session usable; suspend → resume → approve round trip.
- A37 → `test/repl.test.ts`: a fresh clone with a hostile `.pi/code-tools/x.py` does not execute
  without an explicit approval; an unreadable entry does not break the session.

Every item's fix must be accompanied by a test that fails without it. Full suite + `check` + `build` +
`lint` must be clean after each item; `npm run coverage` floors must hold.

## Boundaries

- **Always:** RED first; run the full suite and static gates before reporting done; reuse canonical
  helpers (`realpath` jail, `truncateText`, the `DispatchAccumulators` struct); one item per dispatch.
- **Ask first (recorded, not asked — autonomous run):** new dependencies; changes to the public
  `RunOptions`/`SessionOptions`/tool type surface that break consumers; touching files outside an
  item's declared file set.
- **Never:** `git add -A`; git commands from coders; touching the two RLM tool paths, the
  `raceAgainstSignal` wrapper, or `docs/`; auto-executing `.pi/code-tools` without approval (that is
  the very bug A37 fixes); deleting the existing jail and replacing it with nothing.

## Success Criteria (per item)

### A33 — accumulator desync
- `DispatchAccumulators` is the single mutable owner: `printCallback` writes `acc.stdout += …` and
  `acc.stdoutTruncated = true`; `onAbort` writes `acc.aborted = true`.
- The now-unused `maxStdout` and `printCallback` parameters at the `runDispatchLoop` signature are
  deleted.
- `noUnusedParameters` is enabled in `tsconfig.json` and `npm run check` stays clean.
- Tests: `print` after a loop-dispatched tool call is preserved on both entry points; a mid-run abort
  during an async tool stops the loop.

### A34 — default timeout + abort plumbing
- `toResourceLimits` defaults `maxDurationSecs` (30) and `maxMemory` when the caller passes none.
- `_signal` threads `extensions/repl-extension.ts` → `ReplRunner.run/resume` → `RunOptions.signal`.
- `maxDurationSecs`/`maxMemory`/`signal` are exposed as `repl` tool parameters with sane caps.
- Tests: `repl` with `while True: pass` returns a `TimeoutError` `RunError` within the default budget;
  the Pi process stays responsive.

### A35 — close the read/egress surface
- Bridged read tools are jailed to `cwd` (same `realpath`-checked helper as `builtins.read_file`), or
  gated; a `gateReads` option is added to `BridgeOptions`.
- `http_get` is gated behind approval or restricted to an explicit allowlist, and hardened with SSRF
  defences (loopback/link-local/RFC1918/`::1`/metadata blocked per hop, `redirect: "manual"`,
  `AbortSignal.timeout`).
- Test: the `read('/etc/hostname')` + `http_get` exfil snippet either prompts or fails; both halves
  asserted.

### A36 — guard resumes, reachable suspension
- The three prologue `snapshot.resume()` calls are wrapped exactly as the shared loop wraps its eleven
  resumes (catch `MontyRuntimeError`).
- `ReplRunner.resume` catches the no-suspension case and returns a friendly string (matching the
  no-session branch).
- `ctx.ui.confirm` is replaced with `ctx.ui.select` offering approve / deny / decide-later, returning
  `"suspend"` for the third; `Session.resume`'s `decision` widens from `boolean`.
- `formatResult`'s suspended branch names the `sessionId`.
- Tests: deny-with-uncaught-`PermissionError` returns a `RunError` and leaves the session usable; a
  full suspend → resume → approve round trip works.

### A37 — no auto-execute of `.pi/code-tools`
- Preamble inclusion is approval-gated per file content-hash (prompt once, remember per hash); a
  hostile file does not execute without explicit approval.
- Preamble definitions that shadow a registered host-tool name are refused.
- `createToolStoreTools` is registered in `repl.ts` so `read_tool`/`delete_tool` are reachable.
- The read loop is wrapped in `try` so one bad entry (e.g. `dir.py`) is skipped, not fatal.
- `.pi/` is added to `.gitignore`; total preamble size and file count are capped.
- Test: fresh clone with hostile `.pi/code-tools/x.py` does not execute without an explicit prompt; an
  unreadable entry does not break the session.

## Non-goals

- The two RLM tool paths, the `raceAgainstSignal` wrapper, and `docs/` — out of scope.
- A4 (approval grants bind to command string, not content), A7 remainder, A45 as a standalone item —
  A35 pulls in only the SSRF defence-in-depth that the egress fix needs.
- Sibling issues outside A33–A37.

## Open Questions

None — all ambiguities recorded as assumptions AS1–AS7 above.
