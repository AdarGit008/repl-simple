import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiBridgeTools } from "../src/bridge.js";
import { createBuiltinTools } from "../src/builtins.js";
import { createToolStoreTools } from "../src/toolstore.js";

/**
 * Task 3 (#82): the README must describe the API that actually ships, and the
 * package must carry the third-party attribution.
 *
 * 1. The `import { … } from "repl-simple"` block in README.md must run against
 *    the *built* package (offline, SPEC AS6), with every imported name
 *    resolving to a defined value.
 * 2. The tool names in the README's "Available Python-side tools" section must
 *    be exactly the tools the code registers — derived from the same creators
 *    the code uses (`createPiBridgeTools` / `createBuiltinTools` /
 *    `createToolStoreTools`), so a drift in either direction breaks.
 * 3. `npm pack` must include LICENSE and NOTICE.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Temp dir *inside* the repo (so Node's module resolution walks up to the
 * repo's own `node_modules` — SPEC AS6, never the registry), with the packed
 * tarball extracted at `<consumerDir>/node_modules/repl-simple/`. Same pattern
 * as packaging.test.ts.
 */
let consumerDir: string;

before(() => {
  rmSync(join(REPO_ROOT, "dist"), { recursive: true, force: true });

  const build = spawnSync("npm", ["run", "build"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(
    build.status,
    0,
    `npm run build failed:\n${build.stdout ?? ""}\n${build.stderr ?? ""}`,
  );

  const packDest = mkdtempSync(join(tmpdir(), "repl-simple-readme-pack-"));
  const pack = spawnSync("npm", ["pack", "--pack-destination", packDest], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(pack.status, 0, `npm pack failed:\n${pack.stdout ?? ""}\n${pack.stderr ?? ""}`);
  const tarball = join(packDest, "repl-simple-0.1.0.tgz");
  assert.ok(existsSync(tarball), `expected tarball at ${tarball}\npack output: ${pack.stdout}`);

  consumerDir = mkdtempSync(join(REPO_ROOT, ".tmp-readme-consumer-"));
  const packedPkgDir = join(consumerDir, "node_modules", "repl-simple");
  mkdirSync(packedPkgDir, { recursive: true });

  const extract = spawnSync("tar", ["-xzf", tarball, "-C", packedPkgDir, "--strip-components=1"], {
    encoding: "utf8",
  });
  assert.equal(
    extract.status,
    0,
    `tar extract failed:\n${extract.stdout ?? ""}\n${extract.stderr ?? ""}`,
  );

  rmSync(packDest, { recursive: true, force: true });
});

after(() => {
  if (consumerDir) rmSync(consumerDir, { recursive: true, force: true });
});

function readme(): string {
  return readFileSync(join(REPO_ROOT, "README.md"), "utf8");
}

/**
 * The `import { … } from "repl-simple";` statement, verbatim, from README.md.
 */
function extractImportStatement(src: string): string {
  const start = src.indexOf("import {");
  assert.ok(start >= 0, 'README must contain an `import { … } from "repl-simple"` block');
  const endMarker = '} from "repl-simple";';
  const end = src.indexOf(endMarker, start);
  assert.ok(end >= 0, `README import block must close with ${endMarker}`);
  return src.slice(start, end + endMarker.length);
}

/**
 * The bare names the README import block binds (no `as`/`type` today). Line
 * comments are stripped so `ReplRunner, // new ReplRunner(...)` yields
 * `ReplRunner`.
 */
function importedNames(importStmt: string): string[] {
  const inner = importStmt
    .replace(/^import\s*\{\s*/, "")
    .replace(/\}\s*from\s+"repl-simple";\s*$/, "")
    .replace(/\/\/[^\n]*/g, "");
  return inner
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** The tool names documented in README's "Available Python-side tools" section. */
function readmeToolLists(src: string): {
  bridge: string[];
  builtins: string[];
  toolstore: string[];
} {
  const start = src.indexOf("### Available Python-side tools");
  assert.ok(start >= 0, "README missing '### Available Python-side tools' section");
  const end = src.indexOf("\n### ", start);
  const section = end >= 0 ? src.slice(start, end) : src.slice(start);

  const extract = (label: string): string[] => {
    const line = section.split("\n").find((l) => l.startsWith(`**${label}:**`));
    assert.ok(line, `README 'Available Python-side tools' section missing the '${label}' line`);
    return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  };

  return {
    bridge: extract("Pi bridge"),
    builtins: extract("Builtins"),
    toolstore: extract("Tool store"),
  };
}

/** The tool names the code actually registers, from the same creators it uses. */
function registeredToolNames(): {
  bridge: string[];
  builtins: string[];
  toolstore: string[];
} {
  return {
    bridge: createPiBridgeTools(REPO_ROOT).map((tool) => tool.name),
    builtins: createBuiltinTools({ root: REPO_ROOT }).map((tool) => tool.name),
    toolstore: createToolStoreTools({ root: REPO_ROOT }).map((tool) => tool.name),
  };
}

/** Paths `npm pack --dry-run --json` reports the tarball would contain. */
function packFileList(): string[] {
  const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(
    pack.status,
    0,
    `npm pack --dry-run failed:\n${pack.stdout ?? ""}\n${pack.stderr ?? ""}`,
  );
  const parsed = JSON.parse(pack.stdout) as
    | { files: { path: string }[] }[]
    | { files: { path: string }[] };
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return entry.files.map((f) => f.path);
}

describe("README truth (#82)", () => {
  it("the README import block runs against the built package with every name defined", () => {
    const importStmt = extractImportStatement(readme());
    const names = importedNames(importStmt);
    assert.ok(names.length > 0, "README import block must import at least one name");

    const script = [
      importStmt,
      `const __exports = { ${names.join(", ")} };`,
      `for (const [name, value] of Object.entries(__exports)) {`,
      `  if (value === undefined) throw new Error("README import '" + name + "' is undefined at runtime");`,
      `}`,
      `console.log("readme-import-ok:" + ${JSON.stringify(names.length)});`,
    ].join("\n");

    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: consumerDir,
      encoding: "utf8",
    });
    assert.equal(
      run.status,
      0,
      `README import block failed:\n${run.stdout ?? ""}\n${run.stderr ?? ""}`,
    );
    assert.ok(run.stdout.includes("readme-import-ok"), "consumer did not print its success marker");
  });

  it("the README tool lists exactly match the tools the code registers", () => {
    const documented = readmeToolLists(readme());
    const registered = registeredToolNames();
    assert.deepEqual(
      documented.bridge,
      registered.bridge,
      "README 'Pi bridge' list drifted from createPiBridgeTools",
    );
    assert.deepEqual(
      documented.builtins,
      registered.builtins,
      "README 'Builtins' list drifted from createBuiltinTools",
    );
    assert.deepEqual(
      documented.toolstore,
      registered.toolstore,
      "README 'Tool store' list drifted from createToolStoreTools",
    );
  });

  it("npm pack includes LICENSE and NOTICE", () => {
    const files = packFileList();
    assert.ok(files.includes("LICENSE"), "tarball must include LICENSE");
    assert.ok(
      files.includes("NOTICE"),
      "tarball must include NOTICE — add it to package.json `files` (npm does not auto-include it)",
    );
  });
});
