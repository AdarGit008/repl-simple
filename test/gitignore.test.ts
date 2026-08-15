import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `.pi/` must not travel with a clone (#53).
 *
 * `.pi/code-tools/*.py` is Python the agent wrote for itself, and the repl
 * preamble executes it before user code with full host-tool access. Committing
 * it would hand every future cloner code that runs on their machine — project
 * trust is what stops it running, this is what stops it shipping.
 *
 * Asked of git rather than read out of `.gitignore`: a pattern present in the
 * file and overridden by a later negation, a `!` rule, or `.git/info/exclude`
 * would pass a text match while the file was still committable. `check-ignore`
 * answers the question that matters.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Skip reason when there is no git repository to ask, or `false` when there is.
 *
 * The mutation harness copies the source tree into `.stryker-tmp/sandbox-N`
 * without `.git`, and a test that failed there would fail for every mutant —
 * scoring them all "killed" and making the mutation number meaningless, which
 * is the exact failure #109 and #132 were about. Skipping in a copied tree is
 * correct: a tree with no git in it has no ignore rules to get wrong.
 */
const NO_GIT: string | false = (() => {
  const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (probe.status === 0 && probe.stdout.trim() === "true") return false;
  return `${REPO_ROOT} is not a git work tree (mutation sandbox or unpacked tarball).`;
})();

describe(".gitignore", () => {
  it("ignores .pi/, so agent-written code cannot be committed", { skip: NO_GIT }, () => {
    // A path that does not exist on disk is fine: check-ignore matches rules,
    // not files, which is what keeps this test from depending on local state.
    const check = spawnSync("git", ["check-ignore", "-q", "--", ".pi/code-tools/hostile.py"], {
      cwd: REPO_ROOT,
    });

    // 0 = ignored, 1 = not ignored, anything else = git could not answer.
    assert.equal(
      check.status,
      0,
      ".pi/code-tools/hostile.py is not ignored — saved tools would be committed and " +
        "would then execute on every clone that trusts this project",
    );
  });

  it("ignores the .pi directory itself", { skip: NO_GIT }, () => {
    const check = spawnSync("git", ["check-ignore", "-q", "--", ".pi/"], { cwd: REPO_ROOT });
    assert.equal(check.status, 0, ".pi/ is not ignored");
  });
});
