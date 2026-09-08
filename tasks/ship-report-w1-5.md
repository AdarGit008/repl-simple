# Ship Report — W1-5: RLM boundary hygiene, stub honesty, and the shared redaction helper

Branch: `chunk/w1-5-rlm-hygiene-redaction` · Base: `main` (`3770e46`) · Spec: `tasks/spec-w1-5.md`
(D97–D115; fix round 1 = D111–D115) · Decision: **GO**

Issues closed by the PR: #168, #191, #192, #67, #169, #170, #173 (plus the filed synthesised-reply
residual, which had no number). Epics #70 and #31 are **not** closed here — their closing-comment
drafts are at the end, for the orchestrator to post after merge.

## What was built

Security first, then hygiene — one commit pair (RED test, GREEN fix) per item:

1. **#168 — per-iteration invocation cap (D97).** `RLM_TOOL_CALL_CAP = 16` combined `llm_query` +
   `rlm_query` invocations per loop iteration (decision 4), declared in `src/rlm_tools.ts` so the
   two tool descriptions and the loop's markers cite one number. The counter lives in `runRlm`'s
   closure scope, resets before every sandbox run, and is checked *first* in both closures —
   before the #171 bound, the spend charge, the depth branch and any nested `runRlm` — so a refused
   call charges nothing, builds no child registry and no system prompt. Refusal is a D63-style
   marker as the tool's return value (`[llm_query refused: per-iteration cap of 16
   llm_query/rlm_query calls reached]`, likewise `rlm_query`), never a throw, with or without a
   `SpendBudget`.
2. **#191 — magnitude-free redaction marker (D98).** The provider-error redaction passes
   `unknownTotal`, so every redaction marker reads `[… truncated at 1.0KB. The full provider error
   is not surfaced. …]` — where it cut, never how much it withheld. Model-facing value cuts keep
   their true totals.
3. **#192 — threat model written down (D99).** The `LlmClient` doc block in `src/rlm.ts` (where the
   interface is declared — not `src/types.ts`) states that implementations are trusted host code
   and that the 1 KiB head-only bound is accepted, not tightened; `docs/truncation-policy.md` gains
   the #191 and #192 narratives and the general redaction rule now records "no magnitude" and
   names `src/redact.ts` as the one call site.
4. **`src/redact.ts` — the shared redaction helper (D100; round 1: D111, D112, D114).**
   `redact(text, { maxBytes, recovery })` = `maskSecrets(text)` then a head-only `truncateText` with
   `unknownTotal`. Masking runs before the cut so a token straddling the boundary leaves no
   fragment. Four rule families, each read on one line (`[ \t]`, never `\s`): known token prefixes
   with the prefix kept; `Authorization` header values — a known scheme (`Basic`, `Bearer`,
   `Digest`, `Token`, `Negotiate`, `NTLM`, `HOBA`, `Mutual`, `AWS4-HMAC-SHA256`) kept and its
   credential masked, an unknown first token masked together with the same-line token after it, a
   lone value masked whole — and bare `Bearer` tokens; PEM private-key blocks, terminated or cut
   off, with a tempered body scan; `NAME=value` / `NAME: value` for decision 6's list literally —
   bare `KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`PASSWD` and any name ending in them, word-bounded, bare
   `key` on `=` only. Every regex is linear on 1 MiB adversarial shapes (the PEM scan proven by a
   same-size density test); masking is idempotent in text and count. `redactProviderError` calls
   it, so the shared object has a live consumer; `docs/redaction.md` is the normative description.
5. **Synthesised-answer cap (D101).** The cap-time synthesis reply was the one uncapped
   `RlmResult.answer` path (the monitor report's "flows through the D18 cap" claim was wrong: D18
   caps the conversation copy of *iteration* replies). It is now cut at 256 KiB, value-shaped, plain
   `truncateText` (an API return — no sentinel wrap), with a neutral recovery clause.
6. **#67 — degraded stubs counted, reported, surfaced (D102–D105).** `ToolRegistry.degradedStubs()`
   returns `{ tools, checkerGaps }`: path 1 (`unparseable`) read off the rendered text, path 3
   (`unknown-type`) from a known-type-name check over every rendered name, path 2 as
   `TY_GAP_CANDIDATES` with a reason per entry in `TY_GAP_REASONS`. The renderer maps the HostTool
   spelling `"void"` to Python `None`, so `def SUBMIT(answer: str) -> None:` is checked instead of
   `-> void` being an unresolved name the checker tolerated. `buildSystemPrompt` appends an
   `## Unchecked Tools` section only when the report is non-empty; the shipped prompt is
   byte-identical. The `repl`-side notice is deferred (decision 10) as a todo test.
7. **#169 — stub validation memoised (D106).** Module-level, content-addressed by the joined stub
   text, storing the in-flight promise; a rejection drops its own entry; 64 entries clear
   wholesale. `stubValidationInvocations()` / `resetStubValidationMemo()` mirror the probe memo.
8. **#170 — child inherits the parent's full `options.inputs` (D107)**, merged context on top.
9. **#173 — the question is the reserved `question` sandbox input (D108)**: sliceable in Python,
   announced in the prompt trailer, never rendered as an input block, refused if a caller supplies
   one, and `QUESTION_RECOVERY` now names the slice route while the two tool paths keep the
   sandbox-free wording as `TOOL_PROMPT_RECOVERY`.

No new dependency. No change outside the owned files.

## Verification evidence

- **Gates at HEAD (fix round 1):** `npm run check` clean · `npm run lint` clean ·
  `REQUIRE_BRIDGE_TOOLS=1 npm run test:contained` → **1275 tests, 1273 pass, 0 fail, 2 todo**
  (36.8 s, exit 0, no OOM) · `npm run coverage` (contained) → **"All per-file floors met"**, exit 0;
  owned files measured `src/rlm.ts` 99.64 · `src/rlm_tools.ts` 100.00 · `src/registry.ts` 98.30 ·
  `src/redact.ts` **100.00 in the merged run** — 207/207 lines in both merged measurements at HEAD
  (the gate and a kept-lcov run of the same command line), so the floor of 100 is met without the
  tolerance (D115). The 99.37 the first round saw was one lost line of the 159-line file under the
  #113 merge defect; the rewrite of families 2–4 replaced that region. (Round-0 figures: 1249 tests,
  1247 pass.)
- **Coverage baseline (D110).** `npm run coverage:update` ran exactly once, contained, after every
  test was in (3 measurements, per-file minima, no refusal). Floors that changed, each justified:
  - `src/rlm.ts` 99.14 → **99.64** — the cap, redaction, synthesis, prompt-section and question
    paths are all exercised; the only unexecuted lines left are the two abort/rejection races.
  - `src/rlm_tools.ts` 99.07 → **99.22** — the cap constant and descriptions are read by every
    `runRlm` test.
  - `src/registry.ts` 96.02 → **98.30** — `degradedStubs()`, the memo (hit, miss, rejection, reset)
    and `TY_GAP_REASONS` are covered; the residue is the probe's dead-worker branches.
  - `src/redact.ts` new at **100** — measured 159/159 lines once the `import` was moved above
    the module comment (a `/** */` block ahead of the first import is reported uncovered by V8
    through the tsx source map: 26 lines, 82.58 % in the update run, with every line executed).
    The floor is hand-set to the measured value rather than re-running the update.
  - **Seven untouched files restored to main's floors** (`extensions/repl-extension.ts`,
    `src/bashenv.ts`, `src/builtins.ts`, `src/pathjail.ts`, `src/preamble.ts`, `src/sandbox.ts`,
    `src/truncate.ts`): the update's minima moved each by exactly one line in one of three
    runs (the #113 defect — `src/preamble.ts` 100 → 97.05 is one of 34 lines, `src/truncate.ts`
    100 → 99.74 is the documented case), and this chunk neither lowers nor raises a floor it did
    not earn. The plain gate's one-line tolerance absorbs those observations, so keeping main's
    values cannot go red.
  - `global` 97.84 → 98.32 — reported, not a gate.
- **RED against main, measured:** a scratch copy of the branch with main's `src/` and `extensions/`
  swapped in, running `test/rlm.test.ts test/registry.test.ts test/redact.test.ts`: **288 tests,
  247 pass, 39 fail, 2 todo** — the 39 failures are exactly the new tests (`test/redact.test.ts` as a
  whole plus 38 named tests); every pre-existing test still passes. The one new test that passes in
  that configuration is the policy-doc pin (`docs/` is not swapped); its RED is the commit ordering
  — the pin (`29c6ce0`) precedes the docs (`e0226db`).
- **Per-item RED→GREEN pairs** (commit → commit): #168 `14b19ce`→`acf9cc9` · #191
  `916eb79`→`b867735` · #192 `29c6ce0`→`e0226db` · `redact.ts` `478c85b`→`966e582` · synthesis cap
  `f9f010f`→`3949c60` · #67+#169 `6442d59`→`7b7144d` (one pair: the memo and the accessor share
  `validateStubs`) · #170 `50fa224`→`76c768c` · #173 `f0f911e`→`5f88bda`.
- **Adversarial probes** (all in `test/rlm.test.ts`, block at :5445):
  - *Refusal markers cannot be forged into real output*: sandbox code prints the exact marker; the
    real 17th call is still refused and the forged copy reaches the model only inside the
    feedback's `stdout:` section, as program output.
  - *Cap resets per iteration*: 17 calls in iteration one (17th refused), 16 in iteration two (none
    refused), 32 of 33 reach the provider.
  - *Depth-3 nested `rlm_query` with no budget is bounded*: root floods 20, 16 children spawn, each
    spawns 2 grandchildren under `maxDepth: 2` — exactly 1 + 16 + 32 code-gen calls.
  - *Refusal precedes nested host work*: a spy on the caller registry's `list()` (the child's first
    act, before `buildSystemPrompt`) counts 1 + 16, not 1 + 20.
- **Neighbouring suites** that build `returns: "void"` tools (`test/rlm_tools.test.ts`,
  `test/sandbox.test.ts`, `test/repl_server.test.ts`, `test/types.test.ts`, `test/builtins.test.ts`)
  pass unchanged with the `-> None` rendering: 334/334.

## Fix round 1 — the verifier's findings (2026-09-08)

Verdict on round 0 was *fail* on one blocking finding plus six non-blocking ones. Every finding
is accepted and fixed; none is refuted. One RED→GREEN pair per finding family, each new test
measured RED against the branch's pre-fix code (the fix's parent commit), the guards named.

| # | Finding | Fix | Evidence |
|---|---|---|---|
| 1 (blocking) | Family 2a kept a schemeless `Authorization` credential and masked the *next* token when whitespace and text followed (`Authorization: abcdef1234567890XYZ\nX-Request-Id: 42` → credential survived; the "schemeless header" fixture was green only because `==` is outside the scheme class) | D111: one-line rule (`[ \t]`), a known-scheme list kept, an unknown first token masked with its same-line successor, a lone value masked whole; values end at end of line, whitespace, quote, `;`, `,`; `BEARER_VALUE` no longer crosses a newline | `8ec1ea4` → `bef3137`. `test/redact.test.ts:110` family 2: the exact probe (`:155`), header dumps with several headers, compact and schemeless JSON, two `curl -H` lines, `;`- and `,`-joined pairs, every known scheme by spelling, four unknown schemes, a scheme word with no credential, `the Bearer\nauthentication scheme` untouched. RED: 12 fail (4 rows, 5 named tests, the idempotent count, both fuzzes) |
| 2 | Family 3a quadratic on BEGIN lines with no END (×4 per doubling; 16000 lines = 854 ms; 1 MiB through `redact()` 4.4 s); the doc's linearity claim and the 56 KB fixture did not match | D112: tempered body scan `(?:(?!-----BEGIN )[\s\S])*?`; the shape at 1 MiB; a same-size density test; `docs/redaction.md` says what is measured | `e1f59c9` → `9dff198`. `:833` bounded work: 1 MiB of BEGIN lines 3.6 ms (was 4923 ms); `:855` density: 1024 vs 1 BEGIN lines in 1 MiB, best of 5 × 4 passes, **1.11×** fixed (13.4 / 14.9 ms) vs **36.21×** on the old scan (9.4 / 339.2 ms), bound 3×. 16000 lines 4.19 ms; `redact()` of 1 MiB 4.09 ms. RED: both fail |
| 3 | A caller tool named `question` was silently shadowed by the reserved input (`TypeError: 'str' object is not callable`; the tool never ran) | D113: refused at `runRlm` start after the D51 loop — `runRlm: tool 'question' conflicts with the reserved 'question' input — the sandbox variable would shadow the tool. Rename it.` | `e796bd9` → `d594646`. `test/rlm.test.ts:6151`: exact message, zero LLM calls. RED: "Missing expected rejection" |
| 4 | Decision 6 lists `KEY|TOKEN|SECRET|PASSWORD=value` literally; bare `KEY=value` passed through | D114: bare words and names ending in them, any case, quotes/`export`/spaces tolerated, word-bounded both sides (`monkey=`, `keyboard=`, `keyword=`, `key_id=` stay data), bare `key` on `=` only; Python's `key=` kwarg masks — the recorded cost, exact output pinned | `0e0df0e` → `f49b9d1`. `:354` family 4: the exact probe, a 16-name × 6-form literal-list walk (96 inputs), the `key:` field-name pin; `:517` documented costs. RED: 4 fail (probe, walk, both cost pins); guards: 4 corpus entries and the `key:` pin |
| 5 | `src/redact.ts` floor 100 above the merged 99.37, held by the one-line tolerance | D115: two merged measurements at HEAD read 207/207; the floor is the measured value | `npm run coverage`: `src/redact.ts 100.00 100.00`; kept lcov `LH:207 LF:207`, no `DA:*,0` row |
| 6 | Ship-report citations drifted by 1–2 lines | Regenerated from `grep -n` at HEAD (this document) | `:5890`, `:5983`, `:6000`, `:6041`, `:6099`, `:6151`; registry `:422`, `:532` |
| 7 | Re-run the no-false-positive corpus plus a fuzz of 200 random lines | Corpus: **29 entries**, 0 masked. Fuzz (`:784`, seeded LCG): **200 random one-to-three-line non-secret documents** from 49 header/env/prose/code lines, **0 false positives**; **200 random header dumps** with a planted credential in five header shapes, **0 survivals**, every other header verbatim | The negative fuzz was RED on the old code — 3 documents masked, all `…Bearer\nauthentication…` (the newline-crossing rule); the positive fuzz was RED on schemeless credentials ahead of a header |
| 4a–4d (minor) | `\s+` across newlines; `;`/`,` swallowed; `masked` not idempotent (2 on a second pass); a tautological idempotence assertion | All in D111: `[ \t]` only, terminators preserved, the header and assignment rules refuse a value that is already `[REDACTED]`, the assertion is `twice.masked === 0` | `:601` idempotence over every positive fixture and the corpus: second pass masks 0 |

**RED against the pre-fix code, per pair** (`npx tsx --test test/redact.test.ts` at the RED
commit, `--test-name-pattern="#173"` for `test/rlm.test.ts`): pair 1 — 102 tests, 12 fail; pair 2
— 103 tests, 2 fail (the 1 MiB shape 4923 ms; the density ratio 36×); pair 3 — the `#173` block, 1
fail of 6; pair 4 — 110 tests, 4 fail. **Guards, green before and after by design** (disclosed, not
counted as RED): pair 1's Bearer header dump, compact and schemeless JSON, both `curl -H` lines and
the `WWW-Authenticate` corpus entry (6); pair 4's four corpus entries and the `key:` pin (5).

**Why the growth test holds the size fixed.** A size-doubling form (256 KiB → 1 MiB, under 3× per
doubling, four passes each) measured 2.0 / 6.2 / 17.0 ms = **3.10×** on the *fixed* code under the
parallel full-suite load — cache effects at 1 MiB, not the algorithm (linear separates from
quadratic by 2× vs 4× there, which contention erases). Two texts of exactly 1 MiB with 1 and 1024
BEGIN lines share their memory profile, so only the scan count differs: 1.11× linear against 36×
quadratic under the same 3× bound.

**Documented cost accepted with decision 6, literally.** `sorted(rows, key=lambda r: r[1])` →
`sorted(rows, key=[REDACTED] r: r[1])`. The two kwarg corpus entries became the documented-costs
table; `docs/redaction.md` records the price. Bare `key:` stays a field name.

## Residuals — as todo tests, not issues (decision 9)

| Todo test | Where | Why deferred | Intended approach |
|---|---|---|---|
| `holds the 256 KiB ceiling on a reply just over 1 MiB (truncator marker reserve)` | `test/rlm.test.ts:5890` | `src/truncate.ts` (not owned) reserves the marker at `elided = totalBytes`, assuming the elided figure never renders wider than the total; `formatSize` prints `944.0KB` (7 chars) against `1.2MB` (5), so a cut of a 1–1.35 MB value overshoots invariant 1 by 2–3 bytes on every `truncateText` surface | reserve with the widest rendering of any elided value ≤ total (the 1 MB boundary), then flip the todo |
| `the repl tool reports degraded stubs to the user (deferred, decision 10)` | `test/rlm.test.ts:5983` | decision 10: the `repl`-side notice is wave 2; `src/repl.ts` is not owned | `ReplRunner` surfaces `degradedStubs().tools` once per session in the tool result, the slot the preamble status uses |

Also recorded, not hidden: `src/index.ts` is not owned, so `redact`, `maskSecrets`, `DegradedStub`,
`StubDegradationReport`, `TY_GAP_REASONS`, `stubValidationInvocations`, `resetStubValidationMemo`
and `RLM_TOOL_CALL_CAP` are reachable from their modules, not the barrel, until wave 2 (#85's
`knip` pass will list them).

## Deviations from the brief

- **`returns: "void"` fixed in the renderer, not at `src/rlm_tools.ts:84`.** `HostTool.returns` is
  the closed union `"str" | "void"` in `src/types.ts` (not owned) and `test/rlm_tools.test.ts:120`
  (not owned) pins `SUBMIT.returns === "void"`. The honest Python spelling `None` therefore cannot
  be declared on the tool; `renderReturn` in `src/registry.ts` translates the HostTool vocabulary,
  which also fixes every other void tool, and the known-type-name check guards the rendered names.
  `src/rlm_tools.ts:84` carries the explanatory comment.
- **#67 and #169 share one RED→GREEN pair** because `degradedStubs()` reads the memoised
  `validateStubs` result; splitting them would have meant a GREEN that half-implemented the memo.

## Rollback plan

| Commit | Reverts |
|---|---|
| `f49b9d1` / `0e0df0e` | round 1: family 4 literal (bare `KEY=`, word boundaries, costs table) |
| `d594646` / `e796bd9` | round 1: `question` tool collision |
| `9dff198` / `e1f59c9` | round 1: tempered PEM scan, 1 MiB shape, density test |
| `bef3137` / `8ec1ea4` | round 1: family 2 shapes, one-line rules, idempotent count, fuzz |
| `5f88bda` / `f0f911e` | #173 question input (+ its tests and the re-pinned tests 9/19/21) |
| `76c768c` / `50fa224` | #170 child input inheritance |
| `7b7144d` / `6442d59` | #67 + #169 (registry accessor, memo, prompt section) |
| `3949c60` / `f9f010f` | synthesised-answer cap |
| `966e582` / `478c85b` | `src/redact.ts`, `docs/redaction.md`, the `redactProviderError` switch |
| `e0226db` / `29c6ce0` | #192 doc block + policy narratives |
| `b867735` / `916eb79` | #191 `unknownTotal` |
| `acf9cc9` / `14b19ce` | #168 cap |

Each pair reverts cleanly in newest-first order; reverting `966e582` alone re-opens the
`HEAD_ONLY_RATIO` import in `src/rlm.ts` (the pre-#191 shape) and keeps #191's marker. Reverting
`bef3137` alone re-opens the blocking leak; the round-1 pairs are otherwise independent of each
other.

## Closing-comment drafts (for the orchestrator, after merge)

**#168.** Landed in W1-5 (merge SHA). Decision 4: 16 combined `llm_query` + `rlm_query` invocations
per iteration, those two tools only, enforced with or without a `SpendBudget`, refused with a marker
and never thrown. The check precedes the #171 bound, the charge, the depth branch and any nested
`runRlm`, so the per-spawn host work the budget could not bound (`buildSystemPrompt`) is never
done for a refused call. Tests: `test/rlm.test.ts:5445` (exact marker with and without a budget,
combined counting, registry spy, per-iteration reset, depth-3 tree, forged marker).

**#191.** Landed in W1-5 (merge SHA). Option 2: `redactProviderError` passes `unknownTotal`, so the
marker is `[… truncated at 1.0KB. The full provider error is not surfaced. …]` on all four
surfaces; the policy records it (`docs/truncation-policy.md`, "#191" narrative and the redaction
rule). Tests: `test/rlm.test.ts:5700`.

**#192.** Landed in W1-5 (merge SHA). Option 1, decided: `LlmClient` implementations are trusted host
code, the 1 KiB head-only bound is accepted; the sentence lives on the interface doc block in
`src/rlm.ts` and the policy carries the narrative. `src/redact.ts`'s masking is defence in depth on
top of the bound, not a tightening it relies on. Tests: `test/rlm.test.ts:5810` (source and policy
pins).

**#67.** Landed in W1-5 (merge SHA). Issue tests 1–4: (1) a well-formed signature is checked — the
shipped registry renders every tool as a `def` (`test/registry.test.ts:422`, zero-degraded); (2) a
degraded stub is counted and reported — `degradedStubs()` (`:422`, path 1 and path 3); (3) the
shipped registry has zero degraded tools, and the same assertion fires with a broken stub injected;
(4) a degraded tool is reported to the caller — listed in the RLM system prompt under `## Unchecked
Tools` (`test/rlm.test.ts:5940`). DoD: the count is observable at runtime (`degradedStubs()`), the
deliberate probe gaps are documented per entry (`TY_GAP_REASONS`, pinned). `-> void` no longer
renders. Deferred as a todo test: the `repl`-side notice (decision 10).

**#169.** Landed in W1-5 (merge SHA). Stub validation is memoised per process by stub content, across
`runRlm` calls and nesting levels; the probe memo was already per process. Counter-backed tests:
`test/registry.test.ts:532` (identical sets validate once, a rejected validation is never cached,
reset hook) and `test/rlm.test.ts:6000` (two runs plus a nested child validate once).

**#170.** Landed in W1-5 (merge SHA). Decision 7: the child inherits the parent's full `options.inputs`
with the D52 merged context on top; documented on `RlmOptions.inputs`. Tests: `test/rlm.test.ts:6041`.

**#173.** Landed in W1-5 (merge SHA). `question` is a reserved sandbox input: sliceable, announced in the
trailer, never double-rendered, refused from either input source before any query;
`QUESTION_RECOVERY` names the slice route and the tool paths keep the sandbox-free wording; a
caller *tool* named `question` is refused at `runRlm` start like the D51 names (fix round 1, D113).
Tests: `test/rlm.test.ts:6099`, the tool collision at `:6151`; template pins 9/19/21 updated in the
same commit.

### #70 — Bucket 9 epic (draft; do not close from this PR)

Five exit criteria, each test-backed:

1. **One RLM entry point; `grep RLMLoop src/` returns nothing.** #78 deleted `rlm_loop.ts`;
   measured at W1-5 HEAD: `grep -rn RLMLoop src/` → 0 lines. `runRlm` is the only loop.
2. **A malformed SUBMIT does not end a run.** #71 — `test/rlm.test.ts:4314` ("a SUBMIT call that
   failed to resolve"): an `ok:false` SUBMIT trace no longer stops the loop.
3. **The shipped preamble works as documented.** #72 — `context` is always declared
   (`test/rlm.test.ts` 9.2.7 / 9.2.8 / 9.2.9) and `test/repl_server.test.ts` drives the shipped
   `repl_server.py` helpers; W1-5 adds the `question` input the preamble's docs can now name (#173).
4. **An aborted run returns what it completed.** #75 — `test/rlm.test.ts:1744` (abort parked inside
   the synthesis pass salvages) and `:1853` (salvage of completed iterations).
5. **`rlm.ts`'s mutation score is no longer zero.** `docs/mutation-testing.md:38`: 30.58 % (63/206
   killed) against #24's hand campaign of 0/9; decision 17 moves the re-baseline to standalone
   infra.

W1-5 closes the last bucket-9 children (#67, #169, #170, #173) and the post-ship follow-ups #191,
#192; #154 and #172 are dispositioned by decision 8. Recommend closing after W1-5 merges.

### #31 — Bucket 3 epic (draft; do not close from this PR; pair with W1-3)

Four exit criteria plus the ceiling this bucket did not name when it was scoped:

1. **`while True: pass` returns a `TimeoutError` within the default budget and Pi stays
   responsive.** #32 — `limitsConfig()` defaults (`src/sandbox.ts:695-718`: 30 s compute, 512 MiB,
   host wall clock) apply to every run: `test/sandbox.test.ts:2296` ("ships a finite duration,
   memory and wall-clock budget", a runaway with no `limits` argument reports `errorKind:
   "timeout"`, `:2331`); the repeated-hang and runaway sweeps at `:2464-2536`; 0.0.21 worker
   isolation keeps the event loop live (`docs/monty-0021-spike.md`); the extension clamps
   model-supplied limits (`test/extension.test.ts:209-271`).
2. **A memory bomb is bounded rather than OOM-ing the host.** #32 — `test/sandbox.test.ts:2340`
   ("a memory bomb with no limits argument fails on the default ceiling", `errorKind: "memory"`,
   `:2347`); the host available-memory floor refuses a run before it starts (`:2075`); the
   `SandboxMemoryError` guard is pinned at `test/session.test.ts:814-838`.
3. **No single tool result can exceed a stated byte budget.** #29/#34/#144/#145/#167/#184 — the
   implementation-record table in `docs/truncation-policy.md`; W1-5 closes the last uncapped RLM
   answer path (the synthesised reply, `test/rlm.test.ts:5852`) and bounds provider errors without
   disclosing their size (#191).
4. **No single run can produce an unbounded number of approval prompts, and the user can always say
   no.** #35 — W1-3 (decision 3: 8 dialogs per call, "Deny remaining"); cite W1-3's PR and tests.
5. **Host-tool breadth.** #168 — W1-5's per-iteration cap on `llm_query` / `rlm_query` bounds the
   fan-out the budget alone could not (`test/rlm.test.ts:5445`).

The FROZEN comment's `turnTimeout` claim is retracted per W1-1 (cite its PR). Recommend closing
after W1-3 and W1-5 merge.

## Go / No-Go

**GO.** Security items first and test-backed; every new test measured RED against main's source
(round 0) or the pre-fix parent (round 1, guards disclosed); full contained suite green; no unowned
file touched; the two residuals are todo tests with named approaches; the one brief deviation
(`void` fixed in the renderer) is forced by unowned files and recorded above; the verifier's
blocking finding and all six non-blocking ones are fixed with evidence in the round-1 section.
