# Monitor report — flight F-144 (issue #144 "9.10 — Cap result.error and the question in the RLM feedback loop")

Final consolidated monitor report. Flight is **COMPLETE — GO** (ship commit `e9ba441`
"9.10 — ship report: GO (#144)"; `tasks/FLIGHT_DONE` touched 19:20). Branch
`issue-144-cap-error-question` is 7 commits ahead of flight base `34da5c5`, unmerged at write
time. Advisory only — no issue was edited by this monitor.

Commits: `01e5c6a` SPEC · `9fb8916` plan · `018e51a` T1 (error cap) · `e905ce8` T2 (question cap)
· `527244e` T3 (policy doc) · `35b16cd` review (approve) · `e9ba441` ship (GO).

Artifacts read: `tasks/monitor-watch.md` (F-144 Items 1–13, Polls 1–15), `tasks/review.md`,
`tasks/ship-report.md`, `tasks/plan.md`, `SPEC.md` (via watch quotes), `git log` branch +
`origin/main`. Watch log is the append-only discovery record; this report re-expresses its items
as exact issue-edit wording plus placement.

**Flight results (context for all wording below):** error cap 16 KiB (`ERROR_MAX_BYTES`,
50/50 head+tail, `status === "error"` branch only, real traceback recovery), question cap 64 KiB
(`QUESTION_MAX_BYTES`, 50/50, deliberately weak recovery — Q3), both via the shared `truncateText`.
Tests 8/9 genuine prove-it (verified failing against base), each with byte-identical no-op half.
VERIFY 950/950 ×2, tsc/lint/build clean, src/rlm.ts 97.40% vs 95.94% floor, bounded mutation
sweep 48/451 mutants ≈89.6% detected (supervisor decision — full sweep infeasible, see B4).
REVIEW approve (0 blockers, 6 minor, 5 nit). SHIP fan-out 3×SHIP (2 LOW + 3 INFO security, all
pre-existing or defense-in-depth). No blockers anywhere.

---

## A. Edits to issue #144 itself (still open; branch unmerged — apply before merge/close)

### A1. DoD box → replace the three bullets with the close-out record

Replace the current DoD bullets with:

> - [x] An oversized `result.error` cannot push any iteration's conversation over 256 KiB — the
>   `Error: ` feedback section is ≤ 16 KiB via `truncateText` (`ERROR_MAX_BYTES = 16 * 1024`,
>   50/50 head+tail), recovery `"Catch the exception and print the full traceback to see more."`
>   (test 8; RED at ~100 KiB → GREEN).
> - [x] An oversized question cannot appear uncapped in `messages[0]` — the `# Question` section
>   is ≤ 64 KiB via `truncateText` (`QUESTION_MAX_BYTES = 64 * 1024`), recovery `"The question
>   was truncated. Answer from the part shown and state the assumption if ambiguous."`
>   (test 9; RED at 131072 B → GREEN).
> - [x] Both paths RED→GREEN tested (tests 8 and 9, each with an over-budget and a byte-identical
>   under-budget no-op half); `truncateText` remains the only truncation implementation (test 6
>   untouched; no `Buffer`/`byteLength` in `src/rlm.ts`).
>
> **Reading note:** bullet 1 means *no new uncapped path*, not an unconditional ≤ 256 KiB
> invariant — the conversation bound is best-effort at HEAD (`boundConversation` drops only at
> ≥ 5 messages; a > 256 KiB assistant reply is kept transiently, docs Exception 4; the drop
> marker itself can overshoot). Worst case after this flight: `messages[0]` ≤ 64 KiB question
> + ≤ 32 KiB input preview + headers ≈ 97 KiB; error iteration ≤ 16 KiB error + ≤ 32 KiB stdout.

### A2. "## Do" → append the chosen budgets so nobody re-derives them

> **Budgets chosen by the #144 flight** (the body says "error-appropriate" / "generous" without
> numbers — recorded fire-and-forget, SPEC Assumptions 1–2): error = **16 KiB** (equal to
> `output`'s cap); question = **64 KiB** (sized so a maxed initial prompt cannot alone cross the
> 256 KiB conversation bound). Both use the value shape (50/50 head+tail). The question's recovery
> clause is deliberately weaker because the question is **not sandbox-accessible** — the marker
> may not advertise a route it cannot honour (policy Q3, same rule as the `_` binding).

### A3. Gotchas block → append

> 1. **Template coupling:** tests 8 and 9 locate their sections by the literals `Error: ` /
>    `\nstdout:` and `# Question\n` / `\n\n# Context` (the `# Context` boundary exists only
>    because `runRlm` always injects `context: ""`, `src/rlm.ts:569-570`). Together with F-74's
>    test 7, any prompt-template rewording now breaks tests 7, 8 and 9 on string-matching alone.
> 2. **Scope fact:** `result.error` exists only on error results (`src/types.ts:163-165`); the
>    error cap sits on the `status === "error"` branch only — ok/suspended paths never pay it.
> 3. **Line drift by flight end:** the body's sites were accurate at start (error `src/rlm.ts:313`,
>    question `:276`) but moved during the flight (error cap `:343-347`, question cap `:300-304`).
>    Re-verify against HEAD before any future work (see #77).

### A4. Orphan handoff → move SPEC open question 1 to #145 before closing #144

The note "a future issue could pass the full question as an input so it becomes sliceable" lives
only in this flight's SPEC.md and dies with the branch. Append it to #145 (wording in B3 below).

---

## B. Edits to #145 (9.11 polish — absorb the #144 follow-ups)

### B1. Append a "## Absorbed from the #144 flight" block (ship follow-ups 1–7, re-expressed)

> 1. **Authenticate truncation markers** (security LOW): attacker-controlled text is
>    indistinguishable from real `[… X of Y elided …]` markers; sentinel-delimited markers plus a
>    system-prompt note would make them self-authenticating (all five `truncateText` call sites).
> 2. **Cap or fail on pathological assistant replies** (`src/rlm.ts:599`, security LOW): the last
>    uncapped prompt path — a prompt-injection-induced multi-MiB reply is carried in every
>    subsequent query (the F-74 Assumption 4 edge, still open after #144).
> 3. **Delimit error/stdout sections in feedback** (`src/rlm.ts:352`, security LOW): an exception
>    message containing `\nstdout:` can forge a fake stdout line; indent/quote or `###` headers.
> 4. **Sanitize input names** (`src/rlm.ts:281`, security INFO): input keys are interpolated
>    unescaped into the prompt header — a backtick/newline key injects prompt structure.
>    One-line fix: `/^[A-Za-z_][A-Za-z0-9_]*$/` at the merge site. *(This is the #72-deferral note
>    that previously lived only on #74's comment thread — now homed.)*
> 5. **Test-strength gaps for the new caps** (test-engineer): boundary tests at exactly/just-over
>    budget; "uses the full budget" assertions — the current tests pin ceiling + marker +
>    recovery, so a silent 8 KiB cap or a head-only cut would still pass (the 16/64 KiB magnitudes
>    and the 50/50 head+tail shape are not independently pinned); composition test (huge question
>    + huge inputs together).
> 6. **Naming:** rename `ERROR_MAX_BYTES` → `FEEDBACK_ERROR_MAX_BYTES` (`src/rlm.ts:28`) and
>    revisit the `FEEDBACK_` prefix convention across the budget-constant block.
> 7. **Doc/cosmetic:** `const { text: q }` → full-name binding (`src/rlm.ts:300`);
>    `docs/truncation-policy.md:390` — "The four `#29`/`#34` rows…" is now stale/ambiguous after
>    the two #144 rows were added directly above it; reword so the single-implementation sentence
>    covers the whole table.

### B2. Note on existing #145 items (do not duplicate)

The #144 review re-confirmed the F-74 items already on this issue as still open — reword
Exception 3's `TextEncoder` framing (item 5), tighten test 5's pair-parity (item 2), running byte
total in `boundConversation` (item 3), derive the marker's "256KB" label (item 1), boundary tests
(item 4 — B1.5 above extends it with the two new call sites), fence-split (item 6). No changes
needed to their wording.

### B3. Append the question-as-input follow-up (from #144 SPEC open question 1)

> **Question-as-input follow-up (from #144's SPEC open question 1):** pass the full question as an
> input so it becomes sandbox-sliceable in Python; that would let `QUESTION_RECOVERY` be
> strengthened later (today it is deliberately weak — policy Q3: the question is not
> sandbox-accessible). Changes the input contract; deliberate scope call for this issue or a
> follow-up.

### B4. Mutation note

> **Mutation re-run:** #144's VERIFY ran a bounded sweep only (48/451 mutants, ~19 min, ≈89.6%
> detected; full sweep infeasible on an 8-core host — see `docs/mutation-testing.md`). If this
> flight touches truncate-adjacent code, re-run the full matrix before relying on the score.

---

## C. Cross-references

### C1. #77 (line-number drift) → append a corroborating data point

> #144 corroboration: the #144 flight re-verified its issue body against HEAD before starting and
> found it **accurate** (error `src/rlm.ts:313`, question `:276`), then watched both sites move
> during the flight (error cap `:343-347`, question cap `:300-304`). The re-verify-never-chase
> discipline held both ways. Also: `origin/main` advanced 5 commits (#110/#150 flights) during
> F-144 with **zero code overlap** — only planning-doc conflicts at merge.

### C2. #70 (Bucket 9 epic) → update the #144 line

After `#144  9.10 — cap result.error and the question in the RLM loop   ← from #74 residuals`:

> — **landed** (F-144, 7 commits, ship GO: error 16 KiB / question 64 KiB via `truncateText`,
> tests 8/9; 950/950 ×2; review approve). Residual follow-ups (marker auth, assistant-reply cap,
> error/stdout delimiting, input-name sanitize, test strength, naming, docs) absorbed by #145.

### C3. (Optional) #78 (convergence) → template-coupling note

> **Template-coupling note (from #144):** tests 7 (F-74), 8 and 9 (F-144) locate prompt sections
> by the literals `# Input (available as …`, `Error: `/`\nstdout:`, `# Question\n`/`\n\n# Context`.
> If this flight's prompt-template convergence changes any header wording, all three tests break
> on string-matching alone.

---

## D. Consolidation table (item → source → home → severity)

| # | Discovery (quotable) | Source | Home | Severity |
|---|---|---|---|---|
| 1 | Stale F-74 `FLIGHT_DONE` sentinel present at flight start; a naive "sentinel ⇒ complete" check misfires | watch P1 I1 | process — SHIP must `rm -f` before recreating; monitor checks mtime | process |
| 2 | Issue lines accurate at start (313/276) but moved by flight end (343-347/300-304) | watch P1, review.md | #77 C1 | knowledge |
| 3 | DoD bullet 1's unconditional "cannot push over 256 KiB" is known-false at HEAD (best-effort bound); flight read it as "no new uncapped path" | watch P1 I3, P14 I5 | #144 A1 | med — misreading costs a red test |
| 4 | Issue said "error-appropriate"/"generous"; SPEC fixed 16/64 KiB (Assumptions 1–2, fire-and-forget) | watch P14 I5 | #144 A2 | med — re-derivation cost |
| 5 | `QUESTION_RECOVERY` deliberately weak (Q3); SPEC open question 1 (question-as-input) orphaned once #144 closes | watch P14 I6 | #145 B3; #144 A4 | med — orphaned follow-up |
| 6 | Tests 8/9 add two template-literal couplings (`\nstdout:`, `\n\n# Context`) to the F-74 test-7 gotcha | watch P14 I7; review nits | #144 A3 + #145 B1.5 + #78 C3 | low–med |
| 7 | `origin/main` advanced 5 commits (#110/#150) mid-flight; overlap editorial-only (SPEC/plan/todo); zero code overlap | watch P15 I9; review Merge notes | ship-report merge notes (done) + #77 C1 | gotcha at merge |
| 8 | Supervisor decisions: no rebase; bounded mutation sweep (48/451, ~19 min, ≈89.6%) | watch P15 I10-11; ship report | recorded in ship report + #145 B4 | knowledge |
| 9 | `ERROR_MAX_BYTES` breaks the `FEEDBACK_` prefix convention (`src/rlm.ts:28`) | review readability minor | #145 B1.6 | nit |
| 10 | Tests pin ceiling+marker, not the 16/64 KiB magnitudes or 50/50 shape; no boundary tests (spill threshold hit only by 6×/2× oversize) | review correctness minors 1–2 | #145 B1.5 | med — silent 8 KiB cap would pass |
| 11 | `docs/truncation-policy.md:390` "four rows" sentence stale/ambiguous after rows 5–6 added | review readability nit; ship f/u 7 | #145 B1.7 | low |
| 12 | Ship fan-out follow-ups 1–5: marker auth, pathological assistant reply, error/stdout delimiting, input-name sanitize (the old #72 orphan — now homed), test strength | ship report | #145 B1.1–5 | low (security LOWs; input-name was a med orphan, now homed) |
| 13 | Verification facts: 950/950 ×2; 97.40% vs 95.94% floor; tests 8/9 proven failing against base; no-op halves byte-identical | ship report | none (record) | context |

Severity legend: **med** = costs a future flight rework / a red test / an orphaned note;
**low** = test strength, naming, docs ambiguity; **gotcha** = would break a future flight if
unknown; **process** = flight-hygiene, not a repo defect.

---

## E. How to prevent rediscovery (for the user/driver, in order)

1. Edit #144 per A1–A4 **before merging/closing** it (branch still unmerged).
2. Append the B1–B4 block to #145 — follow-ups 1–7, the question-as-input note, and the mutation
   caveat; the existing F-74 items on #145 stay untouched (B2 confirms they are still open).
3. Append C1 to #77 and C2 to #70; optionally C3 to #78.
4. Process fixes: SHIP must `rm -f tasks/FLIGHT_DONE` before recreating it (F-144 started with
   F-74's stale sentinel); keep reading issues via `gh issue view --json` (classic-Projects
   deprecation); keep the monitor-watch append-only discipline.
5. Known gotchas honored this flight — none were rediscovered: test 6's `Buffer`/`byteLength`
   ban (test 6 untouched), line drift re-verified against HEAD (#77), gh `--json` workaround,
   "256KB" vs "256 KiB" wording, `boundConversation` <5-message edge, O(n²) re-encode,
   test-7 template coupling. All seven already live on #74/#145 from the F-74 report.
