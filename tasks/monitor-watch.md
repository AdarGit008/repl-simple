# Monitor watch — flight F-74 (issue #74 "9.4 — Message growth is unbounded: 1.57 MB across 4 iterations")

Append-only log maintained by the flight's issue-monitor. Every discovered item,
Definition-of-Done criterion, and gotcha is recorded here so future flights read
it before starting. Do not edit earlier entries; append new polls at the bottom.

Repo: /home/adaramir/claude/repl-simple · Branch: issue-74-message-growth · Parent issue: #70 (Bucket 9) · Blocked-by (historical): #18/#30 (both closed).

---

## Poll 1 — 2026-08-17 (monitor resumed mid-flight; no prior monitor-watch.md existed)

**Flight state at resume:** commits 904275f (SPEC), f711649 (plan/todo), d302baf (T1 done),
3fa6aee (T2 done). T3 (initial-prompt 32 KiB input cap), T4 (docs) pending. No
tasks/review.md, no tasks/ship-report.md, no tasks/FLIGHT_DONE yet.
Baseline check: `npx tsx --test test/rlm.test.ts` → 93 pass / 0 fail (green).

### Item 1 — SPEC/plan's "measured as `Buffer.byteLength`" conflicts with test 6's source-level ban on `Buffer`/`byteLength` in rlm.ts (gotcha, resolved via TextEncoder)

- **Source:** BUILD T2 (commit 3fa6aee); SPEC.md D2 and tasks/plan.md T2 wording vs test/rlm.test.ts:1113–1117.
- **Quotable — SPEC D2:** "The `messages` array is bounded by **`MAX_CONVERSATION_BYTES = 256 * 1024`** (256 KiB) measured as `Buffer.byteLength` over all `messages[].content`."
- **Quotable — test 6 (test/rlm.test.ts:1116–1117):** `assert.doesNotMatch(rlmSource, /\bBuffer\b/, "rlm.ts must not hand-roll byte truncation"); assert.doesNotMatch(rlmSource, /\bbyteLength\b/, "rlm.ts must not measure bytes itself");`
- **Resolution:** src/rlm.ts measures bytes with a `TextEncoder`-based `contentBytes()` helper (src/rlm.ts:42–45), JSDoc: "TextEncoder yields the same count without reintroducing byte-level measurement here (the shared truncator owns that, #74 invariant 4)". Tests may still use `Buffer.byteLength` (the ban is only on the rlm.ts source).
- **Why it matters:** implementing SPEC verbatim would have failed test 6. Cost: mid-task rework at T2. Any future flight adding byte measurement to src/rlm.ts must know `Buffer`/`byteLength` are forbidden tokens there.

### Item 2 — Issue #74's line numbers and per-run cap claims are stale against HEAD (gotcha)

- **Source:** DEFINE (SPEC.md commit 904275f) re-verified the issue body against HEAD.
- **Quotable — issue #74:** "`buildFeedback:146` interpolates `result.stdout` … which is 256 KiB **per iteration**"; "`result.output` (`:145`) has **no cap at all**"; "`rlm.ts:249-253` pushes two messages per iteration".
- **Verified at HEAD:** buildFeedback is src/rlm.ts:234+; per-run stdout is capped at 32 KiB by the sandbox's DispatchAccumulators (`STDOUT_MAX_BYTES`); per-run output is capped at 16 KiB by #34's `capOutput` (src/sandbox.ts:475, applied at every RunOk site). The only live headline defect at HEAD is the unbounded `messages` array, plus `buildFeedback` re-interpolating with no budget of its own (so a caller-raised `runOptions.maxStdoutBytes`/`maxOutputBytes` would flow through).
- **Why it matters:** a flight following the issue verbatim chases nonexistent lines and a wrong budget. Related open issue #77 ("Line numbers are shifted by +103…") exists precisely because line numbers drift. Fix: the issue body should carry a note "re-verify line numbers and caps against HEAD before starting".

### Item 3 — #72 deferral lives only in a comment on #74: aggregate input cap (consumed as D6/T3 of this flight) + unescaped input-name interpolation hardening (NOT in this flight's scope)

- **Source:** issue #74 comment (left by the #72 flight); SPEC.md D6.
- **Quotable:** "every input key/value is now rendered into the LLM prompt with a **per-value** 5000-char head/tail cap and **no aggregate cap** (N large inputs ≈ N×~5 KB initial prompt). … input names are interpolated unescaped into the prompt header and the type-check stub — a `/^[A-Za-z_][A-Za-z0-9_]*$/` validation at the merge site would harden both paths."
- **Status:** the aggregate cap is T3 of this flight (D6, `INPUT_PREVIEW_MAX_BYTES = 32 KiB`). The input-name validation is explicitly out of scope for #74 and currently exists nowhere but this comment.
- **Why it matters:** when #74 closes, the unescaped-input-name hardening note disappears unless moved to an open issue; otherwise a future flight rediscovers it. (Candidate home: #76 "Salvaged answers have no provenance and a magic string" is a different concern; a bucket-9 or security-tagged issue should carry it — see final report.)

### Item 4 — `boundConversation` only drops when ≥ 5 messages exist; under that, over-budget is accepted (recorded edge, verify against DoD wording)

- **Source:** BUILD T2 (commit 3fa6aee), src/rlm.ts `boundConversation` — both while-loops gate on `messages.length >= 5`.
- **Quotable:** "Dropping needs at least two pairs — one to drop and the newest to keep — i.e. five messages." The initial message and the newest pair are never dropped.
- **Why it matters:** with < 5 messages the conversation can exceed 256 KiB indefinitely (SPEC Assumption 4 records the single-giant-LLM-reply case; the general <5-message over-budget state is the same mechanism). The DoD bullet "The 1.57 MB reproduction stays bounded" holds for the repro, but the bound is best-effort, not absolute — a future flight asserting an unconditional ≤ 256 KiB on every `llmClient.query` call at low message counts would fail. Mitigated after T3 by D6's 32 KiB input cap (initial prompt alone can't blow the budget). Minor consistency note: the D3 marker says "256KB" while SPEC uses "256 KiB" elsewhere.

### Item 5 — gh CLI classic-projects deprecation breaks plain `gh issue view <n>` (process gotcha)

- **Source:** monitor poll 1, this flight.
- **Quotable — failure:** "GraphQL: Projects (classic) is being deprecated in favor of the new Projects experience … (repository.issue.projectCards)".
- **Why it matters:** plain `gh issue view 74` exits with that error; `gh issue view 74 --json number,title,body,state,comments --jq …` works. Future flights/monitors should always script issue reads with `--json`.

### Item 6 — Issue #74's literal "five tests" DoD no longer matches the re-expressed test set (DoD drift to fix when closing)

- **Source:** issue #74 body ("## Tests" lists 5; "## Definition of Done" box: "All five tests exist and pass") vs SPEC.md testing strategy, which re-expresses them as **7** tests against HEAD (adds a stdout-specific independence test (#3) and the D6 aggregate input test (#7)).
- **Why it matters:** after this flight, the issue's DoD box should read "All seven tests exist and pass" (or the box updated to reference the SPEC), or a future flight re-deriving from the issue alone could implement only the literal 5 and miss stdout-cap-independence and the aggregate input cap.

---

## Poll 2 — 2026-08-17 (~12:12, after T3 landed)

**State:** T3 done (commit df5feb4 "9.4 — cap the RLM initial input preview to 32 KiB (#74)").
Working tree clean except this watch file. todo.md now shows T1–T3 done, T4 pending.

### Item 7 — D6 implementation detail: input-section cut is one flat head+tail over the *joined* previews; recovery clause is input-generic (verified against plan, no divergence)

- **Source:** BUILD T3 (commit df5feb4), src/rlm.ts `buildInitialPrompt`.
- **Quotable:** `const { text: inputSection } = truncateText(inputParts.join("\n"), { maxBytes: INPUT_PREVIEW_MAX_BYTES, headRatio: VALUE_HEAD_RATIO, recovery: INPUT_PREVIEW_RECOVERY });` with `INPUT_PREVIEW_RECOVERY = "Each input is available as a named Python variable — slice it in Python to see more."`
- **Observation (no action):** the flat cut can split a preview mid-fence or mid-header; that matches SPEC D6's explicit "flat head+tail … structure-aware input elision is not attempted (same flat-cut rule the policy already applies to `output` until #69)" — recorded, not a divergence.
- **Test coupling noted:** T3's test 7 locates the input section via the literal `# Input (available as \`data_0\` variable)` header and the `\n\nWrite Python code to answer the question.` trailer (the double-\n comes from `parts.join("\n")` + the trailing part's own leading `\n`). If the prompt template wording changes, test 7 breaks on string-matching alone.

---

## Poll 3 — 2026-08-17 (~12:16, after T4 landed)

**State:** T4 done (commit bb03e5b). All four BUILD tasks complete; working tree clean except this
watch file. No tasks/review.md or tasks/ship-report.md yet.

### Item 8 — T4 docs added "Exception 3" codifying Item 1's TextEncoder resolution (confirms the gotcha is in-repo now)

- **Source:** BUILD T4 (commit bb03e5b), docs/truncation-policy.md.
- **Quotable:** "**Exception 3 — the conversation byte count uses `TextEncoder`, not `Buffer.byteLength`.** D2 writes the budget as `Buffer.byteLength`, but test 6 asserts `rlm.ts` never references `Buffer` or `byteLength` — the canonical signals of a hand-rolled byte truncator. `TextEncoder.encode().length` yields the same UTF-8 byte count, so the budget is measured identically while `rlm.ts` still owns no byte-level measurement (invariant 4). [#74]"
- **Also quotable (Exception 4):** "a single over-budget LLM reply is kept. The loop cannot truncate model output without summarising (deferred, D4), so one reply larger than 256 KiB is kept and the conversation is allowed to exceed the budget transiently until it ages out (#74, Assumption 4)."
- **Why it matters:** the SPEC/plan wording (`Buffer.byteLength`) was never amended, only the policy doc got the exception — future flights re-reading SPEC D2 verbatim would repeat the near-miss. The issue-body recommendation should point at the exception, not the stale SPEC wording.

---

## Poll 4 — 2026-08-17 (~12:20) — no change

State unchanged: HEAD bb03e5b, tree clean (except watch file), no review.md/ship-report.md/FLIGHT_DONE.
Presumed in VERIFY (full suite + coverage + mutation gates run minutes each). Nothing new discovered.

---

## Poll 5 — 2026-08-17 (~12:23) — no change

HEAD bb03e5b; no review.md/ship-report.md/FLIGHT_DONE. Presumed VERIFY still running. Nothing new.

---

## Poll 6 — 2026-08-17 (~12:28, review landed)

**State:** REVIEW done (commit 08e15aa, tasks/review.md). **Verdict: approve — no blockers or
majors.** "The full verification matrix is green." All findings minor/nit. SHIP pending; no
ship-report.md / FLIGHT_DONE yet.

### Item 9 — Review finding: the drop marker itself can overshoot the budget when < 5 messages remain (docs Exception 4 understates the edge)

- **Source:** REVIEW, tasks/review.md "Correctness", second minor (src/rlm.ts:442-447).
- **Quotable:** "When only one pair remains (`messages.length < 5`, so no further drop is possible) but `totalBytes() + contentBytes(marker) > MAX_CONVERSATION_BYTES`, the loop exits and still inserts the marker, so the '≤ 256 KiB' invariant is exceeded by the marker's own bytes. This is the Assumption 4 / docs Exception 4 edge; Exception 4 only names the over-budget LLM reply, not the marker, so the doc slightly understates it."
- **Why it matters:** the bound is best-effort in two ways (giant reply + marker overshoot), not one; future flights asserting a hard ≤ 256 KiB invariant must know both, or they'll rediscover via failing tests.

### Item 10 — Review finding: test 5's pair-atomicity check cannot catch a trailing dangling assistant

- **Source:** REVIEW, tasks/review.md "Correctness", third minor (test/rlm.test.ts:1200-1207).
- **Quotable:** "a dangling assistant at the end still matches that expectation … Asserting `(last.messages.length - 2) % 2 === 0` or `last.messages.at(-1).role === "user"` would close the gap. The current code cannot produce a dangling assistant, so this is a test-strength gap, not a product bug."
- **Why it matters:** the issue's core DoD ('tell the model history was dropped', 'no dangling feedback') is only half-pinned; the recommended one-line assertion should be appended to issue #74's test notes or a follow-up so it is not re-derived.

### Item 11 — Review finding: marker identification relies on "index 1 + user role"; content/shape-based identification would be robust

- **Source:** REVIEW, tasks/review.md "Correctness", first nit (src/rlm.ts:418-423).
- **Quotable:** "If a second stray user message ever occupied index 1, `splice(1, 2)` would drop marker+assistant and leave a feedback dangling. The invariant holds today and is documented in the comment; identifying the marker by content or a dedicated shape would be more robust."

### Item 12 — Review finding: test 1 does not independently pin D2 (its leverage is D1's caps)

- **Source:** REVIEW, tasks/review.md "Correctness", second nit (test/rlm.test.ts:1133-1149).
- **Quotable:** "Four iterations of capped feedback ≈ 128 KiB, under the 256 KiB budget even with the conversation bound removed, so this test really validates D1's feedback caps … D2 itself is pinned by test 4."
- **Why it matters:** a future flight weakening the conversation bound but keeping the feedback caps would still pass test 1 — knowing which test pins which decision prevents misplaced confidence.

### Item 13 — Review finding: exactly-at-boundary and single-oversized-message edges are untested

- **Source:** REVIEW, tasks/review.md "Correctness", third nit.
- **Quotable:** "The strict `>` boundary and the 'keep the over-budget reply transiently' path are implemented and documented (Assumption 4) but not exercised. Deferrable tests."

### Item 14 — Review finding: "no byte-level measurement" framing is misleading; TextEncoder IS byte measurement (verified byte-for-byte, incl. lone surrogates)

- **Source:** REVIEW, tasks/review.md "Readability", first minor (src/rlm.ts:57-62 + docs Exception 3).
- **Quotable:** "`TextEncoder.encode().length` *is* UTF-8 byte measurement; it is byte-for-byte equivalent to `Buffer.byteLength` (verified, including lone surrogates). Docs Exception 3 is a rationalization for a spec deviation (D2 wrote `Buffer.byteLength`) driven by test 6's token grep. The count is correct; only the justification should be reworded."
- **Recommended follow-up #1 in review.md:** "Reword src/rlm.ts:57-62 and docs Exception 3 so the TextEncoder/Buffer.byteLength deviation is stated honestly (it is still byte measurement, just a different symbol)."

### Item 15 — Review finding: `historyDropMarker` hardcodes "256KB"; derive from the constant

- **Source:** REVIEW, tasks/review.md "Readability", second nit (src/rlm.ts:396).
- **Quotable:** "If `MAX_CONVERSATION_BYTES` changes, the marker text and the test assertion (`/conversation bounded at 256KB/`) silently drift. Derive the label from the constant or from `formatSize`."

### Item 16 — Review finding: test 6's token grep is evadable — the positive import assertions are the real guarantee

- **Source:** REVIEW, tasks/review.md "Architecture", nit (test/rlm.test.ts:1116-1117).
- **Quotable:** "Grepping out `Buffer`/`byteLength` would be evaded by a hand-rolled truncator built on `TextEncoder` + manual slicing (exactly what the code had to do to pass the grep). The positive assertions — rlm.ts imports truncateText from ./truncate.js and references it — are the real guarantee and are meaningful."

### Item 17 — Review finding: `boundConversation` drop loop is O(n²) worst case (re-encodes all messages per iteration)

- **Source:** REVIEW, tasks/review.md "Performance", minor (src/rlm.ts:426-444).
- **Quotable:** "`totalBytes()` re-encodes every message … on every `while` iteration, and each iteration drops one pair, so a single oversized message arriving after many tiny messages costs O(n²) encodes. For the default `maxIterations` this is negligible (n ≤ ~21) … a running byte total (add on push, subtract the dropped pair's bytes) would remove the re-encode and the allocation churn."

### Item 18 — Review's deferred follow-up list (verbatim, for the final report's wording)

1. Reword TextEncoder framing (Item 14).
2. Tighten test 5 with even-parity / last-role assertion (Item 10).
3. Track a running byte total in `boundConversation` (Item 17).
4. Add boundary tests for exactly-at-256 KiB and a single over-budget message (Item 13).
5. Derive the marker's "256KB" label from the constant (Item 15).

---

## Poll 7 — 2026-08-17 (~12:31) — no change

HEAD 08e15aa; review.md present and captured in Poll 6. No ship-report.md / FLIGHT_DONE yet. Presumed SHIP in progress.

---

## Poll 8 — 2026-08-17 (~12:34) — no change

HEAD 08e15aa; no ship-report.md / FLIGHT_DONE yet.

---

## Poll 9 — 2026-08-17 (~12:38, SHIP landed, FLIGHT_DONE sentinel present)

**State:** SHIP done (commit 29da9e5 "ship report: GO (#74)"; tasks/ship-report.md; sentinel
tasks/FLIGHT_DONE created untracked). Branch is 7 commits ahead of origin/main, unmerged/unpushed.
Full suite 946/946 deterministic ×2; coverage src/rlm.ts 97.24% vs 95.94% floor; 7 new tests.

### Item 19 — SHIP residuals (fan-out, not blocking): uncapped `result.error` and uncapped `question`

- **Source:** SHIP, tasks/ship-report.md "Residual risks & post-ship follow-ups" items 1–2.
- **Quotable (1):** "`result.error` uncapped (src/rlm.ts:313) — a huge Python exception message (e.g. `raise ValueError("A"*10**7)`) bypasses the 256 KiB bound for one iteration; pre-existing, spec-documented non-goal (Assumption 7), but it undermines the D1 guarantee. Fix: route through `truncateText` (one line) + test. **Recommended next issue.**"
- **Quotable (2):** "`question` uncapped (src/rlm.ts:276) — message[0] is never dropped, so a large question is in every query permanently. Fix: truncate in `buildInitialPrompt`. **Recommended next issue.**"
- **Why it matters:** both are uncapped paths the issue's own "three uncapped paths" framing missed; the monitor must see them filed on open issues before #74 closes.

### Item 20 — SHIP residuals: fence-split on the flat D6 cut; missing high-value tests; cosmetic nits

- **Source:** SHIP, tasks/ship-report.md items 3–5.
- **Quotable:** "Fence-split on flat D6 cut (src/rlm.ts:264-273) — per-value truncation before wrapping would close it" (LLM06-adjacent, LOW — sandbox remains enforcement boundary); "Missing high-value tests: just-under-budget no-drop/no-marker case; single >256 KiB LLM reply completes without hang (guards the `length >= 5` loop-guard); error-path stdout cap"; "marker hardcodes '256KB' (src/rlm.ts:396); test 5 could pin the dropped-turn count; ceiling-only assertions don't pin head/tail ratios."
- **Also quotable (fan-out statuses):** code-reviewer SHIP; security-auditor SHIP with 2 medium pre-existing budget bypasses; test-engineer SHIP (conditional) — 6/7 new tests are genuine prove-it tests.

### Item 21 — SHIP explicitly delegates issue-body updates to this monitor report

- **Source:** SHIP, tasks/ship-report.md "Open-issues recommendations".
- **Quotable:** "See `tasks/monitor-report.md` (flight monitor). Consensus: #74's issue text is partially stale at HEAD (output/stdout already capped by #34; #72 diagnostic fixed); the monitor report carries the exact wording to update #74 and siblings so a future flight doesn't re-derive these facts."
- **Why it matters:** the driver/user expects the exact update wording here — it must cover Items 1–6 and 9–20, not just the staleness note.

---

# Monitor watch — flight F-144 (issue #144 "9.10 — Cap result.error and the question in the RLM feedback loop")

Append-only log maintained by the flight's issue-monitor. Every discovered item,
Definition-of-Done criterion, and gotcha is recorded here so future flights read
it before starting. Do not edit earlier entries; append new polls at the bottom.
This section continues the F-74 section above (same file, append-only).

Repo: /home/adaramir/claude/repl-simple · Branch: issue-144-cap-error-question · Parent issue: #70 (Bucket 9) · Sibling: #145 (9.11 polish).

## Poll 1 — 2026-08-17 (flight start / orientation)

**Flight state at start:** branch `issue-144-cap-error-question` checked out at HEAD `34da5c5`
("9.4 — Bound RLM message growth… (#74) (#146)") — the merged #74. Zero F-144 commits; zero
F-144 artifacts. All of `tasks/` (plan.md, todo.md, review.md, ship-report.md) is committed
F-74 content, not yet replaced.

**Baseline:** `npx tsx --test test/rlm.test.ts` → **94 pass / 0 fail** (12 suites, ~3.2s, green).

**Issue #144 verified against HEAD:** the body's line numbers are accurate at flight start —
error path `src/rlm.ts:313` (`Error: ${result.error}\nstdout: ${stdout}`) and question
interpolation `src/rlm.ts:276` (`# Question\n${question}`). src/rlm.ts is 581 lines;
test/rlm.test.ts is 1404 lines. No drift for this flight yet (drift watch: #77).

### Item 1 — Stale FLIGHT_DONE sentinel at flight start (process gotcha for the monitor itself)

- **Source:** monitor Poll 1, this flight.
- **Quotable:** `tasks/FLIGHT_DONE` exists at flight start with mtime 2026-08-17 12:32:32 —
  created by F-74 (its final poll ~12:38) and left behind untracked. It is **not** a valid
  end-of-flight signal for F-144.
- **Why it matters:** a naive end-of-flight check ("FLIGHT_DONE present ⇒ flight complete")
  would fire immediately. The reliable signals for F-144 completion are instead: new commits
  on `issue-144-cap-error-question`, `tasks/plan.md`/`todo.md` rewritten with #144 content,
  `tasks/ship-report.md` overwritten with an F-144 report, or `tasks/FLIGHT_DONE`'s mtime
  changing. Fix for future flights: F-74's SHIP should have deleted the sentinel, or sentinel
  creation should be preceded by `rm -f`. (Flight-process hygiene, not a repo defect.)

### Item 2 — Baseline context: #144's two paths sit in code already full of truncateText call sites (context, not a discovery)

- **Source:** HEAD `34da5c5`, src/rlm.ts.
- **Quotable:** existing `truncateText` call sites at `src/rlm.ts:270` (input preview),
  `:308` (error-path **stdout**), `:367`/`:372` (output). Budget constants:
  `MAX_CONVERSATION_BYTES = 256 * 1024` (`:35`), `INPUT_PREVIEW_MAX_BYTES = 32 * 1024` (`:44`).
- **Why it matters:** the flight will add call sites for `result.error` (line 313) and
  `question` (line 276) alongside existing ones; the DoD bullet "`truncateText` remains the
  only truncation implementation" is already the established invariant (test 6's positive
  import assertions). Note #145 item 4 also names "the error-path stdout cap" — that's the
  *stdout* half of line 313 and belongs to #145, not #144; #144's scope is `result.error`
  and `question`. Watch for scope overlap when both land.

### Item 3 — Issue #144 is itself an F-74 artifact — its assumptions must be re-verified, not inherited (known-unknowns checklist for this flight)

- **Source:** issue #144 body vs F-74 monitor-report B1 (the filing source); F-74 watch Items 4, 9, 14.
- **Quotable:** #144's body was drafted from F-74's SHIP residuals and carried F-74-era
  line numbers and claims. F-74's own final report (monitor-report.md) records that the
  "256 KiB" bound is **best-effort, not absolute**: `boundConversation` only drops at
  ≥ 5 messages, a >256 KiB LLM reply is kept transiently (docs Exception 4), and the drop
  marker itself can overshoot. #144's DoD bullet 1 — "An oversized `result.error` cannot push
  any iteration's conversation over 256 KiB" — therefore interacts with those edges.
- **Why it matters:** #144's DoD should be read as "no *new* uncapped path" (error/question
  capped at their own budgets), not "conversation ≤ 256 KiB unconditionally" — that stronger
  claim is known-false at HEAD (F-74 Items 4/9) and any test asserting it against low message
  counts would fail. Also: F-74 watch Item 14 / #145 item 5 (TextEncoder framing) may touch
  `src/rlm.ts:57-62` near this flight's edit sites — merge-order noise between #144 and #145.

Nothing else discovered at flight start. Next poll: watch `git log` on the branch and
`tasks/` for the first F-144 artifact.

---

## Poll 2 — 2026-08-17 (~13:58, ~65 min after flight start) — no change

State unchanged: HEAD `34da5c5` (the #74 merge), zero commits on
`issue-144-cap-error-question`, no F-144 artifacts in tasks/ (plan.md/todo.md still F-74's),
FLIGHT_DONE mtime still the stale F-74 12:32:32. Nothing new discovered. Presumed DEFINE /
flight setup in progress (or the flight is queued).

## Poll 3 — 2026-08-17 (~14:50, ~2h after flight start; monitor session resumed) — no change

State unchanged: HEAD `34da5c5` (the #74 merge), zero commits on
`issue-144-cap-error-question`. All of tasks/plan.md, todo.md, review.md, ship-report.md
and SPEC.md are still F-74 content (mtime 12:56:22, committed with the #74 merge at
`34da5c5`) — **not** rewritten for #144. FLIGHT_DONE mtime still the stale F-74
12:32:32 (Item 1 holds).

Baseline re-run (this poll): `npx tsx --test test/rlm.test.ts` → **94 pass / 0 fail**
(12 suites, ~3.0s) — matches the Poll 1 baseline record exactly; the flight has not
touched the tree yet.

Nothing new discovered. Next poll: watch for the first F-144 commit / plan.md rewrite.

## Poll 4 — 2026-08-17 (~15:10) — no change

HEAD still `34da5c5`; all tasks/ artifacts + SPEC.md still F-74 content; FLIGHT_DONE
still the stale F-74 sentinel. Nothing new.

## Poll 5 — 2026-08-17 (~15:30) — no change

HEAD still `34da5c5`; no F-144 commits; tasks/ and SPEC.md untouched (still F-74);
FLIGHT_DONE still stale F-74. Nothing new.

## Poll 6 — 2026-08-17 (~15:50) — no change

HEAD still `34da5c5`; no F-144 commits; tasks/ and SPEC.md untouched (still F-74);
FLIGHT_DONE still stale F-74. Nothing new.

## Poll 7 — 2026-08-17 (~16:10) — no change

HEAD still `34da5c5`; no F-144 commits; tasks/ and SPEC.md untouched (still F-74);
FLIGHT_DONE still stale F-74. Nothing new.

## Poll 8 — 2026-08-17 (~16:30) — no change

HEAD still `34da5c5`; no F-144 commits; tasks/ and SPEC.md untouched (still F-74);
FLIGHT_DONE still stale F-74. Nothing new.

## Poll 9 — 2026-08-17 (~16:50) — no change

HEAD still `34da5c5`; no F-144 commits; tasks/ and SPEC.md untouched (still F-74);
FLIGHT_DONE still stale F-74. Nothing new.

## Poll 10 — 2026-08-17 (~17:11) — no change

HEAD still `34da5c5`; no F-144 commits; tasks/ and SPEC.md untouched (still F-74);
FLIGHT_DONE still stale F-74. Nothing new.

## Poll 11 — 2026-08-17 (~17:31) — no change

HEAD still `34da5c5`; no F-144 commits; tasks/ and SPEC.md untouched (still F-74);
FLIGHT_DONE still stale F-74. Nothing new.

## Poll 12 — 2026-08-17 (~17:51) — no change

HEAD still `34da5c5`; no F-144 commits; tasks/ and SPEC.md untouched (still F-74);
FLIGHT_DONE still stale F-74. Nothing new.

## Poll 13 — 2026-08-17 (~17:58, monitor session resumed — continuation of the F-144 section)

State unchanged: HEAD `34da5c5` (the #74 merge), zero commits on
`issue-144-cap-error-question`. tasks/plan.md, todo.md, review.md, ship-report.md and SPEC.md
all still F-74 content (mtime 12:56:22); FLIGHT_DONE still the stale F-74 sentinel
(mtime 12:32:32). Nothing new.

Baseline re-run (this poll): `npx tsx --test test/rlm.test.ts` → **94 pass / 0 fail**
(12 suites, ~3.1s) — matches the Poll 1/Poll 3 record exactly; the tree is untouched.

### Item 4 — Cross-issue cross-check done at setup: #144's filing provenance is intact in the epic and siblings (context, no action)

- **Source:** this session's setup reads of #70, #77, #145 bodies.
- **Quotable — #70 sub-issues list already contains:**
  `#144  9.10 — cap result.error and the question in the RLM loop   ← from #74 residuals`
  and `#145  9.11 — post-ship RLM message-growth polish ← from #74 review follow-ups` — the
  F-74 monitor report's C1 edit has been applied.
- **Quotable — #77 body ends with the "> #74 corroboration:" block** (F-74 report C2, applied):
  the line-number-drift home for #144's own gotcha "re-verify against HEAD (see #77)" exists.
- **Quotable — #145 item 4** names "the error-path **stdout** cap" among boundary tests. That
  is the *stdout* half of `src/rlm.ts:313` and belongs to #145; #144's scope is only
  `result.error` + `question`. (Same overlap note as Poll 1 Item 2 — confirmed against the
  live #145 body.)
- **Why it matters:** the filing chain F-74 → #144/#145 → epic is complete before this flight
  starts; no orphaned discovery from F-74 remains for this flight to re-home. Future flights
  can trust the epic list.

Nothing else discovered. Next poll: watch for the first F-144 commit / plan.md rewrite.

## Poll 14 — 2026-08-17 (~18:20, BUILD landed — all three tasks)

**State:** five new commits landed since Poll 13: `01e5c6a` SPEC, `9fb8916` plan,
`018e51a` T1 (cap `result.error`), `e905ce8` T2 (cap `question`), `527244e` T3 (policy doc).
todo.md shows T1–T3 all done. Working tree clean except this watch file + stale FLIGHT_DONE
sentry. Focused suite re-run by monitor: **98 pass / 0 fail, 13 suites** (was 94/12 at
baseline — +4 `it` blocks: tests 8 and 9, each with an over-budget and a no-op half).

### Item 5 — SPEC D7/D8 chose concrete budgets where the issue said only "error-appropriate" / "generous" (issue DoD drift, F-74 Item 6 pattern)

- **Source:** DEFINE/BUILD, SPEC.md D7/D8 + Assumptions 1–2; src/rlm.ts at HEAD `527244e`.
- **Quotable — SPEC D7:** `ERROR_MAX_BYTES = 16 * 1024` (16 KiB, same as `output`), 50/50
  head+tail, `ERROR_RECOVERY = "Catch the exception and print the full traceback to see more."`
- **Quotable — SPEC D8:** `QUESTION_MAX_BYTES = 64 * 1024` (64 KiB, "sized so that even a maxed
  initial prompt (≤64 KiB question + ≤32 KiB input preview + headers) cannot alone cross the
  256 KiB conversation bound"), 50/50 head+tail, weaker `QUESTION_RECOVERY` (see Item 6).
- **Quotable — SPEC Assumption 1:** "The issue says 'an error-appropriate budget' without a
  number. Chosen to equal `output`'s 16 KiB…"; **Assumption 2:** "The issue says 'generous'…
  64 KiB is far beyond any genuine query…". Both marked "fire-and-forget, no human asked".
- **Re-expression of the issue DoD:** issue bullet 1 ("An oversized `result.error` cannot push
  any iteration's conversation over 256 KiB") became SPEC success criterion 1 "the `Error: `
  feedback section is ≤ 16 KiB via `truncateText`, and the 256 KiB conversation bound is
  intact" — the unconditional "cannot push over 256 KiB" reading is known-false at HEAD
  (F-74 Items 4/9: best-effort bound; drop marker can overshoot). The flight correctly read it
  as "no new uncapped path", exactly as flagged in Poll 1 Item 3.
- **Why it matters:** a future flight re-deriving from issue #144 alone would redo both budget
  judgements (16/64 KiB) from scratch and could misread DoD bullet 1 as an unconditional
  conversation invariant. The issue body should carry the chosen budgets + the per-section
  reading (final-report recommendation).

### Item 6 — The question's recovery clause is deliberately weaker (policy Q3); SPEC open question 1 proposes a future "pass the full question as an input" issue — currently orphaned

- **Source:** SPEC.md D8 + Open question 1; docs/truncation-policy.md #144 paragraph
  (commit `527244e`).
- **Quotable — SPEC D8:** "recorded as a deliberate, weaker affordance than the value/input
  recoveries because the question is **not** sandbox-accessible: unlike `output`/inputs, the
  model cannot slice it in Python."
- **Quotable — SPEC Open question 1:** "a future issue could pass the full question as an input
  so it becomes sliceable, but that changes the input contract and is out of scope."
- **Also quotable (policy doc):** "the marker must not advertise a route it cannot honour
  (policy Q3, the same rule as the `_` binding)" — the first time Q3 is applied to a model
  message in rlm.ts rather than a sandbox variable.
- **Why it matters:** (a) Q3 ("never ship a marker naming a recovery route that does not
  exist") is now a live rule any future recovery-clause edit must respect — a flight that
  "improves" `QUESTION_RECOVERY` by naming a Python route would violate it. (b) The
  "question as input" follow-up lives only in SPEC.md until #144 closes; unless it is moved
  to an open issue (#145 or #70), it dies with the branch. This is the F-74 Item 3 orphan
  pattern repeating.

### Item 7 — New template-literal couplings in tests 8/9 (extension of the known F-74 test-7 gotcha)

- **Source:** BUILD T1/T2, test/rlm.test.ts at HEAD `527244e`.
- **Quotable — test 8:** locates the error section via `feedback.startsWith("Error: ")` and
  `rest.indexOf("\nstdout:")`; **test 9:** locates the question section via the literal
  `"# Question\n"` header and `prompt.indexOf("\n\n# Context", qStart)` — the `# Context`
  boundary exists only because the default `context` input always renders a `# Context`
  header (the #72 unconditional-context behaviour).
- **Quotable — plan.md Risk table (acknowledged):** "these are the same literals F-74's
  test 7 already couples to (recorded gotcha)."
- **Why it matters:** known gotcha (template-literal coupling), so not rediscovered — but the
  coupling surface grew by two section-boundary literals (`\nstdout:`, `\n\n# Context`). A
  future prompt-template rewording (e.g. #78's convergence flight) now breaks tests 7, 8 and 9
  together. #78 is the convergence issue — it should carry this note.

### Item 8 — Scope facts verified during BUILD (context for #145/#78, not defects)

- **Source:** SPEC.md Assumption 6 + src/rlm.ts diff.
- **Quotable:** "`result.error` exists only on error results (`src/types.ts:163-165`), and the
  ok/suspended paths do not interpolate it" — the error cap applies only to the
  `status === "error"` branch. The docs "four #29/#34 rows" sentence remains accurate after
  T3 (stdout/output/read_file/http_get are exactly the four #29/#34 rows; the two new rows are
  #144-tagged). `ERROR_RECOVERY` names a **real** route (model owns the Python; can
  `try/except` + print traceback) — contrast with `QUESTION_RECOVERY` (Item 6).
- **Why it matters:** #145 item 4's "error-path stdout cap" is the stdout half of the error
  branch — still uncapped as a *test*, untouched by this flight (the flight capped `error`
  only; `stdout` on the error path was already capped by #74's FEEDBACK_STDOUT_MAX_BYTES).
  No overlap materialised. Future flights touching the error branch should know `error` is
  error-results-only.

Nothing else discovered. Next poll: watch for review.md / VERIFY artifacts.

## Poll 15 — 2026-08-17 (~19:20, monitor resumed after earlier timeout; flight tail)

**State:** six commits on the branch: `01e5c6a` SPEC, `9fb8916` plan, `018e51a` T1, `e905ce8` T2,
`527244e` T3, `35b16cd` review ("9.10 — review findings (#144)"). REVIEW verdict **approve** — no
blockers/majors; 6 minor / 5 nit. VERIFY clean: 950/950 ×2 deterministic, tsc/lint/build clean,
src/rlm.ts 97.40% vs 95.94% floor, mutation 89.6% detected with no regression signal. SHIP in
progress (three parallel auditors); tasks/ship-report.md is still F-74 content (mtime 12:56) — not
yet overwritten for F-144. FLIGHT_DONE sentinel still the stale F-74 one (Poll 1 Item 1 holds).

### Item 9 — VERIFY divergence: origin/main advanced 5 commits (#110/#150 flights) after branching; overlap is editorial-only planning docs

- **Source:** VERIFY divergence check; review.md "Merge notes"; `git log origin/main`.
- **Quotable — upstream commits (`34da5c5..origin/main`):** `2ba6522` "Verify and close #110 —
  resume forwards onApproval (#147)", `a17a3ad` "docs: issue-monitor report for the #110 flight
  (#148)", `0755262` "docs: apply issue-monitor items E/F/G/H … (#110) (#149)", `8d1f9eb` "150 —
  Prove Repl.resume() abort propagation with a killing test (#151)", `eadd27e` "docs: apply
  issue-monitor items from the #150 flight (#152)".
- **Quotable — review.md Merge notes:** "`origin/main` advanced five commits during the flight; the
  overlap is editorial-only planning-doc content (SPEC.md, tasks/plan.md, tasks/todo.md rewritten
  for #144 by this branch and independently advanced upstream). No code conflict and no code
  divergence … Merge with `-X ours` for the planning docs if the upstream rewrites collide, or
  verify the upstream SPEC.md/plan.md do not carry stale #74-only assumptions before choosing
  either side."
- **Verified overlap (this poll):** upstream touched SPEC.md, tasks/plan.md, tasks/todo.md
  (planning docs — the only collision surface), plus `docs/*.md` (new #110/#150 flight docs,
  `docs/mutation-testing.md`) and `test/repl.test.ts` (resume tests). This branch's code union
  (`src/rlm.ts`, `test/rlm.test.ts`, `docs/truncation-policy.md`) has **zero** overlap with
  upstream's code union; merge base is `34da5c5`.
- **Why it matters:** the merge at SHIP is not a fast-forward and the planning docs will conflict.
  Choosing upstream's SPEC/plan/todo wholesale would lose this flight's D7/D8 decisions and the
  #144 plan/todo; `-X ours` would drop upstream's #110/#150 planning rewrites. The review's
  actionable check: verify upstream planning docs for stale #74-only assumptions before choosing a
  side.

### Item 10 — Supervisor decision: no rebase onto the advanced origin/main

- **Source:** flight driver handoff (supervisor channel), this poll.
- **Quotable (decision as given):** the flight will **not** rebase onto the advanced origin/main;
  SHIP proceeds from the branch as it stands (base `34da5c5`) with the planning-doc merge strategy
  from review.md's Merge notes.
- **Why it matters:** the future merged history will show a merge whose first-parent divergence
  predates upstream's #110/#150 work; that is intentional, not an oversight. Rebasing would have
  replayed 6 commits onto upstream's rewritten planning docs and churned the SPEC/plan/todo diffs
  for zero code benefit. Recorded so a later flight does not "fix" the merge base.

### Item 11 — Supervisor decision: bounded mutation (partial mutation run accepted for VERIFY)

- **Source:** flight driver handoff (supervisor channel), this poll; review.md verdict line.
- **Quotable — review.md:** "mutation 89.6% detected with no regression signal" — the VERIFY
  mutation gate ran in bounded/partial mode, not the full matrix.
- **Why it matters:** "mutation score did not regress" in the DoD must not be read by a future
  flight as full-matrix evidence for rlm.ts — for #144 it was a bounded run covering the new call
  sites' mutants. #145's polish flight should re-run the full matrix if it touches
  truncate-adjacent code (and #145's DoD already names the mutation score).

### Item 12 — Review finding: `ERROR_MAX_BYTES` breaks the `FEEDBACK_` prefix convention (routed to #145)

- **Source:** REVIEW, tasks/review.md "Readability", first minor (src/rlm.ts:28).
- **Quotable:** "`FEEDBACK_STDOUT_MAX_BYTES`/`FEEDBACK_OUTPUT_MAX_BYTES` carry the prefix because
  the sandbox caps the same fields and the re-cap here must not be confused with them. `error` is
  feedback-only (the sandbox does not cap it), so the plain name is defensible — but
  `FEEDBACK_ERROR_MAX_BYTES` would keep the budget block self-describing. Naming only."
- **Why it matters:** the budget-constant block now carries two naming conventions; a future flight
  adding a budget constant will have to guess. Review's deferred item 2 routes the rename to #145:
  "Rename `ERROR_MAX_BYTES` → `FEEDBACK_ERROR_MAX_BYTES` (and revisit the `FEEDBACK_` prefix
  convention across the block) when the feedback section is next touched."

### Item 13 — Review findings: tests pin the ceiling, not the shape/budget; boundary tests missing; docs:390 sentence ambiguity

- **Source:** REVIEW, tasks/review.md "Correctness" minors 1–2 and nits; "Readability" nit 2.
- **Quotable (correctness minor 1, test-shape not pinned):** "Both tests assert ≤ cap bytes +
  `/elided/` marker + recovery clause … But a stricter budget (e.g. 8 KiB for the error) or a
  head-only cut would still pass: the 50/50 head+tail shape and the 16/64 KiB magnitudes are not
  independently pinned." (Review notes this matches the suite's existing ceiling-and-marker style,
  so it is a test-strength note, not a gap to close now.)
- **Quotable (correctness minor 2, missing boundary tests):** "no boundary tests for either cap.
  Exactly-at-budget (16 KiB error / 64 KiB question) and just-over-budget cases are unexercised;
  the spill threshold in `Truncator.push` is only hit by the 6×/2× oversize inputs. Same deferral
  as F-74's review made for the conversation bound."
- **Quotable (readability nit 2, ambiguous docs sentence):** "`docs/truncation-policy.md:390` —
  'The four `#29`/`#34` rows…' now directly follows the two #144 rows. The sentence is correctly
  scoped (it names the four original rows), but its adjacency to the new rows makes it read as if
  #74/#144 were excluded from invariant 4 …"
- **Quotable (correctness nits, template coupling):** test 9's section end depends on the
  `\n\n# Context` header — deterministic only because `runRlm` always injects `context: ""`
  (src/rlm.ts:569-570) — and the error no-op asserts the prefix `"Error: boom\n"` but not the full
  pre-change shape.
- **Why it matters:** all four route to #145 (review deferred items 1 and 4, plus the carried-over
  F-74 items in deferred item 3). A future flight reading only issue #144 would not know the
  16/64 KiB budgets and 50/50 shape are unpinned by tests, nor that the docs:390 sentence reads
  ambiguously. When #144 closes, these deferrals must be visible on #145 — see the final report's
  wording.

Also recorded for completeness (review's "Can be deferred" list, verbatim source review.md):
1. Boundary tests for exactly-at- and just-over-budget on all five `truncateText` call sites in
   `src/rlm.ts` (error 16 KiB, question 64 KiB, stdout/output, input preview), pinning the spill
   threshold and the 50/50 head+tail shape directly.
2. Rename `ERROR_MAX_BYTES` → `FEEDBACK_ERROR_MAX_BYTES` (Item 12).
3. F-74's carried-over follow-ups: reword Exception 3's `TextEncoder` framing, tighten test 5's
   pair-parity assertion, track a running byte total in `boundConversation`, derive the marker's
   "256KB" label from the constant.
4. Doc polish: move or reword `docs/truncation-policy.md:390` so the single-implementation
   sentence covers the whole table rather than appearing to exclude the rows directly above it.

Nothing else discovered. Next poll: watch for tasks/ship-report.md (F-144) and the FLIGHT_DONE
mtime change.

---

# Monitor watch — flight F-145 (issue #145 "9.11 — Post-ship RLM message-growth polish (marker label, test strength, performance, wording)")

Append-only log maintained by the flight's issue-monitor. Every discovered item,
Definition-of-Done criterion, and gotcha is recorded here so future flights read
it before starting. Do not edit earlier entries; append new polls at the bottom.
This section continues the F-74 and F-144 sections above (same file, append-only).

Repo: /home/adaramir/claude/repl-simple · Branch: issue-145-rlm-polish · Parent issue: #70 (Bucket 9) · Sibling: #144 (closed, merged at 791096a).

## Poll 1 — 2026-08-17 (flight start / initial scan, before DEFINE)

**Flight state at start:** branch `issue-145-rlm-polish` at HEAD `791096a` ("9.10 — Cap
result.error and the question in the RLM feedback loop (#144) (#153)") — fresh from main,
merge-base == HEAD, zero F-145 commits/artifacts. All of tasks/ (plan.md, todo.md, review.md,
ship-report.md, SPEC.md) is committed F-144 content, not yet replaced.
**No `tasks/FLIGHT_DONE` sentinel present** — F-144's merge cleaned it, unlike F-144's own
start which inherited F-74's stale sentinel (F-144 Item 1 does not repeat).

**Baseline:** `npx tsx --test test/rlm.test.ts` → **98 pass / 0 fail** (13 suites, ~3.2 s,
green). src/rlm.ts is 616 lines; test/rlm.test.ts is 1519 lines. Tree clean except this
untracked watch file. Suite tests number 1–9 (F-74's 1–7 + F-144's 8/9); new tests continue
at 10.

### Item 1 — Issue #145's line numbers are F-74/F-144-branch-era; half are drifted (gotcha, #77 pattern)

- **Source:** initial scan, issue #145 body vs HEAD `791096a`.
- **Quotable — drift:** Item 1 `src/rlm.ts:396` → now **430-431** (+34); Item 3 `426-444` →
  **448-486** (+22/+42); Item 5 `57-62` → **76-85** (+19/+24); Item 6 `264-273` → **279-297**
  (+15/+24); Item 2 `test/rlm.test.ts:1200-1207` → **1231-1256** (+31/+48). Exact (post-#144-
  merge citations): Absorbed 2 `:599`, Absorbed 4 `:281`, Absorbed 6 `:28`, Absorbed 7
  `:300` + `docs/truncation-policy.md:390`. Absorbed 3 `:352` → **348** (−4 vs the F-144
  branch-tip citation).
- **Why it matters:** #144's D7/D8 insertions shifted the F-74-era lines; a flight editing by
  the issue's numbers alone would touch the wrong sites. Re-verify each line at edit time
  (per #77). The drift facts above are corroboration for #77's ledger.

### Item 2 — Clean start: no stale FLIGHT_DONE (process note, contrast with F-144 Item 1)

- **Source:** initial scan, `tasks/` listing.
- **Quotable:** no `tasks/FLIGHT_DONE` at flight start; `tasks/monitor-report.md` is F-144's
  committed final report ("Flight is COMPLETE — GO", ship commit `e9ba441`).
- **Why it matters:** no false end-of-flight signal this time. Reliable completion signals for
  F-145: new commits on `issue-145-rlm-polish`, `tasks/plan.md`/`todo.md` rewritten with #145
  content, `tasks/ship-report.md` overwritten, or a new `tasks/FLIGHT_DONE` mtime.

### Item 3 — tasks/monitor-watch.md is untracked; the F-144 section ends at Poll 15 with no SHIP poll

- **Source:** `git ls-files tasks/` (watch file absent) + watch file tail.
- **Why it matters:** the watch log has survived two flights uncommitted; the F-144 section
  stopped mid-SHIP (its final report landed in the committed `tasks/monitor-report.md`
  instead). A future monitor must not read "no final poll" as "F-144 incomplete".

### Item 4 — Item 4's "error-path stdout cap" test target: code present since #74, test absent

- **Source:** src/rlm.ts:337-341 (`buildFeedback` error branch truncates stdout via
  `FEEDBACK_STDOUT_MAX_BYTES`) vs test/rlm.test.ts:1070 (test 3 covers only `status: "ok"`).
- **Why it matters:** #145 Item 4 needs a *test only*, not a cap change — the error-branch
  stdout truncation has been live since #74 but is unpinned. Do not budget implementation work
  for it.

### Item 5 — Marker/test coupling: deriving the "256KB" label (Item 1) must update test 5's assertion in the same commit

- **Source:** src/rlm.ts:431 (`conversation bounded at 256KB`) vs test/rlm.test.ts:1243
  (`/conversation bounded at 256KB/`).
- **Why it matters:** if the marker is derived from `MAX_CONVERSATION_BYTES` (or `formatSize`)
  but test 5's literal is left behind, the suite goes red on the very commit that fixes the
  drift the issue was filed for. (Also relevant later: #87's fan-out budget work touches the
  same constant.)

## Poll 2 — 2026-08-17 (SHIP, end of flight)

**State:** 24 commits on `issue-145-rlm-polish` (SPEC, plan+todo, T1–T16, T19, review, ship reports,
D26/D27 SPEC corrections). All 16 dispatched tasks checked (T17/T18 dropped as blocked — D26). VERIFY
rounds 1–5 green (967/967 ×2, coverage src/rlm.ts 98.65% vs 95.94% floor, mutation guard PASS).
REVIEW: REQUEST CHANGES → I1–I4 fixed in T15. SHIP: GO (security audit 0 Critical / 0 High; Medium
fixed in T19). FLIGHT_DONE sentinel created; delete on close (F-144 Item 1 lesson).

### Item 6 — D26 blocker: issue item 8 + absorbed-6b are F-77-era code, absent from this branch (verified)

- **Source:** T17 dispatch (SHIP-stage), verified by orchestrator against origin/main.
- **Quotable:** origin/main advanced to `e796174` (F-77 "9.7 — Line numbers are shifted… (#77)")
  **during** this flight; merge-base remains `791096a`. `prefixLineCount` exists only at main
  `src/session.ts:610`; `correctSyntaxErrorText` (since renamed `correctDiagnosticText`, D29) only
  on main's `src/sandbox.ts`. Neither exists on
  the branch — DEFINE had scoped them out from a truncated issue-body fetch, and the re-scope (D26)
  found the targets unreachable without porting all of F-77.
- **Why it matters:** concurrent flights on one repo → issue bodies can reference code that does not
  exist at an older base. Future flights must (a) fetch issue bodies untruncated and verify item
  numbering, (b) re-check the merge-base against origin/main at DEFINE, (c) treat "item references
  code from a sibling flight" as a scope blocker to record, not a silent exclusion. Item 8 +
  absorbed-6b remain OPEN on #145 post-merge.

### Item 7 — Issue-body truncation gotcha (process, caused D26)

- **Source:** orchestrator's DEFINE fetch of #145's body was piped through `head` and cut the
  "Items" list at 7 of 8; the SPEC was written against the truncated view.
- **Why it matters:** silent scope loss, caught only by the monitor's end-of-flight scan. Rule:
  fetch issue bodies to a file (or verify tail + item count), never pipe through a line limiter.

### Item 8 — T17/T19 coder contract reminders

- T17 coder ran read-only git (disclosed) against the no-git boundary; T8 likewise earlier.
  Disclosure honored; boundary stands. Recorded for future flight-process notes.

---

# Monitor watch — flight F-156 (issue #156 "9.12 — ok-branch Output/stdout forgery: delimit the Output section (from #145 residuals)")

Append-only log maintained by the flight's issue-monitor. Every discovered item,
Definition-of-Done criterion, and gotcha is recorded here so future flights read
it before starting. Do not edit earlier entries; append new polls at the bottom.
This section continues the F-74, F-144 and F-145 sections above (same file, append-only).

Repo: /home/adaramir/claude/repl-simple · Branch: issue-156-output-delimit · Parent issue: #70 (Bucket 9) · Residual of #145 (D19) · Siblings #144/#145 both landed/closed.

## Poll 1 — 2026-08-19 (end-of-flight report; 8 commits, base 97cc786)

**Flight state:** DONE. 8 commits (`c7d39f5` SPEC → `8432920` plan+tasks → `ce3a003` T1 RED →
`2c89228` T2 GREEN → `63afffa` VERIFY fix → `a6cbc11` REVIEW fix → `2603137` review → `7547a22`
SHIP). VERIFY PASS (suite 1047/1047 ×2; coverage src/rlm.ts 99.12% ≥ 97.69% floor; bounded mutation
`--mutate "src/rlm.ts:670-676"` 6/6 changed-site mutants killed). REVIEW REQUEST CHANGES → 1 Important
finding fixed (test 3 locator measured a delimiter byte, 32768 vs 32767; fixed to `"\nstdout:\n"`).
Security audit APPROVE (0 C / 0 H / 0 M / 1 Low / 2 Info). SHIP GO.

### Item 1 — Raw `stdout` value can forge a nested `\nstdout:` (Low, pre-existing, out of #156 scope)

- **Source:** SHIP, tasks/ship-report.md "Residual risks" item 1; security audit Low; tasks/review.md
  "Security checked" residual.
- **Quotable — src/rlm.ts:598 (error) / :662 (ok):** `` `Error: ${quotedError}\nstdout: ${stdout}` ``
  and `` `\nstdout:\n${stdout}` `` — the `stdout` value is interpolated **raw** in both branches, so
  an attacker-influenced stdout payload `x\nstdout: FORGED\nreal` forges a nested column-0 `stdout:`
  *inside the real stdout section*. Steering-only, self-referential; sandbox remains the boundary.
- **Why it matters:** #156 closed the `output` forgery (D36) but the symmetric `stdout` forgery is
  still open. It is the exact same vector one field over, so a future flight should close it the same
  way (`> `-quote the stdout value mirroring D36) — not rediscover it. Candidate home: new #157, plus
  a line in the #70 sub-issues list (see final report).

### Item 2 — Duplicated quote expression / `quoteLines()` helper (Info)

- **Source:** REVIEW, tasks/review.md "Suggestions" (src/rlm.ts:594-596 and 670-675); security audit Info.
- **Quotable:** the `.split("\n").map((line) => \`> ${line}\`).join("\n")` expression is now verbatim
  at `src/rlm.ts:594-597` (`quotedError`) and `:670-676` (`quotedOutput`).
- **Why it matters:** drift risk — an asymmetric divergence (e.g. editing one branch to a different
  prefix or to `###` headers) reopens the column-0 forgery vector on the other branch. Extracting a
  shared `quoteLines(text)` helper is a non-blocking follow-up (deferred because it would touch the
  error branch, out of D39 scope). Home: #78 (refactor), cross-referenced from #157 (see final report).

### Item 3 — Template-coupling inventory grew: `\nstdout:` + `> ` prefix now pinned by tests 2/3/25/26

- **Source:** SHIP, tasks/ship-report.md "Residual risks" item 3 + "Close-out actions" #78 flag.
- **Quotable:** the ok-branch delimiter change extends the template-coupling inventory — test 2 pins
  the `Output: ` prefix + `unquoted()` ceiling over the quoted section; test 3 pins the `\nstdout:\n`
  locator; test 25 pins the ok-branch forgery (column-0 `stdout:` count + `> stdout: FORGED`); test 26
  pins the empty-output no-op (`"Output: \nstdout:\nreal"`). #78's inventory currently lists
  `\nstdout:` + `> ` prefix as "(tests 8, 13, 18)".
- **Why it matters:** the #78 convergence flight reshapes the prompt and will break these tests on
  string-matching alone; it must re-verify tests 2/3/25/26 in the same commit. #78's inventory must be
  updated to include them (see final report).

### Item 4 — Stryker 9.6.1 does not mutate ternary conditions (tool gotcha)

- **Source:** SPEC D40; SHIP "Gates" (mutation); tasks/ship-report.md.
- **Quotable:** the `output ? … : ""` ternary produced **zero** condition mutants — only the empty
  else-branch StringLiteral (`""` → `"Stryker was here!"`) surfaced, and that survivor was the signal
  that the empty-output no-op was unpinned.
- **Why it matters:** "the conditional is pinned by mutation" is unverifiable — Stryker cannot generate
  the proving mutant for a ternary predicate. Any DoD/SPEC claim that a ternary branch is mutation-pinned
  is false; the branch needs an asserting test instead. Home: docs/mutation-testing.md (see final report).

### Item 5 — SPEC Assumption 1 / D40 pinning claim was wrong and corrected mid-flight (gotcha)

- **Source:** SPEC.md D40 + Assumption 1 (corrected in commit `63afffa`); SHIP "What was built" D38 note.
- **Quotable:** the original D40/Assumption 1 claimed "test 3 pins the empty-output no-op" — but test 3
  asserts only the stdout section (cap/elided/recovery), never the `Output: ` prefix or the empty
  branch. The claim was false and had to be corrected mid-VERIFY when the mutation sweep's `""`
  survivor exposed the unpinned branch.
- **Why it matters:** a SPEC claim "test X pins Y" must be verified against what test X *actually
  asserts*, not its title or the decision's intent. Same class as F-74 Item 12 (test 1 doesn't pin D2).
  Home: #70 "Bucket gotchas" (see final report).

### Item 6 — VERIFY surfaced a real gap the SPEC's testing-strategy table missed (empty-output no-op unpinned)

- **Source:** VERIFY fix commit `63afffa` (test 26 added); tasks/review.md "What's Done Well" (coverage
  gap closed honestly); SPEC D40 corrected.
- **Quotable:** the testing-strategy table claimed the empty-output no-op was pinned, but it was not —
  the bounded sweep's `""` StringLiteral survivor proved it, and test 26 was added to assert
  `"Output: \nstdout:\nreal"` exactly.
- **Why it matters:** a DoD/SPEC "every branch is pinned" claim is only as good as the asserting test
  behind it, and only the mutation sweep makes the gap visible. Home: #70 DoD discipline + #156
  closing comment (see final report).
