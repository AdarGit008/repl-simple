import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  belowFloor,
  combineRuns,
  exceedsSpreadLimit,
  keepFloorable,
  oneLineTolerance,
  pct,
  refusalReasons,
  spreadLimit,
  type MeasuredRun,
} from "../scripts/coverage-core.js";

// ── pct ────────────────────────────────────────────────────────

describe("pct", () => {
  it("returns 100 for a file with no instrumented lines", () => {
    assert.equal(pct({ hit: 0, found: 0 }), 100);
  });

  it("floors to 2dp so a baseline never sits above what was measured", () => {
    assert.equal(pct({ hit: 390, found: 391 }), 99.74);
    assert.equal(pct({ hit: 2, found: 3 }), 66.66);
    assert.equal(pct({ hit: 999, found: 1000 }), 99.9);
  });

  it("returns exactly 100 for a fully covered file", () => {
    assert.equal(pct({ hit: 391, found: 391 }), 100);
  });
});

// ── combineRuns ────────────────────────────────────────────────

function run(
  global: number,
  rows: Array<{ file: string; pct: number; found: number }>,
): MeasuredRun {
  return { global, rows };
}

describe("combineRuns", () => {
  const runs = [
    run(97.92, [
      { file: "src/a.ts", pct: 100, found: 391 },
      { file: "src/b.ts", pct: 99.5, found: 200 },
      { file: "src/c.ts", pct: 98.34, found: 150 },
    ]),
    run(97.9, [
      { file: "src/a.ts", pct: 99.74, found: 391 },
      { file: "src/b.ts", pct: 100, found: 200 },
      { file: "src/c.ts", pct: 98.34, found: 150 },
    ]),
    run(97.91, [
      { file: "src/a.ts", pct: 100, found: 391 },
      { file: "src/b.ts", pct: 100, found: 200 },
      { file: "src/c.ts", pct: 98.34, found: 150 },
    ]),
  ];

  it("returns the per-file minimum and maximum across runs", () => {
    const { files } = combineRuns(runs);
    assert.deepEqual({ ...files["src/a.ts"] }, { min: 99.74, max: 100, found: 391 });
    assert.deepEqual({ ...files["src/b.ts"] }, { min: 99.5, max: 100, found: 200 });
    assert.deepEqual({ ...files["src/c.ts"] }, { min: 98.34, max: 98.34, found: 150 });
  });

  it("returns the minimum global across runs", () => {
    assert.equal(combineRuns(runs).global, 97.9);
  });

  it("takes found as the maximum across runs", () => {
    const uneven = [
      run(97, [{ file: "src/a.ts", pct: 99, found: 100 }]),
      run(97, [{ file: "src/a.ts", pct: 99, found: 120 }]),
    ];
    assert.equal(combineRuns(uneven).files["src/a.ts"].found, 120);
  });

  it("flags files that appear in some but not all runs", () => {
    const unstable = [run(97, [{ file: "src/a.ts", pct: 100, found: 100 }]), run(97, [])];
    const result = combineRuns(unstable);
    assert.deepEqual(result.missingInSomeRuns, ["src/a.ts"]);
    assert.equal(result.files["src/a.ts"].min, 100);
  });

  it("returns an empty flag list when every file appears in every run", () => {
    assert.deepEqual(combineRuns(runs).missingInSomeRuns, []);
  });
});

// ── keepFloorable ─────────────────────────────────────────────

describe("keepFloorable", () => {
  const full = run(97.9, [
    { file: "src/a.ts", pct: 100, found: 391 },
    { file: "scripts/tooling.ts", pct: 62.8, found: 200 },
  ]);

  it("drops rows outside the floor universe and keeps the run global", () => {
    const kept = keepFloorable(full, new Set(["src/a.ts"]));
    assert.deepEqual(kept.global, 97.9);
    assert.deepEqual(kept.rows, [{ file: "src/a.ts", pct: 100, found: 391 }]);
  });

  it("keeps every row when all are floorable", () => {
    const kept = keepFloorable(full, new Set(["src/a.ts", "scripts/tooling.ts"]));
    assert.equal(kept.rows.length, 2);
  });
});

// ── spreadLimit ────────────────────────────────────────────────

describe("spreadLimit", () => {
  it("is one percentage point for files large enough that a line is worth less", () => {
    assert.equal(spreadLimit(391), 1);
    assert.equal(spreadLimit(200), 1);
    assert.equal(spreadLimit(100), 1);
  });

  it("is one line's worth when a line is worth more than a point (small files)", () => {
    const limit = spreadLimit(42);
    assert.ok(Math.abs(limit - 100 / 42) < 1e-9);
  });

  it("is 1 for a file with no instrumented lines", () => {
    assert.equal(spreadLimit(0), 1);
  });
});

// ── exceedsSpreadLimit ───────────────────────────────────────

describe("exceedsSpreadLimit", () => {
  it("passes a spread at the floor of one line's worth (small file, unfavourable 2dp floor)", () => {
    // One line of a 42-line file is 100/42 ≈ 2.3810 pp; the 2dp flooring can
    // report it as 2.39, which must not refuse the update.
    assert.equal(exceedsSpreadLimit(0, 2.39, 42), false);
  });

  it("passes a spread at one percentage point on a large file", () => {
    assert.equal(exceedsSpreadLimit(99, 100, 391), false);
  });

  it("passes an exactly-zero spread", () => {
    assert.equal(exceedsSpreadLimit(98.34, 98.34, 150), false);
  });

  it("refuses a spread above one line's worth", () => {
    assert.equal(exceedsSpreadLimit(97.6, 100, 42), true);
    assert.equal(exceedsSpreadLimit(98.9, 100, 391), true);
  });

  it("passes a spread just above 1pp where one line is 1pp exactly", () => {
    assert.equal(exceedsSpreadLimit(0, 1.01, 100), false);
  });

  it("refuses a spread a hair past the slack", () => {
    assert.equal(exceedsSpreadLimit(0, 1.02, 100), true);
  });
});

// ── refusalReasons ─────────────────────────────────────────────

describe("refusalReasons", () => {
  it("returns an empty list when nothing varies beyond a line", () => {
    const combined = combineRuns([
      run(97, [{ file: "src/a.ts", pct: 99.74, found: 391 }]),
      run(97, [{ file: "src/a.ts", pct: 100, found: 391 }]),
    ]);
    assert.deepEqual(refusalReasons(combined, 3), []);
  });

  it("names the file and its measured range for a wide spread", () => {
    const combined = combineRuns([
      run(97, [{ file: "src/a.ts", pct: 90, found: 391 }]),
      run(97, [{ file: "src/a.ts", pct: 100, found: 391 }]),
    ]);
    const refusals = refusalReasons(combined, 3);
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /^src\/a\.ts: spread 90\.00–100\.00 exceeds one line's worth/);
  });

  it("names a file absent from some runs, with the run count", () => {
    const combined = combineRuns([
      run(97, [{ file: "src/a.ts", pct: 100, found: 391 }]),
      run(97, []),
      run(97, []),
    ]);
    assert.deepEqual(refusalReasons(combined, 3), [
      "src/a.ts: absent from at least one of the 3 runs",
    ]);
  });
});

// ── oneLineTolerance ───────────────────────────────────────────

describe("oneLineTolerance", () => {
  it("is one line expressed in percentage points", () => {
    assert.equal(oneLineTolerance(200), 0.5);
    assert.ok(Math.abs(oneLineTolerance(391) - 100 / 391) < 1e-9);
  });

  it("is 0 when there are no lines to lose", () => {
    assert.equal(oneLineTolerance(0), 0);
  });
});

// ── belowFloor ─────────────────────────────────────────────────

describe("belowFloor", () => {
  // The issue's exact case: truncate.ts measured 99.74 (one unhit declaration
  // line in 391) against a floor written from a 100.00 run. One line of
  // instrument variance must not fail the gate.
  it("passes a measurement one line below the floor (issue's truncate.ts case)", () => {
    assert.equal(belowFloor(99.74, 100, 391), false);
  });

  it("passes a measurement at exactly one line below the floor (boundary)", () => {
    assert.equal(belowFloor(99, 99.5, 200), false);
  });

  it("passes a measurement above the floor", () => {
    assert.equal(belowFloor(100, 99.74, 391), false);
  });

  it("passes a measurement at the floor", () => {
    assert.equal(belowFloor(99.74, 99.74, 391), false);
  });

  it("fails a measurement two lines below the floor", () => {
    assert.equal(belowFloor(99.48, 100, 391), true);
  });

  it("fails a wide drop", () => {
    assert.equal(belowFloor(98, 99.74, 391), true);
  });

  it("passes one line below the floor on a small file (gate-side mirror of the 42-line case)", () => {
    assert.equal(belowFloor(97.61, 100, 42), false);
  });

  it("fails at the closest boundary below the tolerance", () => {
    assert.equal(belowFloor(99.73, 100, 391), true);
  });

  it("fails when found is 0 and any lines are missed", () => {
    assert.equal(belowFloor(99, 100, 0), true);
  });
});
