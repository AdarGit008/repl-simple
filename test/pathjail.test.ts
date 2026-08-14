import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createPathJail } from "../src/pathjail.js";
import { HostToolError } from "../src/types.js";

// ── Fixtures ────────────────────────────────────────────────────

let root: string;
let outside: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "repl-jail-root-"));
  outside = await mkdtemp(join(tmpdir(), "repl-jail-outside-"));

  await writeFile(join(outside, "secret.txt"), "secret\n");
  await writeFile(join(root, "file.txt"), "contents\n");
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub", "nested.txt"), "nested\n");

  await symlink(join(outside, "secret.txt"), join(root, "escape-link"));
  await symlink(outside, join(root, "escape-dir"));
  await symlink(join(root, "sub"), join(root, "inside-dir"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** Assert a rejection carries the given Python type, and say why on failure. */
async function assertRejects(
  promise: Promise<unknown>,
  pythonType: string,
  message: string,
): Promise<HostToolError> {
  try {
    const value = await promise;
    assert.fail(`${message}: expected ${pythonType}, resolved to '${value}'`);
  } catch (e) {
    assert.ok(e instanceof HostToolError, `${message}: expected HostToolError, got ${e}`);
    assert.equal((e as HostToolError).pythonType, pythonType, message);
    return e as HostToolError;
  }
}

// ── Escapes ─────────────────────────────────────────────────────

describe("createPathJail — escapes", () => {
  it("refuses '..' traversal", async () => {
    const jail = createPathJail(root);
    await assertRejects(jail.resolve("../etc/passwd"), "PermissionError", "traversal");
    await assertRejects(jail.resolve("sub/../../elsewhere"), "PermissionError", "traversal");
  });

  it("refuses absolute paths, and says so", async () => {
    const jail = createPathJail(root);
    const e = await assertRejects(jail.resolve("/etc/passwd"), "PermissionError", "absolute");
    assert.match(e.message, /absolute paths are not allowed/);
  });

  it("refuses a symlink that leaves the root", async () => {
    // The prefix check passes here — 'escape-link' is inside the root as a
    // string. Only realpath catches it.
    const jail = createPathJail(root);
    await assertRejects(jail.resolve("escape-link"), "PermissionError", "symlinked file");
    await assertRejects(jail.resolve("escape-dir"), "PermissionError", "symlinked dir");
    await assertRejects(jail.resolve("escape-dir/secret.txt"), "PermissionError", "through a link");
  });

  it("refuses a sibling whose name merely starts with the root", async () => {
    // '/tmp/xyz-evil' is not inside '/tmp/xyz', and a startsWith() without the
    // separator says it is.
    const sibling = `${root}-evil`;
    await mkdir(sibling);
    try {
      await writeFile(join(sibling, "f.txt"), "x");
      const jail = createPathJail(root, { allowAbsolute: true });
      await assertRejects(
        jail.resolve(join(sibling, "f.txt")),
        "PermissionError",
        "prefix sibling",
      );
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it("says why, so the model can adapt", async () => {
    const jail = createPathJail(root);
    const e = await assertRejects(jail.resolve("escape-link"), "PermissionError", "message");
    assert.match(e.message, /outside the project root/);
    assert.match(e.message, /bash/, "the escape hatch is worth naming");
  });
});

// ── Ordinary use ────────────────────────────────────────────────

describe("createPathJail — inside the root", () => {
  it("resolves a relative path to its canonical form", async () => {
    const jail = createPathJail(root);
    const real = await jail.resolve("file.txt");
    assert.equal(real, join(await realRoot(), "file.txt"));
  });

  it("resolves the root itself", async () => {
    const jail = createPathJail(root);
    assert.equal(await jail.resolve("."), await realRoot());
  });

  it("follows a symlink that stays inside", async () => {
    const jail = createPathJail(root);
    assert.equal(
      await jail.resolve("inside-dir/nested.txt"),
      join(await realRoot(), "sub/nested.txt"),
    );
  });

  it("works when the root is itself reached through a symlink", async () => {
    // macOS hands out `/var/folders/…` for a temp dir whose real path is
    // `/private/var/folders/…`, so the root and its canonical form differ and
    // a prefix check against only one of them refuses the root's own files.
    // Reproduced here on every platform rather than left to the macOS leg.
    const linkedRoot = join(outside, "root-link");
    await symlink(root, linkedRoot);
    const jail = createPathJail(linkedRoot, { allowAbsolute: true });

    assert.equal(await jail.resolve("file.txt"), join(await realRoot(), "file.txt"));
    assert.equal(
      await jail.resolve(join(await realRoot(), "file.txt")),
      join(await realRoot(), "file.txt"),
      "an already-canonical path must not be refused entry to its own root",
    );
    await assertRejects(jail.resolve("escape-link"), "PermissionError", "still jailed");
  });

  it("accepts an absolute in-root path only when allowed", async () => {
    const absolute = join(root, "file.txt");
    await assertRejects(createPathJail(root).resolve(absolute), "PermissionError", "default");
    assert.equal(
      await createPathJail(root, { allowAbsolute: true }).resolve(absolute),
      join(await realRoot(), "file.txt"),
    );
  });
});

// ── Paths that are not there ────────────────────────────────────

describe("createPathJail — missing paths", () => {
  it("refuses with FileNotFoundError by default", async () => {
    const jail = createPathJail(root);
    await assertRejects(jail.resolve("nope.txt"), "FileNotFoundError", "missing");
    await assertRejects(jail.resolve("sub/nope/deeper.txt"), "FileNotFoundError", "missing chain");
  });

  it("mustExist: false returns the path for the caller to fail on", async () => {
    const jail = createPathJail(root, { mustExist: false });
    assert.equal(await jail.resolve("nope.txt"), join(resolve(root), "nope.txt"));
  });

  it("walks up past a non-directory to the ancestor that exists", async () => {
    // 'file.txt/child' is ENOTDIR, not ENOENT. Both mean "not there", and a
    // walk that only handled ENOENT would fall through to the loop guard.
    const jail = createPathJail(root, { mustExist: false });
    assert.equal(await jail.resolve("file.txt/child"), join(resolve(root), "file.txt/child"));
  });

  it("reports a filesystem refusal as OSError, not as an escape", async () => {
    // A symlink loop is neither missing nor outside: realpath gives ELOOP.
    // Calling that PermissionError would tell the model its path was banned
    // when the truth is that the filesystem cannot answer.
    await symlink(join(root, "loop"), join(root, "loop"));
    try {
      await assertRejects(createPathJail(root).resolve("loop"), "OSError", "symlink loop");
      await assertRejects(
        createPathJail(root, { mustExist: false }).resolve("loop"),
        "OSError",
        "symlink loop, mustExist off",
      );
    } finally {
      await rm(join(root, "loop"), { force: true });
    }
  });

  it("mustExist: false still checks the ancestor a missing path hangs off", async () => {
    // The check that a prefix test would skip: the path does not exist, so it
    // has no realpath of its own, and its parent is the link out.
    const jail = createPathJail(root, { mustExist: false });
    await assertRejects(
      jail.resolve("escape-dir/not-there.txt"),
      "PermissionError",
      "missing under a symlinked parent",
    );
  });
});

/** The root as the filesystem sees it — /tmp is a symlink on macOS. */
async function realRoot(): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(root);
}
