# F-77 VERIFY — test-engineer report (two rounds)

## Round 1 (post-build, HEAD 9e39c96): NO-GO

Gates: `npm test` 976/976 · `npm run check` PASS · `npm run coverage` all floors met · `npm run lint` PASS.

- Issue tests 1-4 mapped to real tests and green; all six task acceptances mapped to tests.
- **BLOCKING:** typing diagnostics still shifted + leaking preamble source — SPEC premise ("already line-correct via out-of-band `typeCheckStubs`") false in measured reality: `typeCheckStubs` removes only the stub-file contribution; the RLM preamble (~90 lines) still shifts typing diagnostics. Measured end-to-end: `json.loads('{')` on model line 1 → ` --> rlm.py:91:1` with preamble source in the excerpt.
- MEDIUM: `resumeInSession` offset path had no behavior test.
- MEDIUM-LOW: plain `MontySyntaxError` branch never behaviorally exercised.
- LOW: stale types test ("RunOptions with all fields" omitted lineOffset); RLM-level runtime feedback never asserted preamble-source absence; foreign-filename frame caveat (Monty surfaces only user frames, so unconditional subtraction doesn't corrupt imported-module frames in observed cases); README says nothing about per-iteration state.

## Round 2 (post-fix, HEAD 0681c38): GO

Fixes landed: Task 7 (typing path corrected via `correctDiagnosticText`; ≤-offset rows skipped not clamped; false-premise comments/JSDoc corrected; bogus test replaced; RLM-level typing-feedback test), Task 8 (resumeInSession test exposed and fixed a real bug — `Session.resume()` lost lineOffset; plain `MontySyntaxError` branch test via input-name validation; types test updated).

Gates: `npm test` **983/983** · `npm run check` PASS · `npm run coverage` all floors (rlm 97.44, sandbox 97.65, session 98.70, types 100) · lint PASS.

- BLOCKING typing finding: **FIXED** — independent end-to-end rerun: feedback contains exactly ` --> rlm.py:1:4`, excerpt `1 | x: int = 'oops'`, zero line numbers > 5, zero of 4 preamble tokens leaked.
- Resume-path gap: **FIXED (+ real bug found & fixed)** — post-resume `ZeroDivisionError` reports user-relative `line 2`; suspension semantics intact (21 focused suspension tests + full suite green).
- MontySyntaxError branch: **FIXED** — input-name validation failure → kind `syntax`, message pass-through, no prefix source.
- Types test: **FIXED**.
- D3 literals intact; #144 cap pinned on the corrected path; guard pinned.

**Open items restated for SHIP:**
1. SPEC.md/plan.md doc staleness (typing premise) — corrected in the docs commit `b1558af`. ✅ closed
2. README fresh-sandbox contract — added in `b1558af`. ✅ closed
3. **`RLMLoop` path had the same defect, unfixed (MEDIUM, out of scope at the time)** — `src/rlm_loop.ts:265` prepends preamble with no `lineOffset`; `formatErrorFeedback` feeds `result.error` verbatim. → **Resolved by Task 10a (review Required finding).**
4. Multi-block typing diagnostic under offset unpinned (LOW) — line-wise transform handles it; untested.
5. Runtime `endLine` correction unrendered/unobserved (LOW, cosmetic).

## Round 3 (post-review-fix, HEAD c9e0b1f): gates re-run by coder

Task 10 landed (RLMLoop lineOffset wiring + location-regex hardening): `npm test` **986/986** · check clean · lint clean. Coverage floors not re-run in round 3 — the ship auditor runs them as final evidence.
