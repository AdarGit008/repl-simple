import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { requireString } from "./registry.js";
import {
  Truncator,
  decodeWhole,
  VALUE_HEAD_RATIO,
  HEAD_ONLY_RATIO,
  FILE_RECOVERY,
  HTTP_RECOVERY,
} from "./truncate.js";
import { HostToolError } from "./types.js";
import type { HostTool } from "./types.js";

// ── Options ──────────────────────────────────────────────────────

export interface BuiltinToolsOptions {
  /** Workspace root; file tools cannot escape it. */
  root: string;
  /** Include the read_file tool. Disable when a workspace mount replaces it. Default true. */
  readFile?: boolean;
  /** Include the list_files tool. Disable when pi's bridged `ls` replaces it. Default true. */
  listFiles?: boolean;
  /** Cap on returned file bytes; longer files are truncated. Default 256 KiB. */
  maxFileBytes?: number;
  /** Cap on returned HTTP body bytes. Default 256 KiB. */
  maxHttpBytes?: number;
  /** Injectable fetch (tests). Default: global fetch. */
  fetchImpl?: typeof fetch;
}

// ── Constants ────────────────────────────────────────────────────

/**
 * These tools return a value *into the sandbox*, not into the model's context:
 * the model may read a file and process it in Python without ever displaying
 * it. So this is a data-safety ceiling, deliberately far above the 48 KiB
 * `stdout` + `output` budget that governs what actually reaches the model —
 * truncating here corrupts data, truncating there only shortens a view.
 */
const DEFAULT_MAX_BYTES = 256 * 1024;

// ── Private helpers ──────────────────────────────────────────────

/**
 * Read a file into the shared truncator, head + tail.
 *
 * `stat` gives the true size, so the marker can state what was dropped without
 * reading the middle: two seeks are enough. Both reads are decoded with
 * `decodeWhole`, because a byte offset chosen by arithmetic lands wherever it
 * lands — cutting a character there is what produced U+FFFD before (M5).
 */
async function readUtf8FileLimited(
  path: string,
  maxBytes: number,
): Promise<string> {
  const size = (await stat(path)).size;
  const handle = await open(path, "r");
  try {
    if (size <= maxBytes) {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    }

    const out = new Truncator({
      maxBytes,
      headRatio: VALUE_HEAD_RATIO,
      recovery: FILE_RECOVERY,
      totalBytes: size,
    });
    const segment = Math.max(1, Math.ceil(maxBytes * VALUE_HEAD_RATIO)) + 8;

    const headBuf = Buffer.alloc(segment);
    const head = await handle.read(headBuf, 0, segment, 0);
    out.push(decodeWhole(headBuf.subarray(0, head.bytesRead)));

    const tailFrom = Math.max(head.bytesRead, size - segment);
    const tailBuf = Buffer.alloc(size - tailFrom);
    const tail = await handle.read(tailBuf, 0, tailBuf.length, tailFrom);
    out.push(decodeWhole(tailBuf.subarray(0, tail.bytesRead)));

    return out.render();
  } finally {
    await handle.close();
  }
}

async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  // Head-only, and the total is left unknown: the read stops just past the
  // budget rather than draining an arbitrarily large body to measure it.
  // Keeping a tail would mean downloading all of it, and inventing a total
  // would break the "counters are true" invariant.
  const out = new Truncator({
    maxBytes,
    headRatio: HEAD_ONLY_RATIO,
    recovery: HTTP_RECOVERY,
    unknownTotal: true,
  });
  // One byte past the ceiling, so an over-long body actually overflows the
  // truncator rather than landing exactly on its budget and looking whole.
  const scanLimit = maxBytes + 1;

  const reader = response.body?.getReader();
  if (!reader) {
    out.push(await response.text());
    return out.render();
  }

  const chunks: Uint8Array[] = [];
  let collected = 0;
  let stopped = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value ?? new Uint8Array();
      const remaining = scanLimit - collected;
      if (chunk.byteLength >= remaining) {
        chunks.push(chunk.subarray(0, remaining));
        stopped = true;
        break;
      }
      chunks.push(chunk);
      collected += chunk.byteLength;
    }
  } finally {
    if (stopped) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  out.push(decodeWhole(Buffer.concat(chunks)));
  return out.render();
}

// ── createBuiltinTools ───────────────────────────────────────────

/**
 * Starter host tools: read_file / list_files (rooted, escape-proof) and
 * http_get (host-side fetch — the sandbox itself has no network access).
 */
export function createBuiltinTools(
  options: BuiltinToolsOptions,
): HostTool[] {
  const root = resolve(options.root);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_BYTES;
  const maxHttpBytes = options.maxHttpBytes ?? DEFAULT_MAX_BYTES;
  const fetchImpl = options.fetchImpl ?? fetch;

  // Resolves a sandbox-relative path and rejects anything outside the root,
  // including symlink escapes.
  async function resolveInRoot(relPath: string): Promise<string> {
    if (isAbsolute(relPath)) {
      throw new HostToolError(
        "PermissionError",
        `absolute paths are not allowed: '${relPath}'`,
      );
    }
    const resolved = resolve(root, relPath);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new HostToolError(
        "PermissionError",
        `path escapes the workspace root: '${relPath}'`,
      );
    }
    let real: string;
    try {
      real = await realpath(resolved);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new HostToolError(
          "FileNotFoundError",
          `no such file or directory: '${relPath}'`,
        );
      }
      throw new HostToolError("OSError", String((e as Error).message));
    }
    const realRoot = await realpath(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new HostToolError(
        "PermissionError",
        `path escapes the workspace root: '${relPath}'`,
      );
    }
    return real;
  }

  const readFileTool: HostTool = {
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    params: [
      {
        name: "path",
        type: "str",
        description: "Path relative to the workspace root.",
      },
    ],
    returns: "str",
    async execute(args) {
      const path = requireString(args.path, "path");
      const real = await resolveInRoot(path);
      try {
        return await readUtf8FileLimited(real, maxFileBytes);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "EISDIR") {
          throw new HostToolError(
            "IsADirectoryError",
            `is a directory: '${path}'`,
          );
        }
        throw new HostToolError("OSError", err.message);
      }
    },
  };

  const listFilesTool: HostTool = {
    name: "list_files",
    description:
      'List directory entries in the workspace. Directories end with "/".',
    params: [
      {
        name: "path",
        type: "str",
        description: "Directory path relative to the workspace root.",
        optional: true,
      },
    ],
    returns: "str",
    async execute(args) {
      const raw = args.path ?? ".";
      const path = requireString(raw, "path");
      const real = await resolveInRoot(path);
      try {
        const entries = await readdir(real, { withFileTypes: true });
        return entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join("\n");
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOTDIR") {
          throw new HostToolError(
            "NotADirectoryError",
            `not a directory: '${path}'`,
          );
        }
        throw new HostToolError("OSError", err.message);
      }
    },
  };

  const httpGetTool: HostTool = {
    name: "http_get",
    description: "HTTP GET a URL and return the response body as text.",
    params: [
      {
        name: "url",
        type: "str",
        description: "An http:// or https:// URL.",
      },
    ],
    returns: "str",
    async execute(args) {
      const url = requireString(args.url, "url");
      if (!/^https?:\/\//i.test(url)) {
        throw new HostToolError(
          "ValueError",
          `only http(s) URLs are allowed: '${url}'`,
        );
      }
      let response: Response;
      try {
        response = await fetchImpl(url);
      } catch (e) {
        throw new HostToolError(
          "OSError",
          `request failed: ${(e as Error).message}`,
        );
      }
      if (!response.ok) {
        throw new HostToolError(
          "OSError",
          `HTTP ${response.status} for ${url}`,
        );
      }
      return await readResponseTextLimited(response, maxHttpBytes);
    },
  };

  // Append order: http_get first, then unshift the ones we want in front.
  // The sandbox sees tools in registry order; list_files and read_file are
  // used far more often, so they go first.
  const tools = [httpGetTool];
  if (options.listFiles ?? true) tools.unshift(listFilesTool);
  if (options.readFile ?? true) tools.unshift(readFileTool);
  return tools;
}
