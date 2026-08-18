import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, SpendBudget } from "../src/budget.js";

// ── estimateTokens ──────────────────────────────────────────────

describe("estimateTokens", () => {
  it("empty string → 0", () => {
    assert.equal(estimateTokens(""), 0);
  });

  it("known ASCII string → pinned token count", () => {
    // "hello world" is 11 UTF-8 bytes → ceil(11 / 4) = 3.
    assert.equal(estimateTokens("hello world"), 3);
  });

  it("multi-byte UTF-8 → pinned token count", () => {
    // "😀" is 4 UTF-8 bytes → ceil(4 / 4) = 1.
    assert.equal(estimateTokens("😀"), 1);
  });

  it("is deterministic — repeated calls agree", () => {
    const text = "a".repeat(1000);
    assert.equal(estimateTokens(text), estimateTokens(text));
  });
});

// ── SpendBudget — constructor ───────────────────────────────────

describe("SpendBudget constructor", () => {
  it("accepts 0", () => {
    const b = new SpendBudget(0);
    assert.equal(b.limit, 0);
    assert.equal(b.consumed, 0);
    assert.equal(b.remaining, 0);
  });

  it("accepts a positive finite limit", () => {
    const b = new SpendBudget(42);
    assert.equal(b.limit, 42);
    assert.equal(b.consumed, 0);
    assert.equal(b.remaining, 42);
  });

  for (const bad of [NaN, Infinity, -Infinity]) {
    it(`rejects non-finite ${String(bad)}`, () => {
      assert.throws(() => new SpendBudget(bad));
    });
  }

  it("rejects a negative limit", () => {
    assert.throws(() => new SpendBudget(-1));
  });
});

// ── SpendBudget — tryCharge ─────────────────────────────────────

describe("SpendBudget.tryCharge", () => {
  it("charges when affordable and increments consumed", () => {
    const b = new SpendBudget(10);
    assert.equal(b.tryCharge(7), true);
    assert.equal(b.consumed, 7);
    assert.equal(b.remaining, 3);
  });

  it("refuses overspend without charging", () => {
    const b = new SpendBudget(10);
    assert.equal(b.tryCharge(11), false);
    assert.equal(b.consumed, 0);
    assert.equal(b.remaining, 10);
  });

  it("refuses negative tokens without charging", () => {
    const b = new SpendBudget(10);
    assert.equal(b.tryCharge(-1), false);
    assert.equal(b.consumed, 0);
    assert.equal(b.remaining, 10);
  });

  it("tryCharge refuses a non-finite charge (NaN) without mutating consumed", () => {
    const b = new SpendBudget(10);
    assert.equal(b.tryCharge(NaN), false);
    assert.equal(b.consumed, 0);
    assert.equal(b.remaining, 10);
  });

  for (const bad of [Infinity, -Infinity]) {
    it(`tryCharge refuses non-finite ${String(bad)} without mutating consumed`, () => {
      const b = new SpendBudget(10);
      assert.equal(b.tryCharge(bad), false);
      assert.equal(b.consumed, 0);
      assert.equal(b.remaining, 10);
    });
  }

  it("tryCharge(0) is a valid no-op that charges nothing", () => {
    const b = new SpendBudget(10);
    assert.equal(b.tryCharge(0), true);
    assert.equal(b.consumed, 0);
    assert.equal(b.remaining, 10);
  });

  it("exactly exhausting the limit is allowed, then refused", () => {
    const b = new SpendBudget(10);
    assert.equal(b.tryCharge(10), true);
    assert.equal(b.consumed, 10);
    assert.equal(b.remaining, 0);
    assert.equal(b.tryCharge(1), false);
    assert.equal(b.consumed, 10);
  });
});

// ── SpendBudget — shared instance ───────────────────────────────

describe("SpendBudget shared-instance semantics", () => {
  it("two chargers on one instance compete for one remaining pool", () => {
    const b = new SpendBudget(100);
    assert.equal(b.tryCharge(60), true); // charger A
    assert.equal(b.tryCharge(30), true); // charger B
    assert.equal(b.remaining, 10);
    assert.equal(b.consumed, 90);
    assert.equal(b.tryCharge(20), false); // A cannot afford
    assert.equal(b.remaining, 10);
    assert.equal(b.consumed, 90);
  });
});
