# Ship Report — W2-2: Replay integrity and persistence hardening (#61, #62, #63, #58)

Branch: `chunk/w2-2-replay-persistence` · Base: `main` (`e3c68da`) · Commits: `acb83c2` (spec),
`14ae2c0` (RED), `93b084c` (GREEN), `80ac75d` (todo) · Spec: `tasks/spec-w2-2.md` (D121–D132) ·
Maintainer decisions 12, 13 (and 2 for the in-memory precedence rule) · Decision: **GO**

## What was built

1. **stdout is this call's** (`src/session.ts`, `src/sandbox.ts`, `src/types.ts`; D121, D122;
   #61, #58 criterion 1). `Session` keeps a per-snippet byte mark (`stdoutBytes[]`, the first figure
   including the preamble's prints) and hands the sum to `run()`'s sandbox call as the new
   `RunOptions.stdoutSkipBytes`; `makePrintCallback` drops that many leading bytes — slicing a
   straddling callback — before `onPrint` and the accumulator, so the truncation budget applies to
   the delta by construction. The session measures each call's bytes on the unconditional `onPrint`
   stream (truncation-policy invariant 6); a suspension carries the segment's figure and a resume
   adds its own. *Bytes, not the brief's entries*: measured, Monty's callback fires once per
   `print` but holds a partial line (`end=""`) until the next newline or host boundary and chunks a
   large print at 8 KiB, so a prefix ending in a partial line merges with the next call's first
   print into one callback on replay — an entry count would swallow that line, a byte mark cuts it
   exactly. The callback shape is pinned as a tripwire in `test/sandbox.test.ts`.
2. **A14–A17 recovered, fixed or pinned** (D123–D126; #62). A14: pre-gate cache entries travel with
   the suspension (`pending.preGate` in memory, `suspended.preGateCache` in the dump), accumulate
   across a nested re-suspension, and are appended ahead of the resume's own on success. A15:
   inputs are per-call, documented on `RunOptions.inputs` and in `docs/session-replay.md`; the
   session records the input *names* its retained snippets ran with (memory only) and appends a
   note to a failed run that omitted any. A16: pinned, and `filterCachedCalls` is generalised to
   `withoutReplayedCalls` and applied on every outcome — the error trace and the suspension (hence
   the resumed call's trace) no longer carry replayed calls. A17: `MAX_SNIPPETS = 256` (refused at
   `run()` entry, `errorKind: "unavailable"`, nothing about the session changes) and
   `MAX_CACHE_ENTRIES = 1024` (enforced inside the caching registry *before* the tool executes, as
   a Python `RuntimeError` naming the limit — no side effect, run fails `runtime`, nothing appended,
   replay-deterministic); `load()` refuses a dump beyond either. No new `RunErrorKind`;
   `src/repl.ts` untouched. The four recovered descriptions are posted on #62
   (`issuecomment-5584090867`).
3. **Persistence hardened** (D127–D130; #63). Dump **v2**, validated wholesale before anything is
   assigned: the 1 MiB bound (`MAX_DUMP_BYTES`) on the serialized text *before* `JSON.parse` (and on
   `dump()`), every object closed (unknown keys — `suspendedRunOpts`, a raw `signal`, `__proto__` —
   rejected by name), every field typed, base64 by shape, `suspended`/`suspendedCode` together or not
   at all, both caps; a v1 dump refused, not upgraded. **No approvals from a file**: restored cache
   entries are marked in memory, `willReplayKey` is false for one, an approved restored gated call
   runs for real and its real result replaces the file's in place; the suspended call's
   `description` is re-derived from the live tool via the now-exported `buildApprovalRequest`.
   **No host policy from a file** (D129): `suspendedRunOpts` is gone from the dump — mounts are a
   capability, `limits` can say `"unbounded"`, the caps are the host's; the resume caller supplies
   them (the in-process caller-wins merge of W1-2 is unchanged). `dumpRedacted()` is the
   display/export form via `src/redact.ts` — masking on snippets, keys, descriptions, trace errors;
   head-only 4 KiB cut on results and stdout; snapshot and arguments omitted; `redacted: true` and
   refused by `load()`. `dump()` stays verbatim and is documented as sensitive.
4. **Calls serialised per session** (D131; wave-1 follow-up c). `run()` and `resume()` go through a
   per-session queue. Measured before: two concurrent `resume()` calls on one suspension both
   returned `ok` and the gated tool executed **twice** from one approval; concurrent `run()`s
   assembled prefixes that did not include each other. Rejection was not an option for `run()`
   (`test/repl.test.ts:1697`, #59, expects both concurrent runs to succeed).
5. **Wave-1 follow-ups a, b, and #178** (D132). (a) `test/session.test.ts:1752` now discriminates:
   a v2 dump carries no `suspendedRunOpts`, and one that names `{signal: {}}`, `{mount: {"/": "/"}}`
   or `{}` there is rejected by name; a restored resume reads a mounted file only with a fresh caller
   mount. (b) The wall-clock test (`:2035`) is restructured: 2.5 s of host time under the run's 5 s,
   then a trivial continuation resumed under a 2 s budget — per-segment it has the whole 2 s; a
   spanning budget would already be 0.5 s in the past and time out at once (the negative side is
   deterministic; the old 1.2 s + 1.2 s under 2 s had 0.8 s of slack each side). (#178) the
   `String.prototype.split` patch at `:402` uses `withPatchedPrototype`.
6. **Docs.** `docs/session-replay.md` (new, normative: the model, what each call reports, the cache
   and the four recovered defects, the failure table, dumps and the invariant, D129, the schema,
   concurrency, known limits); `docs/approval-grants.md` loses "when #40 removes transcript replay"
   and gains the restored-entry rule; `docs/truncation-policy.md` records the delta budget (#61) and
   the export cut row; source comments at `src/session.ts` (`willReplayKey`) and `src/sandbox.ts`
   (`DispatchAccumulators`) updated.

No new dependency. `src/repl.ts`, `coverage-baseline.json` untouched.

## Verification evidence

**Gates** (final run, tree at `80ac75d`). `npm run check` clean · `npm run lint` clean (59 files) ·
`npm run test:contained` with `REQUIRE_BRIDGE_TOOLS=1`: **1440 tests, 1430 pass, 0 fail, 10 todo**,
40.7 s, exit 0 · `npm run coverage`: **"All per-file floors met"**, exit 0 — `src/session.ts`
**99.46** (floor 98.73), `src/sandbox.ts` **97.74** (97.66), `src/types.ts` **100.00** (100.00);
`src/redact.ts` 99.51 and `src/truncate.ts` 100.00 as the instrument reports them run to run
(`coverage:update` not run).

**RED → GREEN.** With `origin/main`'s `src/` and `extensions/` checked out over the branch
(`git checkout origin/main -- src extensions`): `test/session.test.ts` **118 tests, 84 pass, 32
fail, 2 todo**; `test/sandbox.test.ts` **140 tests, 136 pass, 4 fail**. The 32 + 4 failures are
exactly the intended RED set — `test/session.test.ts` `:103` (own stdout), `:1064` (v2 + mark in the
dump), `:1752` (D129), `:2151 :2162 :2173 :2181 :2194` (#61 t1–t5), `:2208 :2229 :2243 :2251`
(suspend/resume, partial line, onPrint, dump/load mark), `:2301 :2321 :2344` (A14 ×3), `:2362`
(A15 note), `:2387 :2412` (A16 traces), `:2456 :2479 :2506` (A17 ×3), `:2555 :2733 :2739 :2754
:2790 :2822 :2846 :2902 :2961` (#63 t1, 1b, 2, 3, 3b, 3c, 4, 5, 6), `:2983 :3009` (D131); and
`test/sandbox.test.ts` `:2814 :2830 :2848 :2859` (`stdoutSkipBytes`). At `80ac75d` with the
branch's `src/`: session **117 pass, 0 fail, 2 todo**; sandbox **140 pass**. Pins green on `main` by
construction: `:2375` (A15 semantics), `:2035` (wall clock, restructured), `:402` (#178 helper),
and the sandbox tripwire block `:2686 :2697 :2733 :2751` (D122). Reproduce: check out `main`'s
`src/` and `extensions/` over the branch and run `npx tsx --test test/session.test.ts
test/sandbox.test.ts`.

**Adversarial probes from the brief**, each reproduced by a test:

| Probe | Result | Test |
|---|---|---|
| poisoned `callCache` naming a gated `bash` | `PermissionError`, **asked 1, executions 0**, no `FAKE-OUTPUT` (was: `ok`, `FAKE-OUTPUT`, 0, 0) | `test/session.test.ts:2754` |
| approved restored gated entry | runs for real, real result replaces the file's, then replays silently | `:2790` |
| description lies about its args | dialog shows the re-derived `gate_63(x="x")`, never `harmless` | `:2822` |
| malformed dumps (34 shapes: wrong types, extra keys, `__proto__`, bad base64, pre-bump version, half a suspension, `suspendedRunOpts`, a redacted export) | each an `Error` starting `Invalid session dump:` naming the field, never a `TypeError` | `:2555` |
| 100 MB base64 snapshot | refused on byte length before parse; **165 ms** measured in the RED run against main's parser-first path, under 20 ms on the branch | `:2739` |
| `suspendedRunOpts.mount = {"/": "/"}` in a dump | rejected by name; a restored resume reads a mounted file only with a fresh caller mount (W1-2 caller-wins) | `:1752` |
| round trip | snippets, non-gated results, suspension, trace (`error`/`approved`), stdout mark kept; grants dropped | `:2846` |
| secret-shaped cached result in export mode | `token=[REDACTED]`, ≤ 4 KiB, `truncated at` marker; verbatim `dump()` keeps the token; export refused by `load()` | `:2902` |
| 300 KB then a small print | `IMPORTANT-NEW-OUTPUT\n`, untruncated (was 32 751 bytes) | `:2162` |
| suspend → resume double count | call reports `a\nb\n` once, the next call `c\n` | `:2208` |
| cap hit | 257th snippet `unavailable` naming 256 and reset, nothing ran; 1025th entry `runtime` naming 1024, tool not executed, snippet not appended | `:2456`, `:2479` |
| two concurrent resumes | **one** execution; the loser gets `No suspended execution to resume` (was: two) | `:2983` |

**Measurements behind D121/D122** (`scratchpad/probe-w22b.ts`, Monty 0.0.21): 9 `print`s →
8 callbacks (`end=""` merged into the next); `print("a", end=""); print("b", end=""); print("c")`
→ `["abc\n"]`; `print("x", end=""); echo(); print("y")` → `["x", "y\n"]`; 100 000 `Z` → 13
callbacks of 8 192 bytes (`ceil(100001 / 8192)`); a partial straddling a gate: original call
`["x"]` then `["y\n"]`, replay `["x", "y\n"]` — the mark agrees. Garbage / truncated / bit-flipped /
empty snapshots → `runtime` RunError `protocol violation: failed to load session: …`, never a throw
(`probe-w22c.ts`).

## Residuals as todo tests

- `test/session.test.ts:3032` — *a denied restored gated call derails the replay cursor*. The gate
  raises `PermissionError` without advancing the cursor, so the next non-gated entry executes for
  real (the assertion fails, reported as TODO). A key mismatch always behaved this way; D128 makes
  it reachable from a single denial. Intended approach in the reason string: `willReplayKey` hands
  the gate a `skip()` for the entry it refused to treat as a replay, so a denial consumes it and the
  cursor stays aligned. Documented as a known limit in `docs/session-replay.md`.

Not residuals, recorded as documented contract: `abandon()`, `reset()` and `dump()` stay
synchronous and are not queued behind an in-flight call (pre-existing); a non-deterministic prefix
or a different preamble on load mis-sizes the mark (a callback count would fail the same way).

## Deviations from the brief, and why

- **Byte mark, not entry count** (D121). The brief specified `stdoutSkipEntries` and "pin
  one-callback-per-print as the tripwire". Measured, the callback is not one-per-print at a partial
  line or above 8 KiB, and the partial-line case makes an entry count lose data on replay. The
  option is `stdoutSkipBytes`; the tripwire pins the shape as measured.
- **No run options in the dump** (D129), which changes W1-2's `#84 test 5`. The brief's adversarial
  probe ("a dump whose `suspendedRunOpts.mount` points at `/` cannot mount without a fresh caller
  mount") and W1-2's own flag ("mount host paths still persist — coordinate with W2-2") both point
  here; limits and byte caps are the same kind of field. The in-memory rule (decision 2) is
  untouched; `ReplRunner` passes clamped `limits` and no mount either way.
- **`skipped` write-only counter removed** from the trace filter (`src/session.ts`, was flagged for
  the #83 sweep) as part of generalising the function; noted so the sweep does not look for it.

## Closing-comment drafts (for the orchestrator, after merge)

**#61** — Closed by the W2-2 merge (decision 12: replay stays; fixed in place, D121). Test 1
(own output across three runs): `test/session.test.ts:2151`. Test 2 (300 KB then a small print
returns the small one, untruncated): `:2162`. Test 3 (no output → empty stdout): `:2173`. Test 4
(the delta is what truncates): `:2181`. Test 5 (`reset` resets the mark): `:2194`. Both
reproductions behave: `alpha\n`/`beta\n`/`gamma\n` and `IMPORTANT-NEW-OUTPUT\n`. Also: suspend/resume
counted once (`:2208`), partial-line prefix (`:2229`), `onPrint` (`:2243`), dump/load (`:2251`);
sandbox `stdoutSkipBytes` (`test/sandbox.test.ts:2814-2859`) and the callback-shape tripwire
(`:2686-2751`). Policy: `docs/truncation-policy.md` (#61 entry), `docs/session-replay.md`.

**#62** — Closed by the W2-2 merge, first DoD branch: all four defects have a recovered written
description (the comment `issuecomment-5584090867` and `docs/session-replay.md`), a fix or a pin,
and a test each — A14 `test/session.test.ts:2301` (with `:2321` nested, `:2344` through
dump/load), A15 `:2362` (note) and `:2375` (per-call semantics, decision 12), A16 `:2387` and
`:2412`, A17 `:2456`, `:2479`, `:2506`. The `_` binding note in `docs/truncation-policy.md` Q3
remains true: replay stays.

**#63** — Closed by the W2-2 merge (decision 13). Test 1 (malformed dump rejected, not coerced):
`test/session.test.ts:2555` (34 shapes) and `:2739` (oversize, before parse). Test 2 (a dump
claiming prior approvals does not auto-approve after load — tested adversarially): `:2754`
(poisoned cache: asked 1, executions 0, no forged stdout), `:2790` (approved restored entry runs for
real), `:2822` (lying description re-derived), `:1752` (no host policy from a file). Test 3 (round
trip preserves what it should, drops what it must): `:2846`. Test 4 (redaction is applied on
write, same policy object as #46): `:2902` — `Session.dumpRedacted()` through `src/redact.ts`'s
`maskSecrets`/`redact`, the one helper (decision 6); the verbatim `dump()` is documented sensitive.
`dump()` bound: `:2961`. Normative record: `docs/session-replay.md` ("Dumps").

**#58** — All four exit criteria evidenced: (1) each `repl` call reports only what that call
produced — stdout `test/session.test.ts:2151-2251`, calls on every outcome `:2387`, `:2412` (and
`:171` from before); (2) concurrent calls on one `sessionId` cannot discard state — `a0bd242` (#59)
at the runner, and now `Session` itself serialises `run()`/`resume()` (`:2983`, `:3009`); (3) the
pool is bounded and evicts — `a0bd242`; (4) sessions do not outlive the Pi session — W1-3
(`test/extension.test.ts:1820` no leak across shutdown/start, `:1843` idempotent shutdown, `:1922`
shutdown reports the pending session). Children #61, #62, #63 closed with this merge; #59, #60
earlier.

## Rollback plan

| Commit | Reverts |
|---|---|
| `80ac75d` | the residual todo test |
| `93b084c` | the byte mark, A14/A15/A16/A17, the validator and dump v2, restored entries, D129, `dumpRedacted`, the queue, the docs (the RED tests at `14ae2c0` fail again) |
| `14ae2c0` | the tests (revert together with `93b084c`, or 36 RED tests stay red) |
| `acb83c2` | the spec |

`git revert 80ac75d 93b084c 14ae2c0 acb83c2` (newest first) returns to `e3c68da`.

## Go / No-Go

**GO.** All four gates green; 36 RED tests turn GREEN on the fix and nowhere else; the security
property — no approvals, and no host policy, from a file — is tested adversarially with the
measured before/after numbers; `src/repl.ts` untouched, no new kind, no new dependency; the one
residual is a `todo` with its intended approach.
