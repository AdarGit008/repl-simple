# Implementation Plan: coverage:update floors immune to instrument variance (#113)

## Overview

Make `scripts/coverage.mjs` the owner of every floor in `coverage-baseline.json`. `--update`
measures N=3 times, writes the per-file minimum, refuses to write when any file's spread exceeds
`max(1.00 pp, one line)`, and prints the spread report. The plain `coverage` gate gains a one-line
tolerance so it only fails on drops the instrument can actually resolve. The README's by-hand
pinning rule is replaced by a description of the mechanism. Source of truth: `SPEC.md`.

## Architecture Decisions

- **Pure core, thin orchestration.** All decision arithmetic lives in `scripts/coverage-core.ts`
  (typed, strictly checked via import-following, unit-tested). `scripts/coverage.mjs` keeps only
  I/O and process orchestration. Rationale: V8's variance cannot be forced deterministically in a
  fixture, so the refusal/tolerance logic must be pinned at the unit level while the script itself
  is verified empirically.
- **Runner change:** `npm run coverage` / `coverage:update` become `tsx scripts/coverage.mjs` so
  the script can import the `.ts` core. CI calls `npm run coverage` — no workflow edit needed.
- **Update path:** measure 3× → per-file min + global min; a file missing from some (not all) runs
  refuses; a spread above `max(1.00, 100/found)` pp refuses with file + range named; otherwise
  write. The "still unfloored after update" check is unchanged.
- **Gate path:** FAIL only when measured pct is more than one line (`100/found` pp) below the
  floor. Manifest checks (floor absent from report, source file with no floor, UNMEASURED rows)
  stay exact — the tolerance is for percentages only.
- **Baseline shape unchanged** (`{ global, files }`), so the diff on `coverage-baseline.json`
  shows exactly what the script decided.

## Task List

### Phase 1: Decision core (unit-tested)

- [ ] Task 1: `scripts/coverage-core.ts` + `test/coverage-core.test.ts` (TDD: RED → GREEN)
  - Acceptance: exports `pct`, `combineRuns`, `spreadLimit`, `oneLineTolerance`, `belowFloor`;
    `combineRuns` returns per-file `{ min, max, found }` (found = max across runs), per-file
    `missingInSomeRuns` set, and `global` = min of run globals; `spreadLimit(found)` =
    `max(1.00, 100/found)`; `belowFloor` fails only more than one line below the floor — the
    issue's exact cases pinned (floor 100.00, measured 99.74, found 384 → pass; two lines → fail).
  - Verify: `npx tsx --test test/coverage-core.test.ts`; `npm run check`; `npm run lint`.
  - Files: `scripts/coverage-core.ts`, `test/coverage-core.test.ts`

### Checkpoint: Foundation
- [ ] Focused tests green; `npm run check` clean; `npm run lint` clean

### Phase 2: Script wiring

- [ ] Task 2: rewrite `scripts/coverage.mjs` update + gate paths; switch runner to tsx
  - Acceptance: `--update` measures 3×, writes per-file minima + min global, prints the spread
    report (every file whose runs differed, with range), refuses (exit 1, file + range named) on
    spread > threshold or unstable loading; the plain run's FAIL check uses the one-line
    tolerance and the report prints floors as before; manifest/unfloored/UNMEASURED behavior
    unchanged; `package.json` runs both scripts via `tsx`.
  - Verify: `node --help`-free: `npm run coverage` green on current baseline; `npm run check`;
    `npm run lint`.
  - Files: `scripts/coverage.mjs`, `package.json`

### Checkpoint: Wiring
- [ ] Plain gate green on the current baseline; update runs and writes

### Phase 3: Documentation

- [ ] Task 3: README "Coverage floors" rewrite
  - Acceptance: the by-hand pinning paragraph is gone; the section describes N=3 min-of-runs
    writing, the refusal threshold, the spread report, and the one-line compare tolerance; no
    other claim about the script survives that the script does not do.
  - Verify: read-through against `scripts/coverage.mjs`; `npm run lint`.
  - Files: `README.md`

### Phase 4: Empirical verification and ship

- [ ] Task 4: run the real pipeline, commit the script-written baseline
  - Acceptance: `npm run coverage:update` completes (spread report shown; `src/truncate.ts`
    floor is script-written — 99.74 if the machine samples the low, 100.00 otherwise, both safe
    under the tolerance); **three consecutive plain `npm run coverage` runs pass**; `npm test`,
    `npm run check`, `npm run build`, `npm run lint` all exit 0; `coverage-baseline.json` diff is
    exactly what the script wrote; commits per task, issue referenced.
  - Verify: full suite + gate ×3 + check + build + lint, exit codes recorded.
  - Files: `coverage-baseline.json`

### Checkpoint: Complete
- [ ] All SPEC.md success criteria met; ready for review

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| #109's suite flake aborts a measurement | Low | `measure()` already refuses red-suite numbers; rerun the update |
| `bashenv.ts` (84.21) varies beyond threshold on this machine | Med | Refusal is the designed behavior — investigate whether it is the one-line mechanism; record the finding rather than hand-writing |
| One-line tolerance weakens the gate by one line per file | Low | Deliberate, specced (#132); the manifest checks that catch deleted test files are untouched |
| `tsx` runner changes exit-code/stdio propagation | Low | tsx forwards exit codes; verified by running the gate |
| Core `.ts` drifts from what the script needs | Low | Single consumer; strict tsc checks; unit tests pin behavior |

## Open Questions

None blocking — all decisions recorded in SPEC.md "Explicit decisions" and "Assumptions".
