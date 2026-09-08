# Ship Report — W3-1: Sandbox contract and output fidelity (#65, #69; epics #64, #40, #39)

Branch: `chunk/w3-1-sandbox-output-contract` · Base: `main` (`acadb19`) · Commits: `fb3577e` (spec) ·
`833dbac` (RED) · `cf97518` (GREEN) · `bbd2e85` (report) · fix round 1: `7964278` (RED) · `88aa7bc`
(GREEN) · this report · Spec: `tasks/spec-w3-1.md` (D139–D150, fix-round notes under D140 and D144) ·
Maintainer decisions: 15, 11, 9 · Decision: **GO**

## What was built

The remaining bucket-8 work: the sandbox's output contract is enforced where the `RunResult` is
built, a Python value renders as a Python value, a missing required argument is a Python
`TypeError`, every host-tool call knows where in the run it happened, and the extension shows the
trace where it happened.

1. **`src/truncate.ts` — `formatValue`, a budget-aware Python-style repr (D140).** `formatValue`
   (`:831`) spells what crossed the boundary as Python would — `{'a': 1}`, `[1, 2]`, `{1, 2}`,
   `set()`, `True`, `None`, `b'..'`, `inf`/`nan`, `ValueError('bad')`, `<class 'int'>`, Python's
   string quoting and escapes inside a container (`reprString` `:513`, `reprBytes` `:532`), a bare
   `str` verbatim — and, over the budget, elides *between the elements of the outermost value*
   (`elideContainer` `:742`): `[0, 1, 2, [… 299994 of 300000 elements elided. Assign the value to a
   name and slice it to see more. …], 299998, 299999]`. Every path ends in `truncateText`, so
   invariant 1 holds by construction; the renderer (`Repr` `:554`) stops appending past the cap, so
   the work is the budget's, not the value's. `pythonTypeName` (`:426`) names types for the
   `TypeError` messages. The boundary's losses are documented, not hidden (tuple → list, `1.0` → `1`,
   frozenset → set, a bare `str` verbatim).
   **Fix round 1.** The bound was false for a container dominated by one huge scalar: the scalar
   was spelled in full (a per-character loop) up to four times before the flat cut — `['x' * 10**7]`
   3.5 s, `['x' * 10**8]` 42 s, synchronous on the host thread after Monty had finished. Now a
   `str`/`bytes` is spelled one code unit past the cap and no further, by a regex scan
   (`STRING_ESCAPES` `:473`, `bounded` `:497`); `Repr` walks a value from its tail when asked
   (`fromEnd`), and both fallbacks render head and tail under the budget (`reprEnds` `:681`) — the
   whole is never spelled, so that flat cut claims no total (`[… truncated at 16.0KB. … …]`); a
   dict's huge entry descends through its value behind its key. Measured through `runInSandbox`:
   `['x' * 10**7]` 3495 → 136 ms, `{'k': 'x' * 10**7}` 3139 → 58 ms, `['x' * 10**8]` 41.7 s →
   936 ms (main: 1057 ms — the crossing).
2. **`src/sandbox.ts` — the contract at the three `RunOk` sites (D139, D141, D142, D143).**
   `renderOutput` (`:704`) replaces `formatOutput` + `capOutput` at the expression site and both
   SUBMIT sites. `submittedAnswer` / `toolFailure` (`:726`, `:736`) guard both SUBMIT catch sites: a
   non-`str` answer is traced `ok: false` and re-raised into Python as `TypeError: SUBMIT() answer
   must be str, not int` — never the uncaught `ERR_INVALID_ARG_TYPE` it was, never an `ok` with an
   empty output. `resolveToolArgs` (`:790`) enforces required parameters with CPython's wording and
   uses `Object.hasOwn` (W2-3's residual closed). `DispatchAccumulators.record` (`:161`) is the one
   way an entry enters `calls` — the nine push sites (`:1167`–`:1593`) all go through it — stamping
   `seq` (per-run, strictly increasing, continuing after carried entries on a resume) and
   `stdoutOffset` (the accumulator's byte total at the call, partial line included). Entries carry a
   non-enumerable `toJSON` (`persistedTrace` `:96`) that yields the dump validator's shape, because
   `Session.load()`'s closed validator (`src/session.ts`, W3-2's file) would refuse the new keys.
3. **`src/submit_signal.ts`** — `answer: unknown`; the message names the Python type of a non-string.
4. **`src/types.ts`** — Option A recorded on `RunOk.output` (`:241`); `ToolCallTrace.seq` /
   `stdoutOffset` (`:203`, `:205`) documented, optional in the type, always present on a sandbox
   entry.
5. **`extensions/repl-extension.ts` — the interleave (D144), the width guard (D145), the shutdown
   name (D146).** `TraceCallView` carries `seq` / `stdoutOffset`; `ReplDetails.stdoutSpan` is the
   stdout section of the result text, computed at execute time by `buildDetails` from `stdoutSpan`
   (`:453`: ok → up to the last `\n[result]\n`, after a discard notice when the trace says there was
   one; error → after `\n\n[stdout]\n`; the rest → none). `interleave` (`:598`) places each call at
   its byte of the section — before a line it starts, after a line it lands inside, last at the end;
   only the verbatim head of a truncated stdout takes calls — and `renderTrace` (`:711`) lists what
   could not be placed under `[trace] N host-tool call(s), K shown in place`. Collapsed output and
   every `formatTrace` line are unchanged; the model-facing text is untouched.
   `TraceView.render` renders at `DEFAULT_COLUMNS` for a width that is not finite or below 1
   (`NaN` used to grow the output until `Invalid array length`). Fix round 1: the byte→index map
   (`:621`) walks per code point — an emoji counted as six bytes, not four, so every offset past
   one went unplaced. `CwdRunner` remembers the waiting
   tool per session off `RunTrace.suspendedCall` (`noteOutcome` `:822`, `forget` `:829`,
   `dispose` `:842`) and the shutdown report reads `still had a 'write' call waiting for approval`
   (`:1167`) — the name only, never the arguments.
6. **`docs/truncation-policy.md` (D149).** The decision table row reads "yes — between the elements
   of the outermost value"; Q4 is resolved with its reasoning kept; M6/M7 marked historical; the
   non-goal narrowed; a normative **Value rendering** section (spelling table, documented losses,
   the elision rules); the implementation record gains the row.
7. **Pins for #69 findings 2, 3, 5 (D147).** Finding 2 was already the D122 tripwire; its two stale
   0.0.18 comments in `test/sandbox.test.ts` are corrected. Finding 3: five stderr forms, each an
   error result with empty stdout. Finding 5: **dissolved** — a raw-Monty tripwire shows a callback
   returning a value is tolerated on 0.0.21.

## Verification evidence

**RED** (`833dbac`, run against `main`'s `src/` + `extensions/`, `REQUIRE_BRIDGE_TOOLS=1` for the
extension file):

| File | tests | pass | fail | todo |
|---|---|---|---|---|
| `test/truncate.test.ts` | 70 | 39 | **31** | 0 |
| `test/resolve_tool_args.test.ts` | 17 | 13 | **4** | 0 |
| `test/sandbox.test.ts` | 203 | 159 | **43** | 1 |
| `test/extension.test.ts` | 101 | 88 | **13** | 0 |

(At `HEAD` the sandbox figure is **44**: the GREEN commit moved the pre-existing #34 pin "keeps
both ends of the value, 50/50" to the repr's shape, and it fails on `main` too.)

Every fail is a new or flipped test. Controls green on `main` by design and marked so in place: the
type-checker refusals (`SUBMIT()` / `SUBMIT(42)` / `**{'answer': None}`, #65 test 5), the finding-3
and finding-5 measured facts, collapsed rendering, the stale-span fallback, "an abandoned or reset
suspension is not reported", and the surplus-argument pins. The docs pins are RED by commit order
only (docs are not swapped). Four `formatValue` tests were added in the GREEN commit for the
branches the first cut did not reach (nested descent, its depth, a dict's huge entry, the
too-small-for-a-marker budget) — RED on `main` by the same missing export.

**GREEN** (`cf97518`): truncate 74/74 · resolve 17/17 · sandbox 202 pass / 0 fail / 1 todo ·
extension 101/101. Three pre-existing expectations moved with the contract, all in owned files: the
#34 list pin (`test/sandbox.test.ts:2006`, `0,1,2,3` → `[0, 1, 2, 3`), the `onPrint` assertion
tightened to the 0.0.21 shape (`:783`), one span offset off by one and two shape expectations in the
RED set corrected.

**Gates at `cf97518`:** `npm run check` clean · `npm run lint` (biome + knip) clean ·
`npm run coverage`: all per-file floors met — `src/truncate.ts` 99.87 against a 100.00 floor
(within the instrument's one-line tolerance, `scripts/coverage.mjs` #113; the first edition of this
report said 100.00 — corrected), `src/types.ts` 100.00, `src/submit_signal.ts` 100.00,
`src/sandbox.ts` 97.90 (floor 97.66), `extensions/repl-extension.ts` 99.85 (floor 99.73),
`src/rlm_tools.ts` 100.00 (99.22), `src/session.ts` 99.46 (98.73); no `coverage-baseline.json`
change · `npm run test:contained` (`REQUIRE_BRIDGE_TOOLS=1`): **1637 tests, 1625 pass, 0 fail, 12
todo** · CI: `gh pr checks --watch`, all legs including both macOS legs — recorded in the PR.

**Fix round 1** (verifier: the repr spelled a huge scalar whole, up to four times). **RED**
(`7964278`, against the branch's own `src/` + `extensions/` at `bbd2e85`): `test/truncate.test.ts`
84 tests / **10** fail (four work-bound tests at 1.4–3.5 s against a 500 ms bound; six shape tests on
the no-total marker, the real tail, the dict-entry descent, the huge key, the top-level exception) ·
`test/extension.test.ts` 102 / **1** fail (an offset past an emoji went unplaced). Two shapes added
to the boundary table (`one huge element`, `one huge entry`) extend an existing test. **GREEN**
(`88aa7bc`): truncate 84/84 · extension 102/102 · sandbox and resolve unchanged. Gates: `check` ·
`lint` · `coverage` — `src/truncate.ts` **100.00**, `extensions/repl-extension.ts` 99.85, every
floor met, no baseline change · `REQUIRE_BRIDGE_TOOLS=1 npm run test:contained`: **1648 tests,
1636 pass, 0 fail, 12 todo**.

**Measured on 0.0.21** (probes in the session scratchpad, recorded in the spec): a dict arrives as a
`Map`, a set/frozenset as a `Set`, a list/tuple as an `Array`, `1.0` as `1`, `-0.0` as `0`, `1e400`
as `Infinity`, ints ≥ 2^53 as `bigint`, bytes as `Buffer`, `Exception('x')` as
`{__monty_type__: "Exception", excType, message}`, `type(1)` as `{__monty_type__: "Type", value}`,
a self-referential list as `["[...]"]`; `set(range(10**6))` crosses in 921 ms; the partial line
`print("x", end="")` is flushed before the following call reaches the loop; a `printCallback`
returning `"not undefined"` is tolerated.

### Adversarial probes (how a reviewer reproduces them)

- **Every JS shape through both SUBMIT sites and the expression path**:
  `test/sandbox.test.ts:3036` (six `**json.loads` shapes → `RunError` naming `int` / `float` /
  `list` / `dict` / `bool` / `NoneType`), `:3094` (the resume prologue), `:2908` (the 25-row table
  of expression renderings). On `main`: `npx tsx -e` with
  `runInSandbox("import json\nSUBMIT(**json.loads('{\"answer\": 42}'))")` throws
  `ERR_INVALID_ARG_TYPE`.
- **`SUBMIT(**{})` and `answer: null`**: `:3072`, `:3036` — both `RunError`, never an empty `ok`.
- **A self-referential structure**: `:2959` (through the sandbox — Monty breaks the cycle),
  `test/truncate.test.ts:565` (a JS cycle, `[[...]]` / `{'s': {...}}` / `{{...}}`).
- **A 10⁶-element set**: `test/truncate.test.ts:807` (formats within budget, < 2 s asserted,
  measured ≈ 40 ms). Through the sandbox the cost is the boundary crossing (0.9 s).
- **A 10 MB scalar inside a container** (fix round 1): `test/truncate.test.ts` "the work is bounded
  by the budget" — a string in a list, in a dict, as bytes, as an exception's message, each under
  500 ms (measured 8–20 ms; 1.4–3.7 s before). Reproduce through the sandbox with
  `runInSandbox("['x' * 10**7]", { registry })` timed: 136 ms on this branch, 3.5 s at `cf97518`,
  159 ms on `main`; `['x' * 10**8]` 936 ms / 41.7 s / 1057 ms. The marker for that cut is the
  path-5 no-total form (`[… truncated at 16.0KB. … …]`) — pinned in "a value spelled from both
  ends claims no total", with the real tail (`\n\t'end"]`, `\x00\xff\n']`, `', [...]]}` for a
  cyclic value) and the dict-entry descent
  (`{'k': [0, 1, 2, [… N of 100000 elements elided. … …], …, 99999]}`).
- **Boundary mutants on the repr's byte limits** (`test/truncate.test.ts:750-805`): six shapes fit
  whole at exactly their own byte size and are cut at one byte less; the ceiling, UTF-8 wholeness
  and marker completeness hold at budgets `0, 1, 7, 8, 16, 33, 64, 100, 257, 1024, 4096, 16384`.
  A `>=` for `>` in `Repr.push`'s overflow test, or an off-by-one in `elideContainer`'s reserve,
  fails `:760` or `:777`.
- **seq preserved across `resumeSuspended` and replay filtering**: `:3292` (whole-run numbering),
  `:3369` (entries restored without the fields continue from their count), `:3426` (any filter
  keeps the order strictly increasing — the property the W3-2 filter must preserve).
- **`renderResult` interleaves by seq**: `test/extension.test.ts:2830` (line start / inside a line /
  end), `:2850` (several at one offset, seq order), `:2894` (error result), `:2913` (truncated
  stdout: head only), `:2999` (end to end through `repl.execute` with a real `list_saved_tools()`
  between two prints; the model-facing text pinned byte-for-byte).
- **`render(NaN)`**: `:3040` — before, 20 s then `RangeError: Invalid array length`.

## Residuals as todo tests

- `test/sandbox.test.ts:3448` — *`seq` and `stdoutOffset` survive JSON serialisation, so a Session
  dump keeps the ordering.* `src/session.ts` `traces()` is a closed validator and `dump()` writes
  `result.calls` verbatim, so the entries hide the two fields from JSON to keep a suspended session
  loadable (`test/session.test.ts:2344` round-trips one with a pre-gate call). Intended approach:
  the validator accepts both as optional finite numbers, then the `toJSON` in `src/sandbox.ts`
  (`persistedTrace`) is deleted — a one-line change on each side, for the owner of `src/session.ts`.

Documented bounds, not tests: the interleave is best effort by construction (`stdoutSpan` reads the
shapes `formatResult` produces, and a print can imitate any marker — a wrong span misplaces trace
lines in a display, never changes what ran or what the model was told); a call inside a partially
printed line is shown after the line completes; the head-only cut below ~80 bytes may split an
element (the marker claims no total there).

## Needed outside this chunk (not touched — file ownership)

- **`src/session.ts` `traces()`** (W3-2): accept `seq` / `stdoutOffset` as optional finite numbers;
  then delete `persistedTrace` and the `toJSON` in `src/sandbox.ts` and un-todo the test above.
- **`src/rlm_tools.ts:107`** (`const answer = _args.answer as string`): the cast is now cosmetic —
  `SubmitSignal` takes `unknown` — and can go when that file is next touched.
- **`docs/tool-trace.md`** (not owned): still says the trace is unordered relative to `stdout`; one
  sentence for its owner.

## Comment sweep of the owned files (#86 ledger)

Files checked: 10. Comments corrected: 12 · deleted: 2 · claims turned into named tests: 3.

| File | What | Disposition |
|---|---|---|
| `src/sandbox.ts:712` | "If neither, param is left undefined (caller handles optional/defaults)" — no caller did | **deleted**; the behaviour is now the enforcement, documented on `resolveToolArgs` |
| `src/sandbox.ts` `formatOutput` / `capOutput` docs | described `String(value)` and a string-only cap | replaced by `renderOutput`'s |
| `src/sandbox.ts` SUBMIT-site comments | "SubmitSignal — clean termination" for every signal | now "with a str answer", the other branch named |
| `src/sandbox.ts` `makePrintCallback` | nothing said about the return contract (#69 finding 5) | measured fact added, pointing at the tripwire |
| `src/types.ts` `ToolCallTrace` / `RunOk` | one-line docs; `output: string` undocumented | the contract and the ordering fields documented |
| `src/submit_signal.ts` | "returns `{ output: answer }`" with `answer: string` by declaration only | rewritten: `unknown`, the sandbox enforces |
| `extensions/repl-extension.ts:185` | "Unordered relative to `stdout` — the interleave is wave 3's" | corrected to the shipped ordering |
| `extensions/repl-extension.ts` shutdown | "The session id and nothing else" | "and the tool's name" |
| `test/sandbox.test.ts:101` | "Monty calls printCallback once per print, no trailing newline" — false on 0.0.21 | corrected, points at the D122 tripwire |
| `test/sandbox.test.ts:775-779` | "Monty sends newlines as separate callbacks: ('a','\n','b','\n')" — 0.0.18 | corrected; assertion tightened to the measured shape |
| `test/resolve_tool_args.test.ts` header / "today's behaviour" sections | described the pre-#65 state as current | rewritten for the contract; the prototype todo's reason **deleted** (fixed) |
| `test/extension.test.ts:2052` | the W1-3 todo reason ("src/repl.ts is W1-2's file this wave") | implemented through the trace API; reason gone |
| `docs/truncation-policy.md:24`, Q4, non-goals, M6/M7 | "blocked on #69" | resolved; historical text marked as such |

Claims → tests: "one callback per print" (already the D122 tripwire; the comments now say so), "stderr
unreachable" (`test/sandbox.test.ts:3466`), "the print callback must return undefined" (`:3499`,
measured false and pinned as such).

## Rollback plan

| Commit | Reverts |
|---|---|
| this report | `tasks/ship-report-w3-1.md`, `tasks/spec-w3-1.md` (fix-round notes) |
| `88aa7bc` | fix round 1 GREEN — the bounded repr, `reprEnds`, the dict-entry descent, the policy's rules 3–4, the per-code-point byte map (revert together with `7964278`) |
| `7964278` | fix round 1 RED tests |
| `bbd2e85` | the first report |
| `cf97518` | GREEN — the repr, the SUBMIT guard, required parameters, `seq` / `stdoutOffset`, the interleave, the width guard, the shutdown name, the policy doc (revert together with `833dbac` or the suite goes red) |
| `833dbac` | the RED tests |
| `fb3577e` | the spec |

`git revert <report> 88aa7bc 7964278 bbd2e85 cf97518 833dbac fb3577e` (newest first) returns to
`acadb19`.

## Closing-comment drafts (for the orchestrator, after merge)

**#65** — Closed by W3-1. The contract decision is recorded on `RunOk.output` (`src/types.ts`) and
in `docs/truncation-policy.md` "Value rendering": **Option A**, `output` is always a string
(decision 15). All three causes addressed: (1) `SUBMIT`'s stub is `-> None` since D103 and the
checker refuses `SUBMIT()` / `SUBMIT(42)` (pinned, `test/sandbox.test.ts:3130`); (2)
`resolveToolArgs` raises a Python `TypeError` for a missing required parameter, in CPython's
words, on every tool (`test/resolve_tool_args.test.ts:110-156`, `test/sandbox.test.ts:3149`); (3)
every success path renders through one function, `renderOutput` → `formatValue`, and both SUBMIT
sites reject a non-`str` answer with a Python `TypeError` (`:3021-3128`). Tests 1–5: `:3072`
(`SUBMIT(**{})` raises, never `undefined`), `:3036` (`SUBMIT(42)`-shaped runtime answers reject,
never a non-string output), `:3152` / `:3168` (a missing required argument on `echo` and `add`),
`:2908` (the typeof-string property over 25 expression shapes, both entry points at `:2968`),
`:3130` (the checker). The uncaught `ERR_INVALID_ARG_TYPE` reproduction now returns a `RunError`.

**#69** — Closed by W3-1. Finding 1: `output` is a Python-style repr built under the one truncator
(`formatValue`, `src/truncate.ts`), budget-aware at construction as the 2026-08-12 comment asked —
`{}` and `{'a': 1}` are distinguishable (`test/sandbox.test.ts:2949`), a 300 000-element list is
elided *between elements* with a marker under 16 KiB (`:2989`), the losses the boundary imposes are
documented (`docs/truncation-policy.md` "Documented losses"). Finding 2: one callback per `print`,
newline included — the D122 tripwire (`:2686`); the two stale fragment comments are gone. Finding
3: no stderr — `print(file=sys.stderr)` is a `TypeError`, `sys.stderr.write` / `sys.stdout.write`
an `AttributeError`, `os.write` and `warnings` refused by the checker, each pinned (`:3466`).
Finding 4: `ToolCallTrace.seq` and `stdoutOffset` on every entry (`:3223-3446`), preserved across
`resumeSuspended` and any filtering; `renderResult` puts each call back where it happened in
`stdout` (`test/extension.test.ts:2830-3037`). Finding 5: dissolved on 0.0.21 — a callback
returning a value is tolerated, pinned (`:3499`). DoD: the five tests exist and pass on the shipped
Monty; the dict/set decision is recorded beside #65's; ordering is available to #46.

**#64** — All five properties hold on the shipped 0.0.21 with tests: #65 (`RunOk.output` always a
string; required params enforced — above), #66 (closed by W1-1, `test/shadowing.test.ts`), #67
(degraded stubs reported — decision 10, wave 1), #68 (closed; the memoised probe, #116, and its
property "process-invariant work happens once" is what `test/sandbox.test.ts`'s memory-guard
tests stand on), #69 (narrowed to the documented-loss property — above). Exit criterion 2 was
honoured throughout: nothing closed as fixed-upstream without a test (#66's six, #69's finding-2
tripwire and finding-5 pin). Both boxes tick.

**#40** — Every remaining leg is closed with tests: #65 and #69 (W3-1, above), #66 (W1-1), #67
(wave 1), #63 and #84 (W2-2, D129), the namespace-isolation answer recorded here on 2026-09-08. DoD:
the recommendation and the migration plan are `docs/monty-0021-spike.md` and PR #120; every
affected issue was re-scoped or closed with its disposition recorded; the timebox was one session.
The memory-guard item: the leak was a *failing* type check, fixed at source by memoising the probe
(#116) with the measurements in spike §8 and #118; 0.0.21's `typeCheckStubs` removes the probing
code path; the `SandboxMemoryError` guards, the `concurrency: 1` pin and `scripts/contained.mjs`
stay as backstops for the general case (documented in `src/sandbox.ts` "Memory guards"), which is
a cost of staying and of moving alike, as the item asked to be recorded.

**#39** — A ledger, not a queue: every row that became an issue has now reached a close-out or a
recorded disposition; the last bucket-8 rows (`printCallback` fires per fragment; the callback
must return `undefined`; `dict` / `set` convert to `{}`; cap `[result]` before conversion) are
closed by #69 above, with the two Monty-version findings re-measured on 0.0.21 (per-print
callbacks; the return value ignored). Nothing here remains to be filed.

## Go / No-Go

**GO.** Check / lint / coverage green at `cf97518` and again at `88aa7bc` with every owned floor
met and no floor changed; RED → GREEN in separate commits with the counts above, fix round 1
included; the full suite through `test:contained` and CI on all legs are recorded in the PR body.
Nothing outside the owned files touched; two follow-ups named for their owners; one residual as a
todo test.

Verifier notes not taken up in fix round 1, for the record: `dispose()` drops the shutdown warning
when the waiting tool is unknown (a session whose suspension predates the trace API — the name is
what the report exists to say; the warning without it was the W1-3 shape, judged not worth a
second form); `toolFailure()` labels every `SubmitSignal` as the SUBMIT answer guard (only `SUBMIT`
raises one; a second tool raising it would be a bug the label makes visible); `pythonTypeName`
answers `object` for an untagged plain object (Monty tags every record it builds, so none reaches
it); `docs/tool-trace.md` is not owned.
