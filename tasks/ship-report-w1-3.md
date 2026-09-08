# Ship Report — W1-3: Extension boundary — approval cap, lifecycle handlers, patch helper (#35, #60, #178)

Branch: `chunk/w1-3-extension-boundary` · Base: `main` (`3770e46`) · Spec: `tasks/spec-w1-3.md` (D81–D88) · Decision: **GO**

## What was built

All behaviour lives in `extensions/repl-extension.ts`; `src/` is untouched.

1. **#35 — approval-dialog cap and "Deny remaining"** (decision 3; D81–D84).
   `makeOnApproval` (`extensions/repl-extension.ts:333`) now mints an `ApprovalGate` per `repl` /
   `repl_resume` call. Only dialogs actually opened count (`opened++` at `:379`, after the `hasUI` /
   yolo / aborted short-circuits); at `MAX_DIALOGS_PER_CALL = 8` (`:70`) a further gated call latches
   the gate (`:373`) and is denied without a dialog. A fourth answer, `DENY_REMAINING_CHOICE` (`:44`),
   is offered last and latches the gate on the user's say-so (`:390`). The dialog title carries the
   position (`dialog k of 8`, `:381`). When the cap or the latch denied anything, the tool result ends
   with an `[approval cap]` / `[approvals denied]` paragraph (`withApprovalNotice`, `:267`, applied at
   both `execute()` sites). `ApprovalDecision`, `Session.makeApprovalGate` and the `PermissionError`
   text are unchanged; the sandbox still sees plain denials. The pre-existing `/repl-approvals yolo`
   command is unchanged.
2. **#60 — sessions belong to one Pi conversation** (decision 18; D85–D87). Runners are keyed by
   `ctx.cwd` in a `Map<string, CwdRunner>` (`CwdRunner` at `:228`: the `ReplRunner`, its per-cwd trust
   cell, and the session ids it was handed). `pi.on("session_start")` (`:470`) prepares the runner
   for `ctx.cwd` and runs nothing; `pi.on("session_shutdown")` (`:478`) abandons and resets every
   session, reports each dropped suspension with `ctx.ui.notify(…, "warning")` naming the session id
   only, and clears the map — idempotent by construction. The `repl` description states that the
   `sessionId` is scoped to the Pi session (`:529`). `ReplExtensionApi` gains `on`.
3. **#178 — `withPatchedPrototype`** (D88). `test/support/prototype-patch.ts` restores in `finally`
   and documents the sequential assumption; applied at both `test/extension.test.ts` sites (`:414`,
   `:1310`). Not applied in `test/session.test.ts` (W1-2's file; W3-2 does that).
4. **Docs.** `README.md`: "three answers" → four, a dialog-cap paragraph, and a session-scoping
   paragraph in the pool section. `docs/approval-grants.md`: four options, a "Dialog cap" section,
   #35 removed from "What this does not fix". `archive/actionable-items.md`: A7 `[H34]` resolved.

## Verification evidence

- **Gates** — `npm run check` clean; `npm run lint` clean (55 files); `REQUIRE_BRIDGE_TOOLS=1 npm run
  test:contained` — **1140 tests, 1139 pass, 0 fail, 1 todo**, 262 suites, 42.1 s, no OOM;
  `npm run coverage` — "All per-file floors met", `extensions/repl-extension.ts` **99.85 %** against
  its 99.73 floor (`coverage-baseline.json` untouched).
- **RED → GREEN.** Commit `d103d3d` (RED) adds fourteen tests; run against main's
  `extensions/repl-extension.ts` (verified by stashing the extension: 47 pass / **14 fail**), they
  fail for the intended reasons — 50 dialogs where the cap allows 8, three options where four are
  pinned, `range(NaN)` from the undefined constant, `'A'` leaking across cwds, no lifecycle handler
  registered, the scoping sentence absent. Commit `ad3e6e7` (GREEN) turns them green: the extension
  file reports **61 pass / 0 fail / 1 todo** (48 pre-existing tests unchanged in outcome; the
  three-option pin at the old `:1027` became the four-option pin).
- **#35 tests** (`test/extension.test.ts`): 50 gated calls open exactly 8 dialogs, 8 files written and
  42 absent, result names the cap and the count, and yolo opens nothing (`:1523`); "Deny remaining"
  opens one dialog and denies 49 (`:1569`); exactly 8 is not capped and the ninth is, with a replayed
  seed call spending nothing (`:1593`, the stryker boundary pin); an abort at the first dialog ends
  the sequence with no cap notice (`:1645`); the count restarts on `repl_resume` — 8 + 3 dialogs, no
  cap (`:1683`); `repl_resume` is capped on its own count and says so (`:1722`); the dialog offers
  four answers in order and the title carries `(dialog 1 of 8)` (`:1063`). The pre-existing
  `hasUI=false`, no-`onApproval`, abort and timeout pins are unchanged and green.
- **#60 tests**: no leak across a shutdown/start cycle (`:1820`); shutdown idempotent (`:1843`); two
  cwds, two runners — write lands under B, not A (`:1865`); old conversation's suspension not
  resumable (`:1894`); shutdown reports the pending session and only it, with no arguments (`:1922`);
  description pinned (`:1950`); `session_start` runs no preamble, trusted or not (`:1960`). Issue
  test 3 (cwd change mid-session) dropped: `ctx.cwd` is immutable per Pi session (pi 0.84.1
  `runner.js:154`, `:476-478`).
- **Adversarial probes, reproducible by a reviewer.** (a) `git diff main -- extensions/` and grep for
  an "approve all" / "always allow" / remembered-grant affordance: none — the only new choice denies,
  and `DEFAULT_GRANT_USES` is untouched. (b) A script that catches `PermissionError` and loops 50
  times opens at most 8 dialogs: `:1523` (the loop is `gatedLoop` at `:1479`). (c) Nothing registered
  on `session_start` can run a preamble before `isProjectTrusted` is consulted: `:1960` fires the
  handler over a hostile `.pi/code-tools/hostile.py` under both trust values and asserts the file it
  would write is absent and no dialog opened; the handler body is `getRunner(ctx)`, which constructs
  a `ReplRunner` and creates no session.

## Residuals as todo tests

- `test/extension.test.ts:1998` — *the shutdown report names the tool that was waiting, not only the
  session.* `ReplRunner.abandon` answers only an outcome, and `src/repl.ts` is W1-2's file this wave.
  Intended approach: return the dropped `ApprovalRequest`'s tool name alongside the outcome (the name,
  never the arguments) and interpolate it.

Not recorded as todo tests, deliberately: the brief's optional end-to-end `while True` pin through
`repl.execute` (the property is already pinned at `test/sandbox.test.ts:2323-2328`, and a copy here
would be green against main, which the RED rule forbids); a self-test of `withPatchedPrototype` (same
reason).

## Closing-comment drafts (for the orchestrator, after merge)

**#35** — Closed by W1-3 (`extensions/repl-extension.ts`). N = 8 dialogs actually opened per `repl` /
`repl_resume` call (`MAX_DIALOGS_PER_CALL`, rationale in its docblock and `docs/approval-grants.md`
§ "Dialog cap"); yolo, headless, aborted and replayed calls do not count; the count restarts on
`repl_resume`. Fourth dialog answer "Deny remaining" latches the call. The cancel path is #33's signal
(already handed to the dialog by #49). The result names the cap / deny-all as the cause. Tests 1–5:
`test/extension.test.ts:1523` (50 calls → 8 dialogs), `:1569` (deny remaining → 1 dialog), `:1523`
and `:1593` (result names the cap), `:1645` (abort stops the sequence), and the unchanged
fail-closed pins (`hasUI=false`, no `onApproval`). No approval-widening affordance was added.

**#60** — Closed by W1-3. `session_start` and an idempotent `session_shutdown` are registered
(`extensions/repl-extension.ts:470`, `:478`); the runner is keyed by `ctx.cwd`; a pending suspension is
reported as dropped on shutdown; the `repl` description says `sessionId` is scoped to the Pi session.
Tests: `test/extension.test.ts:1820` (1), `:1843` (2), `:1865` (3, replaced — `ctx.cwd` is immutable
per session, `runner.js:154`/`:476-478`), `:1894` and `:1950` (4), `:1922` (5). Residual: the report
names the session, not the tool (`:1998`, todo).

**#178** — Closed by W1-3. `withPatchedPrototype` in `test/support/prototype-patch.ts:24` with the
sequential-assumption comment; applied at `test/extension.test.ts:414` and `:1310`.
`test/session.test.ts:409-419` is left for W3-2.

## Rollback plan

| Commit | Reverts |
|---|---|
| `44fe103` | todo test (test-only) |
| `c0749d8` | README / docs / archive prose |
| `ad3e6e7` | GREEN — cap, deny remaining, lifecycle handlers, cwd-keyed runners |
| `d103d3d` | RED tests (revert together with `ad3e6e7`, or the suite goes red) |
| `fbde352` | `withPatchedPrototype` extraction (test-only, green refactor) |
| `f1981b4` | spec |

`git revert 44fe103 c0749d8 ad3e6e7 d103d3d fbde352 f1981b4` (newest first) returns to `3770e46`.

## Go / No-Go

**GO.** Extension-only; no change to `src/`, to the approval decision type, or to the fail-closed
paths; the only new dialog answer reduces what runs. All four gates green; the extension file stays
at or above its 99.73 floor; one residual, recorded as a todo test.
