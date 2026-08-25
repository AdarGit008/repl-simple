import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPiBridgeTools } from "../src/bridge.js";
import { createBuiltinTools } from "../src/builtins.js";
import { createToolStoreTools } from "../src/toolstore.js";
import { createRLMTools } from "../src/rlm_tools.js";
import { createPackFixture, REPO_ROOT, type PackFixture } from "./support/pack-fixture.js";

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
 * 3. The README's "REPL (direct)" and "RLM Loop" tables must match the tools
 *    the extension registers and the tools `createRLMTools` registers (F3).
 * 4. `npm pack` must include LICENSE and NOTICE, and NOTICE must actually
 *    credit the two upstreams and the whitepaper (F8).
 */

/**
 * Populated by `createPackFixture` in `before`: the private staging package and
 * the tmpdir consumer dir the tarball is extracted into (so `repl-simple`
 * resolves offline via the packed artifact and not via package self-reference —
 * SPEC AS6, never the registry). Same fixture as packaging.test.ts, each in its
 * own private temp dir so the two files (run concurrently by `node:test`)
 * never `rm -rf` the same directory (F4).
 */
let fixture: PackFixture;
let pkgDir: string;
let consumerDir: string;

before(() => {
  fixture = createPackFixture("readme");
  pkgDir = fixture.pkgDir;
  consumerDir = fixture.consumerDir;
});

after(() => {
  fixture?.cleanup();
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

/**
 * The top-level tools the extension registers. Source of truth: the same list
 * `test/extension-loader.test.ts` pins (`EXPECTED_TOOLS`), which drives pi's
 * real loader — that test fails if the extension registers anything else, so
 * this list is a faithful proxy for the real registration.
 */
const REPL_TOP_LEVEL_TOOLS = ["repl", "repl_resume", "repl_reset", "repl_abandon"];

/** Tool names in the first markdown table under the README `heading` section. */
function readmeTableToolNames(src: string, heading: string): string[] {
  const start = src.indexOf(heading);
  assert.ok(start >= 0, `README missing section '${heading}'`);
  const nextHeading = src.indexOf("\n### ", start + heading.length);
  const section = nextHeading >= 0 ? src.slice(start, nextHeading) : src.slice(start);

  const names: string[] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const match = line.match(/^\|\s*`([^`(]+)/);
    if (match) names.push(match[1].trim());
  }
  assert.ok(names.length > 0, `README section '${heading}' has no documented tools`);
  return names;
}

/** The RLM host tool names `createRLMTools` registers (what `runRlm` exposes). */
function rlmRegisteredToolNames(): string[] {
  return createRLMTools({
    onLLMQuery: async () => "",
    onRLMQuery: async () => "",
  }).map((tool) => tool.name);
}

/** Paths `npm pack --dry-run --json` reports the tarball would contain. */
function packFileList(): string[] {
  const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: pkgDir,
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
      `console.log("resolved:" + import.meta.resolve("repl-simple"));`,
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

    // Prove the bare specifier resolved the PACKED artifact, not the repo's own
    // dist via package self-reference (the consumer now lives in tmpdir and
    // cannot self-reference the repo tree).
    const resolvedLine = run.stdout.split("\n").find((l) => l.startsWith("resolved:"));
    assert.ok(resolvedLine, 'consumer did not report import.meta.resolve("repl-simple")');
    const resolved = resolvedLine.slice("resolved:".length);
    assert.ok(
      resolved.startsWith(pathToFileURL(join(consumerDir, "node_modules", "repl-simple")).href),
      `bare "repl-simple" must resolve under the packed consumer (${resolved}), not the repo`,
    );
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

  it("the README 'REPL (direct)' table matches the registered top-level tools (F3)", () => {
    assert.deepEqual(
      readmeTableToolNames(readme(), "### REPL (direct)"),
      REPL_TOP_LEVEL_TOOLS,
      "README 'REPL (direct)' table drifted from the extension's registered tools",
    );
  });

  it("the README 'RLM Loop' table matches the tools runRlm registers (F3)", () => {
    assert.deepEqual(
      readmeTableToolNames(readme(), "### RLM Loop (auto-investigation)"),
      rlmRegisteredToolNames(),
      "README 'RLM Loop' table drifted from createRLMTools",
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

  it("NOTICE credits the two upstreams and the whitepaper (F8)", () => {
    const notice = readFileSync(join(REPO_ROOT, "NOTICE"), "utf8");
    for (const required of ["pi-reepl", "pi-code-tool", "arXiv", "2512.24601"]) {
      assert.ok(
        notice.includes(required),
        `NOTICE must credit "${required}" (upstream attribution)`,
      );
    }
  });
});
