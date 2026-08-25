import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One offline build + pack + extract fixture shared by packaging.test.ts and
 * readme.test.ts (F4).
 *
 * `node:test` runs test files concurrently, and both files used to `rm -rf`
 * the same `dist/` then `npm run build` + `npm pack` against it — two
 * processes deleting each other's build mid-run. Each caller now gets its own
 * private staging dir (built via `tsc --outDir`), so no two test files ever
 * touch the same directory.
 *
 * The scratch consumer lives in the OS temp dir (OUTSIDE the repo tree), not
 * inside it. package.json declares `"name": "repl-simple"` plus `"exports"`,
 * which enables Node package self-reference: any module under the repo tree
 * doing `import "repl-simple"` resolves to the repo's OWN `dist/index.js`
 * (via `exports`) and never touches `node_modules/repl-simple`. In CI the repo
 * `dist/` is never built (this fixture builds into a private `--outDir`), so a
 * repo-internal consumer self-references a missing module. Keeping the
 * consumer in tmpdir disables self-reference entirely — the bare specifier must
 * resolve through `node_modules`. Offline resolution of the packed package's
 * runtime deps is restored by mirroring the repo's own `node_modules` into the
 * consumer (SPEC AS6 — never the registry).
 */

/** Repo root, relative to this module (`test/support/`). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface PackFixture {
  /** Staging dir `npm pack` runs from (package.json + everything `files` ships). */
  pkgDir: string;
  /** The built `dist/` inside `pkgDir` (flat, mirrors `src/`). */
  dist: string;
  /**
   * Scratch consumer dir in the OS temp dir (OUTSIDE the repo package tree),
   * tarball extracted at node_modules/repl-simple. The repo's own node_modules
   * is mirrored into it so the packed package's runtime deps (monty via
   * @pydantic, and @earendil-works/pi-coding-agent) resolve offline (SPEC AS6).
   */
  consumerDir: string;
  /** The extracted package root (`<consumerDir>/node_modules/repl-simple`). */
  packedPkgDir: string;
  /** Remove every temp dir this fixture created. */
  cleanup: () => void;
}

/**
 * Build the package into a private temp dir, pack it offline, and extract the
 * tarball into a tmpdir consumer OUTSIDE the repo tree so the bare
 * `repl-simple` specifier resolves through `node_modules` (never via package
 * self-reference to an in-tree build). Offline resolution of the packed
 * package's runtime deps is restored by mirroring the repo's own node_modules
 * into the consumer (SPEC AS6 — never the registry).
 */
export function createPackFixture(tag: string): PackFixture {
  const tmpRoot = mkdtempSync(join(tmpdir(), `repl-simple-${tag}-`));
  const pkgDir = join(tmpRoot, "pkg");
  mkdirSync(pkgDir, { recursive: true });

  // Stage the manifest and everything the `files` allowlist ships. `dist/` is
  // built into the staging dir below; src/repl/extensions are copied verbatim
  // so the packed package is complete and self-contained.
  for (const file of ["package.json", "README.md", "LICENSE", "NOTICE"]) {
    cpSync(join(REPO_ROOT, file), join(pkgDir, file));
  }
  for (const dir of ["src", "repl", "extensions"]) {
    cpSync(join(REPO_ROOT, dir), join(pkgDir, dir), { recursive: true });
  }

  const dist = join(pkgDir, "dist");
  // `--outDir` overrides tsconfig's `outDir`, so the build lands in *this*
  // fixture's staging dir — never the repo's shared `dist/`.
  const build = spawnSync("npm", ["run", "build", "--", "--outDir", dist], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(
    build.status,
    0,
    `npm run build failed:\n${build.stdout ?? ""}\n${build.stderr ?? ""}`,
  );

  // Pack the staged copy (offline) into a private destination.
  const packDest = mkdtempSync(join(tmpdir(), `repl-simple-${tag}-pack-`));
  const pack = spawnSync("npm", ["pack", "--pack-destination", packDest], {
    cwd: pkgDir,
    encoding: "utf8",
  });
  assert.equal(pack.status, 0, `npm pack failed:\n${pack.stdout ?? ""}\n${pack.stderr ?? ""}`);
  const tarballs = readdirSync(packDest).filter((f) => f.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, `expected exactly one tarball, got: ${tarballs.join(", ")}`);
  const tarball = join(packDest, tarballs[0]);
  assert.ok(existsSync(tarball), `expected tarball at ${tarball}`);

  // Extract into a tmpdir consumer OUTSIDE the repo tree. Keeping the consumer
  // inside the repo would make the bare `repl-simple` import self-reference the
  // repo's own `dist/index.js` (via `exports` + `name`), which in CI doesn't
  // exist — so the test would pass locally only because the repo `dist/` was
  // already built. In tmpdir the specifier must resolve through node_modules.
  const consumerDir = mkdtempSync(join(tmpdir(), `repl-simple-${tag}-consumer-`));
  const nodeModulesDir = join(consumerDir, "node_modules");
  mkdirSync(nodeModulesDir, { recursive: true });
  const packedPkgDir = join(nodeModulesDir, "repl-simple");
  mkdirSync(packedPkgDir, { recursive: true });

  const extract = spawnSync("tar", ["-xzf", tarball, "-C", packedPkgDir, "--strip-components=1"], {
    encoding: "utf8",
  });
  assert.equal(
    extract.status,
    0,
    `tar extract failed:\n${extract.stdout ?? ""}\n${extract.stderr ?? ""}`,
  );

  // Offline dependency resolution (SPEC AS6 — never the registry). The packed
  // package's compiled `dist/` imports @pydantic/monty (via the @pydantic scope)
  // AND @earendil-works/pi-coding-agent (a runtime value import in
  // dist/bridge.js) plus that package's dependency tree. Rather than enumerate
  // every transitive package, mirror the repo's own node_modules — the single
  // offline install — into the consumer. The repo node_modules does NOT contain
  // `repl-simple` (it is the package itself), so the packed package extracted
  // above is never shadowed; and since the consumer lives OUTSIDE the repo tree,
  // package self-reference stays impossible. The @pydantic scope (monty + its
  // @pydantic/* platform binaries) is included in this mirror.
  const repoNodeModules = join(REPO_ROOT, "node_modules");
  const consumerNodeModules = join(consumerDir, "node_modules");
  for (const entry of readdirSync(repoNodeModules)) {
    const from = join(repoNodeModules, entry);
    const to = join(consumerNodeModules, entry);
    if (existsSync(to)) continue;
    let isDir = false;
    try {
      isDir = statSync(from).isDirectory();
    } catch {
      isDir = false;
    }
    symlinkSync(from, to, isDir ? "dir" : "file");
  }

  rmSync(packDest, { recursive: true, force: true });

  return {
    pkgDir,
    dist,
    consumerDir,
    packedPkgDir,
    cleanup: () => {
      rmSync(tmpRoot, { recursive: true, force: true });
      rmSync(consumerDir, { recursive: true, force: true });
    },
  };
}
