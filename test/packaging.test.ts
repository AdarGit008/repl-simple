import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
 *
 * Task 2 (#81) extends this: the tarball must ship `dist/`/`src/`/`repl/`/
 * `extensions/`/`LICENSE` and no tests/docs/plans; a scratch consumer must be
 * able to `import { ReplRunner } from "repl-simple"` and call
 * `getReplPreamble()` against the packed artifact, entirely offline; every
 * value export of `src/index.ts` must be reachable from the packed artifact.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(REPO_ROOT, "dist");

/**
 * A temp dir *inside* the repo (so Node's module resolution walks up to the
 * repo's own `node_modules` for `@pydantic/monty` — SPEC AS6, never the
 * registry), with the packed tarball extracted at
 * `<consumerDir>/node_modules/repl-simple/`.
 */
let consumerDir: string;
let packedPkgDir: string;

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

  // Pack for real (offline) and extract into a repo-internal node_modules.
  const packDest = mkdtempSync(join(tmpdir(), "repl-simple-pack-"));
  const pack = spawnSync("npm", ["pack", "--pack-destination", packDest], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(pack.status, 0, `npm pack failed:\n${pack.stdout ?? ""}\n${pack.stderr ?? ""}`);
  const tarball = join(packDest, "repl-simple-0.1.0.tgz");
  assert.ok(existsSync(tarball), `expected tarball at ${tarball}\npack output: ${pack.stdout}`);

  consumerDir = mkdtempSync(join(REPO_ROOT, ".tmp-consumer-"));
  packedPkgDir = join(consumerDir, "node_modules", "repl-simple");
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

/**
 * Value (runtime) export names declared in `src/index.ts`, excluding
 * `export type { … }` blocks and `type Foo` re-exports (which TypeScript erases
 * at runtime). Mirrors the shape of the file's export statements so a newly
 * added value export cannot silently become unreachable.
 */
function valueExportsOfIndex(): string[] {
  const src = readFileSync(join(REPO_ROOT, "src", "index.ts"), "utf8");
  const names: string[] = [];
  const re = /export\s+(type\s+)?\{([^}]*)\}\s*(?:from\s+"[^"]*")?\s*;/g;
  for (const m of src.matchAll(re)) {
    if (m[1] !== undefined) continue; // whole block is `export type { … }`
    for (const item of m[2].split(",")) {
      const trimmed = item.trim();
      if (trimmed === "") continue;
      if (/^type\s/.test(trimmed)) continue; // `type Foo` inside a mixed block
      // `Foo` (no `as` aliasing today; guard `Foo as Bar` defensively).
      names.push(
        trimmed
          .split(/\s+as\s+/)
          .pop()!
          .trim(),
      );
    }
  }
  return names;
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

describe("tarball contents (#81)", () => {
  it("ships dist/, src/, repl/, extensions/, and LICENSE", () => {
    const files = packFileList();
    for (const required of ["dist/", "src/", "repl/", "extensions/"]) {
      assert.ok(
        files.some((f) => f.startsWith(required)),
        `tarball must ship ${required} (got ${files.length} entries)`,
      );
    }
    assert.ok(files.includes("LICENSE"), "tarball must include LICENSE");
  });

  it("ships no test/, docs/, tasks/, SPEC.md, or plan-issue-9.md", () => {
    const files = packFileList();
    const forbidden = ["test/", "docs/", "tasks/", "SPEC.md", "plan-issue-9.md"];
    for (const bad of forbidden) {
      const found = files.filter((f) => f === bad || f.startsWith(bad));
      assert.deepEqual(found, [], `tarball must not ship ${bad}`);
    }
  });
});

describe("scratch consumer (offline, SPEC AS6)", () => {
  it("imports ReplRunner and calls getReplPreamble() from the packed artifact", () => {
    const script = [
      `import { ReplRunner } from "repl-simple";`,
      `import { getReplPreamble } from "repl-simple";`,
      `if (typeof ReplRunner !== "function") throw new Error("ReplRunner is not a function");`,
      `const preamble = getReplPreamble();`,
      `if (typeof preamble !== "string" || preamble.length === 0) throw new Error("preamble is empty");`,
      `if (!preamble.includes("context_preview")) throw new Error("preamble missing context_preview");`,
      `console.log("consumer-ok");`,
    ].join("\n");

    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: consumerDir,
      encoding: "utf8",
    });
    assert.equal(
      run.status,
      0,
      `consumer import failed:\n${run.stdout ?? ""}\n${run.stderr ?? ""}`,
    );
    assert.ok(run.stdout.includes("consumer-ok"), "consumer did not print its success marker");
  });
});

describe("export reachability", () => {
  it("every value export of src/index.ts is reachable from the packed artifact", async () => {
    const pkg = await import(pathToFileURL(join(packedPkgDir, "dist", "index.js")).href);
    const expected = valueExportsOfIndex();
    assert.ok(expected.length > 0, "expected value exports in src/index.ts");
    for (const name of expected) {
      assert.ok(name in pkg, `export "${name}" is missing from the packed dist/index.js`);
      assert.notEqual(
        pkg[name as keyof typeof pkg],
        undefined,
        `export "${name}" is undefined in the packed dist/index.js`,
      );
    }
  });
});

describe("manifest", () => {
  it("engines.node matches .nvmrc", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    const nvmrc = readFileSync(join(REPO_ROOT, ".nvmrc"), "utf8").trim();
    assert.equal(pkg.engines?.node, `>=${nvmrc}`);
  });
});
