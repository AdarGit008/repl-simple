/**
 * Replace one prototype method for the duration of `body`, then put the
 * original back — in `finally`, so a throwing body restores it too.
 *
 * This is the seam the extension tests use to observe what reaches
 * `ReplRunner.run` / `ReplRunner.resume` without driving a real sandbox: the
 * extension constructs its own `ReplRunner`, so the prototype is the only
 * place a test can stand between the two.
 *
 * **Sequential assumption (#178).** A prototype is process-wide shared state.
 * This is safe only because `node:test` runs the tests *within one file*
 * sequentially: no other test in the file can observe the patched method
 * while `body` is awaiting. Running the file with `--test-concurrency`, or
 * parallelising the tests inside it, would let two patches race — one test
 * seeing another's replacement, or restoring an already-restored original.
 * Two callers with the same prototype in flight at once is a bug in the
 * caller, not something this helper defends against; if the pattern ever
 * needs to survive concurrency, the fix is a constructor-level injection seam
 * in `ReplRunner`, not a smarter patch.
 *
 * Distinct files are already separate processes under `tsx --test`, so a
 * patch here never reaches `test/session.test.ts` or any other file.
 */
export async function withPatchedPrototype<P extends object, K extends keyof P, R>(
  proto: P,
  method: K,
  replacement: P[K],
  body: () => Promise<R>,
): Promise<R> {
  const original = proto[method];
  proto[method] = replacement;
  try {
    return await body();
  } finally {
    proto[method] = original;
  }
}
