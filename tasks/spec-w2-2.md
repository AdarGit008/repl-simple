# Spec — W2-2: Replay integrity and persistence hardening

Chunk: `w2-2` · Branch: `chunk/w2-2-replay-persistence` · Base: `main` (`e3c68da`) · Closes #61, #62,
#63, #58 · Decision IDs: D121–D132 · Maintainer decisions applied: 12, 13 (and 2 for the in-memory
precedence rule)

## Objective

Transcript replay stays (decision 12). Three things are wrong with it and one thing is missing:

- **#61** — every `run()` re-emits everything the transcript ever printed, and past the cap the
  stale output starves the new.
- **#62** — four cache-correctness defects (A14–A17) whose original text is lost; recover each from
  the code, fix or pin it, and write the recovered description down.
- **#63** — `Session.dump()` / `load()` are a public export with no schema, no size bound, and a
  `callCache` that a file can use to forge tool output and skip an approval prompt.
- **#58** — the bucket's exit criterion "each `repl` call reports only what that call produced".

Security first: a persisted session must never be able to grant an approval a human did not grant,
and the schema is written last, once, against the final dump shape — reject, never coerce.

## Current state, measured at `e3c68da` (2026-09-08, probes in the scratchpad)

- `src/session.ts:332-403` `run()` assembles `preamble + snippets + code` (`:338-341`), replays
  through `createCachingRegistry` (`:137-182`, positional cursor, `willReplayKey` at `:179`), and on
  suspension stores the raw result and **drops `newEntries`** (`:391-398`). `resume()` (`:455-567`)
  replays nothing (`:499-503`) and on success appends only its own `newEntries` (`:551`).
- `src/session.ts:618-638` `dump()` writes `{version: 1, snippets, callCache, suspended?,
  suspendedCode?, suspendedRunOpts?}`; `:667-708` `load()` checks only `version` (`:675-680`),
  assigns `snippets` (`:683`) and `callCache` (`:689`) unvalidated, restores the snapshot bytes
  unchecked (`:692`) and narrows `suspendedRunOpts` through `carriedRunOptions` (`:704`).
- `src/sandbox.ts:96-127` `DispatchAccumulators` — the `prior?.stdout` re-push at `:113` with the
  comment "Cross-call stdout semantics are #61's"; `:389-401` `makePrintCallback`, the one writer of
  stdout, unconditional `onPrint` then `acc.print`.
- `src/session.ts:833-884` `filterCachedCalls` is applied to `RunOk` only (`:390`); error and
  suspended results carry the replayed calls.
- **Measured** (probe `probe-w22.ts`):
  - stdout: `'alpha\n'`, `'alpha\nbeta\n'`, `'alpha\nbeta\ngamma\n'`; a run printing nothing returns
    the whole transcript; 300 KB then `IMPORTANT-NEW-OUTPUT` returns 32 751 bytes, truncated, the
    new line surviving only because the 25/75 tail keeps it.
  - A14: `n = int(counter()); bash(...)` suspend → approve → `run("n")` twice: counter executed
    **3** times, `n` reads **2** then **3**.
  - error trace after a prior `echo("a")`: `[["a"],["b"]]`; a resumed call's trace likewise carries
    the replayed `["a"]`.
  - poisoned dump `{callCache: [{key: 'bash::{"cmd":"rm -rf /"}', result: "FAKE-OUTPUT"}]}`:
    `run("print(out)")` → `ok`, stdout `FAKE-OUTPUT`, bash executions 0, dialogs **0**.
  - malformed dumps: `snippets: 5` → `TypeError: session.snippets is not iterable`; `callCache:
    "zzz"` accepted, `run()` later throws `TypeError`; an extra top-level key is accepted; `null`
    → `TypeError: Cannot read properties of null`.
  - inputs: run 1 with `{name: "Alice"}`, run 2 without → `typing` error with the location line
    dropped (it is in the prefix); run 2 with `{name: "Bob"}` → the replayed `y = name` reads Bob.
  - **two concurrent `resume()` calls on one suspension both return `ok` and the gated tool
    executes twice** from one approval.
  - a dump with a 100 KB string variable is 134 523 bytes; `Buffer.byteLength` over 100 MB takes
    87 ms.
- **Measured** (probe `probe-w22b.ts`, Monty 0.0.21 print callback): one callback per `print`,
  **except** a partial line (`end=""`) is held until the next newline-terminated print, a host-call
  boundary, or the end of the run (`print("a", end=""); print("b", end=""); print("c")` → one
  callback `"abc\n"`; `print("x", end=""); echo(); print("y")` → `["x", "y\n"]`), and a single
  large print arrives in **8 192-byte chunks** (100 000 `Z` → 13 callbacks). A partial straddling a
  gate is flushed at the gate in the original call (`["x"]` + `["y\n"]`) and at the same boundary in
  the replay (`["x", "y\n"]`).
- **Measured** (probe `probe-w22c.ts`): a garbage / truncated / bit-flipped / empty snapshot is a
  `runtime` RunError at resume (`RuntimeError: protocol violation: failed to load session: …`),
  never a throw. A dump whose `suspendedCall.description` says `gate(x='harmless')` while `args`
  say `x`: the dialog shows `harmless`, the tool runs with `x`.
- `src/rlm.ts:980-1016` `buildFeedback` is an if/else chain over `RunErrorKind` with no
  fall-through branch, and `test/rlm.test.ts:2799` enumerates every kind; neither file is this
  chunk's. `ReplRunner` never passes a `mount` (`grep mount src/repl.ts extensions/` → nothing).
- `test/session.test.ts:410-423` patches `String.prototype.split` by hand (#178 helper exists at
  `test/support/prototype-patch.ts`); `:1739` (`#84 test 5`) sets `suspendedRunOpts.signal = {}`
  and asserts only the outcome, so the narrowing branch is not discriminated; `:2007` is the
  1.2 s + 1.2 s under 2 s wall-clock test with 0.8 s of slack per segment.

## Decisions

- **D121 — stdout is de-duplicated by a byte mark, not an entry count (#61).** `Session` keeps
  `stdoutBytes[]`, one figure per retained snippet (the first includes whatever the preamble
  printed), and passes `RunOptions.stdoutSkipBytes = Σ` to `run()`'s sandbox call. The sandbox
  drops that many leading bytes of print output before either `onPrint` or the accumulator sees
  them, slicing a straddling callback at the mark; everything after is this call's. `Session`
  measures this call's bytes through its own `onPrint` wrapper (the unconditional stream, invariant
  6 of the truncation policy); a suspension carries the segment's figure and a resume adds its own,
  so a call is counted once whether or not it paused. The truncation budget therefore applies to
  the delta by construction. *Why bytes and not the brief's entries:* a prefix that ends in a
  partial line merges with the next call's output into one callback on replay (measured), so an
  entry count would swallow that output; a byte mark cuts it exactly, and it is indifferent to
  Monty's 8 KiB chunking.
- **D122 — the tripwire pins Monty's callback shape in `test/sandbox.test.ts`.** Per-print
  callbacks; a partial held to the next newline, a host boundary or the end; 8 192-byte chunks;
  and the mark measured identical across a gate in the original call and its replay. If an upstream
  bump changes any of these, the skip arithmetic is what breaks, and this is the test that says so.
- **D123 — A14: pre-gate calls are cached across a suspension.** The entries a run recorded before
  the gate travel with the suspension (`suspendedPreGate` in memory, `suspended.preGateCache` in the
  dump) and are appended ahead of the resume's own entries when the continuation succeeds; a nested
  re-suspension accumulates them. Recovered description: a call that executed for real before the
  gate was never cached, so every later replay re-executed it — its side effect repeated and any
  variable holding its result drifted.
- **D124 — A15: `inputs` are per-call, and the session says so when it matters.** Documented on
  `RunOptions.inputs` and in `docs/session-replay.md`: inputs are bound fresh on every call, a
  replayed snippet reads the *current* call's values (changing one changes what earlier code
  computed), values are never persisted and are absent from a dump. The one code change: the
  session records the input *names* its retained snippets ran with (memory only) and, when a later
  run omits any of them and fails, appends a note naming them — the typing error that otherwise
  results points at a prefix line the caller cannot see. Recovered description: an input was never
  session state; a snippet that read one silently reads whatever the next call binds, or fails
  when it binds nothing.
- **D125 — A16: a failed snippet leaves no replayed state, and every outcome's trace is this
  call's.** Pinned: an errored snippet is not retained, its cache entries are dropped, and its
  bindings are gone; its side effects happened and the trace reports them. What was wrong: the
  trace of an error, and of a suspension (hence of the resumed call), carried the replayed prior
  calls. `filterCachedCalls` is generalised to a `calls` filter and applied on all three outcomes.
  Recovered description: a snippet that raised was not cached — correct — but the caller was told
  the whole transcript's calls ran again, and could not tell which effects belonged to this call.
- **D126 — A17: caps, surfaced as a `RunError`, no new kind.** `MAX_SNIPPETS = 256`: `run()` refuses
  before anything runs (`unavailable` — nothing ran, the code is not the reason; its doc is widened
  to say so), the pending suspension is untouched, `reset()` is named. `MAX_CACHE_ENTRIES = 1024`:
  enforced inside the caching registry *before* the tool executes — the call that would exceed the
  cap raises a Python `RuntimeError` naming the limit, so the run fails `runtime`, no side effect
  happens, nothing is appended, and a replay meets the same refusal at the same position. `load()`
  rejects a dump beyond either cap. No new `RunErrorKind`: `src/rlm.ts`'s advice chain and its
  every-kind test are not this chunk's, and a kind no branch handles is the failure they guard.
  Recovered description: snippets and cache grew without bound, and the replayed transcript's
  stdout starved the new output (the #61 destructive case) — the latter is D121's.
- **D127 — dump v2, schema-validated, reject never coerce, 1 MiB.** `CURRENT_VERSION = 2`; any
  other version is refused (a v1 dump carries neither the stdout marks nor the pre-gate entries, so
  it cannot be restored faithfully). `validateSessionDump` is written last against the final shape:
  the input's byte length is checked against `MAX_DUMP_BYTES = 1 MiB` **before `JSON.parse`** (a
  100 MB snapshot is refused in tens of milliseconds); every object is closed (unknown keys
  rejected, `__proto__` included); every field typed; `stdoutBytes` parallel to `snippets`,
  non-negative integers; `callCache` entries `{key, result}` strings; the snapshot base64 by shape
  (alphabet, padding, length ≡ 0 mod 4); `suspended` requires `suspendedCode` and vice versa. No
  field is assigned until the whole object passes. `dump()` refuses to produce a dump over the
  bound. A snapshot's *contents* are Monty's to reject: measured, a garbage snapshot is a `runtime`
  RunError at resume, not a throw. The "narrowed on load" branch is gone; nothing in a dump is
  narrowed.
- **D128 — no approvals from a file.** Entries restored by `load()` are marked `restored` in memory
  (never serialised). The gate never treats a restored entry as a replay: a gated call reached in
  replay asks the user. If they approve, the tool runs for real and its real result replaces the
  file's in place — from then on the entry is the session's own and replays silently, exactly as
  an entry it recorded itself. Non-gated restored results are served as before (#63: restoring
  cached *results* is acceptable). The suspended call's `description` is display text derived from
  its arguments, so `load()` re-derives it from the live tool (`buildApprovalRequest`, now exported
  from `src/sandbox.ts`): a file cannot show one command and run another. Grants were never
  serialised and still are not.
- **D129 — a dump carries the run's state, not the host's policy.** `suspendedRunOpts` is not
  persisted: mounts are host paths and a capability (a file that names `/` and also supplies the
  code is a file that reads the user's disk); `limits` can say `"unbounded"`; the byte caps are the
  host's. All three come from whoever resumes a restored suspension, as `RunSuspended` already
  documents for `resumeSuspended`'s own callers, or from the defaults. The in-memory rule is
  unchanged: a suspension in the same process keeps its options and `resume()` merges caller-wins
  (decision 2, W1-2 D74). `ReplRunner` passes clamped `limits` and no mount either way, so the
  product loses nothing. W1-2 flagged the host paths for this chunk.
- **D130 — `dumpRedacted()` is the export/display mode (decision 13).** Same structure as the dump,
  passed through `src/redact.ts`: `maskSecrets` on snippets, cache keys (a `bash` command line),
  descriptions and trace errors; `redact()` head-only at 4 KiB on cache results and stdout; the
  snapshot is **omitted** (opaque interpreter state can hold a secret in a variable and no pattern
  can see it) and so are call arguments. It carries `redacted: true` and `load()` refuses it by
  name. `dump()` stays verbatim — the replay cache must serve what the tools returned — and
  `docs/session-replay.md` says it is as sensitive as the tool results it holds.
- **D131 — `run()` and `resume()` are serialised per session.** A queue makes concurrent calls
  behave exactly as sequential ones. Measured: two concurrent resumes on one suspension both
  approved and executed the gated call twice; concurrent runs assemble prefixes that do not include
  each other. The second of two resumes now waits and then meets the existing "No suspended
  execution to resume" (the first consumed it) — or resumes a re-suspension, as it would have
  sequentially. `test/repl.test.ts:1697` (#59) expects both of two concurrent runs to succeed, so
  rejection was not an option for `run()`.
- **D132 — tests and docs follow-ups.** The wall-clock test is restructured to be deterministic on
  the side that matters: 2.5 s of host time under the run's 5 s budget, then a trivial continuation
  resumed under a 2 s budget — per-segment it completes with 2 s to spare for a trivial resume;
  a budget that spanned the suspension would already be 0.5 s in the past and time out at once.
  The `String.prototype.split` patch uses `withPatchedPrototype` (#178). `docs/session-replay.md`
  is new and normative; `docs/approval-grants.md` and the two source comments lose the "when #40
  removes replay" framing and gain the restored-entry rule; `docs/truncation-policy.md` records
  that the stdout budget applies to the call's delta. The four recovered descriptions are posted on
  #62 (the only GitHub action).

## Tests — RED → GREEN plan

RED against `main`'s `src/` (fail before the fix, pass after). File `test/session.test.ts` unless
noted.

| # | Test | Why RED on main |
|---|---|---|
| 1 | #61 t1 own output only across three runs | transcript re-emitted |
| 2 | #61 t2 300 KB then a small print returns only the small line, untruncated | 32 751 bytes of Z |
| 3 | #61 t3 a run printing nothing returns empty stdout | whole transcript |
| 4 | #61 t4 the delta is what truncates | prefix fills the budget |
| 5 | #61 t5 reset resets the mark (two prints after a reset) | second re-emits the first |
| 6 | #61 suspend→resume: the call reports its whole output once; the next call none of it | re-emitted |
| 7 | #61 a prefix ending in a partial line: the merged callback is cut at the mark | `xy\n` |
| 8 | #61 `onPrint` streams only this call's output | replayed prints stream |
| 9 | #61 the mark survives dump/load | re-emitted after load |
| 10 | A14 pre-gate call cached across suspend/resume (count 1, `n` stays 1) | 3, drifts |
| 11 | A14 nested re-suspension accumulates; dump/load between suspend and resume carries it | dropped |
| 12 | A15 a later run that omits an input fails with a note naming it | bare typing error |
| 13 | A16 error trace and resumed trace carry only this call's calls | replayed calls present |
| 14 | A17 257th snippet refused `unavailable`, names 256 and reset, nothing ran | accepted |
| 15 | A17 1 025th cache entry refused inside the run, `runtime`, tool not executed, not appended | accepted |
| 16 | A17 `load()` rejects >256 snippets / >1024 entries | accepted |
| 17 | #63 malformed dumps (table) rejected with a clear error naming the field, never a TypeError | see measured |
| 18 | #63 oversize input refused before parse, fast | parsed |
| 19 | #63 poisoned gated cache entry: asked 1, executions 0, no forged stdout | ok/FAKE/0/0 |
| 20 | #63 approved restored gated call runs for real, replaces the entry, then replays silently | served |
| 21 | #63 round trip keeps snippets/results/suspension/mark, drops grants and the file's authority | authority kept |
| 22 | #63 `dumpRedacted()` masks and cuts, omits the snapshot; `load()` refuses it; `dump()` verbatim | no method |
| 23 | #63 a lying description is re-derived on load | lie shown |
| 24 | #63 `dump()` refuses >1 MiB | produced |
| 25 | D129 `suspendedRunOpts` / `signal: {}` / `mount: "/"` rejected; restored resume takes the caller's mount | narrowed |
| 26 | D131 concurrent resumes execute once; concurrent runs stack in order | twice |
| 27 | `test/sandbox.test.ts` `stdoutSkipBytes` drops N bytes before `onPrint` and the accumulator, slicing a straddler | option ignored |

Pins and guards (green on `main`; they fix the contract):

| # | Test | Guards |
|---|---|---|
| 28 | A15 changed input: replayed state follows the current call; a dump holds no input value | D124 wording |
| 29 | A16 failed snippet: bindings gone, calls not cached, not in the dump | D125 |
| 30 | `test/sandbox.test.ts` Monty callback shape: per-print, partial held, 8 KiB chunks, gate flush | D122 tripwire |
| 31 | wall clock per segment, restructured | D132 |

## Boundaries

- Modify: `src/session.ts`, `src/sandbox.ts`, `src/types.ts`, `test/session.test.ts`,
  `test/sandbox.test.ts`, `docs/approval-grants.md`, `docs/truncation-policy.md`. Create:
  `docs/session-replay.md`, this file, the ship report.
- `src/repl.ts` untouched: `formatOutcome` renders any `RunError`. No new `RunErrorKind` (D126).
- Floors: `src/session.ts` 98.73, `src/sandbox.ts` 97.66, `src/types.ts` 100; no
  `coverage-baseline.json` change.
- GitHub: one comment on #62 with the four recovered descriptions; nothing else.
- Out of scope, recorded: `abandon()`, `reset()`, `dump()` stay synchronous and are not queued
  behind an in-flight run (pre-existing; a caller that resets mid-run gets the pre-run state in the
  dump). A denied *restored* gated call during replay derails the cursor from that point exactly as
  a key mismatch always has (later calls execute for real, gated ones ask) — documented, not fixed.
