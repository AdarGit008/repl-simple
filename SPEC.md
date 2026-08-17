# Spec: coverage:update writes floors the instrument's variance can't turn red — issue #113

> "coverage:update writes floors that the instrument's own variance can turn red"
> Labels: `infra`, `test`, `chore` · Not filed under bucket 1 (the floors are correct as of #112; this
> is about keeping them correct automatically).

## Objective

`scripts/coverage.mjs --update` measures coverage **once** and writes that observation as the floor.
Per-file coverage varies between identical runs of the same tree — V8's per-function range count is
lost when coverage from several test processes is merged — so a floor written from a lucky high run
fails later on an unrelated PR with no signal pointing at the cause. This has already cost one red
build (`src/pool.ts` at `021b5af`, 97.51% vs 100.00%).

**The fix is a mechanism, not a convention.** #105's by-hand rule ("a file that varies gets its floor
set at the low observation") is unenforced and machine-dependent. The script must own the floor:

1. `--update` measures **N times** and writes the **per-file minimum**.
2. `--update` **refuses to write** when a file's spread exceeds a threshold — blind `min` would bake
   a badly slack floor into the baseline if a whole process's data were ever lost. Wide variance is
   a thing to look at, not to average away.
3. The **measured spread is printed**, so a file that starts varying becomes visible.
4. The plain `coverage` gate gains a **one-line tolerance** so it only bites on drops the instrument
   can actually resolve (the #132 correction to the original proposal's arithmetic).
5. The README's by-hand rule is replaced by a description of what the script does.

**User:** anyone landing a change in this repo. **Success:** `coverage:update` followed by any number
of plain `coverage` runs is green on the same tree, with no hand-tuned numbers anywhere.

## Explicit decisions (recorded, not reflexive)

- **N = 3.** The issue proposes 3 ("the low showed up once in six"); three full runs (~45 s each) is
  an acceptable update cost and samples the known-variant files on most machines.
- **Per-file minimum across N runs, global = minimum of the N per-run globals.** The global is
  "reported, not a gate"; min-of-N keeps it consistent with the per-file philosophy.
- **Refusal threshold = max(1.00 pp, one line).** One line of a file is `100/found` pp. The issue's
  "~1 pp" is the term for big files; on a 42-line file the same benign instrument defect is 2.38 pp,
  and refusing there would be a false positive. A spread **above** `max(1.00, 100/found)` pp refuses
  the update with the file and its measured range named, exit 1. Exactly one line of spread always
  passes; more than a line is "look at it, don't average it away".
- **One-line compare tolerance, applied at gate time only.** A measured file fails only when it is
  **more than one line** (`100/found` pp) below its floor. This is #132's alternative to the refusal
  threshold, and both are kept: the threshold keeps floors honest, the tolerance makes the gate
  resolve what the instrument can resolve — a one-line tail below the min-of-3 cannot go red, and
  the hand-pinned 99.74 stops mattering even if this machine's min-of-3 lands on 100.00.
- **The tolerance is for percentage comparisons only.** The manifest checks — a floored file absent
  from the report, a source file with no floor — are structural, not measurements, and stay exact.
- **A file present in some but not all N update runs refuses the update.** A file that loads
  unstably is the instrument at its worst; writing a floor for it would be guessing.
- **Decision logic lives in a typed, unit-tested module.** `scripts/coverage-core.ts` holds the pure
  functions (`pct`, `combineRuns`, thresholds, `belowFloor`). `scripts/coverage.mjs` becomes thin
  orchestration importing it, and `npm run coverage` / `coverage:update` run the script via `tsx`
  (plain `node` cannot import `.ts`). CI already invokes `npm run coverage`, so it is unaffected.
  `tsconfig.json` does not include `scripts/`, but tsc follows imports — the core gets strictly
  checked without joining the built package (tsconfig.build.json emits only src/ + test/).
- **`found` for threshold/tolerance purposes = the maximum LF across the N runs.** On an unchanged
  tree LF is constant; max is the conservative choice if it ever is not.
- **`scripts/` files are printed but never floored.** `scripts/coverage-core.ts` loads in the unit
  tests and lands in the report; its line coverage (62.8%) tracks *comment* density — V8 counts
  comment lines of tsx-transformed files as uncovered (measured: branch coverage 100%, the missing
  37% is JSDoc) — so a floor on it would break CI on comment edits. The update floors only the
  tracked `src/` + `extensions/` universe (`keepFloorable`), and the gate prints the row as
  UNMEASURED without failing. Recorded 2026-08-17 after the first empirical update run surfaced it.

## Tech Stack

Node ≥ 22.19 ESM, `node:test` via `tsx` (the suite runner), Node's `--experimental-test-coverage`
with the lcov reporter, biome 2.5.8, tsc strict. No new dependencies.

## Commands

```
Gate:      npm run coverage              # measure once, compare against floors + tolerance
Update:    npm run coverage:update       # measure 3×, write per-file minima or refuse
Test:      npm test                      # full suite incl. new unit tests
Focused:   npx tsx --test test/coverage-core.test.ts
Check:     npm run check                 # tsc --noEmit (follows imports into scripts/)
Lint:      npm run lint                  # biome check --error-on-warnings
Build:     npm run build
```

## Project Structure

```
scripts/coverage.mjs        → orchestration: measure loop, baseline read/write, refusal, reporting
scripts/coverage-core.ts    → pure decision logic (NEW): pct, combineRuns, spreadLimit, belowFloor
test/coverage-core.test.ts  → unit tests for the core (NEW)
coverage-baseline.json      → { global, files: { path: pct } } — shape unchanged
README.md                   → "Coverage floors" section rewritten to describe the mechanism
```

## Code Style

The script is plain ESM with jsdoc block comments explaining *why* (the existing file is the model).
The core module follows `src/` style: named exports, no default exports, strict types. Example:

```ts
/** Line percentage, floored to 2dp so a baseline never sits above what was measured. */
export function pct({ hit, found }: Counts): number {
  if (!found) return 100;
  return Math.floor((hit / found) * 10000) / 100;
}
```

## Testing Strategy

- **Unit tests** (`test/coverage-core.test.ts`, runs under `npm test`) cover the decision logic:
  `pct` flooring; `combineRuns` minima/spread/global-min and the missing-in-some-runs flag;
  `spreadLimit` = max(1.00, 100/found); `belowFloor` boundaries — the exact known cases from the
  issue (floor 100.00, measured 99.74, found 384 → pass; two lines down → fail).
- **Empirical verification of the script** (not in the unit suite — it spawns the whole suite):
  run `coverage:update`, then three consecutive plain `coverage` runs, all green; the update
  prints the spread table and the written floor for `src/truncate.ts` is script-owned.
- The core is deliberately pure so the threshold/refusal arithmetic is pinned without needing to
  *force* V8 variance in a fixture — that is not deterministic.

## Boundaries

- **Always:** run `npm test` and `npm run coverage` before committing; never hand-edit a floor in
  `coverage-baseline.json` (the script owns it now); explain any deliberate floor change in the
  commit message.
- **Ask first:** (n/a this run — autonomous) changing N or the threshold values.
- **Never:** lower a floor without running `coverage:update`; remove a failing test to make a floor
  pass; add a file to `UNMEASURED_SOURCE_FILES` without its reason in the comment.

## Success criteria (testable)

1. `coverage:update` completes and writes `coverage-baseline.json` from min-of-3; the spread report
   prints every file whose measurements differed, with its range.
2. A file whose spread exceeds `max(1.00, 100/found)` pp fails the update with its measured range
   named — pinned by unit tests on the core (the script path is exercised by feeding the core
   synthetic data; V8 variance cannot be forced deterministically).
3. Three consecutive plain `npm run coverage` runs on the same tree pass after the update —
   verified by running them, not assumed.
4. `src/truncate.ts`'s floor is written by the script (99.74 if the machine samples the low, 100.00
   if it does not — either is safe under the one-line tolerance), and the README's by-hand rule
   paragraph is removed and replaced with the mechanism description.
5. The manifest checks keep their exact behavior: floor-without-report, no-floor, and UNMEASURED
   handling all fail exactly as today (existing behavior, re-verified by running the gate).
6. `npm test`, `npm run check`, `npm run build`, `npm run lint` all clean (exit codes verified).

## Assumptions (recorded; no human asked — autonomous run)

1. N = 3 and threshold = max(1.00 pp, one line) are the reasonable readings of the issue's "~1 pp"
   and "3 is probably enough"; both are single constants in the core and trivial to retune.
2. Adopting **both** #132's alternatives (refusal threshold *and* one-line compare tolerance) is
   intended: they protect different moments (writing vs. gating) and the comment presents them as
   the two real options, not as mutually exclusive.
3. Switching `npm run coverage`/`coverage:update` from `node` to `tsx` is in scope; the script's
   behavior is unchanged, and CI (which calls `npm run coverage`) needs no edit.
4. "Reproduced by the script" (DoD 3) means the script owns the number going forward; whether this
   machine's min-of-3 samples the 99.74 low or the 100.00 high for `truncate.ts`, no hand pinning
   remains.
5. `bashenv.ts`'s floor (84.21) is treated as a real measurement, not variance — its spread is a
   documented separate question on the issue; if the update observes it varying beyond threshold,
   the refusal fires and the run records it rather than silently writing.

## Open Questions

None blocking. Whether the #132 evidence should also be re-tested on the pool/bashenv files after
this lands is a follow-up, not part of this change.

## Not in scope

Fixing the V8/Node coverage-merge behavior itself (upstream defect); touching #109's mutant flake;
changing the mutation-score gate; the CI matrix (floors stay a single Node 24/ubuntu job).
