import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { closeSandboxPool, getSandboxPool, poolConfig, withSandboxSession } from "../src/pool.js";
import { MontyComplete } from "@pydantic/monty/node";

// ── Helpers ─────────────────────────────────────────────────────

/** Runs `fn` with env vars applied, restoring whatever was there before. */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── Configuration ───────────────────────────────────────────────

describe("poolConfig", () => {
  // The two upstream defaults this replaces both fail open: `maxProcesses`
  // follows the CPU count, and `checkoutTimeout` waits forever, so an
  // exhausted pool hangs silently rather than erroring. Asserting the shipped
  // values is the only way to catch a change that leaves every other test
  // passing, since those set their own environment.

  it("ships a finite worker cap and a finite checkout timeout", () => {
    const { maxProcesses, checkoutTimeoutSecs } = poolConfig();
    assert.ok(maxProcesses > 0 && Number.isFinite(maxProcesses));
    assert.ok(checkoutTimeoutSecs > 0 && Number.isFinite(checkoutTimeoutSecs));
  });

  it("reads the environment at call time", async () => {
    await withEnv(
      { REPL_POOL_MAX_PROCESSES: "7", REPL_POOL_CHECKOUT_TIMEOUT_SECS: "3" },
      async () => {
        assert.deepEqual(poolConfig(), { maxProcesses: 7, checkoutTimeoutSecs: 3 });
      },
    );
  });

  it("falls back to the default for a value that is not a positive integer", async () => {
    const shipped = poolConfig();
    for (const bad of ["0", "-1", "not-a-number", ""]) {
      await withEnv({ REPL_POOL_MAX_PROCESSES: bad }, async () => {
        assert.equal(
          poolConfig().maxProcesses,
          shipped.maxProcesses,
          `'${bad}' should not become the worker cap`,
        );
      });
    }
  });
});

// ── Lifecycle ───────────────────────────────────────────────────

describe("the process-wide pool", () => {
  after(async () => {
    await closeSandboxPool();
  });

  it("hands every caller the same pool", async () => {
    assert.equal(await getSandboxPool(), await getSandboxPool());
  });

  it("hands concurrent first callers the same pool", async () => {
    // The reason the module stores the promise rather than the resolved value:
    // `Monty.create()` is async, so two callers racing on a `Monty | null`
    // would both see it empty and both build one, leaving a pool with a
    // prewarmed worker that nothing holds a reference to close.
    await closeSandboxPool();
    const [a, b, c] = await Promise.all([getSandboxPool(), getSandboxPool(), getSandboxPool()]);
    assert.equal(a, b);
    assert.equal(b, c);
  });

  it("builds a fresh pool after being closed", async () => {
    const first = await getSandboxPool();
    await closeSandboxPool();
    assert.notEqual(await getSandboxPool(), first);
  });

  it("closing an unopened pool is a no-op", async () => {
    await closeSandboxPool();
    await closeSandboxPool();
  });
});

// ── Session checkout ────────────────────────────────────────────

describe("withSandboxSession", () => {
  after(async () => {
    await closeSandboxPool();
  });

  it("runs the body against a usable session", async () => {
    const out = await withSandboxSession({}, async (session) => {
      const snap = await session.feedStart("6 * 7");
      return snap instanceof MontyComplete ? snap.output : null;
    });
    assert.equal(out, 42);
  });

  it("returns the worker even when the body throws", async () => {
    // Worth an explicit test because the failure is invisible until the pool
    // runs dry: a body that throws past an unreleased checkout leaks one
    // worker per call, and the symptom arrives later, as an unrelated caller
    // timing out. `maxProcesses` here is deliberately smaller than the number
    // of iterations.
    await closeSandboxPool();
    await withEnv(
      { REPL_POOL_MAX_PROCESSES: "2", REPL_POOL_CHECKOUT_TIMEOUT_SECS: "5" },
      async () => {
        for (let i = 0; i < 6; i++) {
          await assert.rejects(
            () =>
              withSandboxSession({}, async () => {
                throw new Error(`body failed on iteration ${i}`);
              }),
            /body failed on iteration/,
          );
        }
        // Still serviceable: nothing was leaked.
        const out = await withSandboxSession({}, async (session) => {
          const snap = await session.feedStart("'alive'");
          return snap instanceof MontyComplete ? snap.output : null;
        });
        assert.equal(out, "alive");
      },
    );
  });
});
