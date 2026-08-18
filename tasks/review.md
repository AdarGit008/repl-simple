# Review — flight F-145 (issue #145 "9.11 — Post-ship RLM message-growth polish")

Five-axis review of the full branch diff (`origin/main..HEAD`, base 791096a, 17 commits at review time)
by the code-reviewer persona (fresh context). Branch: `issue-145-rlm-polish`.

## Verdict (at review time): REQUEST CHANGES → all Important findings addressed by T15 (commit 7e17677); no re-review needed per ship fan-out merge

## Review Summary

The branch delivers all 16 decisions (D10–D25) cleanly — the D15 two-level elision is arithmetically
exact, the D12 refactor is byte-identical to base, and the test battery (10–24) is the strongest in
the suite's history. No Criticals. The D17 sentinel rule — the branch's headline security mechanism —
was incoherent in two ways (it declared the system's own D3 drop marker "literal data", and its
wording misdescribed what sits between sentinels), and D20's validation accepted Python keywords its
own rationale says should fail early. All four Important findings were cheap, one-site fixes (T15).

### Critical Issues
None.

### Important Issues (all addressed in T15)
- **I1** `src/rlm.ts:255` + `:661` — the sentinel rule made the D3 drop marker "literal data" by its
  own definition. Fix: carve-out sentence appended ("The history-drop notice placed after the first
  message is also system-emitted and authentic."), pinned in test 17(c).
- **I2** `src/rlm.ts:253-254` — the rule misdescribed between-sentinel text ("has been elided" is
  false; it is the retained head+tail view). Reworded to "is a truncated view — portions of it have
  been elided and are summarised by a marker".
- **I3** `src/rlm.ts:145-166` — the sentinel scheme did not close forgery; it re-based it: (a)
  under-budget attacker values could render a forged sentinel pair whole and sentinel-free; (b)
  over-budget attacker text lands inside the authentic pair where the rule declares every marker
  authentic. Fix: `truncateWithSentinels` now neutralises sentinel-token sequences inside the value
  before wrapping (`value.replaceAll("[TRUNCATED VIEW", "[TRUNCATED\u200BVIEW")`, byte-measured after
  the swap so budgets stay exact) + two RED test cases. Docs Exception 5 updated: no residual forgery
  vector remains.
- **I4** `src/rlm.ts:119,703-707` — D20's regex accepted Python keywords (`class`, `def`, `None`,
  `True`, `import`, …) whose downstream type-check failure is exactly what D20's rationale claims to
  reject before any query. Fix: module-const `INPUT_NAME_KEYWORDS` (35 hard keywords, Python's
  `keyword.kwlist`; soft keywords deliberately excluded) checked at the merge site with a distinct
  message + `class` row in test 15's boundary matrix.

### Suggestions
- **S1** `SPEC.md:184` duplicated sentence — de-duplicated in T15.
- **S2** docs: quoted error section renders ≤ 2× its value budget — recorded in T15.
- **S3** `src/rlm.ts:206` `if (payload <= 0) return ""` silently drops the input section; unreachable
  at current budgets; recorded, deferred (insurance if budgets ever shrink below the reserve).
- **S4** `src/rlm.ts:233-238` reserve/newline coupling — comment added in T15.
- **S5** `DEFAULT_RLM_SYSTEM_PROMPT` is default-only — caller-supplied `options.systemPrompt` silently
  drops the sentinel rule while wrapping still happens. JSDoc + docs Exception 5 note added in T15.
- **S6** Test coupling inventory for #78 (record, not fix): tests 20/21/22 pin the effective-payload
  boundary (`maxBytes − SENTINEL_OVERHEAD_BYTES`); tests 5/23/24, 8/13/18, 9/19/21 pin `256\.0KB`,
  `\nstdout:`, `> `, `# Question\n`, `\n\n# Context`, the `\n\nWrite Python code…` trailer and the
  `/inputs elided/` marker line. Tests 10/12/23/24 self-derive sizes from observed messages (robust);
  the static literals are the churn surface for #78's convergence rework.
- **S7** `test/rlm.test.ts` `unquoted()` helper strips `> ` from legitimate content lines too —
  measurement-only drift, negligible, noted.
- **S8** File size `src/rlm.ts` 616→815 justified — constants, contract comments, two small helpers;
  extracting prompt-section elision to a module is a #78 candidate, not now (test 6's greps/import
  assertions are tuned to the current layout).

### What's Done Well
- `elideInputBlocks` is arithmetically exact — the 32 KiB ceiling holds including sentinels in every
  block ordering (reserve-at-widest marker, 4-newline reserve exact).
- D12 is genuinely byte-identical to base `boundConversation` (marker-strip-before-total order, strict
  `>` boundary, marker-loop re-measurement, `droppedTurns === 0` early return all preserved).
- Tests 23/24 are the best work in the diff — mutation-kill constructions that re-derive all sizes
  from observed messages and kill both `-=`→`+=` mutants with a 9-message kill point that exits via
  the byte condition, not the length guard.
- Discipline: prove-it guards GREEN at HEAD first (T1–T3), RED tests paired with fixes in-commit,
  policy Q3 respected at every recovery clause, D14's honesty without the banned tokens, exact scope
  (7 files, `src/truncate.ts` untouched).

### Verification Story (at review time)
- Tests reviewed: all of `test/rlm.test.ts` (tests 10–24 + edits to 5/6/8/9.2.6), full `src/rlm.ts`,
  `truncate.ts` Truncator semantics, base `boundConversation` for D12 equivalence.
- Build verified: focused suite 113/113 green locally; VERIFY's 966/966 ×2 + tsc/lint/coverage/mutation
  gates green.
- Security checked: D17/D19/D20 analyzed at every call site; no secrets, no new deps, no injection
  regression.
