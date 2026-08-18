# Monitor report — flight F-145 (issue #145 "9.11 — Post-ship RLM message-growth polish")

End-of-flight issue-monitor report (advisory only — no issue was edited). Branch `issue-145-rlm-polish`,
24 commits ahead of `origin/main` at report time (base `791096a`). **Note:** origin/main advanced to
`e796174` (F-77 merged) *during* this flight; the branch was not rebased (see D26 blocker below).

**Flight results:** D10–D25 + D26/D27 implemented; tests 10–24 added (15 new `it` blocks) plus edits
to tests 5/6/8/9.2.6/17(c); sentinel-delimited markers (D17), assistant-reply cap (D18), error-line
quoting (D19), input-name validation + keyword denylist (D20), block-level input elision (D15),
running byte total (D12). VERIFY 967/967 ×2 across five rounds; review REQUEST CHANGES → I1–I4 fixed
in T15; security audit Medium fixed in T19 (D27); all named-site mutation survivors killed
(T14/T16/T19 pins).

---

## 1. Issue #145 (9.11 polish) — the primary target

### 1.1 D16 assertion-scope defect (spec-authoring gotcha)

**Wording to append (gotcha block next to the D16 item):**
> **Gotcha — dropped-count assertions must scope to completed turns.** The original D16 wording
> ("assert the marker count equals the number of `TURN_i_` labels 0–9 absent from the final query")
> was **unsatisfiable at HEAD** and was build-corrected mid-flight (commit `4b3e677`): absent labels
> were {0,1,9} = 3 while the marker counted 2 — the newest turn's label is absent *by construction*
> because the final query is composed *for* the pending turn. Correct scope: **completed turns only**
> (labels 0 … last-completed-turn), which gives {0,1} = 2 == 2. Any future assertion comparing a
> marker count against absent labels must exclude the pending newest turn.

### 1.2 "Five truncateText call sites" is stale — six at flight start, seven after D18

**Correction (replace "all five `truncateText` call sites"):**
> **Correction:** "five call sites" was an F-144-era undercount — the two stdout sites (error branch
> and ok branch) were counted as one. At flight start there were **six** (input preview, question,
> error-branch stdout, error, ok-branch output, ok-branch stdout), and D18 added the **seventh**: the
> assistant-reply copy at step 7 of `runRlm`. All seven now route through one `truncateWithSentinels`
> helper; the D15 block-level aggregate marker is wrapped manually (it is not a `truncateText` call).

### 1.3 #145's DoD box drift — closing record

**Wording (replace the unchecked DoD box):**
> - [x] Items 1–7 and absorbed 1–7 landed as SPEC D10–D23 (tests 10–24, 15 new `it` blocks, plus edits
>   to tests 5/6/8/9.2.6; T13–T16/T19 closed VERIFY/review/audit gaps).
> - [x] Per the DoD's "where one is named" clause, two items landed with **suite guards, not new named
>   tests**: item 3 (D12 running byte total — guarded by tests 1/4/5/24) and item 5 (D14 TextEncoder
>   reword — guarded by test 6's source greps + full suite). Absorbed 6 (D22) and 7 (D23) likewise.
> - [x] Suite 967/967 ×2 deterministic; tsc/lint/build clean; src/rlm.ts 98.65% vs 95.94% floor.
> - [x] Mutation: **bounded sweep only** (D25, flagged deviation — full matrix ≈ 32.9 CPU-hours,
>   infeasible on the 8-core host). Population non-comparable with #144's; see §1.5.
> - [ ] **Item 8 (`Session.prefixLineCount()` O(n²)) — NOT implemented (blocked, see §1.7).** Stays
>   open as the sole outstanding item.
> - [ ] **Absorbed 6 second half (`correctDiagnosticText` rename) — NOT
>   implemented (blocked, see §1.7).** Re-home to #78 or a post-merge follow-up.

### 1.4 D20 keyword denylist — do not regress

**Wording (append to absorbed item 4):**
> **Landed beyond the one-line regex (review I4):** the merge-site validation is the regex **plus** a
> 35-entry hard-keyword denylist (`INPUT_NAME_KEYWORDS`, Python's `keyword.kwlist`). Soft keywords
> (`match`, `case`, `type`) are **deliberately excluded** — valid identifiers. Distinct error message
> for the keyword path; test 15's boundary matrix includes a `class` row. "Simplifying" to regex-only
> or adding soft keywords regresses the decision.

### 1.5 Mutation story — how to record "did not regress" honestly

**Wording (replace the "Mutation re-run" paragraph):**
> **Mutation re-run (F-145 result):** full matrix infeasible (~32.9 CPU-hours on the 8-core host) —
> flagged deviation, D25. This flight ran a **bounded sweep over the changed call sites only**
> (rlm.ts-only population), **61.9% detected**; #144's 89.6% covered a **different population**
> (48/451 mutants) — **the two numbers are not comparable; never present 61.9% vs 89.6% as a
> regression.** The honest no-regression evidence is per-mutant: survivors C1/C2 (`-=`→`+=` in both
> drop loops) killed by test 24 (T14); prose mutants M4/M5 + three D27 sentences pinned by test 17(c)
> (T16/T19). Future flights must record population (mutants tested / total per file), mode (bounded vs
> full), duration, and per-survivor disposition — not a bare percentage.

### 1.6 Residuals and absorbed-item statuses (record on #145)

> 1. **D24 question-as-input follow-up — deferred, needs a home** (today only in SPEC open question 1).
>    Re-home to #78 or a dedicated issue before #145 closes.
> 2. **ok-branch stdout forgery — recorded, not fixed (D19 residual).** `Output: …\nstdout:\n…` shares
>    the forged-`\nstdout:` vector; test 3's locator couples to the ok-branch shape; the `> `-quote
>    remedy applies. Route: #77/#78.
> 3. **S3:** `payload <= 0` → `return ""` in `elideInputBlocks` silently drops the input section —
>    unreachable at current budgets; insurance only. Recorded, deferred.
> 4. **S5:** caller-supplied `options.systemPrompt` replaces the default wholesale and drops the
>    sentinel rule while wrapping still happens. Documented in `src/types.ts` + docs Exception 5.
> 5. **S7:** test `unquoted()` helper strips `> ` from legitimate content lines too — measurement-only
>    drift, negligible, noted.
> 6. **S8:** `src/rlm.ts` 616→~830 lines, justified; extracting prompt-section elision is a **#78
>    candidate** (test 6's greps/import assertions are tuned to the current layout).
> 7. **Item 4's "error-path stdout cap" needed a test only** — the cap has been live since #74; test
>    13 pins it.
> 8. **Marker label is now "256.0KB"** (`formatSize`); test 6 gains a `/256KB/` grep so the label can
>    never be re-hardcoded.
> 9. **D17 is a soft control, not authentication** (security audit): ZWSP/homoglyph confusables and
>    marker-shaped text inside authentic pairs remain steering-only residuals; the sandbox is the real
>    boundary. Docs Exception 5 carries the honest record (corrected in T19).
> 10. **Error-branch sentinels render line-quoted** (`> [TRUNCATED VIEW BEGIN]`) — quoting is applied
>     after wrapping; the rule notes the shape (T19 chose the note over the reorder because
>     quote-then-wrap would shift the effective-budget pins in tests 20/21/22).

### 1.7 D26 blocker — item 8 and absorbed-6b are F-77-era code, absent from this branch (verified)

**Wording (append as a "Post-merge follow-ups" block):**
> **Blocked at SHIP (verified):** F-77 (issue #77's flight) merged to main as `e796174` **after** this
> branch was cut (merge-base `791096a`). Item 8's target `Session.prefixLineCount()` and the
> absorbed-6b rename target `correctDiagnosticText` exist only in F-77's code on main
> (`src/session.ts:610`, `src/sandbox.ts` post-F-77) — **neither exists on the branch**. Porting F-77
> into this branch at SHIP stage was rejected (four-file merge churn into a finished flight).
> **Item 8 and absorbed-6b remain OPEN after this branch merges** — fix them on main where the
> targets exist (both are perf/rename, zero interaction with D10–D25). A RED is achievable for item 8
> post-merge via split-call-count observation.

---

## 2. Issue #77 (line-number drift ledger)

**Append to the corroboration chain (after the "#144 corroboration" block):**
> **#145 corroboration (F-145 start, HEAD `791096a`):** half the issue body's citations were
> F-74/F-144-branch-era and drifted by flight start (item 1 `:396`→430-431 +34; item 3 `:426-444`→
> 448-486 +22/+42; item 5 `:57-62`→76-85 +19/+24; item 6 `:264-273`→279-297 +15/+24; item 2
> `test:1200-1207`→1231-1256 +31/+48; absorbed 3 `:352`→348 −4). All were re-verified at edit time and
> landed correctly — third data point proving every bucket-9 issue must carry "re-verify line numbers
> against HEAD before starting".

---

## 3. Issue #78 (convergence — the biggest downstream consumer)

**3.1 Template-coupling inventory (replace the existing F-144 note):**
> **Template-coupling inventory after #145 (the complete churn surface):** static literals pinned by
> tests: `256\.0KB` (tests 5/23/24); `\nstdout:` + `> ` prefix (8/13/18); `# Question\n` and
> `\n\n# Context` (9/19/21 — the `# Context` boundary exists only because `runRlm` always injects
> `context: ""`); the `\n\nWrite Python code to answer the question.` trailer (14/19); the
> `# Input (available as \`…\` variable)` header and `/inputs elided/` marker (14/19); sentinel
> literals `[TRUNCATED VIEW BEGIN]/END` + neutralised `[TRUNCATED\u200BVIEW` (17); the
> effective-payload boundary `maxBytes − SENTINEL_OVERHEAD_BYTES` (20/21/22); system-prompt prose pins
> (17(c): M4/M5 + three D27 sentences). Tests 10/12/23/24 self-derive sizes from observed messages
> (robust). **Any convergence rewording must update each pinned test in the same commit.**

**3.2 The merged prompt must carry the sentinel rule:**
> **Carry forward from #145:** `DEFAULT_RLM_SYSTEM_PROMPT` now contains the sentinel-authentication
> rule (truncated-view description, scoped marker grant, history-drop carve-out, error-branch quoting
> note). A rebuilt prompt that **omits the rule silently disables D17's marker-authentication while
> `truncateWithSentinels` wrapping still happens** — the same failure mode as S5. The merged
> `buildSystemPrompt` must carry the rule verbatim; test 17(c) pins its prose.

**3.3 Deferred renames/extractions:**
> (a) `correctDiagnosticText` (F-77-era, blocked on #145's branch — do it
> here); (b) extracting prompt-section elision out of `src/rlm.ts` (~830 lines) is a #78 candidate
> (S8 — test 6's greps are tuned to the current layout).

---

## 4. Issue #87 (global spend budget)

**Append:**
> **Inputs from #145 for the worked example:** the per-conversation 256 KiB bound is **best-effort,
> not a hard ceiling** — drops only at ≥ 5 messages, a single over-budget assistant reply is kept
> transiently (docs Exception 4), the drop marker's own bytes can overshoot, and the D18 cap bounds
> the *conversation copy* only (`iterations[].llmResponse` stays raw). Effective payload budget of
> every truncated section is `maxBytes − SENTINEL_OVERHEAD_BYTES` (D17). The drop-marker label derives
> from `MAX_CONVERSATION_BYTES` via `formatSize`, so a budget change propagates automatically. Any
> "depth × branching × iterations × per-message bytes" arithmetic must use these numbers.

---

## 5. Issue #70 (Bucket 9 epic)

**Append after the #144 line:**
> `#145  9.11 — post-ship RLM message-growth polish                  ← from #74 review follow-ups`
> `      └──► landed (F-145, 24 commits: D10–D27, tests 10–24, 967/967 ×2; review I1–I4 fixed in T15;`
> `             audit Medium fixed in T19). Outstanding after it: item 8 (Session.prefixLineCount,`
> `             blocked — F-77-era code, fix post-merge) + absorbed-6b rename (→ #78); ok-branch`
> `             stdout-forgery residual; question-as-input follow-up needs a home.`
> Also: #76's final synthesis reply will automatically flow through the D18 cap; tests 23/24 advance
> the epic's "rlm.ts mutation score no longer zero" criterion.

---

## 6. Issue #69 (structure-aware elision)

**Append/replace the scope note:**
> **Scope note update (from the #145 flight):** the flat head+tail cut this note describes no longer
> exists. #145 D15 replaced it with **per-value 5 KiB `truncateText` previews plus block-level
> aggregate elision** (`elideInputBlocks` in `src/rlm.ts`) with an `/inputs elided/` marker —
> fence-split closed and pinned by test 14. What remains for #69 is **true structure-aware elision of
> values** (and the `output` section). The block-level work is deliberately not a second
> byte-truncator (invariant 4 intact).

---

## 7. New-issue candidates

- **7.1 Question-as-input follow-up (D24)** — dedicated issue or #78: "Pass the full question as a
  sandbox input so `QUESTION_RECOVERY` can be strengthened (currently deliberately weak — policy Q3)."
- **7.2 ok-branch stdout forgery (D19 residual)** — dedicated security-tagged issue or #78: "The
  ok-branch `Output: …\nstdout:\n…` shape can be forged by an `output` containing `\nstdout:`; the
  same `> `-quote remedy as D19 applies; test 3's locator couples to the shape."
- **7.3 Session.prefixLineCount O(n²) (item 8, blocked)** — stays on #145 or a dedicated perf issue;
  fix post-merge on main where the method exists.

---

## 8. Process gotchas (flight hygiene)

1. **`tasks/monitor-watch.md` remains untracked across three flights (F-74/F-144/F-145)** — the
   discovery ledger itself is uncommitted. Recommend committing it or an explicit .gitignore decision.
2. **F-144's watch section never got a final SHIP poll**; its final report landed in the committed
   `tasks/monitor-report.md`. Future monitors: "no final poll" ≠ "incomplete".
3. **FLIGHT_DONE sentinel hygiene:** delete on close or `rm -f` before recreation (F-144 Item 1
   lesson; F-145 started clean).
4. **Issue-body fetching must not be truncated** — DEFINE's truncated fetch of #145's body missed
   item 8 and absorbed-6b (caught at SHIP by the monitor). Future flights: fetch issue bodies to a
   file, verify completeness against the issue's item numbering before SPECing.
5. Two coders ran read-only git against the contract (T8, T17 — both disclosed). Disclosure honored;
   the boundary stands.

---

**Monitor bottom line:** Flight F-145 landed D10–D27 with the strongest test battery in the suite's
history (tests 10–24, 967/967 ×2, review I1–I4 and audit-Medium fixed), but #145's issue body is now
stale in five ways that cost future flights rework if not fixed at close: the "five call sites" count
(§1.2), the literal DoD box vs what landed (§1.3), the mutation-paragraph comparability (§1.5), the
D16 assertion-scope gotcha (§1.1), and the two blocked items (§1.7). The highest-leverage edit is on
#78: its convergence flight must carry the sentinel rule verbatim and know the full
template-coupling inventory or it will silently disable D17 and break a dozen tests on string
matching alone. Apply §1–§7 before closing #145; nothing blocks SHIP itself.
