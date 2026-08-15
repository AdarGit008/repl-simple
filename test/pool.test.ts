import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import {
  SandboxUnavailableError,
  closeSandboxPool,
  getSandboxPool,
  poolConfig,
  withSandboxSession,
} from "../src/pool.js";
import { Monty, MontyComplete } from "@pydantic/monty/node";

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

  it("does not cache a failed create — the next caller can still get a pool", async () => {
    // The property the comment at `pool.ts` states and nothing held: a
    // rejected `Monty.create()` must not be left in `poolPromise`, or every
    // later caller awaits that same rejection forever with no way to retry.
    // `Monty.create` is a writable static and `pool.ts` calls it as a property
    // lookup, so the mock is the binding the module actually reaches — no
    // sleep, no race, and no dependence on how V8 attributes an arrow nobody
    // invokes (#132).
    await closeSandboxPool();
    const create = mock.method(Monty, "create", () => Promise.reject(new Error("create refused")));
    try {
      await assert.rejects(() => getSandboxPool(), /create refused/);
      await assert.rejects(() => getSandboxPool(), /create refused/);
      // The load-bearing assertion. A cached rejection satisfies both rejects
      // above while never calling `create` a second time.
      assert.equal(
        create.mock.callCount(),
        2,
        "the second caller must reach Monty.create, not a cached rejection",
      );
    } finally {
      create.mock.restore();
    }
    // And the pool is not poisoned once the cause clears.
    const pool = await getSandboxPool();
    assert.equal(await getSandboxPool(), pool);
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

  it("refuses a checkout no worker can serve, naming the cap that refused it", async () => {
    // The same refusal `test/sandbox.test.ts` reaches end-to-end, but with the
    // race taken out: there, a 300 ms sleep hopes the holder checks the single
    // worker out first. Here the competing checkout runs *inside* the callback
    // that holds it, so "the pool is exhausted" is not a hope about timing —
    // it is where we are standing. #132.
    await closeSandboxPool();
    await withEnv(
      { REPL_POOL_MAX_PROCESSES: "1", REPL_POOL_CHECKOUT_TIMEOUT_SECS: "1" },
      async () => {
        await withSandboxSession({}, async () => {
          await assert.rejects(
            () => withSandboxSession({}, async () => "unreachable"),
            (err: unknown) => {
              assert.ok(err instanceof SandboxUnavailableError, `got ${err}`);
              // The message names the live pool's settings, not the ones that
              // would apply to a pool built now.
              assert.match(err.message, /within the 1s checkout timeout \(cap: 1 workers\)/);
              assert.ok(err.cause instanceof Error, "upstream's rejection survives as the cause");
              return true;
            },
          );
        });
      },
    );
    // Built with a cap of 1; do not leave it for the next test.
    await closeSandboxPool();
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
