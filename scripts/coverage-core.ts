// Pure decision logic for `scripts/coverage.mjs` (#113).
//
// Why this file exists: the instrument's variance — V8 loses per-function
// range counts when coverage from several test processes is merged — cannot
// be forced deterministically in a fixture, so the arithmetic that decides
// floors, refusals and failures lives here, typed and unit-tested, while
// coverage.mjs keeps only I/O and process orchestration.
//
// Kept outside `src/`: this is build tooling, not package surface. tsc still
// checks it strictly — the test file imports it, and tsc follows imports.

/** Hit/found line counts as reported by the lcov record. */
export interface Counts {
  hit: number;
  found: number;
}

/** One file's measurement from a single coverage run. */
export interface RunRow {
  file: string;
  /** Instrumented lines (LF). */
  found: number;
  /** Line percentage, already floored to 2dp by `pct`. */
  pct: number;
}

/** Everything one coverage run produced. */
export interface MeasuredRun {
  global: number;
  rows: RunRow[];
}

/** A file's measurements combined across runs. */
export interface FileAcrossRuns {
  /** The floor the update writes: the lowest observation. */
  min: number;
  /** The highest observation; spread = max - min. */
  max: number;
  /** Instrumented lines, as the maximum across runs (constant on an unchanged tree). */
  found: number;
}

export interface CombinedRuns {
  files: Record<string, FileAcrossRuns>;
  /** Files present in some but not all runs — a refusal condition, never a floor. */
  missingInSomeRuns: string[];
  /** Minimum of the per-run globals. */
  global: number;
}

/** Line percentage, floored to 2dp so a baseline never sits above what was measured. */
export function pct({ hit, found }: Counts): number {
  if (!found) return 100;
  return Math.floor((hit / found) * 10000) / 100;
}

/**
 * Combine N measured runs into per-file minima, maxima and a global minimum.
 * `found` is the maximum across runs: on an unchanged tree LF is constant, and
 * when it is not, the conservative (largest, smallest-tolerance) value is the
 * one a threshold or tolerance should be computed against.
 */
export function combineRuns(runs: MeasuredRun[]): CombinedRuns {
  const files: Record<string, FileAcrossRuns> = {};
  for (const run of runs) {
    for (const row of run.rows) {
      const existing = files[row.file];
      if (!existing) {
        files[row.file] = { min: row.pct, max: row.pct, found: row.found };
      } else {
        existing.min = Math.min(existing.min, row.pct);
        existing.max = Math.max(existing.max, row.pct);
        existing.found = Math.max(existing.found, row.found);
      }
    }
  }
  const missingInSomeRuns = Object.keys(files)
    .filter((file) => runs.some((run) => !run.rows.some((row) => row.file === file)))
    .sort();
  const global = Math.min(...runs.map((run) => run.global));
  return { files, missingInSomeRuns, global };
}

/**
 * The spread a file may show before `--update` refuses to write (#113).
 *
 * At least one percentage point — the issue's "~1 pp". But the benign
 * instrument defect is *one line*, and on a small file a line is worth more
 * than a point: a 42-line file loses 2.38 pp per line. A spread above one
 * line's worth is the "look at it, don't average it away" case; exactly one
 * line always passes.
 */
export function spreadLimit(found: number): number {
  if (!found) return 1;
  return Math.max(1, 100 / found);
}

/**
 * Both `pct` and the stored floors are floored to 2dp. A measurement whose
 * true value is one line below the floor can report up to 0.01 below
 * `floor - oneLine` after that flooring, so the failure test allows for it.
 * With this slack, `belowFloor` is false exactly when the measurement's true
 * value is within one line of the floor (for files under 10,000 lines).
 * `exceedsSpreadLimit` applies the same slack on the update side.
 */
const FLOORING_SLACK = 0.01;

/** One line, expressed in percentage points of the file. */
export function oneLineTolerance(found: number): number {
  if (!found) return 0;
  return 100 / found;
}

/**
 * The update's refusal test: did a file's spread exceed what the known
 * one-line defect can produce? Mirrors `belowFloor`'s `FLOORING_SLACK` —
 * both `min` and `max` are 2dp-floored, so a true one-line spread can report
 * up to 0.01 above `spreadLimit` and must still pass.
 */
export function exceedsSpreadLimit(min: number, max: number, found: number): boolean {
  return max - min > spreadLimit(found) + FLOORING_SLACK;
}

/**
 * Drop rows whose file is outside the floor universe (tracked `src/` and
 * `extensions/` sources). `scripts/` is tooling, not package surface: its
 * modules load in tests and would otherwise earn a floor whose number tracks
 * comment density — V8 counts comment lines of tsx-transformed files as
 * uncovered — rather than behavior. The gate still *prints* those rows, so
 * nothing is hidden; it just does not floor them.
 */
export function keepFloorable(run: MeasuredRun, floorable: ReadonlySet<string>): MeasuredRun {
  return { global: run.global, rows: run.rows.filter((row) => floorable.has(row.file)) };
}

/**
 * The plain-run gate's failure test (#132's correction): a file fails only
 * when it is **more than one line** below its floor. The instrument cannot
 * resolve sub-line differences — a floor written from a 100.00 run and a
 * later 99.74 measurement of the same file are the same observation.
 */
export function belowFloor(measured: number, floor: number, found: number): boolean {
  return measured < floor - oneLineTolerance(found) - FLOORING_SLACK;
}
