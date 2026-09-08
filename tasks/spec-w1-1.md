# Spec: W1-1 — Verification-only close-out and the namespace answer

Chunk `w1-1` of the wave-1 plan · branch `chunk/w1-1-verification-closeout` · decisions **D68–D72** ·
session 2026-09-08.

## Objective

Drain the tracker of state that already landed on `main` before any agent re-derives it (precedent:
the STOP-SHIP A33–A37 verification-only close-out, `8476fed`), and pin the one open question that
needed a measurement rather than a code change: whether Monty 0.0.21's `externalLookup` makes
host-tool shadowing structurally impossible (#40's namespace question, recorded from #54).

**This chunk ships no `src/` or `extensions/` diff.** It ships tests, two documentation corrections,
and GitHub tracker actions backed by re-verified `file:line` evidence.

## Current state (measured at HEAD `3770e46`, 2026-09-08)

### #199 / #200 / #201 — landed, never closed

- `git branch -r --contains 9e126af` and `… a5abac8` both list `origin/main`.
- `9e126af` (PR #202): ever-private memory `src/builtins.ts:83-94` (`everPrivate` set, doc comment),
  membership refusal before any lookup `:490-499`, first-lookup recording `:500-513`, two-lookups-agree
  `:516-540` (`second = await resolveAddresses`, `sameAddressSet`, `rebinding detected`). Tests:
  `test/builtins.test.ts:820-925` (ever-private memory) and `:1023-1135` (two-lookups-agree).
- `a5abac8` (PR #203): `EVER_PRIVATE_MAX_ENTRIES = 1024` at `src/builtins.ts:97`, `everPrivateKey`
  (lowercase + strip one trailing dot) `:100-103`, `rememberEverPrivate` fail-closed at saturation
  `:109-115`. Tests: `test/builtins.test.ts:884-925` (L2 normalization) and `:927-1021` (L1 saturation).
- GitHub missed PR #202's bold `Closes **#199**`; PR #203 cited no issue number.
- Two residuals recorded in `tasks/ship-report-199-l1l2.md` and `docs/http-egress.md:69-99`, both
  still open in the code: (a) `fetchGuarded` hands `fetchImpl` `url.href` — the *name* —
  at `src/builtins.ts:568`, so the connection resolves a third time outside validation
  (`:225-233` documents it); (b) `rememberEverPrivate` returns `false` at saturation without
  recording (`:112`), so a hostname first refused at saturation is refused again only after a fresh
  lookup (R1 in the L1+L2 ship report).

### #172 — nothing emits or consumes the proposed shapes

- `grep -rn "RlmStep\|RlmProgressEvent" src/ extensions/ docs/ test/ tasks/ README.md SPEC.md` is
  empty.
- What exists instead: `RlmIteration` `src/rlm.ts:40-50` (`index`, `code`, `result`, `llmResponse`),
  `RlmOptions.onIteration` `:94`, invoked per iteration at `:1416`; `RlmResult` `:126-146` carries
  `status` / `answer` / `answerSource` / `iterations` / `budget` / `error`. `src/index.ts:106-115`
  exports them. A24's "structured trajectory" is served by `onIteration` + `iterations[]`.

### #154 — the premise is false

- `node_modules/@pydantic/monty/dist/session.d.ts:26-38`: `FeedOptions.externalLookup` — "a function
  entry becomes a host function the sandbox can call (sync or async)". `:115-116`: "Session state
  (globals, functions) persists across `feedRun` calls". `:49-63`: `FeedStartOptions.externalLookup`.
- `src/sandbox.ts:1224-1228` already calls `session.feedStart(code, { inputs, printCallback, mount })`
  on a checked-out `MontySession`; the host-tool bridge runs on `NameLookupSnapshot` resolution
  (`:944-957`) and snapshot resume, not on an `externalFunctions` option that never existed.
- Cost, re-measured 2026-09-08 with the probe in the ship report: 8 live sessions, `x = 1` fed once
  each — **9.6 MB RSS mean per worker without type checking (76.8 MB total)**, **15.6 MB with
  `typeCheck: true` (124.5 MB total)**; host process 84 MB. `src/pool.ts:24`
  `DEFAULT_MAX_PROCESSES = 4` against `src/repl.ts:111` `DEFAULT_MAX_SESSIONS = 32`.

### #66 — the property holds; five of six tests are missing

- `src/sandbox.ts:944-957`: a `NameLookupSnapshot` for a registered name resolves to the name itself,
  so the sandbox holds a proxy that reports the right tool whenever it is eventually called.
- Present: alias (`test/sandbox.test.ts:2148`), list storage (`:2158`), unregistered name (`:2167`).
- Missing (issue tests 2–6): comprehension, dict storage, passed-as-argument, `map()`, `print(f)`.
  Measured 2026-09-08: the first three dispatch with `calls.length === 1`; `map()` is
  `error[unresolved-reference]: Name \`map\` used when not defined` at type-check time with
  `calls.length === 0` — a different failure from the runtime `NameError` the issue was filed on;
  `print(f)` prints `<function 'echo' external>` and raises nothing (the 0.0.18 `TypeError: Value is
  not undefined` residual is gone).

### #40 namespace question (from #54) — measured 2026-09-08

With `echo` registered as a host tool (`runInSandbox`, `ToolRegistry([echo])`):

| Form | Result | Host calls |
|---|---|---|
| `def echo(text): …` / annotated `def echo(text: str) -> str` | `ok`, Python body wins | 0 |
| `class echo: …` | `ok`, class wins | 0 |
| `import json as echo` / `from json import dumps as echo` | `ok`, module/function wins | 0 |
| `import json` with a tool named `json` | `ok`, module wins | 0 |
| `echo = 1`, `echo = lambda …`, `echo = _e`, `(echo := 5)`, `echo, x = 1, 2`, `for echo in …`, `global echo; echo = 5` | `error[invalid-assignment]` (typing) | 0 |
| `echo += 1` | `error[unsupported-operator]` (typing) | 0 |
| `del echo; echo("x")` | `error[unresolved-reference]` (typing) | 0 |
| `a = echo("first")` then `def echo` then `echo("x")` | `ok`, `<echo:first>\|SHADOWED` | **1** |
| nested `def echo` inside a function; module-level `echo("y")` | `ok`, `INNER\|<echo:y>` | 1 |
| parameter `def g(echo)`; module-level `echo("y")` | `ok`, `param\|<echo:y>` | 1 |
| `exec(…)`, `globals()`, `setattr(…)` | `error[unresolved-reference]` — the names do not exist | 0 |
| `from json import *` | runtime `NotImplementedError: Wildcard imports … not supported` | 0 |

`findShadowingBindings` (`src/toolstore.ts:263`) records `echo` for every zero-call form except the
bare `import json` with a tool named `json` (its import branch, `:332-337`, records only `as`
aliases — by design, since no shipped tool shares a name with a Monty module).

### Spike document — two stale statements

- `docs/monty-0021-spike.md:290` prescribes declaring `@bjorn3/browser_wasi_shim`. `package.json`
  carries `@pydantic/monty` as its only runtime dependency, deliberately: `docs/platform-support.md:32-48`
  records that the shim makes the in-process wasm entry *loadable*, which forfeits crash isolation, and
  `src/` imports `@pydantic/monty/node` explicitly so that path cannot be selected by accident.
- `docs/monty-0021-spike.md:339` (and the same claim at `:125-127`) lists `npm pack` / `files` as
  unanswered. `tasks/ship-report-bucket-10.md:14-16` answered it: `files: ["dist", "src", "repl",
  "extensions", "NOTICE"]`, a 60-entry tarball, no tests/docs/plans.

## Decisions

| # | Decision |
|---|---|
| **D68** | **No `src/` / `extensions/` diff; RED evidence by falsification.** The tests this chunk adds are of two kinds. *Todo tests* (decision 9) assert the missing property and are RED against `main` by construction — un-`todo`'d they fail, and the commit message carries that output. *Characterization pins* pass at HEAD by design (the behaviour already landed), so "RED against main's `src/`" is structurally impossible for them; instead each pinned property was falsified by an uncommitted local edit to `src/` (host-tool name resolution removed; `findShadowingBindings` stubbed to `[]`) and the number of pins that failed under each falsification is recorded in the ship report and the commit message. That is the honest analogue of RED for a verification-only chunk. |
| **D69** | **The namespace answer: `externalLookup` does not make shadowing structurally impossible; `findShadowingBindings` is the whole boundary.** Host tools resolve only through name lookup for names Python has not bound, and resolution is per lookup: `def`, `class`, `import … as`, `from … import … as` and a bare `import` of a same-named module all bind ahead of the host tool with zero host calls. The assignment forms are refused, but by `typeCheckStubs` (`error[invalid-assignment]` against the stub's `def echo(text: str) -> str`) — a type-checker property that would vanish with the stub, not a namespace property. `exec` / `globals()` / `setattr` / `import *` — the false negatives the #40 note feared — do not exist in Monty 0.0.21, so the scanner has no dynamic-rebinding gap to cover. Consequence for #54: its load-time scan stays the boundary, not belt-and-braces. The one measured scanner gap (bare `import X` for a tool named like a Monty module) is latent for the shipped tool set and becomes a todo test, not a `src/` change. |
| **D70** | **The two #199 residuals are todo tests in `test/http-egress-residuals.test.ts`, never issues** (decision 9). Both reuse the resolver-mock pattern of `test/builtins.test.ts`. (a) *Connect-time window*: the pin asserts the connection target handed to `fetch` is pinned to a validated address — literal-IP host or an address-pinning `dispatcher` on the init — which is how the intended fix (a custom `undici` dispatcher whose `lookup` returns the validated set) would be observable without prescribing it. (b) *R1*: the pin asserts a hostname first refused at saturation is refused again *before any new lookup*; intended fix: refuse **and** record, or a bounded LRU. #199 closes now on the landed interim hardening, with both residuals named as these tests. |
| **D71** | **#154 is re-scoped, not closed** (decision 8). Title and body are rewritten to the measured premise (`externalLookup` is host functions; `MontySession` keeps globals across feeds; `feedStart` is already in use) and the new scope — one persistent sandbox per RLM loop plus a pool cap of 16, costed at the measured 9.6–15.6 MB per worker — scheduled after the wave-3 sandbox chunk. A correction comment names what was wrong and cites the `.d.ts` lines. #172 closes as superseded by `onIteration` / `RlmIteration` / `RlmResult`. |
| **D72** | **Documentation corrections are dated addenda, tracker ticks need evidence.** The two spike-document fixes are made in place with a "corrected 2026-09-08" marker (plus a one-line pointer at the duplicate `:125-127` claim); the dated 2026-08-13 dispositions table is left as history. On the nine epics, a checkbox is ticked only where a `file:line` or a merge commit on `main` evidences it, and every unticked criterion is named in the audit comment with the reason (open child issue, or contested evidence such as the #109-tainted mutation score). Only `gh` actions the chunk adjustments list are taken; #66's closing comment is drafted in the ship report and posted only after this PR merges. |

## Tests — RED → GREEN plan

### `test/http-egress-residuals.test.ts` (todo, RED by construction)

1. `connects to the validated address, not the hostname` — resolver answers one public address to
   both lookups; `fetchImpl` records `(url, init)`; assert the target is a validated literal IP or
   the init carries a `dispatcher`. Today: handed `rebind.example.com`, no dispatcher → fails → TODO.
2. `remembers a hostname first refused at saturation (R1)` — fill the memory to
   `EVER_PRIVATE_MAX_ENTRIES`, drive one more private-resolving hostname to the saturated refusal,
   call it again, assert the resolver was **not** consulted again. Today: consulted twice → fails →
   TODO.

### `test/shadowing.test.ts` (characterization pins; falsification evidence in the ship report)

- **Shadowing forms (0 host calls):** `def`, annotated `def`, `class`, `import … as`,
  `from … import … as`, bare `import` of a same-named module — each asserts `status: "ok"`, the
  exact output, and `calls.length === 0`.
- **Assignment forms refused by the type checker:** `echo = 1`, `echo = lambda`, `echo = _e`,
  walrus, tuple target, `for` target, `global` — `errorKind: "typing"`,
  `/^error\[invalid-assignment\]/m`, `calls.length === 0`. `+=` → `unsupported-operator`;
  `del` → `unresolved-reference`.
- **Resolution is per lookup:** `a = echo("first")` / `def echo` / `echo("x")` →
  `calls.map(tool) === ["echo"]`, output `<echo:first>|SHADOWED`; same with `class`; nested `def`
  and a parameter named `echo` leave the module-level name resolving to the host tool.
- **No dynamic rebinding primitive:** `exec`, `globals`, `setattr` are unresolved names;
  `from json import *` is refused at runtime.
- **`findShadowingBindings` is the whole boundary:** every zero-call shadowing form is recorded;
  every assignment form is recorded; scoped bindings (`def g(echo)`, `lambda echo="x"`) are not.
  Todo: the bare-import gap.
- **#66 remainder:** comprehension, dict storage, passed-as-argument (`calls.map(tool) === ["echo"]`,
  exact output); `map()` is a type-check `unresolved-reference` with zero calls; `print(f)` and
  `str(echo)` yield `<function 'echo' external>`.

### Gates

`npm run check && npm run lint && npm run test:contained && npm run coverage`, all green before push.

## Boundaries

- May modify: `docs/monty-0021-spike.md`. May create: `test/shadowing.test.ts`,
  `test/http-egress-residuals.test.ts`, `tasks/spec-w1-1.md`, `tasks/ship-report-w1-1.md`.
  Nothing else — `test/sandbox.test.ts` belongs to W1-2, `src/` and `extensions/` to sibling chunks.
- `gh` actions limited to the eleven listed in the chunk adjustments; no issue is filed; #66, #38,
  #154 and #40 stay open.
- No new dependency; no `coverage:update`.
