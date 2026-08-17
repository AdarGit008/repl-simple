# Monitor report — flight F-74 (issue #74 "9.4 — Message growth is unbounded: 1.57 MB across 4 iterations")

Final replacement monitor. Flight is COMPLETE (sentinel `tasks/FLIGHT_DONE` present; SHIP commit
`29da9e5` "ship report: GO (#74)"). Branch `issue-74-message-growth` is 7 commits ahead of
`origin/main`, unmerged. Advisory only — no issue was edited by this monitor.

Artifacts read: `tasks/monitor-watch.md` (Items 1–21, polls 1–9), `tasks/ship-report.md`,
`tasks/review.md`, `SPEC.md`, `tasks/plan.md`, `src/rlm.ts` (verified quotes at HEAD `29da9e5`),
issue #74 body + comments, issue #70 body, `gh issue list --state open`.
Cap provenance verified via `git log -S`: stdout 32 KiB/run = #29 (`4434ed1`,
`DispatchAccumulators`); output 16 KiB = #34 (`e556a70`, `capOutput`).

The watch log is the complete append-only discovery record. This report re-expresses its
Items 1–21 as exact issue-edit wording plus placement, and adds the follow-up defects the
watch log's final poll flagged as needing a home.

---

## A. Edits to issue #74 itself (still open; branch unmerged — edit before merge)

### A1. Staleness block → append to the "## Problem" section of #74 (before "## Do")

The issue text was written against the pre-#29/#34 tree. Verified against HEAD by the #74
flight's DEFINE phase:

> **Status vs HEAD (verified when #74 was worked — re-verify before starting any future flight):**
> the body above is partially stale.
> - `buildFeedback` is now `src/rlm.ts:234`, not `:146`; the push site is `src/rlm.ts:413/420`, not `:249-253`.
> - `result.stdout` is **already capped per run at 32 KiB** by the sandbox's `DispatchAccumulators`
>   (`STDOUT_MAX_BYTES`; landed in #29, `4434ed1`) — not the "256 KiB per iteration" the body claims.
> - `result.output` is **already capped at 16 KiB** by #34's `capOutput` (`src/sandbox.ts:475`,
>   every `RunOk` site; landed in `e556a70`) — not "no cap at all".
> - The "#72 ~4 KB diagnostic appended every iteration" compounding is **fixed at HEAD** by #72
>   (`3e74313`, `runInputs.context = runInputs.context ?? ""`, `src/rlm.ts:339`).
> - The **live headline defect at HEAD** is the unbounded `messages` array, plus `buildFeedback`
>   re-interpolating `stdout`/`output` with **no feedback budget of its own** (a caller raising
>   `runOptions.maxStdoutBytes`/`maxOutputBytes` flows straight through to the model), plus #72's
>   **deferred aggregate input-preview cap** (N large inputs ≈ N×~5 KB initial prompt — see the
>   #72 comment below). All three were fixed by this flight (D1, D2–D4, D6).
>
> Line-number drift is a known failure mode — see #77. Never chase the line numbers in this body
> without re-verifying against HEAD.

### A2. DoD box → replace the "five tests" bullet

Replace `- [ ] All five tests exist and pass.` with:

> `- [ ] All seven tests exist and pass: the five below re-expressed against HEAD, plus a
> stdout-cap-independence test (feedback cap holds even when the sandbox cap is raised) and the
> D6 aggregate input-preview test (the #72 deferral). See SPEC.md of the #74 flight for the
> re-expression.`

### A3. Tests section → append notes about test leverage and template coupling

Append after the issue's five tests:

> 6. `buildFeedback`'s stdout cap is **independent of the sandbox cap** (synthetic `RunResult`
>    with huge stdout, or raised `runOptions.maxStdoutBytes`).
> 7. Aggregate input-preview cap (D6): several large inputs ⇒ initial message's input section
>    ≤ `INPUT_PREVIEW_MAX_BYTES` (32 KiB).
>
> **Leverage note (from review):** test 1 as re-expressed validates **D1's feedback caps**, not
> D2 — four iterations of capped feedback ≈ 128 KiB stays under 256 KiB even with the
> conversation bound removed. **D2 itself is pinned by test 4.** Test 7 locates the input section
> by the literal header ``# Input (available as `data_0` variable)`` and the
> `\n\nWrite Python code to answer the question.` trailer; any prompt-template rewording breaks
> it on string-matching alone.

### A4. Gotchas block → append a new "## Gotchas (recorded by the #74 flight)" section (before "## Source")

> 1. **`Buffer`/`byteLength` are forbidden tokens in `src/rlm.ts`.** Test 6
>    (`test/rlm.test.ts:1116-1117`) asserts the rlm source never references either — they are the
>    canonical signals of a hand-rolled byte truncator. The conversation byte count therefore uses
>    a `TextEncoder`-based helper (`src/rlm.ts:42-45`), byte-for-byte equivalent to
>    `Buffer.byteLength` (verified, incl. lone surrogates). Any spec or plan that says "measure
>    with `Buffer.byteLength` inside rlm.ts" will fail test 6 — see
>    `docs/truncation-policy.md` Exception 3. Tests may still use `Buffer.byteLength`; the ban is
>    on rlm source only. Note also: the grep is evadable (a TextEncoder+manual-slice truncator
>    would pass); the real guarantee is the positive assertions — rlm.ts imports `truncateText`
>    from `./truncate.js` and references it.
> 2. **The 256 KiB bound is best-effort, not absolute.** `boundConversation` only drops when
>    ≥ 5 messages exist (needs two pairs: one to drop, the newest to keep — plus the initial
>    message). Under that, over-budget is accepted. Two known over-budget edges: (a) a single
>    >256 KiB LLM reply is kept and the conversation exceeds the budget transiently
>    (Assumption 4 / docs Exception 4); (b) the **drop marker itself can overshoot** — with one
>    pair left (`messages.length < 5`), the loop exits and still inserts the marker even if
>    `totalBytes() + contentBytes(marker) > MAX_CONVERSATION_BYTES` (`src/rlm.ts:442-447`; docs
>    Exception 4 only names edge (a) and understates it). A future flight must not assert an
>    unconditional ≤ 256 KiB on every `llmClient.query` at low message counts.
> 3. **Marker unit drift:** D3's marker says "conversation bounded at **256KB**" while SPEC/policy
>    use "256 KiB"; the label is hardcoded (`src/rlm.ts:396`) and the test asserts the literal
>    `/conversation bounded at 256KB/`. Derive the label from `MAX_CONVERSATION_BYTES` (see B2).
> 4. **Test-5 pair-atomicity gap:** the role walk (`test/rlm.test.ts:1200-1207`) cannot catch a
>    trailing dangling assistant; add `(last.messages.length - 2) % 2 === 0` or
>    `last.messages.at(-1).role === "user"` (see B2). Current code cannot produce one — test
>    strength gap only.
> 5. **Marker identification is positional** ("index 1 + user role", `src/rlm.ts:418-423`); a
>    stray user message at index 1 would make `splice(1, 2)` drop marker+assistant and dangle a
>    feedback. Holds today; content/shape-based identification would be robust.
> 6. **Input-name hardening is orphaned:** #72's comment on this issue carries an unescaped
>    input-name interpolation note that was **out of scope** for this flight. When #74 closes the
>    note disappears — see B3 for where it must live.
> 7. **Process:** plain `gh issue view <n>` currently fails on the classic-Projects deprecation
>    ("GraphQL: Projects (classic) is being deprecated…"). Always read issues with
>    `gh issue view <n> --json number,title,body,state,comments`.

---

## B. New follow-up issues to file (exact bodies)

### B1. New child of #70 (bucket 9) — cap `result.error` and the question

**Title:** `9.10 — Cap result.error and the question in the RLM feedback loop`

**Body:**

```
**Bucket 9, child of #70** · Filed by the #74 flight (ship-report residuals 1–2; review
correctness minor 1). Both paths were declared out of scope for #74 (SPEC Assumptions 7, scope).

## Problem

Two message paths in `runRlm` (`src/rlm.ts`) remain uncapped after #74:

- The error path interpolates `result.error` raw — `src/rlm.ts:313`:
  `Error: ${result.error}\nstdout: ${stdout}`. A huge Python exception
  (e.g. `raise ValueError("A"*10**7)`) bypasses the 256 KiB conversation bound for one
  iteration. Pre-existing and spec-documented as a non-goal (Assumption 7) with D2 as backstop,
  but it undermines the D1 feedback-cap guarantee.
- `buildInitialPrompt` interpolates the question raw — `src/rlm.ts:276` (`# Question\n${question}`) —
  and `messages[0]` is never dropped by `boundConversation`, so a large question is in every
  query permanently.

## Do

- Route `result.error` through the shared `truncateText` (one line) with an error-appropriate
  budget; add a test.
- Truncate the question in `buildInitialPrompt` via `truncateText`; add a test.

## Definition of Done

- [ ] An oversized `result.error` cannot push any iteration's conversation over 256 KiB.
- [ ] An oversized question cannot appear uncapped in message[0].
- [ ] Both paths RED→GREEN tested; `truncateText` remains the only truncation implementation.

## Gotchas

- Test 6 forbids `Buffer`/`byteLength` tokens in `src/rlm.ts` source — use `TextEncoder`
  (docs Exception 3). Tests may use `Buffer.byteLength`.
- `src/rlm.ts` line numbers drift; re-verify against HEAD (see #77).
```

### B2. New child of #70 (bucket 9) — post-ship message-growth polish

**Title:** `9.11 — Post-ship RLM message-growth polish (marker label, test strength, performance, wording)`

**Body:**

```
**Bucket 9, child of #70** · Filed by the #74 flight from review.md "Can be deferred (recommended
follow-ups) 1–5" and ship-report residuals 3–5. Non-blocking; none affect ship of #74.

## Items

1. **Derive the marker label from the constant.** `historyDropMarker` hardcodes "256KB"
   (`src/rlm.ts:396`); if `MAX_CONVERSATION_BYTES` changes, the marker and the test assertion
   (`/conversation bounded at 256KB/`) silently drift. Derive from the constant or `formatSize`.
2. **Tighten test 5.** Add `(last.messages.length - 2) % 2 === 0` or
   `last.messages.at(-1).role === "user"` so a trailing dangling assistant cannot pass
   (`test/rlm.test.ts:1200-1207`).
3. **Track a running byte total in `boundConversation`** instead of re-encoding every message per
   while-iteration (`src/rlm.ts:426-444`, O(n²) worst case; negligible at default
   `maxIterations` ≈ 21, so not a blocker).
4. **Add boundary/high-value tests:** exactly-at-256 KiB is retained (strict `>` boundary);
   a single >256 KiB LLM reply completes **without hanging** (guards the `length >= 5`
   loop-guard); just-under-budget produces no drop and no marker; the error-path stdout cap.
5. **Reword the TextEncoder framing honestly** (`src/rlm.ts:57-62` + `docs/truncation-policy.md`
   Exception 3): `TextEncoder.encode().length` IS UTF-8 byte measurement, byte-for-byte equal to
   `Buffer.byteLength` (verified, incl. lone surrogates). The deviation is a symbol swap driven by
   test 6's token grep — not "no byte-level measurement".
6. **Fence-split on the flat D6 cut** (`src/rlm.ts:264-273`): the assembled input section is cut
   as one flat head+tail over the joined per-value previews, which can split a ``` fence or a
   header mid-preview. Per-value truncation before wrapping would close it. LLM06-adjacent,
   LOW — the sandbox remains the enforcement boundary. See also #69 (structure-aware elision).
7. (Cosmetic) Test 5 could pin the dropped-turn count; ceiling-only assertions don't pin
   head/tail ratios.

## Definition of Done

- [ ] Items 1–7 each land with a test where one is named; full suite, coverage floors and
      mutation score stay green.
```

### B3. Input-name validation → append to #78 (or file as a security-tagged bucket-9 child)

The #72 comment on #74 carries a hardening note that this flight explicitly left out of scope.
When #74 closes it has no home. **Recommended home: append to #78** (convergence runs last and
touches the runRlm merge site; alternatively file a standalone child of #70). Exact wording:

> **Adopted note (from #74's comment thread):** input names are interpolated **unescaped** into
> the prompt header (`# Input (available as \`${name}\` variable)`) and the type-check stub in
> `buildInitialPrompt` (`src/rlm.ts`). A `/^[A-Za-z_][A-Za-z0-9_]*$/` validation at the merge
> site would harden both paths. This note lived only on #74 and disappears when #74 closes.

---

## C. Edits to sibling issues

### C1. #70 (Bucket 9 epic) → append to the "## Sub-issues" list

```
 #NN  9.10 — cap result.error and the question in the RLM loop   ← from #74 residuals (B1)
 #NN  9.11 — post-ship RLM message-growth polish                  ← from #74 review follow-ups (B2)
```
(Use the real numbers once B1/B2 are filed; keep the "← from #74" provenance.)

### C2. #77 (line-number drift) → append a corroborating data point

> #74 corroboration: the #74 flight re-verified its issue body against HEAD before starting and
> found it stale — `buildFeedback` had moved from `:146` to `:234`, the push site from
> `:249-253` to `:413/:420`, and the "256 KiB per-iteration stdout cap" / "no cap on output"
> claims had been superseded by #29 (stdout 32 KiB/run) and #34 (output 16 KiB). The staleness
> block appended to #74's Problem section carries the verified values.

### C3. #69 (structure-aware elision) → append a scope note

> Scope note (from the #74 flight): when structure-aware elision lands, it must also cover the
> RLM **initial-prompt input section** — #74 D6 (`src/rlm.ts:264-273`) applies a flat head+tail
> cut to the joined per-value previews, which can split a ``` fence or a header mid-preview.
> Known fix: per-value truncation before wrapping.

---

## D. Consolidation table (item → source → home → severity)

| # | Discovery (quotable) | Source | Home | Severity |
|---|---|---|---|---|
| 1 | SPEC D2/plan T2 say "measured as `Buffer.byteLength`" but test 6 greps `Buffer`/`byteLength` out of rlm.ts; resolved via `TextEncoder` (`src/rlm.ts:42-45`) | watch 1, 8, 14; review readability minor | #74 gotchas A4.1 + B2 item 5 | gotcha — verbatim SPEC would fail test 6 |
| 2 | Issue body stale: `buildFeedback:146`→`:234`; "256 KiB per iteration stdout" superseded by #29's 32 KiB accumulator cap; "no cap on output" superseded by #34's 16 KiB `capOutput`; #72 diagnostic fixed in `3e74313`; live defect = unbounded messages + missing feedback re-caps + #72's input-preview deferral | watch 2; SPEC "Verified against HEAD" | #74 A1; #77 C2 | gotcha — verbatim issue chases nonexistent lines |
| 3 | #72 deferral: aggregate input cap (consumed as D6/T3) + unescaped input-name hardening (no home once #74 closes) | watch 3; #74 comment | #78 B3 (or new child); #70 C1 if standalone | med — orphaned security note |
| 4 | `boundConversation` drops only at ≥5 messages; bound is best-effort, not absolute | watch 4 | #74 gotchas A4.2 | gotcha for future test authors |
| 5 | `gh issue view` broken by classic-Projects deprecation; use `--json` | watch 5 | #74 gotchas A4.7 (process note) | process |
| 6 | Issue DoD says "All five tests"; SPEC re-expresses as 7 (adds stdout-independence + D6 aggregate) | watch 6 | #74 A2 | DoD drift |
| 7 | D6 cut is flat over joined previews; recovery clause input-generic; test 7 coupled to template literals | watch 7 | #74 A3 (test note) + #69 C3 | low — template coupling |
| 9 | Drop marker itself can overshoot budget when <5 messages; docs Exception 4 understates edge | watch 9; review correctness minor | #74 gotchas A4.2 | med (doc understatement) |
| 10 | Test 5 cannot catch trailing dangling assistant; one-line assertion closes gap | watch 10; review correctness minor | #74 A4.4 + B2 item 2 | low (test strength) |
| 11 | Marker identified by "index 1 + user role"; stray user at index 1 would dangle a feedback | watch 11; review nit | #74 A4.5 | nit |
| 12 | Test 1 pins D1, not D2; D2 pinned by test 4 | watch 12; review nit | #74 A3 leverage note | knowledge |
| 13 | Exactly-at-boundary and single-oversized-message edges untested | watch 13; review nit | B2 item 4 | low — deferrable tests |
| 14 | "No byte-level measurement" framing misleading; TextEncoder IS byte measurement | watch 14; review readability minor | B2 item 5 | wording |
| 15 | `historyDropMarker` hardcodes "256KB"; derive from constant | watch 15; review readability nit | B2 item 1 + #74 A4.3 | low — literal drift |
| 16 | Test 6 token grep evadable; positive import assertions are the real guarantee | watch 16; review architecture nit | #74 A4.1 | knowledge |
| 17 | `boundConversation` drop loop O(n²) re-encodes; running byte total suggested | watch 17; review performance minor | B2 item 3 | low (negligible at default n) |
| 18 | Review's deferred follow-up list (5 items) | watch 18 | B2 items 1–5 (mapped) | — |
| 19 | `result.error` uncapped (`src/rlm.ts:313`) and `question` uncapped (`src/rlm.ts:276`, message[0] never dropped) | watch 19; ship residuals 1–2 | B1 (new child of #70) | **med-high** — both bypass the 256 KiB bound |
| 20 | Fence-split on flat D6 cut; missing high-value tests; cosmetic nits | watch 20; ship residuals 3–5 | B2 items 4, 6, 7 | low–med |
| 21 | Ship delegates issue-body updates to this report | watch 21 | this document | — |

Severity legend: **med-high** = uncapped budget bypass (D1 guarantee undermined);
**med** = doc understatement / orphaned security note; **low** = test strength, literal drift,
cosmetic; **gotcha** = would cost a future flight rework or a red build if unknown.

## E. How to prevent rediscovery (one-line summary for the user)

1. Edit #74 per A1–A4 **before merging** the branch (it is still open and the branch unmerged).
2. File B1 and B2 as new children of #70 and add them to #70's sub-issue list (C1).
3. Move the input-name hardening note to #78 (B3) so it survives #74's close.
4. Add the cross-references to #77 and #69 (C2, C3).
