# Spec: W1-3 — Extension boundary: approval cap, lifecycle handlers, patch helper (#35, #60, #178)

Branch `chunk/w1-3-extension-boundary` · Base `main` = `3770e46` · Decision range **D81–D88**

## Objective

Three extension-boundary changes, all in `extensions/repl-extension.ts` and its test file, with no
change to `src/`:

1. **#35** — bound approval-dialog spam. One `repl` / `repl_resume` call opens at most **8**
   dialogs; a fourth dialog answer, **Deny remaining**, latches the call closed; and the model is
   told, in the tool result, why later gated calls were denied without a dialog. This is the last
   unmet criterion of blocker epic #31.
2. **#60** — sessions belong to one Pi conversation. Register `session_start` and an idempotent
   `session_shutdown`; the shutdown disposes every runner and reports a pending suspension as
   dropped instead of letting it be garbage-collected silently. Key runners by `ctx.cwd`. State in
   the `repl` description that `sessionId` is scoped to the Pi session.
3. **#178** — extract the `ReplRunner.prototype` monkey-patch into `test/support/prototype-patch.ts`
   (`withPatchedPrototype`), apply it at both sites in `test/extension.test.ts`, and document the
   sequential assumption. Not applied in `test/session.test.ts` (W1-2's file).

Binding inputs: `scratchpad/decisions.md` rows 3 and 18; the W1-3 brief; issues #35, #60, #178
(no comments on any of the three).

## Current state (measured at HEAD `3770e46`, 2026-09-08)

- **Approval callback.** `src/sandbox.ts:1045` calls `runOpts.onApproval(req)` once per gated call,
  with no counter; a denial becomes `PermissionError: tool '<name>' requires approval` at `:1071` and
  the dispatch loop `continue`s (`:1076`) — a Python `try/except PermissionError` therefore reaches
  the gate again on the next gated call. That is the fatigue primitive in #35.
- **Dialog.** `extensions/repl-extension.ts:205-245` (`makeOnApproval`) offers exactly
  `[APPROVE_CHOICE, DENY_CHOICE, LATER_CHOICE]` (`:38-40`, `:231`). The closure is minted per
  `execute()` — `:343` (`repl`) and `:373` (`repl_resume`) — so any state inside it is per call.
  The text returned to the model is built at `:347` / `:376` from `ReplRunner.run/resume` only.
- **Cache-served calls never reach the callback.** `Session.makeApprovalGate` (`src/session.ts:674`)
  answers a positional replay before consulting the user callback, so replayed calls are free of
  any counter placed in the extension without further work.
- **Abort.** `src/sandbox.ts:1180-1186` / `:1278-1284` set `acc.aborted` from the signal; the
  dispatch loop checks it at the top of every iteration, so after an abort the next gated call never
  reaches the gate. `makeOnApproval:227` already returns `false` without a dialog for an
  already-aborted signal.
- **Runner lifetime.** `extensions/repl-extension.ts:170` holds one `runner: ReplRunner | null` per
  factory closure; `getRunner` (`:184-188`) constructs it from the first `ctx.cwd` seen and reuses it
  for every later cwd. No `pi.on(...)` handler is registered anywhere; `ReplExtensionApi`
  (`:140-152`) has no `on`.
- **Pi 0.84.1 lifecycle (node_modules/@earendil-works/pi-coding-agent).**
  `dist/core/extensions/types.d.ts:416-421` (`SessionStartEvent`, reason
  `startup|reload|new|resume|fork`), `:464-469` (`SessionShutdownEvent`, reason
  `quit|reload|new|resume|fork`), `:862` (`ExtensionHandler<E>` = `(event, ctx: ExtensionContext)`),
  `:869` / `:875` (the two `on` overloads), `:209-249` (`ExtensionContext` carries `cwd`, `hasUI`,
  `ui.notify`, `isProjectTrusted()`). `dist/core/agent-session-runtime.js:102-111`
  (`teardownCurrent`) awaits `session.abort()`, emits `session_shutdown`, then disposes the session
  and builds a new runtime — so on `/new`, `/resume`, `/fork` the extension factory is re-run
  (`dist/core/extensions/loader.js:407-409`) and a fresh closure exists anyway. `ctx.cwd` is set once
  in the runner constructor (`dist/core/extensions/runner.js:154`) and exposed through a getter with
  no setter (`:476-478`): it cannot change inside one Pi session, which is why #60's test 3 is
  dropped. What remains of #60 is the contract: an explicit disposal, a report of what it dropped,
  and a runner per cwd.
- **`ReplRunner` surface** (`src/repl.ts`): `run`, `resume`, `abandon` (returns
  `"abandoned" | "nothing-pending" | "no-session"`), `reset` (evicts the entry), `liveSessionCount`.
  No dispose, no session listing, and `abandon` does not name the suspended tool — the extension
  cannot learn which sessions exist except by remembering the ids it handed out.
- **Tests.** `test/extension.test.ts` (1398 lines, 48 tests, ~5 s): the `load()` harness
  (`:57-70`) stubs only `registerTool` / `registerCommand`; prototype patches at `:347-372`
  (`ReplRunner.prototype.run`) and `:1241-1259` (`ReplRunner.prototype.resume`); the three-option
  dialog is pinned at `:1027-1031`. No `test/support/prototype-patch.ts` exists.
- **Docs.** `README.md:142` says every dialog offers **three answers**; `README.md:44-60` (session
  pool) says nothing about the Pi session boundary. `docs/approval-grants.md:64-67` says the select
  has three options, `:105-107` says #35 "tracks" the spam half, `:136-139` lists #35 under "What
  this does not fix". `archive/actionable-items.md:243-258` (A7, `[H34]`) records the 20-dialog
  measurement as open.
- **Coverage floor.** `coverage-baseline.json`: `extensions/repl-extension.ts` **99.73** (not owned
  here; must not be edited).

## Decisions

- **D81 — N = 8 dialogs actually opened, per `repl` / `repl_resume` call** (decision 3). The
  counter lives in the `makeOnApproval` closure, which is minted per `execute()`, so it is per call
  by construction and restarts on `repl_resume` with no extra plumbing. Only a call that reaches
  `ctx.ui.select` counts: `hasUI === false`, yolo, and an already-aborted signal return before the
  counter, and cache-served calls never reach the callback at all (`Session.makeApprovalGate`
  branch 1). A dismissed dialog (Escape / timeout / abort) counts — it was opened. Why 8: the
  20-dialog reproduction is the failure; legitimate multi-step work through the shipped strict mode
  (one approval per execution) rarely exceeds a handful of distinct gated calls per snippet, and a
  user who needs more is one `repl_resume` — or `/repl-approvals yolo`, which already exists — away.
  `MAX_DIALOGS_PER_CALL` is exported so tests pin the number, not a copy of it.
- **D82 — "Deny remaining" is the fourth choice, offered last, and latches the closure.** Order
  stays `approve, deny, decide later, deny remaining`: the three existing positions do not move
  (muscle memory, and every existing test), and the most consequential answer is the one that needs
  reading. Once chosen, that call's closure denies every later gated request without opening a
  dialog. It is per call — the next `repl` / `repl_resume` mints a new closure — so it cannot become
  a remembered preference. It only ever reduces what is approved: no approve-all, no
  always-allow-this-tool, no remembered grant is added (the ordering note in #35).
- **D83 — The cause is reported in the tool result, by the extension.** When the cap or the
  latch denied at least one call — or the user chose "Deny remaining" at all — a one-paragraph
  `[approval cap]` / `[approvals denied]` notice is appended to the text `ReplRunner` returned, at
  the two `execute()` sites. `ApprovalDecision`, `Session.makeApprovalGate` and the
  `PermissionError` text are untouched (`src/` is out of scope); the sandbox still sees plain
  denials. Appended, not prepended, per the brief — the `[error: PermissionError]` the model reads
  first is true, and the sentence that explains it follows.
- **D84 — The dialog title carries the count.** `Allow <description>? (dialog k of 8)` — the bound
  is discoverable from the dialog itself, which is where a user who is being fatigued is looking.
  The existing title pins (`/write/`, `/offered\.txt/`) hold.
- **D85 — Sessions belong to one Pi conversation** (decision 18). `session_shutdown` disposes
  **every** runner in the map — a conversation that spanned directories owns all of them — by
  abandoning and resetting each session id the extension handed out, then clearing the map. It is
  idempotent by construction: a second call finds an empty map and does nothing. Each dropped
  suspension is reported with `ctx.ui.notify(…, "warning")`, naming the session id and saying the
  call never executed; the tool name and arguments are not available from `ReplRunner.abandon`
  and would not be printed anyway (the `GrantSummary` discipline: an approval description can hold a
  pasted credential). In Pi 0.84.1 the factory is re-run after shutdown, so the disposal is
  belt-and-braces; the report is the user-visible change.
- **D86 — Runners keyed by `ctx.cwd`, each with its own trust cell.** A `Map<string, CwdRunner>`
  where `CwdRunner` owns the `ReplRunner`, the `trusted` boolean its `isProjectTrusted` closure reads
  (refreshed on every tool call, as today), and the set of session ids it has been handed (the only
  way to dispose them without a `src/` listing API). `session_start` calls the same `getRunner` so
  the conversation's runner exists from its first event; constructing a `ReplRunner` reads no file
  and runs no code — sessions, and therefore the preamble, are created only by `repl`, after
  `isProjectTrusted()` has been consulted. Nothing else is registered on `session_start`.
- **D87 — The `repl` description states the scope.** "The sessionId is scoped to this Pi session:
  when the conversation ends (/new, /resume, /fork, quit) every REPL session is disposed, a pending
  approval is dropped, and the same sessionId in the next conversation is a new, empty REPL." Pinned
  by a test, as #60's definition of done requires.
- **D88 — `withPatchedPrototype` in `test/support/prototype-patch.ts`.** Generic over the prototype
  and method name, restores in `finally`, and carries the #178 sequential-assumption comment
  (`node:test` runs the tests in one file sequentially; `--test-concurrency` or a parallelised
  suite would race the shared prototype). Applied at the two `test/extension.test.ts` sites only.
  `test/session.test.ts:409-419` is W1-2's file this wave and is left alone (W3-2 applies it there).

## Tests — RED → GREEN plan

All in `test/extension.test.ts` unless noted. Each RED test fails against main's
`extensions/repl-extension.ts` (the verifier's check-out), for the reason given.

**#35 (describe "approval cap and deny remaining (#35)")**

| # | Test | Fails on main because |
|---|---|---|
| 1 | 50 gated calls in a `try/except PermissionError` loop, all approved: exactly 8 dialogs opened, 8 files written, the 42nd-onwards absent, result names the cap | 50 dialogs open |
| 2 | "Deny remaining" at the first dialog: exactly 1 dialog, no file, result names deny-remaining | `DENY_REMAINING_CHOICE` undefined; second dialog opens |
| 3 | Exact boundary: 8 gated calls open 8 dialogs and no cap notice; 9 open 8 and the ninth is denied with the notice | 9 dialogs open |
| 4 | Abort at the first dialog stops the sequence: 1 dialog, `aborted` result, and the cap notice is absent (the abort, not the cap, ended the run) | the abort half already holds on main; RED through the four-option pin it shares — recorded as a control |
| 5 | The count restarts on `repl_resume`: 8 dialogs in `repl` (8th = decide later) then 2 more in `repl_resume`, nine files, no cap notice | not RED on its own (no cap on main); RED through the title pin `(dialog k of 8)` — recorded as a control |
| 6 | The dialog offers four answers in order and the title carries `(dialog k of 8)` (replaces the three-option pin at `:1027-1031`) | three options |
| 7 | Yolo-approved calls do not count: 50 gated calls in yolo, 0 dialogs, 50 files, no cap notice | not RED on its own (yolo already asks nothing) — recorded as a control |

Tests 4, 5 and 7 are controls that the cap must not break; they are RED through the shared
`DENY_REMAINING_CHOICE` / `MAX_DIALOGS_PER_CALL` imports (undefined on main, so the assertions
that use them fail) and stated so in their comments.

**#60 (describe "session lifecycle (#60)")**

| # | Test | Fails on main because |
|---|---|---|
| 1 | `x = 1`, fire `session_shutdown` then `session_start`, `x` → NameError | no handler registered |
| 2 | `session_shutdown` twice: no throw, second notifies nothing | no handler registered |
| 3 | *dropped* — `ctx.cwd` is immutable per Pi session (`runner.js:154`, `:476-478`); replaced by: two `ctx.cwd` values get two runners — an approved `write('marker.txt')` under cwd B lands in B, and `x` set under A is a NameError under B | one cached runner rooted at A |
| 4 | A suspension pending in the old conversation is not resumable in the new one — `repl_resume` says no session exists | no handler; the session survives |
| 5 | Shutdown with a pending suspension notifies with the session id and "never executed"; a session with nothing pending is not mentioned | no handler |
| 6 | The `repl` description says `sessionId` is scoped to this Pi session and that a pending approval is dropped | text absent |
| 7 | `session_start` under an untrusted project with a hostile `.pi/code-tools/*.py` runs nothing (no `pwned.txt`, no dialog), and the same under a trusted project also runs nothing — session_start never creates a session | no handler |

**#178** — `test/support/prototype-patch.ts` created; `runWithLimits` and the resume-signal pin
rewritten on it. Refactors of green tests, not RED tests.

**GREEN** — `extensions/repl-extension.ts`: constants, `makeOnApproval` returns an
`ApprovalGate` `{ onApproval, notice }`, `withApprovalNotice` at the two `execute()` sites,
`CwdRunner` + `runners` map, `pi.on("session_start")`, `pi.on("session_shutdown")`, description
text. Then README / docs / archive.

## Boundaries

- Modify only: `extensions/repl-extension.ts`, `test/extension.test.ts`, `README.md`,
  `docs/approval-grants.md`, `archive/actionable-items.md`. Create only:
  `test/support/prototype-patch.ts`, `tasks/spec-w1-3.md`, `tasks/ship-report-w1-3.md`.
- `src/` untouched: no change to `ApprovalDecision`, `Session.makeApprovalGate`, the
  `PermissionError` text, or `ReplRunner`.
- `/repl-approvals yolo` (`extensions/repl-extension.ts:249-278`) unchanged.
- README: only the lines the fourth choice and the session scoping make false, plus the cap; W2/W3
  own other README lines.
- `coverage-baseline.json` untouched; `extensions/repl-extension.ts` stays at or above 99.73.
- No new dependencies. No GitHub issue comments or new issues; residuals are `todo` tests.
