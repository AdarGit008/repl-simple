# Ship Report — W1-1: Verification-only close-out and the namespace answer

Branch: `chunk/w1-1-verification-closeout` · Base: `main` (`3770e46`) · PR: [#207](https://github.com/AdarGit008/repl-simple/pull/207) · Date: 2026-09-08 · Decision: **GO**

## What was built

No `src/` or `extensions/` change (`git diff main --stat -- src/ extensions/` is empty). The PR is tests,
two documentation corrections, a design record, and tracker actions backed by re-verified evidence.

1. **`test/shadowing.test.ts` — the #40 namespace answer, measured on the shipped Monty 0.0.21** (41 tests:
   40 pass, 1 todo). `externalLookup` does **not** make host-tool shadowing structurally impossible: `def`,
   annotated `def`, `class`, `import … as`, `from … import … as`, and a bare `import` of a same-named
   module all bind ahead of a registered host tool with **zero host calls**; the seven assignment forms
   are refused by `typeCheckStubs` with `error[invalid-assignment]` naming the stub signature — a
   type-checker property, not a namespace one; `+=` is `unsupported-operator`, `del` then call is
   `unresolved-reference`; resolution is **per lookup** (`a = echo("first")` → `def echo` → `echo("x")`
   makes exactly one host call, output `<echo:first>|SHADOWED`); nested `def` and a parameter named like
   a tool leave the module-level name resolving to the host; `exec` / `globals` / `setattr` are not names
   in 0.0.21; `from json import *` is refused at runtime. A cross-check block pins that
   `findShadowingBindings` (`src/toolstore.ts:263`) records every zero-call form and every assignment
   form and does not refuse scoped bindings — it is the whole boundary (D69). The same file carries the
   five #66 tests still missing on 0.0.21: comprehension, dict storage, passed-as-argument (one host
   call each), `map()` as a type-check `unresolved-reference` with zero calls, `print(f)` printing
   `<function 'echo' external>` instead of raising.
2. **`test/http-egress-residuals.test.ts` — the two #199 residuals as `todo` tests** (D70), never issues:
   the connect-time rebinding window (`fetch` is handed the name, `src/builtins.ts:568`) and R1
   saturation-not-remembered (`rememberEverPrivate` returns `false` without recording, `:112`).
3. **`docs/monty-0021-spike.md`** — migration-plan step 1 no longer prescribes declaring
   `@bjorn3/browser_wasi_shim` (deliberately omitted: it makes the in-process wasm trap loadable,
   `docs/platform-support.md:32-48`); §Undetermined's `npm pack` / `files` line is struck through with
   bucket 10's answer (`tasks/ship-report-bucket-10.md:14-16`, PR #205); the duplicate claim in §2 gets
   a one-line pointer. Dated addenda, history left intact (D72).
4. **`tasks/spec-w1-1.md`** — D68–D72, current state with `file:line`, the RED → GREEN plan.

## Measurements (2026-09-08, this worktree, `@pydantic/monty` 0.0.21, Node 24.19)

| Probe | Result |
|---|---|
| `def echo …; echo("x")` with `echo` registered | `ok`, `SHADOWED`, `calls.length === 0` |
| `class echo` / `import json as echo` / `from json import dumps as echo` / `import json` (tool `json`) | `ok`, `calls.length === 0` |
| `echo = 1`, lambda, same-signature function, walrus, tuple, `for`, `global` | `errorKind: "typing"`, `error[invalid-assignment]: … not assignable to \`def echo(text: str) -> str\`` |
| `a = echo("first")` / `def echo` / `echo("x")` | `calls.map(tool) === ["echo"]`, `calls[0].args === ["first"]` |
| `exec` / `globals` / `setattr` | `error[unresolved-reference]: Name \`exec\` used when not defined` (etc.) |
| `map(read_file, ["a","b"])` | `error[unresolved-reference]: Name \`map\` used when not defined`, `calls.length === 0` |
| `print(f)` where `f = echo` | stdout `<function 'echo' external>\n`, no error |
| `findShadowingBindings("import json\n…", {"json"})` | `[]` — the one scanner gap (todo) |
| Worker RSS, 8 live sessions, `x = 1` fed once, no type checking | **9.6 MB mean**, 76.8 MB total, host 84.5 MB |
| Worker RSS, same, `typeCheck: true` | 15.6 MB mean, 124.5 MB total, host 84.1 MB |
| `grep -rn "RlmStep\|RlmProgressEvent" src/ extensions/ docs/ test/ tasks/ README.md SPEC.md` | empty |
| `git branch -r --contains 9e126af` / `… a5abac8` | both list `origin/main` |
| `grep -r turnTimeout node_modules/@pydantic/monty/dist` | empty (`requestTimeout` at `dist/pool.d.ts:23`) |

## Verification evidence

- **Gates at `f494bc0`** (all four, in order): `npm run check` clean · `npm run lint` 56 files, no
  warnings · `npm run test:contained` **1169 tests / 267 suites: 1166 pass, 0 fail, 3 todo**, 38.5 s,
  exit 0 · `npm run coverage` all per-file floors met (`src/builtins.ts` 99.53 vs 99.45,
  `src/toolstore.ts` 98.90 vs 98.90, `src/sandbox.ts` 97.66 vs 97.66; global 98.51 reported).
- **RED, todo tests** (`cb8e803`): un-`todo`'d, both fail against `main`'s `src/` —
  `fetch was handed 'rebind.example.com' with no address-pinning dispatcher` and
  `a hostname refused at saturation must be refused from memory next time, not re-resolved — 2 !== 1`.
- **RED by falsification, characterization pins** (`0d2a7c0`, D68): each an uncommitted `src/` edit,
  restored afterwards (`git status -- src/` clean). (a) `src/sandbox.ts` name lookups never resolve to
  a host tool → **36 pass / 4 fail** (the four #66 value-form pins). (b) `src/toolstore.ts`
  `findShadowingBindings` returns `[]` → **29 pass / 11 fail** (the eleven scanner cross-checks). The
  shadowing-form and per-lookup pins characterize Monty's own semantics and guard a version bump; no
  local `src/` edit can falsify them.
- **Tracker post-conditions**: `gh issue view 199 200 201 172 --json state` → CLOSED;
  `gh issue list --label bucket-4 --state open` → #41, #46; #154 retitled and open; #66, #38, #40 open;
  #178 carries `bucket-11`.

## GitHub actions taken (all 33 succeeded; comments cite commit SHA + `file:line` re-verified on `main`)

| Issue | Action | URL |
|---|---|---|
| #199 | closing comment (`9e126af` / `a5abac8`; residuals → todo tests) | https://github.com/AdarGit008/repl-simple/issues/199#issuecomment-5580998137 |
| #199 | closed (completed) | https://github.com/AdarGit008/repl-simple/issues/199 |
| #200 | closing comment (`EVER_PRIVATE_MAX_ENTRIES` `src/builtins.ts:97`, tests `:932`, `:977`) | https://github.com/AdarGit008/repl-simple/issues/200#issuecomment-5580998624 |
| #200 | closed (completed) | https://github.com/AdarGit008/repl-simple/issues/200 |
| #201 | closing comment (`everPrivateKey` `src/builtins.ts:100-103`, tests `:884`, `:902`) | https://github.com/AdarGit008/repl-simple/issues/201#issuecomment-5580999092 |
| #201 | closed (completed) | https://github.com/AdarGit008/repl-simple/issues/201 |
| #172 | closing comment (superseded by `onIteration` `src/rlm.ts:94` / `RlmIteration` `:40-50` / `RlmResult` `:126-146`; grep empty) | https://github.com/AdarGit008/repl-simple/issues/172#issuecomment-5580999500 |
| #172 | closed (not planned / superseded) | https://github.com/AdarGit008/repl-simple/issues/172 |
| #154 | retitled "9.x — One persistent sandbox per RLM loop (raise the pool cap to 16)", body rewritten | https://github.com/AdarGit008/repl-simple/issues/154 |
| #154 | correction comment (premise false; `session.d.ts:26-38`, `:115-116`; 9.6 MB / worker) | https://github.com/AdarGit008/repl-simple/issues/154#issuecomment-5581000246 |
| #40 | namespace-isolation answer | https://github.com/AdarGit008/repl-simple/issues/40#issuecomment-5581000526 |
| #198 | cross-link to the #40 answer | https://github.com/AdarGit008/repl-simple/issues/198#issuecomment-5581000730 |
| #38 | mount verification (`test/sandbox.test.ts:949`, `9cd4981`; not closed — W1-2) | https://github.com/AdarGit008/repl-simple/issues/38#issuecomment-5581000912 |
| #31 | retraction of the FROZEN comment (`turnTimeout` absent; mount was unmeasured) | https://github.com/AdarGit008/repl-simple/issues/31#issuecomment-5581001095 |
| #26 | ticked 3 of 4 exit criteria; audit comment | https://github.com/AdarGit008/repl-simple/issues/26#issuecomment-5581001477 |
| #31 | ticked 3 of 4; audit comment | https://github.com/AdarGit008/repl-simple/issues/31#issuecomment-5581001948 |
| #41 | ticked 4 of 5; audit comment | https://github.com/AdarGit008/repl-simple/issues/41#issuecomment-5581002375 |
| #47 | ticked 4 of 5; audit comment | https://github.com/AdarGit008/repl-simple/issues/47#issuecomment-5581002760 |
| #52 | ticked 5 of 5; audit comment | https://github.com/AdarGit008/repl-simple/issues/52#issuecomment-5581003196 |
| #58 | ticked 2 of 4; audit comment | https://github.com/AdarGit008/repl-simple/issues/58#issuecomment-5581003587 |
| #64 | ticked 0 of 2; audit comment | https://github.com/AdarGit008/repl-simple/issues/64#issuecomment-5581004003 |
| #70 | ticked 4 of 5; audit comment | https://github.com/AdarGit008/repl-simple/issues/70#issuecomment-5581004398 |
| #83 | ticked 0 of 3; audit comment | https://github.com/AdarGit008/repl-simple/issues/83#issuecomment-5581004930 |
| #178 | label `bucket-11` added | https://github.com/AdarGit008/repl-simple/issues/178 |

Checkboxes left unticked, each named in its audit comment with the reason: #26 mutation floor (#175,
decision 17); #31 approval-dialog cap (#35, decision 3, wave-1 sibling); #41 trace visibility (#46,
wave 2); #47 "Escape is distinguishable from denial" (superseded by the fail-closed design + "Decide
later"; owner should reword); #58 stdout de-duplication (#61) and session lifetime (#60); #64 both (open
children; the second is a rule); #70 mutation score (#109-tainted, #175); #83 all three (#85, #86, #84).

Not done, deliberately: no issue filed (decision 9); no comment on #66 (closes after merge — draft below);
no comment on #68 (not in this chunk's adjustments); #54 already closed, its disposition is in the #40
answer.

## Residuals as todo tests

| Test | Reason | Intended approach |
|---|---|---|
| `test/http-egress-residuals.test.ts` "connects to the validated address, not the hostname" | `fetchGuarded` hands `fetch` the hostname (`src/builtins.ts:568`); a resolver answering public to both validation lookups and private at connect time is invisible | custom `undici` dispatcher whose `lookup` answers from the validated set, on the `docs/http-egress.md` revisit trigger |
| `test/http-egress-residuals.test.ts` "remembers a hostname first refused at saturation (R1)" | `rememberEverPrivate` refuses without recording at the cap (`:112`) | refuse **and** record, or a bounded LRU keyed by `everPrivateKey` |
| `test/shadowing.test.ts` "records a bare import of a module named like a host tool" | the import branch (`src/toolstore.ts:331-337`) records only `as` aliases; latent for the shipped tool set | also record a plain `import X` / `import X.Y` whose first segment is reserved |

## Closing comment for #66 — post after PR #207 merges (do not post before)

> **Closing — fixed upstream in 0.0.21 and now pinned by tests in this repository**, which is what #64's
> rule required before this could close.
>
> The six tests:
> 1. `f = echo; f("hi")` — `test/sandbox.test.ts:2148` (alias), plus `:2158` (list storage) — `9cd4981`.
> 2. Comprehension — `test/shadowing.test.ts` "dispatches a tool reached through a comprehension":
>    `[t("x") for t in [echo]][0]` → `<echo:x>`, `calls.map(tool) === ["echo"]`.
> 3. Dict storage — "dispatches a tool stored in a dict".
> 4. Passed as argument — "dispatches a tool passed as an argument".
> 5. `map(read_file, paths)` — "map() fails at type-check time as an unresolved name — not a runtime
>    NameError, zero calls": `error[unresolved-reference]: Name \`map\` used when not defined`,
>    `errorKind: "typing"`, `calls.length === 0` — asserted separately from the runtime `NameError`, as
>    the issue asked.
> 6. `print(f)` — "print(f) prints the proxy's repr instead of raising": stdout
>    `<function 'echo' external>\n`, `str(echo)` the same, no error. The 0.0.18
>    `TypeError: Value is not undefined` residual is gone on 0.0.21; the test is its documentation.
>
> Mechanism on 0.0.21: `src/sandbox.ts:944-957` resolves a name lookup to the tool's own name, so the
> sandbox holds a proxy that reports the right tool whenever it is eventually called — there is no
> `SENTINEL` to leak. Merged in `<merge SHA>` (PR #207).

## Rollback plan

| Commit | Reverts |
|---|---|
| `f494bc0` | the two spike-doc corrections |
| `0d2a7c0` | `test/shadowing.test.ts` (pins + one todo) |
| `cb8e803` | `test/http-egress-residuals.test.ts` (two todo tests) |
| `ebcba5e` | `tasks/spec-w1-1.md` |

Every commit is independently revertable; none touches `src/`. The tracker actions are comments and
checkbox ticks with their URLs above; reopening #199/#200/#201/#172 is a `gh issue reopen` each, and
#154's previous body is preserved in its history.

## Go / No-Go

**GO.** No code change; all four gates green; every closed issue's closing comment cites a merge commit on
`main` and `file:line` re-verified today; the namespace question that gated #54's disposition is answered
by 41 tests; every residual is a `todo` test with its intended approach; #66 waits for the merge under
#64's rule.
