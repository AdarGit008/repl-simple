# Todo — STOP-SHIP A33 → A34 → A35 → A36 → A37

Source of truth: `SPEC.md` + `tasks/plan.md`. One item = one coder dispatch = one orchestrator commit.
Order is fixed (AS1). A36 steps 1–2 before 3–4 (AS2).

> **REALITY CHECK (verified at HEAD `22b4245`, 2026-08-22):** every item below was already
> landed on `main` by 76 commits since `dfc1136` (the commit `docs/actionable-items.md` was written
> against — the doc is stale). This flight is therefore **verification-only**: no new implementation
> is required. Commit map: A33 → `cef2782` (#27); A34 → `30b2d2b` (#32) + `08985c5` (#179);
> A35 → `cb6e35d` (#42) + `e7bc7da` (#43); A36 → `b7e223c` (#36) + `dc170ea` (#51) +
> `8ac0a1e` (#48) + `4709f57` (#49) + `43d06ce` (#129); A37 → `198384f` (#53) + `4232cc7` (#54) +
> `0e93978` (#55) + `10c536c` (#57) + `4c7662c` (#56). Checkboxes below are marked
> **VERIFIED-LANDED**; any residual gap found by Phase 4–6 is recorded instead.

- [x] **A33 — Fix the `runDispatchLoop` accumulator desync**
  - [x] RED — test in `test/sandbox.test.ts`: `print` after a loop-dispatched tool call preserved on
        both entry points; mid-run abort during an async tool stops the loop. Fails at HEAD.
  - [x] GREEN — `DispatchAccumulators` is the single mutable owner (`printCallback` writes
        `acc.stdout`/`acc.stdoutTruncated`; `onAbort` writes `acc.aborted`).
  - [x] Delete the now-unused `maxStdout` and `printCallback` parameters at the `runDispatchLoop`
        signature.
  - [x] Enable `noUnusedParameters` in `tsconfig.json`; `npm run check` clean.
  - [x] `npm test` + `check` + `build` + `lint` clean.
  - Files — `src/sandbox.ts`, `test/sandbox.test.ts`, `tsconfig.json`.

- [ ] **A34 — Default timeout + plumb the abort signal**
  - [ ] RED — `repl` with a busy loop (`while True: pass`) returns a `TimeoutError` `RunError` within
        the default budget; process stays responsive.
  - [ ] GREEN — `toResourceLimits` defaults `maxDurationSecs` (30) and `maxMemory` when caller passes
        none.
  - [ ] Thread `_signal` → `ReplRunner.run/resume` → `RunOptions.signal`.
  - [ ] Expose `maxDurationSecs`/`maxMemory`/`signal` as `repl` tool params with caps.
  - [ ] `npm test` + `check` + `build` + `lint` clean.
  - Files — `src/sandbox.ts`, `src/repl.ts`, `src/types.ts`, `extensions/repl-extension.ts`,
    `test/repl.test.ts`.
  - Depends on: A33.

- [ ] **A35 — Close the read and egress surface**
  - [ ] RED — the exfil snippet (`read('/etc/hostname')` + `http_get`) either prompts or fails; both
        halves asserted.
  - [ ] GREEN — bridged read tools jailed to `cwd` (same `realpath`-checked helper as
        `builtins.read_file`), or gated; `gateReads` option added to `BridgeOptions`.
  - [ ] Gate `http_get` (or allowlist) + SSRF defences (block loopback/link-local/RFC1918/`::1`/
        metadata per hop, `redirect: "manual"`, `AbortSignal.timeout`).
  - [ ] `npm test` + `check` + `build` + `lint` clean.
  - Files — `src/bridge.ts`, `src/builtins.ts`, `src/types.ts`, `test/bridge.test.ts` and/or
    `test/builtins.test.ts`.
  - Depends on: A33.

- [ ] **A36 — Guard the prologue resumes, then make suspension reachable**
  - [ ] RED — deny-with-uncaught-`PermissionError` returns a `RunError` and leaves the session usable;
        suspend → resume → approve round trip works.
  - [ ] Step 1 — wrap the three prologue `snapshot.resume()` calls in `MontyRuntimeError` catches
        exactly as the shared loop does.
  - [ ] Step 2 — `ReplRunner.resume` catches the no-suspension case and returns a friendly string
        (matching the no-session branch).
  - [ ] Step 3 — replace `ctx.ui.confirm` with `ctx.ui.select` (approve / deny / decide-later), return
        `"suspend"` for the third; widen `Session.resume`'s `decision` from `boolean`.
  - [ ] Step 4 — name the `sessionId` in `formatResult`'s suspended branch.
  - [ ] `npm test` + `check` + `build` + `lint` clean.
  - Files — `src/sandbox.ts`, `src/session.ts`, `src/repl.ts`, `src/types.ts`,
    `extensions/repl-extension.ts`, `test/repl.test.ts`, `test/session.test.ts`.
  - Depends on: A33.

- [ ] **A37 — Stop auto-executing `.pi/code-tools` unreviewed**
  - [ ] RED — a fresh clone with a hostile `.pi/code-tools/x.py` does not execute without an explicit
        approval; an unreadable entry does not break the session.
  - [ ] GREEN — preamble inclusion approval-gated per file content-hash (prompt once, remember per
        hash); hostile file refused by default.
  - [ ] Refuse preamble definitions that shadow a registered host-tool name.
  - [ ] Register `createToolStoreTools` in `repl.ts` so `read_tool`/`delete_tool` are reachable.
  - [ ] `try`-wrap the read loop so one bad entry is skipped, not fatal.
  - [ ] Add `.pi/` to `.gitignore`; cap total preamble size and file count.
  - [ ] `npm test` + `check` + `build` + `lint` clean.
  - Files — `src/repl.ts`, `src/session.ts`, `src/registry.ts` (and/or `src/toolstore.ts`),
    `src/index.ts`, `.gitignore`, `test/repl.test.ts`.
  - Depends on: A33–A36.
