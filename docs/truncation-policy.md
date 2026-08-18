# Truncation policy for model-facing output

**Status:** Decided · **Issue:** #30 (Bucket 1, step 0) · **Implemented by:** #29, #34

This document is the recorded decision for how `repl-simple` truncates the two model-facing output
fields, `stdout` and `output`. It exists so that #29 and #34 implement one policy instead of two.

Everything below is marked as either **[measured]** — reproduced on this tree at `db957ee`, with the
numbers given — or **[judgement]** — reasoned from prior art and stated so you can disagree with it.
Nothing was tested against a live model; see [What was not tested](#what-was-not-tested).

---

## The decision in one table

| | `stdout` | `output` |
|---|---|---|
| **Shape** | head + tail, elided middle (25 / 75) | head + tail, elided middle (50 / 50) |
| **Byte budget** | 32 KiB | 16 KiB |
| **Line budget** | 1000 lines (SHOULD) | none |
| **Marker inside the budget?** | yes | yes |
| **Marker carries magnitude?** | yes | yes |
| **Marker carries a recovery route?** | yes | yes |
| **Structure-aware?** | no | no — **blocked**, see Q4 |

One tool result is therefore bounded at **48 KiB**, down from unbounded today.

---

## What the code does now

Three truncation sites, two marker constants, one uncapped path.

| Site | Cap | Marker | State |
|---|---|---|---|
| `sandbox.ts:29,490-502` — `stdout` | 256 KiB | `\n[...stdout truncated]` | head-only, **overshoots** the budget |
| `builtins.ts:27,31-37` — `read_file`, `http_get` | 256 KiB | `\n[...truncated]` | head-only, **corrupts** the boundary character |
| `repl.ts:112` — `[result]` / `output` | **none** | none | uncapped `[H32]` |

### Measured

All figures reproduced against `src/` at `db957ee`.

**M1 — `stdout` overshoots its byte budget.** `print("é"*50)` with `maxStdoutBytes: 10` returns **42
bytes / 32 chars**. `sandbox.ts:493-497` computes a byte budget and then applies it as
`text.slice(0, n)`, a **character** index; 10 characters of `é` is 20 bytes. Confirms `[H12]` `[A12]`
exactly, including the 42.

**M2 — `output` is uncapped.** `'A'*2000000` returns an `output` of **2,000,000 bytes**. Confirms
`[H32]`.

**M3/M4 — the marker sits outside the budget.** A 1024-byte cap yields **1046 bytes**: 1024 of payload
plus the 22-byte marker. The advertised ceiling is not the real ceiling. Holds for both a single huge
`print` and 1000 small ones.

**M5 — `builtins` corrupts the boundary character.** `read_file` on 50 × `é` with `maxFileBytes: 11`
returns a payload of **13 bytes / 6 chars ending in U+FFFD** — the byte cut lands mid-character. With
`maxFileBytes: 10` it lands on a boundary and is clean. So the two truncators are wrong in *opposite*
directions: `sandbox` keeps characters intact and blows the budget, `builtins` honours the budget and
mangles a character. Neither cuts at a character boundary at or below the budget.

**M6/M7 — `output` is not a repr.** `formatOutput` (`sandbox.ts:89-92`) is `String(value)`. So
`[1,2,3]` → `"1,2,3"` and `{'a': 1}` → `"[object Map]"`. This is load-bearing for Q4.

**M10 — but the values arrive intact.** Read directly off `MontyComplete.output`:

| code | constructor | `String(v)` | `JSON.stringify(v)` | contents |
|---|---|---|---|---|
| `{'a': 1, 'b': 2}` | `Map` | `"[object Map]"` | `"{}"` | `[["a",1],["b",2]]` |
| `{1, 2, 3}` | `Set` | `"[object Set]"` | `"{}"` | `[1,2,3]` |
| `[1, 2, 3]` | `Array` | `"1,2,3"` | `"[1,2,3]"` | `[1,2,3]` |

Nothing is lost crossing the boundary; `formatOutput` flattens it afterwards. Note that
`String(new Map())` and `String(new Map([["a",1]]))` are both `"[object Map]"` — that collision is
what makes a populated dict look empty.

**M9 — truncation also silences the user's live view.** `printCallback` (`sandbox.ts:491-492`, and the
second copy at `:623-624`) checks `if (stdoutTruncated) return;` *before* calling
`runOpts?.onPrint?.(text)`. A program emitting 200
prints under a 512-byte cap fired `onPrint` **11 times** and then went silent. The model-facing buffer
and the human-facing stream share one budget, so capping the former blinds the latter. The issue did
not raise this; it should be fixed with #29.

---

## Prior art

Read first-hand out of `node_modules/@earendil-works/pi-coding-agent@0.84.1` — the host this project
bridges to — plus published behaviour for two other harnesses.

**pi** (`dist/core/tools/truncate.js`, `read.js`, `bash.js`):

- Two independent limits, whichever hits first: **2000 lines or 50 KB**.
- *"Never returns partial lines."* Truncation is line-boundary aware, not byte-boundary.
- `read` truncates **head** (`truncateHead`); `bash` truncates **tail** — the shape follows the
  meaning of the stream, not one global rule.
- Markers carry magnitude **and** a recovery route:
  - `[Showing lines 1-2000 of 50000. Use offset=2001 to continue.]`
  - `[Showing lines 1-500 of 9000. Full output: /tmp/…]` — bash spills the remainder to a file.
  - `[Line 12 is 80.0KB, exceeds 50.0KB limit. Use bash: sed -n '12p' path | head -c 51200]` — a
    literal command to run.
- `GREP_MAX_LINE_LENGTH = 500`: a **per-line** cap distinct from the whole-output cap, so one
  pathological line cannot consume the budget.

**Claude Code** — Bash output capped at 30,000 characters with **middle**-truncation (head + tail
retained), tunable via `BASH_MAX_OUTPUT_LENGTH`.

**Codex** — 10 KiB or 256 lines, whichever hits first, head + tail with a middle marker.

**Common failure mode.** Silent truncation is a named bug across these ecosystems: the model treats a
fragment as complete and reasons from it. It is invisible to tests, which is precisely why #30 is step
0 of a bucket about verification.

### The one fact that decides most of this

The model in this harness **already sees pi's markers**, on every bridged `read`, `grep`, `find` and
`bash` call. Whatever `repl-simple` emits lands in the same context window as
`[Showing lines 1-2000 of 50000. Use offset=2001 to continue.]`.

Inventing a second vocabulary means the model must learn two truncation dialects in one conversation,
one of which (`[...stdout truncated]`) is strictly less informative. **Align with pi.** This is the
cheapest correctness win available here and it costs nothing to adopt. **[judgement]**

---

## The five questions

### Q1 — Shape: head, tail, or head + tail?

**Decision: head + tail with an elided middle, for both fields. Weighted 25/75 for `stdout`, 50/50 for
`output`.**

The issue's framing is right that the two fields differ, but the difference sets the *weighting*, not
the shape.

`stdout` is chronological. The payload is usually at the end — the last print before an exception, the
final tally after a loop. But a pure tail (pi's `bash` choice) discards what the stream *was*: the
header row, the first iteration that establishes the pattern, the config echoed at startup. A 25/75
split keeps enough head to identify the stream and spends the rest where the answer usually is.
**[judgement]**

`output` is a single value. Its beginning and end together identify it — `"[1, 2, 3, … , 998, 999]"`
tells you the type, the element shape, and the extent. A head-only cut of a long list looks exactly
like a short list, which is the silent-truncation failure in its purest form. 50/50. **[judgement]**

**Implementation cost, stated plainly:** head+tail on `stdout` is not a drop-in change. Today's
`printCallback` stops accumulating at the cap; retaining a tail needs a ring buffer of `tailBudget`
bytes alongside the head buffer. That is bounded work — the buffer never exceeds the budget — but #29
should expect it rather than discover it.

**Line-boundary rule (SHOULD).** Follow pi: prefer not to emit a partial line. Cut back to the last
newline at or before the budget when one exists within a reasonable distance, and fall back to a
character-boundary cut when a single line exceeds the budget alone.

### Q2 — Does the marker carry magnitude?

**Decision: yes. Always show what was kept against the true total.**

`[...stdout truncated]` conveys nothing actionable. The difference between losing 200 bytes and losing
1.9 MB is the difference between "carry on" and "that query was hopeless, ask something narrower," and
today the model cannot tell them apart. Every surveyed harness carries magnitude; pi carries it in
both lines and bytes. **[judgement, with unanimous prior art]**

The totals must be the **true** totals, not the truncated ones. For `stdout` this means the accumulator
has to keep counting bytes and lines after it stops keeping them — a counter, not a buffer.

### Q3 — Is truncation an affordance or a dead end?

**Decision: an affordance. This is the highest-value part of this document.**

Every surveyed harness gives the model a route to the rest: an `offset` to continue from, a temp-file
path, or a literal shell command. `repl-simple` currently gives it a full stop.

This project has a **better** affordance available than any of them, because the sandbox session
persists across calls: the model can slice the value itself in Python. Nothing needs paging, spilling,
or a new tool — the data is already in a live interpreter that the model controls.

There is one gap. **[measured, M8]** There is no `_` binding: evaluating `_` returns
``TypeError: error[unresolved-reference]: Name `_` used when not defined``. So a truncated `output`
whose value the model never assigned to a name is genuinely unreachable — it has been discarded.

**Therefore, as a prerequisite for the `output` affordance: bind the last expression's value to `_`**,
as CPython's REPL does. Then the marker can name a real recovery route. **[judgement; the binding
itself is unverified against Monty and must be spiked before #34 depends on it — if it proves
infeasible, fall back to the `stdout` wording, which needs no binding.]**

**Spiked during #34. The binding did not land. [measured, M10]** `_` is usable in Monty two ways —
declared as an input (`inputs: { _: "…" }` → `output "carried"`) or assigned in the snippet
(`_ = 5; _ * 2` → `10`). So the mechanism exists. What blocks it is `Session`, which persists state by
**replaying prior snippets as source**, not by carrying a snapshot. Passing the previous value in as
an input named `_` therefore rebinds `_` for every replayed snippet, not just the next one:

```
call 1   bigvalue                 →  truncated; _ = the big string
call 2   _[10000:11000]           →  correct slice
call 3   anything                 →  replays call 2 against call 2's OWN output — IndexError
```

The advertised route would corrupt the session that used it, and it is exactly the flow the marker
would be advertising. Fixing it means changing how `Session` persists state, which is #62's scope, not
a truncation issue's.

**What shipped instead is a route that is true today**: assign the expression to a name and slice
that. It needs no new binding, it survives replay because the name is bound by the snippet itself, and
it delivers Q3's substance — the model can reach the rest without a new tool. Revisit `_` if #62
replaces replay with a snapshot.

Note the second-order effect the issue anticipated: once recovery is cheap, a **tighter** budget beats
a looser one, because the model spends context on the slice it asked for instead of on incidental
bulk. That is what licenses the 5× reduction in Q5.

### Q4 — Structure-aware truncation for `output`?

**Decision: no. Not because it is a bad idea — because it is currently impossible. Revisit after
#69.**

The issue assumes `output` is "a structural repr of a Python value." **[measured, M6/M7]** It is not.
`formatOutput` is `String(value)`, so by the time truncation could run, the structure is already gone:

| Python value | `output` today | A repr would give |
|---|---|---|
| `[1,2,3]` | `"1,2,3"` | `"[1, 2, 3]"` |
| `{'a': 1}` | `"[object Map]"` | `"{'a': 1}"` |

"First N and last N elements" cannot be computed from `"[object Map]"`. There is no list left to
sample.

**But the structure is not lost at the boundary — only in rendering.** **[measured, M10]** Read
straight off `MontyComplete.output` on `@pydantic/monty@0.0.18`, a Python `dict` arrives as a real JS
`Map` with every entry intact (`[["a",1],["b",2]]`), a `set` as a real `Set`, a `list` as an `Array`.
`formatOutput`'s `String(value)` is what flattens them one layer later. Note that this corrects #69's
finding 1, which reads the `{}` from `JSON.stringify` as evidence that the boundary itself is lossy;
`JSON.stringify` renders a `Map` as `{}` because its entries are not own enumerable properties.

So Q4 has no complexity cliff to locate yet; it has a **dependency**, and a cheaper one than it looks.
`#69 (8.5 — value conversion and print capture lose information silently)` is the blocker. Until it
lands, `output` gets the same flat head+tail cut as `stdout`.

**Recommendation for whoever takes #69:** emit a real repr, and make it truncation-aware at
construction — a repr walking `.entries()` already knows the budget and can elide *between elements*,
producing `[1, 2, 3, … 994 more … , 999, 1000]` for free. Retrofitting structure onto a flattened
string afterwards is the expensive path, and the reason to fix it at the source. Because the values
arrive intact, this is a local change to `formatOutput` rather than an upstream conversion fix, and it
does not appear to depend on #40 the way #69's print-capture findings do.

### Q5 — One budget or two?

**Decision: two fixed sub-budgets under one declared ceiling. `stdout` 32 KiB, `output` 16 KiB, total
48 KiB. No borrowing between them.**

Three sub-decisions:

**Why a total at all.** Today `stdout` is capped at 256 KiB and `output` at nothing, so a single tool
result is unbounded — measured at 2 MB (M2). A per-field cap without a declared total means nobody can
state the worst case for one `repl` call. State it: 48 KiB.

**Why 48 KiB and not 256 KiB.** 256 KiB is roughly 64K tokens for one tool call — a large fraction of
the window spent without the model choosing to. It is also a wild outlier: pi caps at 50 KB, Claude
Code at ~30 KB, Codex at 10 KiB. 48 KiB lands in that range while staying the most generous of the
four, which suits a REPL whose whole purpose is producing output. Combined with Q3's recovery route,
the tighter budget should be a net gain. **[judgement]**

**Why fixed, not shared-with-borrowing.** Borrowing is more efficient and less predictable: the same
code produces differently-truncated results depending on how much the other field happened to use, so
a truncation bug becomes non-reproducible. Predictability matters more than the marginal bytes here,
and #29 and #34 can then be implemented and tested independently — which is the point of this
document. **[judgement]**

`stdout` gets 2× `output` because it is where deliberate instrumentation lands: the model chose to
print each of those lines. `output` is one value it chose to surface.

---

## Specification

Normative. #29 and #34 assert against this section.

### Budgets

```
STDOUT_MAX_BYTES = 32 * 1024   // 32 KiB
OUTPUT_MAX_BYTES = 16 * 1024   // 16 KiB
STDOUT_MAX_LINES = 1000        // SHOULD; bytes is the MUST
```

`maxStdoutBytes` in `RunOptions` stays as the per-call override. Add `maxOutputBytes` alongside it.

### Invariants

1. **The budget is a ceiling, including the marker.** `Buffer.byteLength(field) <= budget`, always.
   Fixes M3/M4, where a 1024-byte cap produced 1046 bytes. The marker's cost comes out of the payload.
2. **Never split a character.** Cut at a UTF-8 character boundary at or below the budget. Never emit
   U+FFFD from truncation (M5); never exceed the byte budget to preserve a character (M1).
3. **Prefer not to split a line** (SHOULD), per pi.
4. **One implementation.** Three sites today with two markers. Extract a single shared helper and have
   `sandbox.ts`, `builtins.ts` and the new `output` path import the same symbol — the same argument
   #43 makes about the path jail, for the same reason: two copies drift and one ends up wrong. `[A12]`
   already notes both existing copies survived a refactor verbatim.
5. **Counters keep counting.** Totals in the marker are the true totals.
6. **Truncation must not silence `onPrint`** (M9). Move the `onPrint` call above the
   `if (stdoutTruncated) return;` guard, in **both** copies (`sandbox.ts:491-492` and `:623-624`). The
   human's live stream is not the model's context window and must not share its budget.

### Marker text

Shaped to match pi's vocabulary, since both appear in the same context window.

`stdout`, both ends kept:

```
[… 1.9 MB of 2.0 MB elided (lines 431-19204 of 19631). Re-run with a narrower print to see more. …]
```

`stdout`, line counts unavailable:

```
[… 1.9 MB of 2.0 MB elided. Re-run with a narrower print to see more. …]
```

`output` (as shipped — see the Q3 spike; the `_` binding did not land):

```
[… 1.9MB of 2.0MB elided. Assign the value to a name and slice it to see more. …]
```

Rules:

- Sizes via a `formatSize` equivalent (`42B`, `1.5KB`, `1.9MB`) — pi's format, so the two agree.
- The marker goes **where the cut is** — between head and tail, not appended at the end. An appended
  marker on a head+tail result implies the tail was dropped when it was not.
- If the `_` binding from Q3 does not land, the `output` marker uses the `stdout` wording. Do not ship
  a marker naming a recovery route that does not exist. **Resolved: it did not land, and the shipped
  wording names assignment instead — a route that needs no binding.**
- A caller that stops reading before the end cannot know the total, and inventing one would break
  invariant 5. That case states where it cut instead: `[… truncated at 16.0KB. RECOVERY …]`. Used by
  `http_get`, which will not drain an arbitrarily large body just to measure it.

### Non-goals

- Token-based budgets. Bytes are cheap, deterministic and tokenizer-independent.
- Structure-aware `output` elision — Q4, blocked on #69.
- Truncating `errorKind`. The `error` string is now capped (16 KiB, #144); `errorKind` stays uncapped as a small bounded enum string.

---

## What this means for the blocked issues

**#29 (2.3 — byte-vs-char truncation; de-duplicate printCallback).** Scope grows, and the DoD should
assert shape rather than a byte ceiling:

- Fix the byte/char confusion in both copies (`sandbox.ts:493-497`, `:625-628`) per invariant 2.
- Implement head+tail with the ring buffer from Q1 — new work relative to the issue as written.
- Bring the marker inside the budget (invariant 1).
- Fix the `onPrint` silencing (invariant 6) — not in the issue today.
- Extract the shared helper (invariant 4), covering `builtins.ts` too. The `builtins` copy is a third
  site the issue does not currently mention.
- Test: a 10-byte cap on `"é"*50` yields **≤ 10 bytes** and no U+FFFD. Both boundary mutations M11/M12
  that `[A12]` reports as surviving should die against this.

**#34 (3.3 — cap the `[result]` field).** Budget and shape are now specified: 16 KiB, 50/50 head+tail,
marker inside the budget. Two additions:

- The `_` binding spike from Q3 is a prerequisite for the marker's recovery clause. Land it or use the
  fallback wording.
- Q4 records that structure-aware elision is deferred to #69, so #34 should not attempt it.

**#69 (8.5 — value conversion loses information).** Newly implicated by M6/M7. It is the blocker for
Q4, and Q4's recommendation — build the repr truncation-aware at construction — belongs in its scope.

---

## Implementation record

What landed, and the two places the implementation deliberately differs from a literal reading of the
spec above. Recorded here rather than left as drift, per #34's DoD.

| Site | Budget | Shape | Landed in |
|---|---|---|---|
| `stdout` | 32 KiB / 1000 lines | 25/75 head+tail | #29 |
| `output` | 16 KiB | 50/50 head+tail | #34 |
| `read_file` | 256 KiB | 50/50 head+tail | #29 |
| `http_get` | 256 KiB | head-only, total unknown | #29 |
| `buildFeedback` `stdout` | 32 KiB | 25/75 head+tail | #74 |
| `buildFeedback` `output` | 16 KiB | 50/50 head+tail | #74 |
| `runRlm` conversation (`messages`) | 256 KiB | keep first + last N, drop oldest whole pairs | #74 |
| `buildInitialPrompt` input preview | 32 KiB aggregate; 5 KiB per value | per-value 50/50 head+tail; aggregate whole-block elision | #74, #145 |
| `buildFeedback` `error` | 16 KiB | 50/50 head+tail | #144 |
| `buildInitialPrompt` `question` | 64 KiB | 50/50 head+tail | #144 |
| `runRlm` assistant reply (conversation copy) | 256 KiB | 50/50 head+tail | #145 |

Every `truncateText` row in this table goes through one implementation, `src/truncate.ts`, per
invariant 4 — the `#74`/`#144`/`#145` rows too, not only the four `#29`/`#34` rows. The conversation
row is not a truncation (`boundConversation` drops whole message pairs), and after #145 the aggregate
input-preview cut is block-level elision in `rlm.ts` over whole per-value previews (D15), not a
second byte-level truncator.

**Exception 1 — `builtins.ts` keeps its 256 KiB ceiling; it is not part of the 48 KiB budget.**
`read_file` and `http_get` return a value *into the sandbox*, not into the model's context: the model
may read a file and process it in Python without ever displaying it. Whatever it chooses to surface is
then capped again, correctly, by `stdout` or `output`. Truncating at the read would corrupt data;
truncating at the display only shortens a view. The 48 KiB total in Q5 therefore still holds for a
tool result, which is what it was about.

**Exception 2 — `output` is capped where the `RunResult` is built, not in `repl.ts`'s
`formatResult`.** #34 names `repl.ts:112`, but capping there would leave the RLM loop uncapped, which
is the same defect under a different consumer — `docs/REVIEW.md` A23 records a snippet ending in a
bare `context` appending a full copy of the context to every subsequent prompt. Capping in
`sandbox.ts` covers both, and is the stronger reading of "one policy, not two". `formatResult` then
interpolates an already-bounded value, and says so.

**#74 (RLM feedback loop) additions.** Three of the four new rows reuse `truncateText` at the same
budgets the sandbox already applies, so the normal feedback path is a marker-free no-op — a caller
who raises `runOptions.maxStdoutBytes` / `maxOutputBytes` no longer leaks that raised ceiling into
the model's context. The conversation row is not a truncation: `runRlm` measures the whole
`messages` array against `MAX_CONVERSATION_BYTES = 256 KiB` and drops the oldest middle turns in
whole assistant+feedback pairs (keeping `messages[0]` and the newest pair). Each drop emits a
cumulative user-role marker — `[… N earlier turns dropped — conversation bounded at 256KB. The most
recent context follows. …]` — that counts toward the budget, so the model is told the history it
sees is partial. The input-preview row uses a named-variable recovery clause ("Each input is
available as a named Python variable — slice it in Python to see more."), because inputs are already
declared as sandbox variables and need no assignment step.

**#144 (RLM feedback loop, error + question).** Two of #74's recorded non-goals are now capped. The
`error` path reuses the value shape at the `output` budget (16 KiB, 50/50 head+tail) with a real
recovery route — "Catch the exception and print the full traceback to see more." — because the model
owns the Python and can re-run the failing code under `try/except` to print the whole traceback. The
`question` path is capped at 64 KiB (50/50 head+tail), sized so that even a maxed initial prompt
(≤64 KiB question + ≤32 KiB input preview + headers) cannot alone cross the 256 KiB conversation
bound, and because `messages[0]` is never dropped. Its recovery clause is deliberately weaker — "The
question was truncated. Answer from the part shown and state the assumption if ambiguous." — because
the question is **not** sandbox-accessible: unlike `output` and inputs, the model cannot slice it in
Python, so the marker must not advertise a route it cannot honour (policy Q3, the same rule as the
`_` binding). Both caps go through the one shared `truncateText`.

**#145 (RLM message-growth polish).** The last uncapped model-facing path is now bounded and every
truncated view is authenticated: the assistant reply copied into the conversation is capped at the
conversation budget (256 KiB, 50/50 head+tail — the row above) with a deliberately weak recovery
clause ("Keep replies concise and re-state anything important."), because the model cannot recover
its own elided reply from anywhere (policy Q3), while `iterations[].llmResponse` keeps the raw
reply for the caller; truncated views are sentinel-delimited (Exception 5); error and output lines are
`> `-quoted so a forged `stdout:` line cannot pass as the real delimiter (D19, D36); input names are
validated against a Python-identifier pattern before any query (D20); the drop marker's label
derives from the budget via `formatSize` ("256.0KB"); the quoted error section renders ≤ 2× its
value budget (the `> ` prefix doubles pathological newline-only lines — bounded, not a growth
vector); and the aggregate input-preview cut is
block-level elision over whole per-value previews (D15), so no cut can split a fence or a header.

**Exception 3 — the conversation byte count uses `TextEncoder`, and that *is* byte measurement.**
D2 writes the budget as `Buffer.byteLength`; `TextEncoder.encode().length` is UTF-8 byte measurement
too, and byte-for-byte identical to `Buffer.byteLength` for the same text (verified, including lone
surrogates). The deviation from D2's wording is a symbol swap driven by test 6's source grep — it
bans `Buffer` and `byteLength` from `rlm.ts` (comments included) as the canonical signals of a
hand-rolled byte truncator — not "no byte-level measurement". The count is byte-level either way;
test 6's positive assertions (rlm.ts imports `truncateText` from `./truncate.js`) are what keep the
one-shared-truncator invariant (invariant 4). [#74]

**Exception 4 — a single over-budget LLM reply is kept.** The loop cannot truncate model output
without summarising (deferred, D4), so one reply larger than 256 KiB is kept and the conversation is
allowed to exceed the budget transiently until it ages out (#74, Assumption 4).

**Exception 5 — every truncated view is sentinel-delimited (#145, D17).** A marker carried by
attacker-controlled text is indistinguishable from a real one, so `rlm.ts` wraps every truncated
view in `[TRUNCATED VIEW BEGIN]` / `[TRUNCATED VIEW END]` lines and the RLM system prompt tells
the model that only elision markers inside the sentinels are authentic — marker-looking text
anywhere else is literal data (the history-drop notice after the first message is carved out as
also system-emitted and authentic). Sentinel-token sequences inside a value itself
(`[TRUNCATED VIEW`, under budget or over) are neutralised before wrapping — the ordinary space
becomes a zero-width space, `[TRUNCATED\u200BVIEW`, which cannot form a sentinel — so
sentinel-token forgery is closed: a forged pair can neither render whole-and-sentinel-free
under the budget nor land inside the authentic pair over it. Marker-shaped text is a different
residual: the retained head and tail inside an authentic pair are still attacker-controlled,
and a forged `[… N of M elided …]` line inside them sits inside the sentinels. That residual
is steering-only — it can bias the model toward the attacker's summary, never read or
exfiltrate data — the sandbox remains the real boundary. The system prompt therefore grants
authenticity only to the marker the system places next to the sentinels, declaring anything
resembling a summary inside the data itself to be that data's own content (D27), and the
ZWSP/homoglyph confusable family — a neutralised sentinel differs from a real one by one
invisible character — makes the mechanism a soft control (defense-in-depth), not
authentication. On the error and ok branches the authentic sentinels render line-quoted as
`> [TRUNCATED VIEW BEGIN]` because D19/D36's quoting is applied after the wrap; the rule notes
that quoted shape rather than reordering. The sentinel bytes are subtracted from the
section budget before the `truncateText` call, so the ceilings in the table stay hard with the
sentinels included; the value is byte-measured after the neutralisation swap, so the budgets
stay exact. Under the budget the path is a sentinel-free no-op (byte-identical apart from that
swap), and forged marker-looking text stays raw. A caller-supplied `options.systemPrompt`
replaces the default wholesale, dropping the authentication rule while the sentinel wrapping
still happens — callers who override it should restate the rule.

**The budget-smaller-than-the-marker edge**, which #29 asked to decide explicitly: the result is
**empty**, with the truncated flag set. A partial marker is misinformation and the budget is a hard
ceiling, so an empty field plus an accurate flag is the only unambiguous answer.

---

## What was not tested

Stated plainly so a later reader can tell evidence from judgement.

**Not done: the live-model evaluation.** The issue's Method asks whether a model recovers from each
candidate shape — does it re-query correctly, or treat the fragment as complete? That needs API spend
and a harness that does not exist in this repo. Every claim about *model behaviour* here is inference
from prior art, not measurement:

- that head+tail beats head-only,
- that the 25/75 and 50/50 weightings are right,
- that magnitude in the marker changes re-query behaviour,
- that a tighter budget plus a recovery route beats a looser budget.

The convergence of pi, Claude Code and Codex on head+tail-with-magnitude is real evidence about what
practitioners concluded, but it is not evidence about *this* harness's model.

**What is measured** is everything about the current implementation: M1–M9, all reproducible against
`db957ee` with the numbers given.

**If you want the evaluation before committing:** the cheapest version is the three realistic shapes
the issue names — a long log, a large list repr, a wide table — run under head-only and head+tail, with
one question each: does the model re-query, or does it answer from the fragment? That is a small
number of calls and would upgrade the four inferences above. It is not a blocker for #29 and #34,
because both are strictly better than today's behaviour under any of the candidate shapes.

**Lowest-confidence claim in this document:** the 25/75 `stdout` weighting. It is a guess at where the
payload of a REPL session's prints sits. If the evaluation ever runs, test that first.

---

## Source

Raised while scoping bucket 3. Findings: `docs/REVIEW.md` H32, H12 · `docs/actionable-items.md` A7,
A12. Measurements M1–M9 taken against `src/` at `db957ee`; prior art read from
`@earendil-works/pi-coding-agent@0.84.1` as installed.
