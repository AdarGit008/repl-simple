import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

/**
 * Drives pi's *real* extension loader against this repository.
 *
 * The defect this guards against lives entirely in the difference between pi's
 * two entry-resolution implementations, so a test that mocks either one proves
 * nothing.
 *
 * `loader.js:473-501` (`resolveExtensionEntries`) reads our `pi.extensions`
 * manifest and accepts any entry that passes `existsSync` — with **no
 * `isFile()` check** — then hands it straight to `jiti.import()`. A directory
 * entry therefore resolves to a directory and loads zero tools. It governs
 * extension *discovery*: `<agentDir>/extensions/<pkg>/`,
 * `<cwd>/.pi/extensions/<pkg>/`, and explicitly configured paths.
 *
 * `package-manager.js:2013-2032` (`collectFilesFromPaths`) stats the path and
 * expands directories, so it tolerates either form. It governs `pi package add`
 * and the CLI's `--extension` flag.
 *
 * See issue #37.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EXTENSION_PATH = join(REPO_ROOT, "extensions", "repl-extension.ts");
const EXPECTED_TOOLS = ["repl", "repl_resume", "repl_reset", "repl_abandon"];

let agentDir: string;
let projectDir: string;

before(() => {
  // An isolated agent dir: `discoverAndLoadExtensions` defaults to the real
  // `getAgentDir()`, which would pull in whatever the developer has installed
  // globally and make this test machine-dependent.
  agentDir = mkdtempSync(join(tmpdir(), "repl-agentdir-"));

  // A scratch project with this repo installed the way a user would install it:
  // as a package directory under `<cwd>/.pi/extensions/`.
  projectDir = mkdtempSync(join(tmpdir(), "repl-project-"));
  mkdirSync(join(projectDir, ".pi", "extensions"), { recursive: true });
  symlinkSync(REPO_ROOT, join(projectDir, ".pi", "extensions", "repl-simple"));
});

after(() => {
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe("pi extension loading (real loader)", () => {
  it("loads the extension from the repo with no errors", async () => {
    const result = await discoverAndLoadExtensions([REPO_ROOT], REPO_ROOT, agentDir);

    assert.deepEqual(
      result.errors,
      [],
      `pi's loader reported errors: ${JSON.stringify(result.errors)}`,
    );

    const ours = result.extensions.filter((e) => e.resolvedPath === EXTENSION_PATH);
    assert.equal(
      ours.length,
      1,
      `expected repl-extension.ts to load exactly once, got ${ours.length}`,
    );
  });

  it("registers exactly the four repl tools", async () => {
    const result = await discoverAndLoadExtensions([REPO_ROOT], REPO_ROOT, agentDir);
    const ext = result.extensions.find((e) => e.resolvedPath === EXTENSION_PATH);
    assert.ok(ext, "repl-extension.ts did not load");

    // Assert the set, so a missing registration and an unexpected extra one
    // both fail.
    assert.deepEqual([...ext.tools.keys()].sort(), [...EXPECTED_TOOLS].sort());
  });

  // The realistic install shape, and the one the directory entry actually
  // breaks: pi discovers the package directory and reads its manifest.
  it("loads when installed as a project-local extension package", {
    skip: process.platform === "win32" ? "symlinks need privileges on Windows" : false,
  }, async () => {
    const result = await discoverAndLoadExtensions([], projectDir, agentDir);

    assert.deepEqual(
      result.errors,
      [],
      `pi's loader reported errors: ${JSON.stringify(result.errors)}`,
    );
    assert.equal(result.extensions.length, 1, "expected exactly one discovered extension");
    assert.deepEqual([...result.extensions[0].tools.keys()].sort(), [...EXPECTED_TOOLS].sort());
  });
});
