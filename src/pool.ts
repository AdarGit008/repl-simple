import { Monty, type CheckoutOptions, type MontySession } from "@pydantic/monty/node";

// ── Worker pool ──────────────────────────────────────────────────
//
// Monty 0.0.21 runs Python in crash-isolated worker subprocesses checked out
// of a pool, where 0.0.18 ran it in-process. One pool serves the whole
// process: workers are the expensive thing (~8.5 MB each), sessions are not,
// and a pool per call would forfeit the warm-worker reuse that makes a
// checkout cost ~0.5 ms instead of ~30 ms.
//
// Both knobs below are set explicitly and never left to upstream's defaults,
// because both defaults fail open in the same direction — silently, and only
// under load:
//
//   - `maxProcesses` defaults to the CPU count. On a 64-core CI box that is a
//     licence to hold 64 workers, and the number that matters here is memory,
//     not parallelism.
//   - `checkoutTimeout` defaults to **waiting forever**. The first checkout
//     past the cap then hangs with no error, no timeout and no log — measured
//     in the #40 spike. A caller that has wedged is strictly worse than one
//     that has failed.

/** Worker cap. Sized by memory (~8.5 MB each), not by core count. */
const DEFAULT_MAX_PROCESSES = 4;
/** Seconds a checkout waits for a free worker before failing. Never `undefined`. */
const DEFAULT_CHECKOUT_TIMEOUT_SECS = 30;

/** Read at call time, not module load, so a caller can change it between runs. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The pool settings as they would apply right now. Exists for the same reason
 * `memoryGuardConfig()` does: every test sets its own environment, so shipping
 * a default that never takes effect would pass all of them.
 */
export function poolConfig(): { maxProcesses: number; checkoutTimeoutSecs: number } {
  return {
    maxProcesses: envInt("REPL_POOL_MAX_PROCESSES", DEFAULT_MAX_PROCESSES),
    checkoutTimeoutSecs: envInt("REPL_POOL_CHECKOUT_TIMEOUT_SECS", DEFAULT_CHECKOUT_TIMEOUT_SECS),
  };
}

/**
 * The live pool, as a promise rather than a value.
 *
 * Storing the promise is what makes concurrent first-callers share one pool:
 * `Monty.create()` is async, so two callers racing on a `Monty | null` field
 * would both see `null`, both create, and one pool would leak its prewarmed
 * worker with nothing holding a reference to close it.
 */
let poolPromise: Promise<Monty> | null = null;

/** The process-wide pool, created on first use. */
export async function getSandboxPool(): Promise<Monty> {
  if (poolPromise === null) {
    const { maxProcesses, checkoutTimeoutSecs } = poolConfig();
    poolPromise = Monty.create({
      maxProcesses,
      checkoutTimeout: checkoutTimeoutSecs,
      minProcesses: 1,
    }).catch((err: unknown) => {
      // A failed create must not be cached: the next caller would await a
      // rejected promise forever with no way to retry.
      poolPromise = null;
      throw err;
    });
  }
  return await poolPromise;
}

/**
 * Shut the pool down and drop it, so the next call builds a fresh one.
 *
 * Not required for the process to exit — an idle pool holds no handle that
 * keeps the event loop alive (measured). It exists so a test can reset the
 * pool after changing `REPL_POOL_*`, and so a long-lived host can release
 * workers it knows it will not need.
 */
export async function closeSandboxPool(): Promise<void> {
  const pending = poolPromise;
  if (pending === null) return;
  poolPromise = null;
  const pool = await pending.catch(() => null);
  await pool?.close();
}

/**
 * Run `fn` against a checked-out session and always return the worker.
 *
 * The `close()` is guarded because a crashed worker has already been discarded
 * and replaced by the pool, so closing its session throws a second
 * `MontyCrashedError` — one that would replace the real outcome on its way out
 * of a `finally`. The session is being abandoned either way; what matters is
 * that the caller sees why.
 */
export async function withSandboxSession<T>(
  checkoutOpts: CheckoutOptions,
  fn: (session: MontySession) => Promise<T>,
): Promise<T> {
  const pool = await getSandboxPool();
  const session = await pool.checkout(checkoutOpts);
  try {
    return await fn(session);
  } finally {
    await session.close().catch(() => {});
  }
}
