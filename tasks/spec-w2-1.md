# Spec — W2-1 Trace visibility through `details` (#46, #41; #198 command and carry-overs)

Branch `chunk/w2-1-trace-visibility` · Base `main` = `e3c68da` · Decision range **D111–D120** ·
Maintainer decisions applied: **11** (additive `runWithTrace()` / `resumeWithTrace()`, `run()` /
`resume()` byte-identical, unordered — `seq` arrives in wave 3), **5** (the pi command that calls
`ReplRunner.acceptPreamble()`), **6** (`src/redact.ts` for masking), **9** (residuals are todo tests).

## Objective

Every host-tool call the sandbox makes is visible to the user and to the model — the last unmet
criterion of blocker epic #41. Today `ReplRunner.run` / `resume` return `Promise<string>` and drop
`RunResult.calls`, the four tools return `details: {}`, and the bridge discards pi's own `details`.
This chunk:

1. adds an additive trace API to `ReplRunner` and populates `details` on all four tools, with a
   `renderResult` that lists the calls under the result;
2. keeps the trace display-safe: arguments head-truncated and secret-masked, bodies never carried;
3. merges pi's built-in `details` (truncation, full-output path) instead of dropping them;
4. registers `/repl-accept-preamble` (decision 5) and the README lines W1-4 deferred;
5. closes four wave-1 follow-ups (test store hygiene, the cap pin, the "0 later gated call(s)"
   wording, the README sentence pi 0.84.1 cannot produce) and four preamble carry-overs in
   `src/repl.ts` / `src/toolstore.ts`.

## Current state, measured at `e3c68da` (2026-09-08)

| What | Where | Finding |
|---|---|---|
| `details: {}` | `extensions/repl-extension.ts:573`, `:606`, `:658`, `:700` | four sites; `grep -c 'details: {}'` = 4 |
| Runner returns text only | `src/repl.ts:243-258` (`run`), `:276-313` (`resume`) | `formatResult` (`:920-934`) renders `stdout` / `output` / the suspension; `result.calls` never leaves |
| Trace population | `src/sandbox.ts:1016`, `:1060` (denied, `approved: false`), `:1098`, `:1118`, `:1138` (`approved`) | one entry per dispatch; a resume seeds `acc.calls` from the suspended result (`:109`), so the resumed result reports the whole run |
| Replay filter | `src/session.ts:833-884`, applied at `:390` only | **ok results only**. Measured: an error result carries every replay-served entry (three replayed `read`s ahead of the denied `write`); a suspended result and a resumed result are raw too |
| Replay cursor | `src/session.ts:137-183` | positional; the cursor does not advance on a mismatch; only successes are cached (`newEntries.push` after `originalExecute` resolves) |
| Bridge drops `details` | `src/bridge.ts:444-449` | `content` text joined, `result.details` discarded |
| pi's `details` | `read.js:222/235` `{ truncation }`, `bash.js:253` `{ truncation, fullOutputPath }`, `edit.js:223` `{ diff, patch, firstChangedLine }`, `ls.js:130-135`, `write.js:165` `undefined` | `TruncationResult.content` **is the truncated body** — merging verbatim would carry results into `details` |
| `renderResult` | pi `dist/core/extensions/types.d.ts:375`; call site `tool-execution.js:248`; `Component` = pi-tui `tui.d.ts:10-31` (`render(width): string[]`, `invalidate()`) | `@earendil-works/pi-tui` is nested under pi-coding-agent's own `node_modules` and is not resolvable from this repo's root, so the component is implemented structurally, not imported |
| Command surface | `extensions/repl-extension.ts:425-454` (`/repl-approvals`); `ReplExtensionApi.registerCommand` `:190-199` narrows `ctx` to `{ ui.notify }` | no accept command; `docs/project-trust.md:130-132` says it "lands in the next wave" |
| Notice text | `src/repl.ts:838-860` (`changedNotice`) | names `save_tool`, `delete_tool`, `ReplRunner.acceptPreamble()` only |
| Deny-remaining notice | `extensions/repl-extension.ts:410-416` | "`0 later gated call(s)` … were denied" when the answer came at the last gated call |
| `MAX_DIALOGS_PER_CALL` | `:70` = 8; `test/extension.test.ts:1493` reads it as `CAP` | the value itself is never pinned |
| Test store hygiene | `test/extension.test.ts` | zero occurrences of `REPL_PREAMBLE_STORE_DIR` / `preambleStoreDir`; every trusted context (`:419`, `:471`, `:596`, `:635`, `:773`, …, `:1789`, `:1809`) writes a manifest into the developer's default store (`resolvePreambleStoreDir`, `src/toolstore.ts:1424-1435`) |
| README | `README.md:61-63` | "a conversation that spans directories" — pi 0.84.1's `ctx.cwd` is fixed per session (`runner.js:154`, `:476-478`; `tasks/ship-report-w1-3.md:59`) |
| Carry-over 1 | `src/repl.ts:653-662` builds `preambleStatus` once (`unaccepted: new Map(...)`); `src/toolstore.ts:612-629` (`save_tool`), `:685-696` (`delete_tool`) update the manifest but not the view; `:770-788`, `:839-865` render it | re-saving a withheld file leaves the in-session list saying "not accepted — added since …" |
| Carry-over 2 | `src/toolstore.ts:1207-1215` | an escaping `.pi/code-tools` → `nothingLoaded()`; `src/repl.ts:629` then reports every accepted file "no longer in .pi/code-tools" |
| Carry-over 3 | `src/toolstore.ts:1213-1214` (`loadSavedTools`), `:1115-1116` (`savedToolNames`) rethrow anything that is not a `PermissionError`; `src/pathjail.ts:83-87` turns `EACCES` on `realpath` into `HostToolError("OSError")` | `.pi` at mode 000 rejects `run()`, `acceptPreamble()` and even an untrusted session build |
| Carry-over 4 | `src/repl.ts:607-609` | the unlistable notice returns before `read.status` is consulted; an unavailable store is reported only once the directory lists |

## Decisions

**D111 — Additive trace API, text byte-identical by construction.** `src/repl.ts` gains
`runWithTrace()` / `resumeWithTrace()` with the same parameters as `run()` / `resume()`, returning
`RunTrace { text, sessionId, status, errorKind?, calls, suspendedCall?, discardedSuspension? }`.
`status` is the sandbox's `ok | error | suspended` plus the three resume early-returns —
`no-session`, `nothing-pending`, `trust-changed` — each with `calls: []`. `run()` and `resume()`
are `(await this.runWithTrace(…)).text` / `(await this.resumeWithTrace(…)).text`: the string is the
same object, so the 188 existing call sites see byte-identical output, and a test asserts it on the
same code across two sessions. `calls` carry the sandbox's verbatim entries (`TracedCall extends
ToolCallTrace`) plus `details` (D113): **sensitive**, documented so, the library's caller is trusted
host code (decision 7's `LlmClient` precedent, decision 13's replay-cache precedent). The types are
exported from `src/repl.ts` only — `src/index.ts` is W2-3's this wave.

**D112 — The trace is what executed; alignment by execution record.** `Session` filters
replay-served entries on the ok path only (measured above), so a suspended, error or resumed result
would show phantom calls. The runner therefore wraps every host tool in the session's registry —
inside the caching wrapper, so a replay-served call never reaches it — with a per-session recorder
of real executions `{ tool, key, ok, details }`, where `key` is the tool name plus the resolved
arguments (`resolveToolArgs`, the same function the sandbox and the replay cache use). `calls` are
aligned to the records **per tool, from the end**: an `ok: true` entry with no matching record is
replay-served and dropped; an `ok: false` entry is always kept (the cache stores successes only, so
a failure never replays). This is exact under deterministic replay — the cursor never advances on a
mismatch and dispatch is sequential — and degrades to a cosmetic swap of `details` between two calls
with identical arguments under a non-deterministic transcript, the same bound `filterCachedCalls`
has. Records are cleared at the start of every `run` (a run always starts a fresh call; a pending
suspension is dropped anyway) and on `abandon`, and kept across a suspension so a resumed result's
whole-run `calls` align. Calls on one session are assumed sequential: the extension guarantees it
(`executionMode: "sequential"`) and #59 documents it for the library.

**D113 — The bridge reports pi's `details` instead of dropping them.** `BridgeOptions.onDetails?:
(event: { tool, args, details }) => void` is called after every successful built-in execution with
`result.details`; the string return contract of `HostTool.execute` is unchanged (`src/types.ts` is
W2-2's). The runner stashes the event and the recorder attaches it to the execution record, so
`TracedCall.details` is the built-in tool's own object — `truncation`, `fullOutputPath`, `diff`,
`patch`, `firstChangedLine`, `entryLimitReached`, … — verbatim at the library level.

**D114 — `details` at the extension boundary are display-safe and JSON-safe.** pi persists
`details` to the session file and emits them over RPC (#46), so nothing verbatim leaves the
extension. `ReplDetails { sessionId, status, calls, omittedCalls, suspendedCall? }` where each call
is `{ tool, ok, approved?, durationMs, args, error?, details? }`:
- `args` is one rendered line — positional arguments as Python-ish reprs, keyword arguments as
  `name=repr`, strings in JSON quotes like the approval dialog — masked and cut. Every string leaf is
  masked with `maskSecrets` **before** the repr cuts it (a 4 KiB window per leaf, its last 64
  characters dropped when the leaf was longer, so no token fragment survives a cut), the renderer
  stops at a work cap, and the joined line goes through `redact()` at `TRACE_ARGS_MAX_BYTES = 256`
  (head-only, magnitude-free marker). `Map` → `{k: v}`, `Set` → `{…}`, `null`/`undefined` → `None`,
  booleans → `True`/`False`, bytes → `<bytes n>`, depth-limited to 4.
- `error` is masked and cut the same way (a `bash` failure carries its output).
- `details` is a **fail-closed projection** of the built-in tool's object: numbers, booleans and
  `null` anywhere (depth ≤ 3); strings only under `fullOutputPath` and `truncatedBy`, masked and
  cut; every other string — `TruncationResult.content`, `diff`, `patch` — is dropped. Bodies are
  never in `details`.
- `calls` is capped at `TRACE_MAX_CALLS = 1000` head entries with `omittedCalls` counting the rest
  (the accumulator has no cap of its own).
- `suspendedCall` is `{ tool, args }` rendered the same way. Results, `stdout` and return values are
  never in the trace at any level — `ToolCallTrace` does not carry them.
`repl_reset` and `repl_abandon` return the same shape with `calls: []` and their own `status`
(`reset` / `no-session`; `abandoned` / `nothing-pending` / `no-session`) — details on all four
tools, one type.

**D115 — `renderResult` is a trivial component over a pure formatter.** `formatTrace(details,
{ expanded })` returns the trace lines: collapsed, one summary line (`n host-tool call(s): a ok, b
denied, c failed`); expanded, one line per call — `✓`/`✗`, `tool(args)`, `approved` / `denied`,
`Nms`, `— error`, and notes from the projected details (`output truncated by lines`, `full output:
path`, `entry limit N`) — plus the suspended call and the omitted count. `renderResult` on `repl`
and `repl_resume` returns a `TraceView` (a structural `Component`: `render(width)` wraps the lines to
the width, `invalidate()` is a no-op) holding the result text followed by the trace, reusing
`context.lastComponent`. The theme is not used: plain text, so the formatter is testable without pi's
theme and the transcript in the ship report is what the TUI shows. `repl_reset` / `repl_abandon`
keep pi's default rendering — nothing to trace.

**D116 — `/repl-accept-preamble`.** Registered beside `/repl-approvals`; the handler takes the
command context (`cwd`, `isProjectTrusted`, `ui.notify` — `ReplExtensionApi.registerCommand`
widens to that), goes through `getRunner(ctx)` so the trust cell is refreshed on the way in, calls
`acceptPreamble()` and prints one line per outcome: `accepted` (info; names the tools and the
manifest path, and says live sessions keep their preamble — run `repl` with a new `sessionId`),
`untrusted` (warning), `refused`, `store-unavailable`, `unreadable` (error, each naming the reason).
`changedNotice()` in `src/repl.ts` names the command next to `ReplRunner.acceptPreamble()`. The
README gets the sentence W1-4 deferred and the command; `docs/project-trust.md` is not this chunk's
file and its "lands in the next wave" sentence is reported as a deviation.

**D117 — The deny-remaining notice never says "0 later".** When "Deny remaining" was the last gated
call in the run, the notice says so — the call on screen was refused and there was nothing after
it — instead of counting zero. The cap notice is unchanged: `closed = "cap"` is set only when a
further gated call arrives, so its count is ≥ 1 by construction.

**D118 — Test store hygiene, pinned.** `test/extension.test.ts` sets `REPL_PREAMBLE_STORE_DIR` to a
`mkdtempSync` dir at module load and restores the variable and removes the dir in a root-level
`after`, the three lines `test/repl.test.ts:41-52` use. A pin records the default store's
`preambles/` listing before the override and asserts, after the suite, that no manifest keyed to a
`repl-ext-` temp cwd appeared (existing files are ignored, so leftovers from earlier runs cannot fail
it; a concurrently running file cannot either — its cwds are named differently). Both the pin and
the `MAX_DIALOGS_PER_CALL === 8` pin are controls: green against main by construction (the fix is
test-side; the value is already 8) and recorded as such.

**D119 — Preamble carry-overs.**
1. *Stale in-session annotation.* `PreambleStatus.acceptedSince?: ReadonlySet<string>` — names
   withheld at session creation and accepted since. The runner builds the view with mutable
   collections it owns; `save_tool` (accepted) and `delete_tool` (removed) report a successful,
   trusted manifest update through `ToolStoreOptions.onManifestChange`, and `acceptPreamble()`
   moves `unaccepted ∩ loaded` of every live session the same way. `list_saved_tools` renders
   `[not loaded: accepted after this session started — loads in new sessions]` and `read_tool` the
   matching `# NOTE`. Event-driven, so exact for in-process changes; another process's accept is not
   observed until the next session (documented).
2. *Escaping symlink.* `SavedToolsPreamble.escaped?: string` — the containment refusal, with every
   other field empty. The runner reports `[preamble unreadable] .pi/code-tools was not read: it
   resolves outside the project root (…)`, touches no manifest, and `acceptPreamble()` answers
   `unreadable` with that reason. Nothing executes, as before; the notice now names the cause.
3. *`.pi` itself unreadable.* Any other jail failure from `containedToolsDir` (`OSError`: `EACCES`
   on `realpath`) is `unlistable` in the loader and `[]` in `savedToolNames` — never a throw out of
   session creation. `run()` resolves with the unlistable notice and a working session;
   `acceptPreamble()` answers `unreadable`; the manifest is untouched. (The brief offers "a
   `RunError` / error status"; a notice plus a working session is the same fail-closed outcome with
   the session kept, matching the existing unlistable path.)
4. *Both diagnostics.* When the directory is unlistable or escaped **and** the manifest store is
   unavailable, the model is told both: the unlistable notice and a `[preamble unverified]` line that
   says nothing was withheld for it and names the store variable.

**D120 — README.** (d) `README.md:61-63`: runners are keyed by working directory, and in pi 0.84.1
`ctx.cwd` is fixed for a conversation, so this is one runner per conversation in practice — the
keying is what keeps the jail, the preamble root and the bridge tools rooted where the call was made
if a host ever varies it. Plus: the trace paragraph under Tools with the `docs/tool-trace.md`
cross-reference, the W1-4 sentence and `/repl-accept-preamble` in the tool-store paragraph, and the
API comment (`preambleStoreDir?`, `runWithTrace()`). The README tool tables pinned by
`test/readme.test.ts` are untouched.

## Tests — RED → GREEN plan

Every RED test fails against main's `src/` + `extensions/` unless marked *control*. New exports are
reached through namespace imports so each file still loads on main.

**`test/extension.test.ts`** — `describe("repl extension — the trace reaches details (#46)")` and
siblings:

| # | Test | Fails on main because |
|---|---|---|
| 1 | DoD 1: one `details.calls` entry per host-tool call, `approved` true for an approved `write`, false for a denied one, absent for an ungated `read` | `details` is `{}` |
| 2 | DoD 2: `read_file` then `http_get` (denied) — both entries present, in order, the fetch marked denied | same |
| 3 | DoD 3: a bridged `read` of a 2 500-line file carries `details.truncation.truncated === true` and no `content` | same |
| 4 | DoD 4: a 64 KiB `write` — `args` ≤ `TRACE_ARGS_MAX_BYTES`, carries the marker, not the body's tail; the rendered lines do not either; exact boundary: a line of exactly 256 bytes untouched, 257 cut | same; `TRACE_ARGS_MAX_BYTES` undefined |
| 5 | DoD 5: a `ghp_…` token in a `write` body is `ghp_[REDACTED]` in `args` and in the rendered lines; an `Authorization: Bearer` value in a denied `bash` command likewise | same |
| 6 | DoD 6: `details.sessionId` / `status` on all four tools; `renderResult` present on `repl` and `repl_resume` | same |
| 7 | the source has no `details: {}` left (the DoD grep as a test) | 4 hits |
| 8 | a suspended `repl` carries the partial trace, `status: "suspended"`, `suspendedCall` rendered and masked; the `repl_resume` that approves it reports the whole run | `details` is `{}` |
| 9 | replay-served entries are excluded from a suspended result's `calls` (a `read` from an earlier snippet is not listed again) | same |
| 10 | `details` round-trips through `JSON.stringify` unchanged (ok, error, suspended) | same |
| 11 | `formatTrace`: collapsed summary; expanded lines for ok / approved / denied / failed; the truncation and full-output notes; `omittedCalls`; `TRACE_MAX_CALLS` boundary (1000 kept, 1001 → one omitted) | `formatTrace` undefined |
| 12 | `renderResult` returns a component whose `render(width)` starts with the result text and ends with the trace, wraps to the width, and reuses `lastComponent` | `renderResult` undefined |
| 13 | `/repl-accept-preamble`: registered; the five outcomes each notify their sentence; after `accepted` a new `sessionId` loads the file and the live one does not | command absent |
| 14 | "Deny remaining" at the last gated call: no "0 later gated call(s)"; says it was the last | the zero |
| 15 | *control* `MAX_DIALOGS_PER_CALL === 8` | green on main by construction |
| 16 | *control* no manifest keyed to a `repl-ext-` cwd under the default store after the suite | green on main by construction (the fix is in this file) |

**`test/repl.test.ts`**:

| # | Test | Fails on main because |
|---|---|---|
| 17 | `runWithTrace().text` equals `run()` for the same code in two sessions; `calls` carry `approved`; error results carry `errorKind`; the resume early-returns carry `no-session` / `nothing-pending` / `trust-changed` with `calls: []` | `runWithTrace` is not a function |
| 18 | bridged `details` merged: a 2 500-line `read` has `truncation.truncated`; `write` has `undefined`; both `read`s across a suspension keep their details in order | same |
| 19 | replay-served entries are excluded from error and suspended results (measured raw on main) | same |
| 20 | `changedNotice` names `/repl-accept-preamble` | text absent |
| 21 | carry-over 1: re-saving a withheld file in the same session refreshes `list_saved_tools` / `read_tool`; `acceptPreamble()` refreshes every live session; the live session still raises `NameError` | annotation stale |
| 22 | carry-over 2: an escaping `.pi/code-tools` symlink — nothing executes, the notice names "outside the project root", no "no longer in", manifest byte-identical, `acceptPreamble()` → `unreadable` | reported as removals; `accepted: []` |
| 23 | carry-over 3: `.pi` at mode 000 — trusted `run()` resolves with `[preamble unreadable]`, untrusted `run()` resolves, `acceptPreamble()` → `unreadable`, manifest untouched, silent again once readable (skips under root / win32) | rejects with `EACCES … realpath` |
| 24 | carry-over 4: store path is a regular file and the directory is at mode 000 — both `[preamble unreadable]` and `[preamble unverified]` | only the first |

**`test/toolstore.test.ts`**: 25 — loader `escaped` / `unlistable` for the two jail failures,
`savedToolNames` → `[]` without a throw; 26 — `onManifestChange` fires from `save_tool` and
`delete_tool` in a trusted project with a manifest (not without one, not untrusted); the
`acceptedSince` annotations in the list and the read NOTE.

**`test/bridge.test.ts`**: 27 — `onDetails` receives pi's own `details` for `read` (`truncation`)
and `edit` (`diff`, `patch`), reports `undefined` for `write`, and is not called when the tool
throws.

**GREEN**: `src/bridge.ts` (`onDetails`), `src/toolstore.ts` (view refresh hook, `acceptedSince`,
`escaped`, jail-failure handling), `src/repl.ts` (trace API, recorder, alignment, notices,
`acceptPreamble` refresh), `extensions/repl-extension.ts` (details, view, formatter, component,
command, wording), then `README.md` and `docs/tool-trace.md`.

## Boundaries

- Modify only: `extensions/repl-extension.ts`, `src/repl.ts`, `src/toolstore.ts`, `src/bridge.ts`,
  `test/extension.test.ts`, `test/repl.test.ts`, `test/toolstore.test.ts`, `test/bridge.test.ts`,
  `README.md`. Create only: `docs/tool-trace.md`, `tasks/spec-w2-1.md`, `tasks/ship-report-w2-1.md`.
- Never: `src/index.ts` (W2-3), `src/session.ts`, `src/sandbox.ts`, `src/types.ts` (W2-2),
  `coverage-baseline.json` (W2-3), `docs/project-trust.md`, `docs/truncation-policy.md`.
- Floors: extension 99.73, `src/repl.ts` 100, `src/bridge.ts` 99.77, `src/toolstore.ts` 98.90.
- `run()` / `resume()` output byte-identical; the 188 `test/repl.test.ts` call sites untouched.
- Unordered: no `seq`; the interleave with `stdout` is W3-1's.
- No new dependency; no GitHub issue comments; residuals are `todo` tests.
