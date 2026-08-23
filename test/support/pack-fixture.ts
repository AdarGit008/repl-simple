import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
 */

/** Repo root, relative to this module (`test/support/`). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface PackFixture {
  /** Staging dir `npm pack` runs from (package.json + everything `files` ships). */
  pkgDir: string;
  /** The built `dist/` inside `pkgDir` (flat, mirrors `src/`). */
  dist: string;
  /** Scratch consumer dir inside the repo, tarball extracted at node_modules/repl-simple. */
  consumerDir: string;
  /** The extracted package root (`<consumerDir>/node_modules/repl-simple`). */
  packedPkgDir: string;
  /** Remove every temp dir this fixture created. */
  cleanup: () => void;
}

/**
 * Build the package into a private temp dir, pack it offline, and extract the
 * tarball into a repo-internal consumer so Node resolves `@pydantic/monty`
 * from the repo's own `node_modules` (SPEC AS6 — never the registry).
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

  // Extract into a repo-internal node_modules so the scratch consumer can
  // resolve `@pydantic/monty` up the tree (SPEC AS6).
  const consumerDir = mkdtempSync(join(REPO_ROOT, `.tmp-${tag}-consumer-`));
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
