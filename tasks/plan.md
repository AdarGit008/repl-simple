# Plan — post-merge micro-flight: close #145's two open items (D28, D29)

Branch `issue-145-post-merge-items` from main `b6392e5` (F-145 merged, PR #157). Two tasks, strict
sequence (independent files — order fixed for single-writer commits). Scaled pipeline: DEFINE
(SPEC D28/D29, done) → BUILD (T1, T2) → VERIFY → REVIEW → SHIP.

## Tasks

- [ ] **T1 — `Session.prefixLineCount()` O(n²) → incremental (D28)**
  - Objective: running prefix-line total; byte-identical numbers; F-77 `lineOffset` contract intact.
  - Scope: `src/session.ts`, `test/session.test.ts`.
  - RED: split-call-count test (stub `String.prototype.split`; N sequential runs → quadratic count
    at HEAD, linear after).
  - Verify: `npx tsx --test test/session.test.ts`; `npm test`; `npm run check`; `npm run build`;
    `npm run lint`; `npm run coverage`.

- [ ] **T2 — rename `correctSyntaxErrorText` → `correctDiagnosticText` (D29)**
  - Objective: mechanical rename + every repo reference (grep src/ test/ docs/ tasks/ — incl.
    `tasks/monitor-77-report.md` if it names the function).
  - Scope: `src/sandbox.ts` + reference sites.
  - Guard: no new test; `tsc --noEmit` + full suite + grep audit (`grep -rn correctSyntaxErrorText`
    must return nothing).
  - Verify: same gates as T1.

## Risks

- **F-77 contract risk (T1):** the `lineOffset` wiring (`run` :308, `resume` :425) must produce the
  same numbers — guarded by the existing session tests; do not touch the wiring, only the counter.
- **Drift risk (both):** line numbers verified at HEAD in SPEC D28/D29; re-verify at edit time (#77
  discipline).

## Checkpoint

- [ ] After T1+T2: full suite ×2 deterministic, all static gates, all coverage floors (session.ts
      98.65, sandbox.ts 97.39).

## DoD

- [ ] Both items land with SPEC-referenced guards; gates green; #145 closable with both DoD boxes
      checked in a closing comment; #78 carry-forward rename note ticked "done".
