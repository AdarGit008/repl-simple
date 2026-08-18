// ── Spend budget ────────────────────────────────────────────────
//
// The shared, observable spend budget for the RLM loop (and, once #78 ports
// nesting, the tree of nested investigations). Every charge is a *before-the-
// call* cost so a run never overspends; a call that fits is charged in full
// and a call that cannot fit degrades instead of throwing (D4).

/**
 * Estimated tokens per UTF-8 byte: ≈4 bytes/token for typical English code and
 * prose. The estimate is a documented approximation — `estimateTokens` is the
 * single swap point if a real tokenizer ever lands (D2).
 */
const BYTES_PER_TOKEN = 4;

/**
 * Deterministic token estimate: UTF-8 bytes ÷ 4, rounded up.
 *
 * Measured with `TextEncoder` — the library stays tokenizer-independent, and
 * `src/rlm.ts` never hand-rolls byte measurement (D8).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / BYTES_PER_TOKEN);
}

/**
 * A shared, mutable spend budget.
 *
 * Siblings that pass the same instance compete for one pool: `consumed` is
 * cumulative across every charge, so the second caller sees the first's spend.
 */
export class SpendBudget {
  private readonly limitValue: number;
  private consumedValue = 0;

  /**
   * @param limit The total spend ceiling, in estimated tokens. Must be a
   * finite, non-negative number — `0` is well-defined (nothing may run).
   */
  constructor(limit: number) {
    if (!Number.isFinite(limit) || limit < 0) {
      throw new Error(`SpendBudget limit must be a finite, non-negative number (got ${limit})`);
    }
    this.limitValue = limit;
  }

  /** The total spend ceiling, in estimated tokens. */
  get limit(): number {
    return this.limitValue;
  }

  /** Cumulative spend so far, in estimated tokens. */
  get consumed(): number {
    return this.consumedValue;
  }

  /** Tokens still spendable before the ceiling is hit. */
  get remaining(): number {
    return this.limitValue - this.consumedValue;
  }

  /**
   * Charge `tokens` against the budget.
   *
   * Returns `false` — and charges nothing — when `tokens` is negative or the
   * charge would exceed `limit`. Otherwise adds to `consumed` and returns
   * `true`.
   */
  tryCharge(tokens: number): boolean {
    if (tokens < 0 || this.consumedValue + tokens > this.limitValue) {
      return false;
    }
    this.consumedValue += tokens;
    return true;
  }
}
