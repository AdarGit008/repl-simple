# The tool trace

Every host-tool call a `repl` or `repl_resume` call makes — every jailed `read`, every `http_get`,
every gated `write` and how it was decided — is reported on the tool result's `details`, and the
two tools that run code render it under the result. This is the control that makes the other
perimeter controls auditable: the path jail and the egress gate could be read in the source, but
until [#46] nothing in the product showed a tool call happening. A user could not audit an approval
they had granted; the model could not see what it had already read.

Two layers, two audiences.

## The library: `runWithTrace()` and `resumeWithTrace()`

`ReplRunner.run()` and `resume()` return the text the model reads, and nothing else. The trace API
is additive (decision 11): the same parameters, the same text, plus the calls.

```typescript
const trace = await runner.runWithTrace("read('a.txt')\nwrite('b.txt', 'x')", "s", onApproval);
trace.text;          // exactly what run() returns — run() is `.text` of this call
trace.status;        // "ok" | "error" | "suspended" | "no-session" | "nothing-pending" | "trust-changed"
trace.calls;         // [{ tool: "read", args: ["a.txt"], kwargs: {}, ok: true, durationMs, details? }, …]
trace.suspendedCall; // the ApprovalRequest, when status is "suspended"
```

Each entry is the sandbox's `ToolCallTrace` — tool, positional `args`, `kwargs`, `durationMs`,
`ok`, `error`, `approved` (`true` approved, `false` denied, absent for an ungated call) — plus
`details`: the built-in pi tool's own details for the seven bridged tools (`read`, `grep`, `find`,
`ls`, `bash`, `edit`, `write`), verbatim. `read` reports its truncation, `bash` its truncation and
full-output path, `edit` its diff and patch; `write` reports none, and neither do the builtins or
the toolstore tools. The bridge hands them over through `BridgeOptions.onDetails` instead of
dropping them with the rest of pi's `AgentToolResult`.

**This level is verbatim, and therefore sensitive.** `args` hold whatever the script passed — a
`write` body, a `bash` command line, an `Authorization` header pasted into an `http_get` — exactly
as the replay cache does (decision 13). The library's caller is trusted host code, as `LlmClient`
is; redaction is the boundary's job, below. Results, `stdout` and return values are never in the
trace at any level: `ToolCallTrace` does not carry them.

### What "the calls" means

The trace is what **executed**. A session replays every earlier snippet's calls from its cache
before the new code runs, and the sandbox records those dispatches like any other — `Session`
strips them from an `ok` result and from nothing else (measured: an error result lists every
replayed read ahead of the failure; a suspended result and a resumed one are raw too). The runner
therefore keeps its own recorder: every host tool in a session's registry is wrapped so a real
execution, success or throw, leaves a record — inside the replay cache, so a replayed call leaves
none. The sandbox's entries are then aligned to the records **per tool, from the end**:

- an `ok: true` entry with a matching record (same tool, same resolved arguments) executed;
- an `ok: true` entry with none was served from the cache and is dropped;
- an `ok: false` entry is always kept — the cache stores successes only, so a failure never
  replays.

From the end because replayed entries come first: the transcript replays the earlier snippets
before the new code, and the replay cursor never advances on a mismatch. This is exact under
deterministic replay. On a non-deterministic transcript it degrades to a swap of `details` between
two calls with identical arguments — the same bound `Session.filterCachedCalls` has — and never to
a missing or invented call.

A resumed result reports the **whole run**, the calls before the gate and after it, because that
is what the sandbox accumulates; the records survive the suspension so the whole run aligns. They
are cleared when a call finishes or is abandoned, and at the start of every `run` — a run is a fresh
call, and a pending suspension is dropped anyway. Calls on one session are assumed sequential: the
extension serialises them (`executionMode: "sequential"`), and [#59] documents the library's stance.

One consequence worth knowing: a call that executed for real before a suspension and is re-executed
by the *next* `run` — because a suspended snippet's pre-gate calls are not cached — is listed by
that run, because it did execute again. The trace reports executions, not intentions.

## The extension: `details` and the rendered trace

pi persists `details` to the session file, emits it over RPC and hands it to `renderResult`. It
outlives the call, so nothing verbatim leaves the extension. `details` on all four tools is a
`ReplDetails`:

```jsonc
{
  "sessionId": "default",
  "status": "ok",                  // the trace status, or "reset" / "abandoned" for those tools
  "calls": [
    { "tool": "read", "ok": true, "durationMs": 7.7, "args": "\"hello.txt\"",
      "details": { "truncation": { "truncated": true, "truncatedBy": "lines", "totalLines": 2500, … } } },
    { "tool": "write", "ok": true, "approved": true, "durationMs": 1.7,
      "args": "\"tok.txt\", \"ghp_[REDACTED]\"" },
    { "tool": "write", "ok": false, "approved": false, "durationMs": 0,
      "args": "\"no.txt\", \"y\"", "error": "tool 'write' requires approval" }
  ],
  "omittedCalls": 0,
  "suspendedCall": { "tool": "bash", "args": "\"npm test\"" }   // when status is "suspended"
}
```

Display-safe, and JSON-safe (no `Buffer`, `Map` or `Set` — it round-trips through `JSON.stringify`
unchanged):

- **`args`** is one rendered line: positional values, then `name=value` for keywords, strings in
  JSON quotes like the approval dialog, `None` / `True` / `False`, `{k: v}` for a dict, `{…}` for a
  set, `<bytes n>` for bytes, nesting to four levels. Every string leaf is masked with
  `maskSecrets` (`src/redact.ts`, decision 6) **before** anything is cut — a 4 KiB window per leaf,
  its last 64 characters dropped when the leaf was longer, so a token straddling the window's edge
  leaves no prefix behind — and the joined line goes through `redact()` at
  `TRACE_ARGS_MAX_BYTES = 256`: head-only, with a magnitude-free marker
  (`[… truncated at 256B. The trace keeps only the head of the arguments. …]`). A 64 KiB `write`
  body shows its first two hundred bytes and the marker. Exact boundaries are pinned: a line of
  256 bytes is untouched, 257 is cut.
- **`error`** is masked and cut the same way — a `bash` failure carries the command's output.
- **`details`** is a **fail-closed projection** of the built-in tool's object: numbers, booleans and
  `null` survive anywhere (three levels deep); a string survives only under `fullOutputPath` and
  `truncatedBy`, masked and cut; every other string — `TruncationResult.content`, which is the
  truncated body itself, `edit`'s `diff` and `patch`, any string a future tool adds — is dropped.
- **`calls`** is capped at `TRACE_MAX_CALLS = 1000` head entries; `omittedCalls` counts the rest
  (the sandbox's accumulator has no cap of its own).
- **`suspendedCall`** is `{ tool, args }`, rendered the same way.

`repl_reset` and `repl_abandon` return the same shape with `calls: []` and their own status
(`reset` / `no-session`; `abandoned` / `nothing-pending` / `no-session`).

### The rendered trace

`repl` and `repl_resume` define `renderResult`: a small component holding the result text followed
by the trace lines from `formatTrace`, wrapped to the terminal width. Plain text, no theme — the
formatter is a pure function of `details`, so what a test asserts is what the TUI shows.

Collapsed, one line:

```
[trace] 3 host-tool call(s): 2 ok, 1 denied, 0 failed — expand to list them
```

Expanded, one line per call — `✓` / `✗`, the call, `approved` / `denied` for a gated one, the
duration, the error, and what the built-in tool's details add:

```
[trace] 3 host-tool call(s)
  ✓ read("hello.txt") 8ms · output truncated by lines
  ✓ write("tok.txt", "ghp_[REDACTED]") approved 2ms
  ✗ write("no.txt", "y") denied 0ms — tool 'write' requires approval
```

A suspended call is listed last as `⏸ bash("npm test") waiting for approval`; calls past the cap
as `… N more call(s) not listed (trace capped at 1000)`. The header counts every call the run made,
listed or not. A run with no calls says `[trace] no host-tool calls`.

### Ordering

The trace is in dispatch order. It is **not** interleaved with `stdout`: a `print` before a call
and one after it are both in the result text, and the trace is a separate list below it. Monty
0.0.21 can report where each call fell in the stream ([#40]); the `seq` index that lines the two up
arrives in wave 3 (decision 11).

## What this does not cover

- **Redaction is a bound, not a proof.** `maskSecrets` covers shapes with a recognisable prefix,
  header, envelope or name (`docs/redaction.md`); a bare high-entropy string is data to it, and
  survives the 256-byte head if it sits inside it.
- **The library trace is verbatim.** An embedder that persists or displays `runWithTrace().calls`
  owns its own redaction; the extension's `buildDetails` is the reference.
- **A concurrent run on one session** — two `runWithTrace` calls in flight on the same `sessionId`,
  which the extension never does — shares the recorder, and the alignment of the later one is
  best-effort.
- **The rendered trace is plain.** No colours, no per-call expansion; pi's own `read`/`bash` tools
  render richer results for calls made directly, and the trace is an audit line, not a viewer.

[#46]: https://github.com/AdarGit008/repl-simple/issues/46
[#59]: https://github.com/AdarGit008/repl-simple/issues/59
[#40]: https://github.com/AdarGit008/repl-simple/issues/40
