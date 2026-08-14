import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { HostToolError } from "./types.js";

// ── Path jail ────────────────────────────────────────────────────

/**
 * The one path jail.
 *
 * Two callers confine two different sets of tools to the same root:
 * `builtins.ts` for `read_file` / `list_files`, and `bridge.ts` for pi's
 * `read` / `grep` / `find` / `ls`. They differ only in the options below.
 * There is deliberately no second implementation — the version that is not
 * exercised is the one that ends up wrong, and this one is the reason
 * `read_file` held against absolute paths, `..` and symlinks while the
 * bridged `read` next to it in the same registry read anything on the host
 * (#43).
 */
export interface PathJailOptions {
  /**
   * Accept an absolute path that lands inside the root, rather than refusing
   * every absolute path outright. Pi's tools document their `path` as
   * "relative or absolute", so the bridge sets this; the sandbox builtins
   * take relative paths only and leave it off.
   */
  allowAbsolute?: boolean;
  /**
   * Require the path to exist, and refuse with `FileNotFoundError` when it
   * does not. Off means a path that does not exist yet is still checked —
   * against the nearest ancestor that *does* exist, so it cannot be a way
   * out — and then returned unresolved for the caller to fail on in its own
   * words.
   */
  mustExist?: boolean;
}

export interface PathJail {
  /** The absolute, resolved root. Every returned path is inside it. */
  readonly root: string;
  /**
   * Resolve `path` against the root and return the absolute path to use.
   *
   * The returned path is canonical whenever the target exists, which is what
   * makes this check authoritative rather than advisory: hand the result to
   * a downstream tool and that tool's own path handling — `~`, `file://`,
   * `@` prefixes, unicode spaces — has nothing left to do.
   *
   * @throws HostToolError `PermissionError` outside the root, `FileNotFoundError`
   *   when `mustExist` and it does not, `OSError` when the filesystem refuses.
   */
  resolve(path: string): Promise<string>;
}

/** Refusals say *why*, so the model adapts instead of retrying the same path. */
function outsideRoot(path: string, root: string): HostToolError {
  return new HostToolError(
    "PermissionError",
    `'${path}' is outside the project root '${root}'; ` +
      "reads cannot leave it. Anything outside needs a gated bash call.",
  );
}

export function createPathJail(rootPath: string, options: PathJailOptions = {}): PathJail {
  const root = resolve(rootPath);
  const allowAbsolute = options.allowAbsolute ?? false;
  const mustExist = options.mustExist ?? true;

  /** Inside, or the root itself — never merely sharing its prefix. */
  function contains(candidate: string, container: string): boolean {
    return candidate === container || candidate.startsWith(container + sep);
  }

  /**
   * The nearest ancestor that exists, canonicalised.
   *
   * A path that does not exist has no `realpath`, so a symlinked parent would
   * go unchecked. Walking up finds the deepest link that *can* be followed,
   * which is the one an escape would have to go through.
   */
  async function realExistingAncestor(path: string): Promise<string> {
    for (let current = path; ; ) {
      try {
        return await realpath(current);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          throw new HostToolError("OSError", String((e as Error).message));
        }
      }
      const parent = dirname(current);
      // The filesystem root always exists, so this terminates before it.
      if (parent === current) throw new HostToolError("OSError", `cannot resolve '${path}'`);
      current = parent;
    }
  }

  return {
    root,

    async resolve(path: string): Promise<string> {
      if (isAbsolute(path) && !allowAbsolute) {
        throw new HostToolError("PermissionError", `absolute paths are not allowed: '${path}'`);
      }

      // Cheap check first: it rejects `..` and absolute escapes without
      // touching the filesystem. It is not sufficient on its own — a symlink
      // inside the root passes it — which is what the realpath check below is
      // for.
      const resolved = resolve(root, path);
      if (!contains(resolved, root)) throw outsideRoot(path, root);

      const realRoot = await realpath(root);

      let real: string;
      try {
        real = await realpath(resolved);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          throw new HostToolError("OSError", String((e as Error).message));
        }
        if (mustExist) {
          throw new HostToolError("FileNotFoundError", `no such file or directory: '${path}'`);
        }
        // Does not exist — check what it would be created under, then hand
        // back the uncanonicalised path so the caller reports the miss.
        if (!contains(await realExistingAncestor(resolved), realRoot)) {
          throw outsideRoot(path, root);
        }
        return resolved;
      }

      if (!contains(real, realRoot)) throw outsideRoot(path, root);
      return real;
    },
  };
}
