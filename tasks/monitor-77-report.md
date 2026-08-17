# F-77 Final Monitor Report — open-issue recommendations

Advisory only — no issue edited by the monitor. Flight: branch `issue/77-line-offset-continuity`,
`791096a..c9e0b1f` (11 commits), ship **GO**, 986/986 tests + check + coverage floors + lint.

## Discovery 1 — "typing diagnostics are line-correct" premise was FALSE

`typeCheckStubs` removes only the stub-file contribution; the caller-assembled RLM preamble still
shifted typing diagnostics (+~90) and leaked preamble source — measured `json.loads('{')` on model
line 1 → ` --> rlm.py:91:1`. Cost: a NO-GO verify round + Task 7 + a replaced bogus test. The
flight-start staleness comment on #77 (id 5318877797) carries the same false half-premise.

- **#77 comment:** correct the staleness block — typing diagnostics get the same `lineOffset`
  correction as syntax (`classifyStartError` → `correctSyntaxErrorText`).
- **#70 gotcha:** "Typing diagnostics are NOT line-correct under any caller-assembled prefix; do
  not re-derive this."

## Discovery 2 — Real pre-existing bug: `Session.resume()` dropped `lineOffset`/traceback

- **#77 landing comment + #70 gotcha:** post-resume errors reverted to shifted, excerpt-less
  feedback. Invariant to record: the offset passed at `resume()` equals the value the suspending
  `run()` used (`src/session.ts:418-430`, guarded by a behavioral test).

## Discovery 3 — Monty 0.0.21 API facts

- **3a. New issue (upstream-blocked):** true continuity impossible — `MontyRepl.feed()` accepts
  only `{ mount }`, no `externalFunctions`. File so the deferred decision survives #77's close.
- **3b. #70 gotcha:** plain `MontySyntaxError` is forceable only via input-name validation with
  `typeCheck` on; its message carries no line numbers.
- **3c. #70 gotcha + #78 coupling note:** blank excerpt lines render `N |` (no trailing space);
  location lines are ` --> file:line:col` with the number after the final colon of the filename
  (digit-ending-scriptName collision hardened; regression test via public `RunOptions.scriptName`).

## Discovery 4 — Residual risks placement

- Traceback re-renderer drift on monty bump → #70 gotcha (+ #40 cross-ref).
- `prefixLineCount()` O(n²) → **#145 new item 8**.
- Multi-block typing diagnostic unpinned → #70 test-strength note.
- Runtime `endLine` unrendered → #77 landing comment (cosmetic).
- Rename `correctSyntaxErrorText` → `correctDiagnosticText` → **#145 item 6 extension**.

## Discovery 5 — Continuity settled; #77's "Under #40" section is now closed

- **#77 body edit:** replace "Under #40" with the settled record (typing fixed in-flight; json
  declined; fresh-sandbox contract adopted; true continuity deferred upstream; tests 1-4 pass on
  Monty 0.0.21 and are retained on the branch). Close after merge with a "tests retained" note.
- **#70 sub-issue line:** mark #77 ← landed.
- **#87 cross-ref:** factor re-declaration overhead into the worked example's token cost.
- **#78:** extend Do items 2/8 + template-coupling note — the merged prompt must carry the
  fresh-sandbox wording (test 4 pins it), RLMLoop's prompt still implies continuity until
  convergence, and the RLMLoop lineOffset test (Task 10a) must be folded or superseded.

## Process note

`tasks/verify-77.md`, `tasks/review.md`, `tasks/ship-report.md` (F-77), and this report were
committed before the final report; `tasks/ship-report.md` previously held the stale F-144 report —
replaced deliberately.

## Applied (2026-08-17, user-approved)

- **#77**: body edited — header marks F-77 landed; "Under #40" replaced with the settled record;
  all three DoD boxes checked with landing notes. Two comments posted: the staleness-block
  correction (typing half-premise) and the landing comment (resume bug + `endLine` cosmetic
  residual). **Left OPEN — closes after merge with a "tests retained" note.**
- **#70**: sub-issue line `#77 ← landed (F-77, 12 commits, ship GO, 986/986)`; new
  "Bucket gotchas (recorded by the F-77 flight)" section (6 gotchas).
- **#78**: Do item 2 extended (merged prompt must carry the fresh-sandbox wording); Do item 8
  extended (fold or supersede the RLMLoop lineOffset case); template-coupling note extended
  (test 4 coupling + diagnostic-regex coupling).
- **#87**: "Fresh-sandbox contract note (from F-77/#77)" section appended (re-declaration
  overhead in the worked example).
- **#145**: item 8 added (`prefixLineCount()` O(n²)); item 6 extended (rename nit);
  DoD updated to Items 1–8.
- **New issue filed: #154** — "9.x — True RLM sandbox continuity once Monty FeedOptions supports
  externalFunctions" (labels: bucket-9, question) — carries the deferred continuity decision so
  it survives #77's and #70's eventual closes.
