/**
 * Skip reason for tests that pin an invariant by reading a source file as
 * *text*, or `false` when the files on disk are the ones the repo ships.
 *
 * Pass straight to node:test — `it(name, { skip: SOURCE_PIN_SKIP }, fn)`.
 *
 * Why this exists: a source pin asserts on the spelling of the code, which is
 * the right instrument for an invariant with no observable surface (see
 * `test/rlm.test.ts`'s `cause` pin, or the barrel's dead-export pins). But
 * Stryker copies the project into `.stryker-tmp/sandbox-*` and **instruments
 * every mutated file** before it runs anything, so under mutation testing the
 * text those pins read is not the text the repo contains:
 *
 *     // src/rlm.ts as written
 *     return new Error(redactProviderError(err), { cause: err });
 *
 *     // src/rlm.ts as the sandbox contains it
 *     return new Error(redactProviderError(err), stryMutAct_9fa48("2995")
 *       ? {} : (stryCov_9fa48("2995"), { cause: err }));
 *
 * The pin then fails during the *dry run*, and Stryker refuses to start at all
 * (`ConfigError: There were failed tests in the initial test run`). That is
 * what blocked #175 — the pins arrived with the wave work and the sweep was
 * never re-run afterwards, so nothing reported the collision.
 *
 * Skipping loses no coverage, because a source pin cannot kill a mutant even
 * in principle: Stryker's mutants are not textual edits to the file the pin
 * reads. Every mutant is present at once behind a `stryMutAct_*` switch, so the
 * file's text is identical whichever mutant is active, and the pin's verdict
 * cannot vary with it. What the pins do protect — that a human editing the
 * source cannot quietly delete the invariant — is unaffected: `npm test`, and
 * every CI leg, run them uninstrumented.
 *
 * Detected two ways, so neither has to be remembered:
 *   - the sandbox path, which Stryker names and this file sits inside; and
 *   - `MUTATION_RUN=1`, for a runner that lays the sandbox out differently.
 */
export const SOURCE_PIN_SKIP: string | false = (() => {
  const reason =
    "source pins read the file as text, and Stryker's sandbox contains the " +
    "instrumented copy — see test/support/source-pin.ts";

  // The same shape `scripts/mutation-guard.mjs` uses to find its way back out
  // of the sandbox, so a changed `tempDirName` does not defeat one and not the
  // other.
  if (/\/[^/]*stryker[^/]*\/sandbox-[^/]+\//.test(import.meta.url)) return reason;
  if (process.env.MUTATION_RUN === "1") return reason;
  return false;
})();
