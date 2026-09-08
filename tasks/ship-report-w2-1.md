# Ship Report — W2-1: Trace visibility through `details` (#46, #41; #198 command and carry-overs)

Branch: `chunk/w2-1-trace-visibility` · Base: `main` (`e3c68da`) · Commits: `08f70ec` (spec) ·
`eca7dd4` (RED) · `1361cfe` (GREEN) · `021eaa6` (wrap fix) · `0a4c80b` (docs) · `7c30b07` (coverage
control + todo) · Spec: `tasks/spec-w2-1.md` (D111–D120) · Maintainer decisions: 11, 5, 6, 9 ·
Decision: **GO**

## What was built

The last unmet criterion of blocker epic #41: every host-tool call the sandbox makes is visible to
the user and to the model.

1. **`src/repl.ts` — the trace API (decision 11; D111, D112).** `runWithTrace()` (`:472`) and
   `resumeWithTrace()` (`:528`) return `RunTrace { text, sessionId, status, errorKind?, calls,
   suspendedCall?, discardedSuspension? }`; `run()` / `resume()` are `.text` of the same call, so the
   string API is byte-identical by construction and the 188 existing call sites are untouched.
   `calls` are what **executed**: every host tool in a session's registry is wrapped with a
   per-session recorder (`recordExecutions`, `:139`) inside `Session`'s replay cache, and the
   sandbox's entries are aligned to the records per tool from the end (`alignTrace`, `:180`) — a
   replay-served entry is dropped whatever the result's status (`Session` filters ok results only;
   measured), a failure is always kept, and the bridged tool's `details` ride on the record. Records
   survive a suspension so a resumed result's whole-run calls align (`traceOf`, `:676`). The types
   are exported from `src/repl.ts` only (`src/index.ts` is W2-3's).
2. **`src/bridge.ts` — details survive the bridge (D113).** `BridgeOptions.onDetails` (`:79`) is
   called after every successful built-in execution with pi's own `details` (`:464`) instead of
   dropping them; the string return contract is unchanged.
3. **`extensions/repl-extension.ts` — `details` on all four tools, display-safe (D114, D115).**
   `buildDetails` (`:407`) renders each call's arguments Python-ish with every string leaf masked by
   `maskSecrets` **before** the cut, then head-cuts the line through `redact()` at
   `TRACE_ARGS_MAX_BYTES = 256` (`:188`); errors likewise; the built-in tool's details are projected
   fail-closed (`viewDetails`, `:376`: numbers, booleans, `null`; strings only under `fullOutputPath`
   / `truncatedBy`; `TruncationResult.content`, `diff`, `patch` dropped); `calls` capped at
   `TRACE_MAX_CALLS = 1000` (`:191`) with `omittedCalls`. `formatTrace` (`:470`) is the pure formatter
   and `TraceView` (`:507`) the structural `Component` behind `renderResult` on `repl` and
   `repl_resume` (`:1058`, `:1094`); `repl_reset` / `repl_abandon` carry the same shape with their own
   status (`:1146`, `:1189`). `grep -c 'details: {}' extensions/repl-extension.ts` = **0**.
4. **`/repl-accept-preamble` (decision 5; D116).** Registered beside `/repl-approvals` (`:884`),
   through `getRunner(ctx)` so the trust cell is refreshed; one `notify` per outcome — `accepted`
   (info, names the tools and the manifest path), `untrusted` (warning), `refused`,
   `store-unavailable`, `unreadable` (error, each with its reason). `changedNotice()` names the
   command (`src/repl.ts:1225`).
5. **Wave-1 follow-ups.** (a) `test/extension.test.ts` runs against a temp
   `REPL_PREAMBLE_STORE_DIR` set at module load and restored in a root-level `after`, with a pin that
   no manifest keyed to a `repl-ext-*` cwd reaches the default store (D118); (b)
   `MAX_DIALOGS_PER_CALL === 8` pinned; (c) "Deny remaining" at the last gated call says so instead of
   counting zero later calls (D117); (d) `README.md` no longer describes a conversation that spans
   directories (D120).
6. **Preamble carry-overs (D119; `src/repl.ts`, `src/toolstore.ts`).** (1) `PreambleStatus.
   acceptedSince` (`toolstore.ts:91`) and `ToolStoreOptions.onManifestChange` (`:188`), fired by
   `save_tool` / `delete_tool` after a trusted manifest update (`:647`, `:717`); `acceptPreamble()`
   moves `unaccepted ∩ loaded` of every live session (`repl.ts:640`); the list and `read_tool` say
   "accepted after this session started — loads in new sessions" (`:811`, `:887`). (2) An escaping
   `.pi/code-tools` is `SavedToolsPreamble.escaped` (`:1108`, `:1275`), reported by `escapedNotice`
   (`repl.ts:1156`) with the cause, manifest untouched, `acceptPreamble` → `unreadable`. (3) Any other
   jail failure (`.pi` itself unreadable) is `unlistable` in the loader (`:1276`) and `[]` in
   `savedToolNames` (`:1173`): never a throw out of session creation. (4) Both diagnostics when the
   directory is unreadable and the store unavailable (`repl.ts:919`, `storeUnavailableNotice`
   `:1173`); a manifest path through a file is `unavailable` at read time (`toolstore.ts:1694`).
7. **Docs.** New `docs/tool-trace.md`; `README.md` gains "The tool trace", the accepted-set
   sentence W1-4 deferred plus the command, the corrected session-pool sentence, and the API comment.

No new `src/` module; `coverage-baseline.json` untouched (W2-3's). No new dependency.

## Verification evidence

- **Gates** (final, at `7c30b07`): `npm run check` clean; `npm run lint` clean (59 files);
  `REQUIRE_BRIDGE_TOOLS=1 npm run test:contained` — **1446 tests, 1436 pass, 0 fail, 10 todo**, 323
  suites, 38.9 s, exit 0, no OOM; `npm run coverage` — "All per-file floors met":
  `extensions/repl-extension.ts` **99.83** (floor 99.73), `src/repl.ts` **100.00** (100.00),
  `src/bridge.ts` **99.78** (99.77), `src/toolstore.ts` **99.20** (98.90); all files 98.85.
- **RED → GREEN.** Commit `eca7dd4` adds 42 tests; run against main's `src/` + `extensions/`
  (measured before GREEN): `test/extension.test.ts` 86 / **23 fail** / 1 todo (the eleven trace
  tests and the DoD grep fail with `details carry no trace: {}` / `viewArgs is not a function`; the
  seven formatter tests with `formatTrace is not a function`; the three command tests with the
  command absent; the deny-remaining wording with the zero; the command-list pin strengthened);
  `test/repl.test.ts` 137 / **14 fail** (`runWithTrace is not a function`; the notice lacking the
  command; the stale annotation; "no longer in" for an escape; `EACCES … realpath` rejecting;
  the hidden store); `test/toolstore.test.ts` 158 / **4 fail** / 2 todo; `test/bridge.test.ts` 38 /
  **1 fail**. Two controls are green on main by construction and say so in their comments:
  `MAX_DIALOGS_PER_CALL === 8` (`test/extension.test.ts:2868`) and the store-hygiene pin (`:2904`,
  the fix is test-side). `7c30b07` adds one more control (`test/repl.test.ts:2686`, restoring the
  D91 branch to coverage after carry-over 4 moved the store-as-file case) and one todo.
  Commit `1361cfe` turns everything green; the four pre-existing prototype-patch pins follow the
  new seam (`runWithTrace` / `resumeWithTrace`).
- **#46 DoD tests** (`test/extension.test.ts`): 1 — one entry per call with the approval status
  (`:2147`); 2 — `read_file` then `http_get`, both listed, the fetch denied (`:2183`); 3 — pi's read
  `truncation` survives, `content` does not (`:2213`); 4 — a 64 KiB `write` is cut to ≤ 256 bytes
  with the marker, the body never rendered (`:2237`), exact boundary 256 / 257 (`:2265`); 5 — a
  `ghp_` token and a `Bearer` value are `[REDACTED]` in `details` and in the rendered lines
  (`:2281`); 6 — `details` on all four tools, `renderResult` on the two that run code (`:2319`).
  Plus: the DoD grep (`:2393`); the suspended partial trace and the whole-run resume (`:2401`);
  replay exclusion at the extension (`:2439`); JSON round-trip for ok / suspended / error (`:2470`);
  `formatTrace` lines, notes, waiting call, omitted count, `TRACE_MAX_CALLS` 1000 / 1001 boundary,
  `viewArgs`, and the component's wrap and reuse (`:2537`–`:2648`).
- **Library trace** (`test/repl.test.ts`): text byte-identical to `run()` (`:3158`) and to
  `resume()` across a suspension (`:3223`); `errorKind` (`:3174`); the three early-return statuses
  (`:3184`, `:3200`); bridged details aligned across a suspension (`:3249`); replay exclusion on
  error and suspended results, and agreement with Session's own ok filter (`:3272`); a failure is
  never dropped as replayed (`:3306`).
- **Command and follow-ups**: the five outcomes (`test/extension.test.ts:2723`, `:2780`, `:2826`);
  the notice names the command (`test/repl.test.ts:3342`); deny-remaining wording (`:2872`);
  registration pin (`:609`).
- **Carry-overs**: in-session refresh after `save_tool` and after `acceptPreamble()`, `delete_tool`
  dropping the annotation, the live session still raising `NameError` (`test/repl.test.ts:3366`,
  `:3411`; `test/toolstore.test.ts:3137`, `:3192`); the escaping symlink — nothing executes in either
  directory, the notice names the cause, no "no longer in", manifest byte-identical,
  `acceptPreamble` → `unreadable` (`test/repl.test.ts:3452`; loader `test/toolstore.test.ts:3086`);
  `.pi` at mode 000 — trusted and untrusted runs resolve, `acceptPreamble` → `unreadable`, record
  survives (`test/repl.test.ts:3494`; loader / `savedToolNames` `:3109`); both diagnostics
  (`test/repl.test.ts:3543`).
- **Adversarial probes, reproducible by a reviewer.** (a) Exfiltration path visible after the fact:
  `secret = read_file(...)` then `http_get(...)` denied — `details.calls` lists both, in order
  (`:2183`). (b) Body disclosure through `details`: `write('f', 'B'*65536)` — `args` ≤ 256 bytes,
  `formatTrace` output has no `B{1000}`; a 2 500-line `read` — `details.truncation` has no `content`
  key and the JSON has no `line 1999` (`:2237`, `:2213`). (c) Secret in an argument:
  `write('tok.txt', 'ghp_…')` and `bash('echo Authorization: Bearer …')` — `JSON.stringify(details)`
  has neither value (`:2281`). (d) Phantom calls: a suspended second snippet lists the new `read`
  only, not the replayed one (`:2439`; library `:3272`). (e) `grep -c 'details: {}'
  extensions/repl-extension.ts` → 0 (`:2393`). (f) The jail token pin: `grep -n realpath src/*.ts`
  matches `src/pathjail.ts` only (`test/bridge.test.ts` "is one implementation").
- **Formatter transcript** (`scratchpad/w21/transcript.mts` through the real `repl` /
  `repl_resume` tools and their `renderResult`, width 100; the live-TUI screenshot is a maintainer
  step — see the closing comment):

  ```
  Tool 'http_get' requires approval.
  http_get(url="http://127.0.0.1:9/exfil?d=line ")

  Session: 'demo'. Use repl_resume(sessionId='demo') to approve, or repl_abandon(sessionId='demo')
  to discard.
  [trace] 3 host-tool call(s)
    ✓ read("big.txt") 5ms · output truncated by lines
    ✓ write("tok.txt", "ghp_[REDACTED]") approved 1ms
    ✗ write("no.txt", "y") denied 0ms — tool 'write' requires approval
    ⏸ http_get("http://127.0.0.1:9/exfil?d=line ") waiting for approval
  ```

  collapsed: `[trace] 3 host-tool call(s): 2 ok, 1 denied, 0 failed; http_get waiting for approval
  — expand to list them`. After `repl_resume` (approved; the fetch fails on loopback, the next
  `bash` is denied):

  ```
  [trace] 5 host-tool call(s)
    ✓ read("big.txt") 5ms · output truncated by lines
    ✓ write("tok.txt", "ghp_[REDACTED]") approved 1ms
    ✗ write("no.txt", "y") denied 0ms — tool 'write' requires approval
    ✗ http_get("http://127.0.0.1:9/exfil?d=line ") approved 1ms — '127.0.0.1' resolves to
    127.0.0.1, a private or reserved address
    ✗ bash("echo Authorization: Bearer [REDACTED]") denied 0ms — tool 'bash' requires approval
  ```

- **CI**: verified only when `gh pr checks <n> --watch` reports every leg — Linux and macOS, node
  22 and 24, lint, coverage — SUCCESS (conventions "CI on all legs"); the PR body carries the line.

## Residuals as todo tests

- `test/repl.test.ts:3319` — *two concurrent runs on one session each get exactly their own calls.*
  The recorder is per session, not per run (D112): the first run to finish clears it and the other's
  alignment drops calls. The extension never does this (`executionMode: "sequential"`) and #59
  documents the library's stance. Intended approach: a per-run recorder handed to `Session.run` /
  `resume` as a run-scoped registry wrapper (`src/session.ts`, another chunk's file this wave).

Documented bounds, not tests (`docs/tool-trace.md` "What this does not cover"): masking is the
`src/redact.ts` bound (a bare high-entropy string inside the 256-byte head survives); the library
trace is verbatim and an embedder owns its own redaction; the non-deterministic-transcript swap of
`details` between identical-argument calls (the same bound `Session.filterCachedCalls` has); the
plain rendering.

## Needed outside this chunk (not touched — file ownership)

- **`docs/project-trust.md:130-132`, `:204`** — say the pi command "lands in the next wave" / "is
  not in this wave"; it has landed as `/repl-accept-preamble`. One-sentence fix for the owner of
  that file.
- **`src/index.ts`** (W2-3 this wave, W3-2 for the re-export) — `RunTrace`, `TracedCall`,
  `TraceStatus` from `src/repl.ts`; `BridgeToolDetails` from `src/bridge.ts`; `ManifestChange` from
  `src/toolstore.ts`.
- **W3-1** — the `seq` index on `TracedCall` and the interleave with `stdout`; the trace is
  unordered relative to the stream by decision 11.

## Rollback plan

| Commit | Reverts |
|---|---|
| `7c30b07` | the read-only-store control and the concurrency todo (test-only; reverting the control re-opens the `src/repl.ts` floor breach — revert only together with `1361cfe`) |
| `0a4c80b` | `docs/tool-trace.md`, the README lines |
| `021eaa6` | word-wrapping in `TraceView` (cosmetic) |
| `1361cfe` | GREEN — the trace API, the recorder and alignment, `onDetails`, the details view, formatter and component, the command, the wording, the carry-overs (revert together with `eca7dd4` or the suite goes red) |
| `eca7dd4` | the RED tests |
| `08f70ec` | the spec |

`git revert 7c30b07 0a4c80b 021eaa6 1361cfe eca7dd4 08f70ec` (newest first) returns to `e3c68da`.

## Closing-comment drafts (for the orchestrator, after merge)

**#46** — Closed by W2-1. `ReplRunner.runWithTrace()` / `resumeWithTrace()` (additive, decision 11;
`run()` / `resume()` byte-identical) return the executed host-tool calls with arguments, duration,
outcome and approval status, plus the bridged pi tool's own `details`
(`BridgeOptions.onDetails` — merged, not dropped). All four tools return `details`
(`{ sessionId, status, calls, omittedCalls, suspendedCall? }`), display-safe: arguments masked with
`src/redact.ts` before a head-only cut at 256 bytes, built-in details projected to their facts (no
`content`, `diff` or `patch`), calls capped at 1000, results and `stdout` never in the trace.
`renderResult` on `repl` / `repl_resume` lists the calls under the result. Tests 1–6:
`test/extension.test.ts:2147`, `:2183`, `:2213`, `:2237` (+ boundary `:2265`), `:2281`, `:2319`.
`grep -c "details: {}" extensions/repl-extension.ts` = 0 (pinned at `:2393`). Redaction policy:
`docs/tool-trace.md`, shared with #63's dump work through the same `src/redact.ts` helper
(decision 6, 13). Transcript: the PR body / `tasks/ship-report-w2-1.md`. **Maintainer step: a
screenshot of the rendered trace in a live pi TUI** (the formatter output is pinned line by line,
but legibility in the real terminal is the reviewer's call — precedent #49). Unordered relative to
`stdout` until wave 3's `seq`.

**#41** — All five exit criteria hold with tests. The fifth — *every host-tool call the sandbox
made is visible to the user and to the model* — by #46 above: the model reads them in `details`
(pi passes `details` to `tool_result` handlers and persists them), the user sees them rendered
under the result; the exfiltration snippet at the top of the epic is listed as `read_file` then
`http_get` denied (`test/extension.test.ts:2183`). The other four are unchanged since the W1-1
close-out. `gh issue list --label bucket-4 --state open` after this merge: none.

**#198** (already closed by W1-4; addendum) — W2-1 lands the pi command `/repl-accept-preamble`
(`extensions/repl-extension.ts:884`; outcomes `test/extension.test.ts:2723`, `:2780`, `:2826`), the
README lines, and the four deferred items: in-session refresh of the tools' view after a re-save or
an accept (`test/repl.test.ts:3366`, `:3411`), an escaping `.pi/code-tools` named as the cause with
the manifest untouched (`:3452`), `.pi` itself unreadable never rejecting a session build (`:3494`),
and an unlistable directory no longer hiding an unavailable store (`:3543`).

## Go / No-Go

**GO.** All four gates green locally at `7c30b07` (check / lint / test:contained
**1446-1436-0-10** / coverage, floors met with `src/repl.ts` at 100.00). RED → GREEN in separate
commits: 42 new tests red on main for the reasons recorded, two controls named as such, one
coverage control, one residual as a todo test. `run()` / `resume()` byte-identical by construction
and pinned; nothing outside the owned files touched; three follow-ups named for their owners. CI on
all legs is the last gate; the PR body carries its result.
