# Session replay

**Status:** Decided · **Issues:** #61, #62, #63, #58 (Bucket 7) · **Implemented in:**
`src/session.ts`, `src/sandbox.ts` (`makePrintCallback`) · **Decisions:** 12, 13 (2026-09-08), D121–D132

This document is normative for what a `Session` does between calls: what it replays, what it
caches, what each call reports, what a dump is and — the part that matters most — what a dump is
not allowed to do. `test/session.test.ts` asserts it.

## The model in one paragraph

A `Session` holds no interpreter. Every `run()` assembles `preamble + every retained snippet + the
new code`, feeds the whole transcript to a fresh sandbox, and keeps the new code as a snippet only
if it completed. Prior snippets therefore **re-execute on every call**. Two things make that
tolerable: an ordered **call cache** answers each host-tool call the prefix makes, in order, with
the result it produced the first time, so side effects do not repeat; and a **stdout mark** drops
the bytes the prefix printed, so each call reports only its own output. Monty 0.0.21's `feedRun`
could replace all of this with a live interpreter; decision 12 keeps replay for now, and this page
records the semantics it has.

## What each call reports (#61, #58)

`stdout` is what *this* call printed. The session keeps, per retained snippet, the number of bytes
it printed when it ran (`stdoutBytes[]` in a dump — the first figure includes whatever the preamble
printed), and hands the sum to the sandbox as `RunOptions.stdoutSkipBytes`. The sandbox drops that
many leading bytes of the print stream before either `onPrint` or the accumulator sees them, slicing
a callback that straddles the mark. Consequences, all pinned:

- Three runs printing `alpha`, `beta`, `gamma` return `alpha\n`, `beta\n`, `gamma\n`. Before: the
  transcript, cumulatively.
- The **truncation budget applies to the delta**. A 300 KB print followed by a small one returns
  the small line, untruncated. Before: 32 751 bytes of stale output with the new line surviving only
  in the tail.
- A run that prints nothing returns `""`.
- The live `onPrint` stream is not shown the replayed output again.
- A call that suspends and resumes reports its whole output once; the next call none of it.
- `reset()` resets the mark.

**Why a byte mark and not a callback count.** Measured on 0.0.23 (`test/sandbox.test.ts`, the
tripwire and print-batching blocks): the worker holds `print()` output for up to 5 ms
(`printFlushInterval`, pydantic/monty#809) and hands the callback whatever accumulated — a thousand
prints in a tight loop arrive as one callback, and a partial line (`end=""`) arrives on its own once
the interval lapses. It always flushes before a host call and by the end of the run, and a single
large print still arrives in 8 KiB chunks. So whether a replayed prefix's last bytes share a
callback with this call's first print is timing: a callback count would swallow or re-emit lines
depending on it, while a byte count cuts at the same byte however the stream is chunked. (0.0.21
called back once per `print` and held a partial until the next newline; the mark was made bytes then,
for the partial-line case, and batching is why it still has to be.) The sandbox keeps upstream's
batching rather than pinning `printFlushInterval: 0`; the reasoning is at `makePrintCallback`. The
tripwire pins the shape; if an upstream bump changes it, that test fails before a session quietly
swallows or re-emits a line.

**Determinism.** The mark taken from the original run describes the replay only if the replay prints
the same bytes. It does, because the replay runs the same code with the same cached tool results and
crosses the same host boundaries (a cached call still crosses the host, so buffered output is flushed
there in both — measured across a gate in the original call and in the replay). Code that prints
non-deterministically without a tool call is the exception, and it would break a callback count
just the same.

`calls` is likewise this call's on **every** outcome — success, error, and suspension (and so the
resumed call's) — not the replayed prior calls (A16 below).

## The call cache, and what a replay is

Every host-tool call a retained snippet made is in an ordered list, keyed on `tool::{sorted args}`.
A replay serves them **positionally**: the cursor advances only on a key match, and a mismatch (the
code changed between runs) falls through to real execution from that point. `docs/approval-grants.md`
explains why the approval gate treats "the next entry the cursor will serve" — and only that — as a
replay that needs no consent.

### The four recovered defects (#62)

The original text of A14–A17 lived in a review document that no longer exists. Each was recovered
from the code, and this is the record.

**A14 — pre-gate calls were not cached across a suspension.** A run that suspended at a gated call
dropped the cache entries it had recorded *before* the gate; only the resume's own entries were
kept. Every later replay re-executed those pre-gate calls — the side effect repeated and a variable
holding the result drifted (measured: `n = int(counter()); bash(…)` → the counter ran three times
and `n` read 2, then 3). Fixed (D123): the entries travel with the suspension (`preGateCache` in a
dump), a nested re-suspension accumulates them, and a successful continuation appends them ahead of
its own.

**A15 — `inputs` were never session state.** They are bound as globals for the call that passes
them; a replayed snippet reads whatever the *current* call binds — a changed value changes what
earlier code computed, an omitted one fails the replay with a typing error on a prefix line the
caller cannot see. Decision 12 keeps them **per-call** and documents it (`RunOptions.inputs`).
Values are never persisted. The one code change (D124): the session remembers the input *names* its
retained snippets ran with and, when a later run omits any of them and fails, appends a note naming
them. Re-supply the same inputs on every call that depends on them; the RLM loop already does.

**A16 — a failed snippet leaves no replayed state.** It is not retained, its calls are not cached,
its bindings are gone. Its side effects happened, and the trace says so. What was wrong was the
trace: an error's — and a suspension's — `calls` carried the replayed prior calls, so a caller could
not tell which effects were this call's (D125, fixed on all three outcomes).

**A17 — unbounded growth and stdout starvation.** Snippets and cache grew without bound, and the
replayed transcript's output starved the new output past the cap (the #61 destructive case). The
starvation is #61's fix. The caps (D126): **256 snippets** — `run()` refuses before anything runs,
`errorKind: "unavailable"`, nothing about the session changes; **1024 cache entries** — enforced
inside the caching registry *before* the tool executes, so the call that would exceed the cap
raises a Python `RuntimeError` naming the limit, no side effect happens, the run fails `runtime`,
nothing is appended, and a replay meets the same refusal at the same position. `reset()` is the way
out of either. `load()` refuses a dump beyond either cap. A replayed call is served from the cache
but still crosses the host, so on Monty 0.0.23 it spends one of the run's `maxSuspensions` like a
real call; the sandbox's default (`REPL_MAX_SUSPENSIONS`, 10 000) is pinned at twice the cache cap
at least, because Monty's own 1000 refused a full cache before this cap could.

## Failure, in one table

| The snippet… | Retained? | Its calls cached? | Its bindings later? | Its trace |
|---|---|---|---|---|
| completed | yes | yes | yes | its own calls |
| raised, or hit a limit | no | no | gone | its own calls; side effects happened |
| suspended at a gate | not yet | pre-gate entries held with the suspension | after a successful resume | its own calls, continued by the resume |
| was refused at the snippet cap | no | — | — | empty; nothing ran |
| hit the cache cap mid-run | no | no | gone | the refused call, `ok: false` |

## Dumps (#63)

`Session.dump()` serialises the session for another process; `Session.load()` restores it. Both are
public exports, and the following rules are what makes that safe to be.

### The dump is verbatim, and therefore sensitive

The replay cache holds every tool result exactly as the tool returned it — file contents, command
output, HTTP bodies — because that is what a replay must serve. **A dump is as sensitive as the
most sensitive thing the session read.** Treat it as a credential file. The display/export form is
`Session.dumpRedacted()` (decision 13, D130): the same structure passed through `src/redact.ts` —
secrets masked in snippets, cache keys (a `bash` command line), descriptions and trace errors;
cache results and stdout masked and cut head-only at 4 KiB with a magnitude-free marker; the
snapshot **omitted**, because it is opaque interpreter state that can hold a secret in a variable
and no pattern can see into it; and call arguments omitted for the same reason `GrantSummary` omits
them. It carries `redacted: true`, and `load()` refuses it by name.

### The invariant: a file cannot approve anything

*A persisted session must never be able to grant an approval that a human did not grant.*
Measured before this change: a dump whose `callCache` named a `bash` call ran `print(out)` to `ok`
with the file's `FAKE-OUTPUT` and no dialog — the cache entry was treated as a replay, and a replay
needs no consent. Now (D128):

- **Restored entries are marked** (in memory only; the flag is never written). For the approval gate
  a restored entry is *not* a replay: a gated call reached in replay asks the user. If they approve,
  the tool runs for real and its real result replaces the file's, in place — from then on the entry
  is the session's own and replays silently, exactly as an entry the session recorded itself. If
  they deny, Python raises `PermissionError` at that point of the prefix, as for any denial.
- **Non-gated restored results are served.** Restoring cached *results* is acceptable (#63);
  restoring the fact that something was *approved* is not.
- **The suspended call's description is re-derived** on load from the live tool and the stored
  arguments. Measured: a dump could show `gate(x='harmless')` in the dialog and run `x`. The dialog
  now shows what would run, whatever the file said. (A tool the registry no longer knows keeps the
  stored text; its resume raises `NameError` before anything can run.)
- **Grants are never serialised** (`docs/approval-grants.md`), and a restored session re-asks.

### The dump carries the run's state, not the host's policy

`suspendedRunOpts` is gone (D129). Mounts are host paths and a capability — a file that names `/`
and also supplies the code that reads it is a file that reads the user's disk; `limits` can say
`"unbounded"`; the byte caps are the host's. None of the three is written, and a dump that names
them is refused, not narrowed. Whoever resumes a restored suspension supplies them (or the defaults
apply), as `RunSuspended` has always required of `resumeSuspended`'s own callers. In the same
process a suspension still carries all four, merged caller-wins on `resume()` (decision 2, W1-2).
`ReplRunner` passes clamped `limits` and no mount either way, so the product is unaffected.

### Schema: reject, never coerce

`load()` validates the whole input before assigning anything (D127):

1. **Size first, on the text.** Over 1 MiB (`MAX_DUMP_BYTES`) is refused before any parser sees it —
   a 100 MB input in tens of milliseconds. `dump()` refuses to *write* over the bound for the same
   reason, where the caller can still reset or keep less.
2. **Version 2 only.** A v1 dump has neither the stdout marks nor the pre-gate entries and cannot be
   restored faithfully; it is refused, not upgraded.
3. **Every object is closed.** An unknown key — `suspendedRunOpts`, a raw `signal`, `__proto__`,
   anything — is an error naming it. Every field is typed; `stdoutBytes` is parallel to `snippets`
   and non-negative integers; the snapshot is base64 by shape; `suspended` and `suspendedCode` come
   together or not at all; both caps apply.
4. **What cannot be checked is Monty's.** The snapshot's contents are opaque; a malformed one is a
   `runtime` RunError at resume (`protocol violation: failed to load session`), never a throw.

Every rejection is an `Error` whose message starts `Invalid session dump:` and names the field; the
version error keeps its historical wording. Nothing is a `TypeError` from inside the constructor.

### What a dump does not carry, in one list

Grants · the run's options (mount, limits, byte caps) · input values *and* names · `grantUses` ·
the registry · the preamble (rebuild it exactly — the first snippet's stdout mark includes what it
printed) · the `restored` flag.

## Concurrency (D131)

`run()` and `resume()` on one session are serialised through a queue, so concurrent calls behave
exactly as sequential ones. Measured without it: two concurrent resumes of one suspension both
approved and executed the gated call; two concurrent runs assembled prefixes that did not include
each other. The second of two resumes now waits and then finds either the re-suspension the first
produced or nothing pending (`No suspended execution to resume`). `abandon()`, `reset()` and
`dump()` are synchronous and not queued: a reset issued mid-run takes effect when it is called.

## Known limits (recorded, not hidden)

- **A denied restored gated call derails the cursor** from that point, exactly as a key mismatch
  always has: later calls in the prefix execute for real, gated ones ask. The prefix's assumptions
  were broken by the denial anyway.
- **A non-deterministic prefix** (prints that vary without a tool call) mis-sizes the mark. The
  same code would already produce a different transcript on every replay.
- **A different preamble on load** mis-attributes its prints to the first snippet. The dump is half
  a session; rebuild the other half as it was.
- **Replay is O(transcript) per call.** The caps bound it; they do not remove it. Decision 12 keeps
  replay; a live `feedRun` interpreter would remove all of this page's second half.
