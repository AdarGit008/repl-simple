# Tasks — coverage:update floors immune to instrument variance (#113)

- [x] Task 1: `scripts/coverage-core.ts` + unit tests (TDD: RED → GREEN)
  - Acceptance: exports `pct`, `combineRuns`, `spreadLimit`, `oneLineTolerance`, `belowFloor`;
    `combineRuns` → per-file `{ min, max, found }` (found = max across runs), `missingInSomeRuns`
    set, `global` = min of run globals; `spreadLimit(found)` = max(1.00, 100/found);
    `belowFloor` fails only more than one line below the floor; issue's exact cases pinned
    (floor 100.00 vs measured 99.74 at found 384 → pass; two lines → fail).
  - Verify: `npx tsx --test test/coverage-core.test.ts`; `npm run check`; `npm run lint`.
  - Files: `scripts/coverage-core.ts`, `test/coverage-core.test.ts`

- [ ] Task 2: rewrite `scripts/coverage.mjs` update + gate paths; runner → tsx
  - Acceptance: `--update` measures 3×, writes per-file minima + min global, prints spread report
    (every file whose runs differed, with range), refuses (exit 1, file + range named) on spread
    > threshold or a file missing from some runs; plain gate FAIL uses the one-line tolerance;
    manifest/unfloored/UNMEASURED behavior unchanged; `package.json` coverage scripts run via
    `tsx`.
  - Verify: `npm run coverage` green on current baseline; `npm run check`; `npm run lint`.
  - Files: `scripts/coverage.mjs`, `package.json`

- [ ] Task 3: README "Coverage floors" rewrite
  - Acceptance: by-hand pinning paragraph removed; section describes N=3 min-of-runs, refusal
    threshold, spread report, one-line compare tolerance; no surviving claim the script does not
    implement.
  - Verify: read-through against `scripts/coverage.mjs`; `npm run lint`.
  - Files: `README.md`

- [ ] Task 4: empirical verification + script-written baseline
  - Acceptance: `coverage:update` completes with spread report; `src/truncate.ts` floor is
    script-written; three consecutive plain `npm run coverage` runs pass; `npm test`, `npm run
    check`, `npm run build`, `npm run lint` all exit 0; `coverage-baseline.json` diff is exactly
    what the script wrote; per-task commits reference #113.
  - Verify: full suite + gate ×3 + check + build + lint, exit codes recorded.
  - Files: `coverage-baseline.json`
