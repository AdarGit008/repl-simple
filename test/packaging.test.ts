import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The build must emit a flat, consumable `dist/` (#80): `dist/index.js` at the
 * top level (not `dist/src/index.js`), no test files, and a preamble that
 * loads from the *compiled* output — not just the in-tree source.
 *
 * Builds once in `before`, then asserts on the result. `dist/` is gitignored
 * build output; clearing it first keeps stale artifacts from a previous
 * (broken) build from masking a regression.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(REPO_ROOT, "dist");

before(() => {
  rmSync(DIST, { recursive: true, force: true });

  const build = spawnSync("npm", ["run", "build"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(
    build.status,
    0,
    `npm run build failed:\n${build.stdout ?? ""}\n${build.stderr ?? ""}`,
  );
});

/** Every file under `dir`, as paths relative to `dir`. */
function filesRelativeTo(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;

  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const fullPath = join(current, entry);
      if (statSync(fullPath).isDirectory()) walk(fullPath);
      else out.push(relative(dir, fullPath));
    }
  };
  walk(dir);
  return out;
}

describe("build output", () => {
  it("emits dist/index.js at the top level, not dist/src/index.js", () => {
    assert.ok(existsSync(join(DIST, "index.js")), "expected dist/index.js to exist");
    assert.ok(
      !existsSync(join(DIST, "src", "index.js")),
      "expected dist/src/index.js to NOT exist — the build must not nest src/",
    );
  });

  it("emits no test files into dist/", () => {
    const files = filesRelativeTo(DIST);
    const testFiles = files.filter((f) => f.split(sep)[0] === "test" || /\.test\./.test(f));
    assert.deepEqual(testFiles, [], "dist/ must not contain test/ or *.test.* files");
  });

  it("getReplPreamble() works against the compiled dist/preamble.js", async () => {
    const { getReplPreamble } = await import(pathToFileURL(join(DIST, "preamble.js")).href);
    const preamble = getReplPreamble();
    assert.ok(preamble.includes("context_preview"));
    assert.ok(preamble.includes("context_summary"));
  });
});
