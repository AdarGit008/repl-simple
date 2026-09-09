# Spec — W3-1 Sandbox contract and output fidelity (#65, #69; epics #64, #40, #39)

Branch `chunk/w3-1-sandbox-output-contract` · Base `main` = `acadb19` · Decision range **D139–D150** ·
Maintainer decisions applied: **15** (Option A: `RunOk.output` always a string, `SUBMIT` rejects a
non-`str` with a Python `TypeError`, expression results via a budget-aware Python-style repr with
documented losses), **11** (`seq` arrives in wave 3), **9** (residuals are todo tests).

## Objective

Close the remaining bucket-8 work: the sandbox's output contract is enforced where the `RunResult`
is built, a Python value renders as a Python value, missing required arguments are a Python
`TypeError`, every host-tool call knows where in the run it happened, and the extension shows the
trace where it happened.

1. **#65** — `RunOk.output` is a string on every success path; `SUBMIT` with a non-`str` answer is a
   Python-visible `TypeError` (never an uncaught `ERR_INVALID_ARG_TYPE`, never an empty `ok`);
   `resolveToolArgs` raises for a missing required parameter.
2. **#69** — `formatOutput`'s `String(value)` becomes a budget-aware Python-style repr in
   `src/truncate.ts`; `ToolCallTrace` gains `seq` and `stdoutOffset`; `renderResult` interleaves;
   findings 2, 3 and 5 pinned against the shipped Monty.
3. **#64 / #40 / #39** — closing comments drafted in the ship report with every DoD item evidenced
   (no issue actions this chunk).
4. Wave-2 carry-overs: `TraceView.render(NaN)` guarded; the W1-3 shutdown-report todo implemented
   through the trace API.

## Current state, measured at `acadb19` (2026-09-08; probes in the scratchpad)

| What | Where | Finding |
|---|---|---|
| `formatOutput` | `src/sandbox.ts:633-636` | `String(value)`: `{'a': 1}` → `[object Map]`, `{}` → `[object Map]`, `{1,2}` → `[object Set]`, `[1,2,3]` → `1,2,3`, `True` → `true`, `(1, 2.0)` → `1,2` |
| `capOutput` | `:650-660` | `truncateText(text)` — `Buffer.byteLength(42)` throws `ERR_INVALID_ARG_TYPE` |
| SUBMIT sites | `:1132-1148` (dispatch), `:1440-1456` (resume prologue) | `capOutput(err.answer)` with `answer` cast, never checked |
| `resolveToolArgs` | `:690-715`; comment `:712` "caller handles optional/defaults" | no caller does: `echo(**{})` → `output "undefined"`; `SUBMIT(**{})` → **`ok`, output `""`, SUBMIT traced `ok: true`** |
| `param.name in kwargs` | `:700` | walks the prototype chain (W2-3 todo `test/resolve_tool_args.test.ts:138`) |
| `calls.push` sites | `:1051`, `:1095`, `:1133`, `:1153`, `:1173`, `:1429`, `:1441`, `:1459`, `:1475` | nine, all building the entry inline; no ordering field |
| `ToolCallTrace` | `src/types.ts:176-184` | `tool, args, kwargs, durationMs, ok, error?, approved?` |
| `RunOk.output` | `src/types.ts:217-225` | `string`, undocumented rendering |
| `SubmitSignal` | `src/submit_signal.ts:6-14` | `answer: string` by declaration only |
| Boundary shapes (0.0.21) | probe | dict → `Map`, set/frozenset → `Set`, list/tuple → `Array` (`()` → `[]`), `1.0` → `1`, `-0.0` → `0`, `1e400` → `Infinity`, `nan` → `NaN`, ints ≥ 2^53 → `bigint`, bytes → `Buffer`, `Exception('x')` → `{__monty_type__: "Exception", excType, message}`, `type(1)` → `{__monty_type__: "Type", value: "int"}`, `range`/lambda/instances → Monty's own repr string, a self-referential list → `["[...]"]` (Monty breaks the cycle itself) |
| Boundary cost | probe | `set(range(10**6))` crosses in 921 ms; `list(range(2*10**5))` in 167 ms |
| Type checker on SUBMIT | probe | `SUBMIT()` → `error[missing-argument]`, `SUBMIT(42)` / `**{'answer': None}` → `error[invalid-argument-type]` (D103's `-> None` stub) — the runtime cases need `**json.loads(...)` |
| Runtime SUBMIT | probe | `SUBMIT(**json.loads('{"answer": 42}'))` → **uncaught `ERR_INVALID_ARG_TYPE`**; `null` → `ok ""` |
| Print callback order | probe | `print("x", end="")` then `echo("b")`: the partial is flushed **before** the call reaches the dispatch loop, so the accumulator's byte count at a call is the stream position |
| Finding 2 | `test/sandbox.test.ts:2686` (D122 tripwire) | one callback per `print`, newline included — already pinned; the comments at `:101` and `:775-779` still describe 0.0.18's fragments |
| Finding 3 | probe | `print(file=sys.stderr)` → `TypeError`, `sys.stderr.write` / `sys.stdout.write` → `AttributeError`, `os.write` → typing `unresolved-attribute`, `warnings` → `unresolved-import`; `sys.stderr` exists as `<stderr>` |
| Finding 5 | probe | a `printCallback` returning `"not undefined"` / `42` **does not throw** on 0.0.21 — dissolved |
| Extension | `extensions/repl-extension.ts:185` "Unordered relative to `stdout` — the interleave is wave 3's"; `TraceCallView :226`; `buildDetails :407`; `formatTrace :470`; `TraceView.render :514` (`Math.max(1, Math.floor(NaN))` = `NaN` → unbounded loop); `renderTrace :549`; `CwdRunner.dispose :646`; shutdown `:958` | |
| Trace API | `src/repl.ts:180-215` `alignTrace` spreads `{ ...call }` | extra fields on an entry survive to `RunTrace.calls` |
| Dump | `src/session.ts:1127` writes `result.calls` verbatim; `:490-509` `traces()` is a **closed** validator (`closedObject`, "unexpected key") | any new enumerable key on a suspended call's trace entry makes `Session.load(session.dump())` throw (`test/session.test.ts:2344` round-trips one) |
| W1-3 todo | `test/extension.test.ts:2052` | `AbandonOutcome` carries no tool; `RunTrace.suspendedCall.tool` does |
| Policy doc | `docs/truncation-policy.md:24` "Structure-aware? no — blocked", `:62-75`, `:212-244` (Q4), `:341` | all written before the repr |

## Decisions

**D139 — Option A recorded on the type.** `RunOk.output` is documented as: the `SUBMIT` answer
verbatim when the run ended in `SUBMIT`, else the value of the last expression rendered by
`formatValue` (D140) — always a string, bounded by `maxOutputBytes`. `src/types.ts`.

**D140 — `formatValue` in `src/truncate.ts`: a budget-aware Python-style repr.** Scalars render as
Python spells them: `None`, `True`/`False`, integers (a safe-integral `number` or a `bigint`) as
digits, other numbers in JS's shortest form (`2.5`, `0.30000000000000004`, `1e+21`), `inf` /
`-inf` / `nan`; a `str` **inside a container** with Python's quoting (single quotes unless the text
holds a `'` and no `"`; `\\`, `\n`, `\r`, `\t`, `\xNN` for other controls, `\uXXXX` for a lone
surrogate); bytes as `b'…'`; list `[…]`, dict `{k: v}`, set `{…}` / `set()`; Monty's tagged records
as `ValueError('bad')` and `<class 'int'>`; a function or symbol as `<function>` / `<symbol>`; a
cycle as `[...]` / `{...}`. **A top-level `str` renders verbatim** (as today, and as `print` would):
the REPL's main use is inspecting text, a 10 KiB document as one escaped line is not an
improvement, and every existing consumer (`RlmResult.answer` salvage, 60 tests) reads it raw.
**Documented losses** (in the type doc and the policy): tuple → list, `1.0` → `1`, `-0.0` → `0`,
frozenset → set, `bytes` only (no `bytearray` in Monty), `1e400` → `inf` (Python's own literal is
`inf` too), a top-level `str` and its content collide (`'1'` and `1` both show `1` — inside a
container they do not), exponent spelling (`1.5e-7` vs Python's `1.5e-07`).
**Budget.** `formatValue(value, { maxBytes, recovery })` → `{ text, truncated }` with
`byteLength(text) <= maxBytes` always (invariant 1). A value that renders within the budget is
returned whole. Over it, the **outermost container** is elided *between its elements*: elements
are taken from the front and the back into a 50/50 split of the payload, whole or not at all, and
the gap is one marker in the policy's vocabulary —
`[1, 2, 3, [… 994 of 1000 elements elided. Assign the value to a name and slice it to see more. …], 999, 1000]`
(`entries` for a dict). A nested value is shown whole or skipped; a scalar (a long string, or a
container whose ends fit nothing) falls to the flat 50/50 cut. The one truncator is the floor under
every path: the structural text goes through `truncateText` last, so the ceiling holds by
construction. Rendering work is bounded by the cap (the walker stops appending past it), so a
10⁶-element set costs the boundary crossing, not the repr. `pythonTypeName(value)` (`NoneType`,
`bool`, `int`, `float`, `str`, `bytes`, `list`, `dict`, `set`, `type`, an exception's class, …) is
exported beside it for the `TypeError` messages.
**Fix round 1 (verifier finding).** The bound above was false for one shape: a container dominated
by a single huge scalar. `Repr.scalar` spelled a `str`/`bytes` in full (a per-code-point `+=`
loop) before `push` checked the cap, and the two fallbacks — `elideContainer`'s zero-fit branch and
`formatValue`'s scalar branch — rendered the same value whole for the flat cut, so `['x' * 10**7]`
cost four full passes: 3.5 s (main: 159 ms), 42 s for `10**8`, synchronous on the host thread
after Monty had finished. Now: (1) a `str`/`bytes` is spelled at most `cap - used + 1` code units
from the chosen end — enough to overflow, never more — by one regex scan (`\p{Cc}`, `\p{Cs}`,
the quotes, the backslash) instead of the loop; (2) `Repr` walks a value from its tail when asked
(`fromEnd`: the same pieces in reverse, last elements first, a string from its end), and
`reprEnds` renders head and tail under the cap for the flat cut — the whole is never spelled, so
that cut claims no total (`[… truncated at 16.0KB. … …]`, the path-5 marker) rather than an
`X of Y` it could only know by doing the forbidden work; (3) a dict's huge entry descends through
its value behind its key (`{'k': [0, 1, 2, [… N of 10⁶ elements elided …], …]}`) instead of the
flat fallback. Measured through `runInSandbox`: `['x' * 10**7]` 3495 → 136 ms, `{'k': 'x' * 10**7}`
3139 → 58 ms, `{'k': list(range(10**6))}` 624 → 392 ms (the crossing), `['x' * 10**8]` under a
second; isolated `formatValue` 3692 → 11 ms and 38 711 → 94 ms. The policy's "Elision" rules 3–4
and its bounded-work sentence are rewritten to what is now true.

**D141 — The SUBMIT guard lives where the signal is caught.** `SubmitSignal.answer` is typed
`unknown` (the `as string` in `rlm_tools.ts` was the lie; that file is not owned, and the type now
tells the truth without it). Both catch sites route through one helper: a string answer is the
`ok` result with `capOutput(answer)`; anything else is traced `ok: false` with
`SUBMIT() answer must be str, not <pytype>` and re-raised into Python as a `TypeError`, exactly as
a resolution failure is. `runRlm`'s `submitted` condition already requires `ok`, so a rejected
SUBMIT reaches the next iteration as feedback and never becomes the answer. A missing `answer`
never reaches the guard: D142 refuses it first.

**D142 — Required parameters are enforced in `resolveToolArgs`.** After binding, a parameter with
neither a positional nor a keyword and no `optional: true` is a `HostToolError("TypeError")` with
CPython's wording: `add() missing 1 required positional argument: 'a'`,
`… 2 required positional arguments: 'a' and 'b'`, `… 'a', 'b', and 'c'`. Keyword presence is
`Object.hasOwn` (the W2-3 todo becomes a real test). The type checker already refuses the direct
forms; this closes `**kwargs` and `*args`. Every caller is already in a `try`
(`src/session.ts` `keyFor` / `withoutReplayedCalls`; `alignTrace` resolves ok entries only).

**D143 — `seq` and `stdoutOffset` on every entry, assigned in one place.**
`DispatchAccumulators.record(entry)` is the only way an entry enters `calls`: it stamps `seq` (a
per-run counter, strictly increasing across every push site, continuing after the carried entries
on a resume — `max(seq)+1`, or the carried count for entries restored from a dump) and
`stdoutOffset` (the accumulator's byte total at that moment: this call's own stdout, after the
replay mark, before truncation — the partial line Monty flushes at a host boundary is already in
it, measured). Both fields are optional in the type (the dump validator and every test literal
build entries without them) and always present on an entry the sandbox produced. Replay filtering
leaves gaps; the order is what matters. **Not serialised:** the entry carries a non-enumerable
`toJSON` that returns the validator's shape, because `Session.dump()` writes `result.calls`
verbatim and `Session.load()`'s closed validator (`src/session.ts`, W3-2's file) refuses an
unknown key — without this, a suspended session with a pre-gate call could not be reloaded
(`test/session.test.ts:2344`). In-process round trips (`{ ...call }`, `structuredClone`,
`deepEqual`) keep the fields. A todo test records the intended end state: widen the validator's
optional keys and delete the `toJSON`.

**D144 — `renderResult` interleaves by position.** `TraceCallView` carries `seq` and
`stdoutOffset`; `ReplDetails.stdoutSpan` is the `[start, end)` of the stdout section of the result
text, computed at execute time by `buildDetails` from `trace.text` and `trace.status` (`ok`: up to
the last `\n[result]\n`, after the discard notice when `trace.discardedSuspension` says there is
one; `error`: after `\n\n[stdout]\n`; `suspended` and the rest: none — the text has no stdout).
Expanded, `renderTrace` places each call with an offset at that byte of the section: at a line
start, before that line; inside a line, after it (a call inside a partially printed line is shown
after the line completes); at the end, after the last line. Only the **verbatim head** of a
truncated stdout takes calls — offsets at or past the first marker line (`[… … …]`) are not
placed. The trailing `[trace] N host-tool call(s), K shown in place` block lists what was not
placed, the omitted count and the waiting call. Collapsed output is unchanged, and so is every
existing `formatTrace` line. The model-facing text is untouched.

**D144, fix round 1.** `interleave`'s byte→index map walked `head` per UTF-16 code unit, so an
astral character (an emoji: two units, four bytes) counted as six and every offset past one missed
its boundary — the call fell to the unplaced list. The walk is per code point now; pinned by "an
offset past an astral character still lands".

**D145 — `TraceView.render` width guard.** A width that is not finite or is below 1 renders at 80
columns (`DEFAULT_COLUMNS`), never loops.

**D146 — The shutdown report names the tool.** `CwdRunner` remembers, per session id, the tool of
the last suspended result (`RunTrace.suspendedCall.tool`, set by `repl` / `repl_resume`, cleared by
any other status and by `repl_reset` / `repl_abandon`); `dispose()` returns `{ sessionId, tool? }`
and the notice reads `… still had a 'write' call waiting for approval …`. The name only — never the
arguments, which can hold a pasted credential (W1-3's own rule).

**D147 — #69 findings 2, 3 and 5 pinned against the shipped Monty.** Finding 2 is the D122
tripwire already at `test/sandbox.test.ts:2686`; the two stale 0.0.18 comments (`:101`, `:775-779`)
are corrected to point at it. Finding 3: one test per form — `print(file=sys.stderr)` is a
`TypeError`, `sys.stderr.write` / `sys.stdout.write` an `AttributeError`, `os.write` and `warnings`
refused by the checker — each an error result with empty stdout: there is no error channel, and
nothing here must ever build on one. Finding 5: **dissolved** on 0.0.21 — a raw-Monty tripwire
shows a callback returning a value is tolerated, and the callback's comment records it as a
measured fact rather than a rule.

**D148 — Comment sweep of the owned files (#86 ledger in the PR body).** `src/sandbox.ts:712`
("caller handles optional/defaults"), the `formatOutput` / `capOutput` docs, the print-callback
note, `extensions/repl-extension.ts:185`, the two test comments, `src/types.ts` `ToolCallTrace`,
`src/submit_signal.ts`.

**D149 — `docs/truncation-policy.md` reconciled.** The decision table row becomes "yes — between
the elements of the outermost value"; Q4's "blocked" becomes the implementation record; M6/M7 and
the Q4 table are marked historical with the shipped rendering beside them; the non-goal is
removed; a "Value rendering" section records D140's rules and losses; the implementation table
gains the `output` repr row.

**D150 — Epics closed by evidence, not by this chunk.** #64's table row for #69 is narrowed to the
documented-loss property; #40's remaining legs and its memory-guard DoD item are answered with the
existing evidence; #39 is a ledger. All three closing comments are drafted in the ship report with
test `file:line` evidence; the orchestrator posts them after merge.

## Tests — RED → GREEN plan

RED against `main`'s `src/` + `extensions/` unless marked as a pin. New symbols are read off
namespace imports so every file still loads against `main` and fails per test, not at link time.

| # | Test (file) | Why RED on main |
|---|---|---|
| 1 | typeof-string property over every success path — dict / list / set / bool / None / int / tuple / bytes / SUBMIT, through `runInSandbox` and `resumeSuspended` — with the *rendered* shape (`sandbox`) | `[object Map]`, `1,2,3`, `true`, uncaught throw |
| 2 | `SUBMIT(**json.loads('{"answer": 42}'))` → `RunError` (`runtime`, `TypeError: SUBMIT() answer must be str, not int`), SUBMIT traced `ok: false`; the same for `[1, 2]`, `{"a": 1}`, `true`, `1.5` (`sandbox`) | `ERR_INVALID_ARG_TYPE` escapes |
| 3 | `SUBMIT(**json.loads('{"answer": null}'))` and `SUBMIT(**{})` are errors, never an empty `ok`; the resume prologue too (`sandbox`) | `ok ""` |
| 4 | `SUBMIT()` / `SUBMIT(42)` / `**{'answer': None}` refused by the checker (`sandbox`, **pin**) | green: D103 |
| 5 | missing required parameter on `echo` (`**{}`, `*[]`) → Python `TypeError` with CPython's wording, traced `ok: false` (`sandbox`) | `output "undefined"` |
| 6 | `resolveToolArgs`: the two "flips" flipped; 1/2/3 missing wording; optional still omitted; `Object.hasOwn` (the un-todo'd test) (`resolve_tool_args`) | absent key / prototype walk |
| 7 | `formatValue`: scalars, quoting rules, bytes, nested `{'a': (1, 2.0), 'b': [None, True]}` → `{'a': [1, 2], 'b': [None, True]}`, `Map()` vs `Map([['a',1]])`, `set()`, tagged records, cycle, function, top-level str verbatim, `pythonTypeName` table (`truncate`) | no export |
| 8 | `formatValue` budget: a 1 MB list elided between elements with the marker, both ends kept, ≤ `OUTPUT_MAX_BYTES`; a dict likewise (`entries`); a long string flat-cut; a container whose first element is huge; exactly-at-cap fits whole, one byte over elides; the ceiling holds for a range of budgets and shapes; `maxBytes: 0` is `""` + truncated; work bound on a 10⁶-element set (`truncate`) | no export |
| 9 | through the sandbox: `list(range(300000))` → elided output under `OUTPUT_MAX_BYTES` with a marker and `outputTruncated: true`; `x = 'hi'; x` still `hi` (**pin**) (`sandbox`) | flat `0,1,2,…` |
| 10 | `seq` strictly increasing over the nine push sites (ok, tool throw, denied, resolution failure, SUBMIT; resume approved / denied / thrown / SUBMIT), preserved across `resumeSuspended`, `stdoutOffset` equals the bytes printed before the call (partial line included), `toJSON` drops both, `{ ...call }` keeps them (`sandbox`) | fields absent |
| 11 | replay filtering keeps `seq`: an entry array filtered by an arbitrary predicate stays strictly increasing (the property the filter must preserve) (`sandbox`) | fields absent |
| 12 | `SubmitSignal` message for a string and a non-string answer (`sandbox`, 100 % floor) | message shape |
| 13 | `buildDetails` carries `seq` / `stdoutOffset` / `stdoutSpan`; `stdoutSpan` per status and with a discard notice; `renderResult` interleaves at a line start, inside a line, at the end, and with several calls at one offset; a truncated stdout places only head calls; collapsed unchanged; end-to-end through `repl.execute` with `print` / `list_saved_tools()` / `print` (`extension`) | no span, no interleave |
| 14 | `TraceView.render(NaN)` / `0` / `-5` / `Infinity` return within 80 columns promptly (`extension`) | loops until it throws |
| 15 | the shutdown report names the tool (`extension`, the W1-3 todo un-todo'd) | no name |
| 16 | finding 3 forms (`sandbox`, **pin**), finding 5 raw tripwire (`sandbox`, **pin**) | green: measured facts |
| 17 | `docs/truncation-policy.md` says structure-aware `output` elision shipped (`truncate`, RED by commit order only — docs are not swapped) | wording |

Residual (todo, decision 9): `seq` / `stdoutOffset` survive `JSON.stringify` (a `Session` dump) —
intended approach: `src/session.ts` `traces()` accepts them as optional finite numbers, then the
`toJSON` in `src/sandbox.ts` is deleted.

## Boundaries

- Owned: `src/sandbox.ts`, `src/types.ts`, `src/truncate.ts`, `src/submit_signal.ts`,
  `extensions/repl-extension.ts`, `test/sandbox.test.ts`, `test/truncate.test.ts`,
  `test/extension.test.ts`, `test/resolve_tool_args.test.ts`, `docs/truncation-policy.md`; created:
  `tasks/spec-w3-1.md`, `tasks/ship-report-w3-1.md`.
- Not touched: `src/rlm_tools.ts` (`as string` stays; the type is honest without it),
  `src/session.ts` (validator, replay filter — W3-2), `src/repl.ts`, `src/index.ts`,
  `coverage-baseline.json` (no floor changes; every owned file stays at or above its floor).
- No issue comments; no new dependencies; no change to the model-facing result text.
