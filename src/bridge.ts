import { randomUUID } from "node:crypto";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashToolOptions,
  type EditToolOptions,
  type FindToolOptions,
  type GrepOperations,
  type GrepToolOptions,
  type LsOperations,
  type LsToolOptions,
  type ReadOperations,
  type ReadToolOptions,
  type WriteToolOptions,
} from "@earendil-works/pi-coding-agent";
import { constants, type Stats } from "node:fs";
import {
  access as fsAccess,
  open as fsOpen,
  readdir as fsReaddir,
  type FileHandle,
} from "node:fs/promises";
import {
  createBashEnvHook,
  describeWithheld,
  filterBashEnv,
  resolveBashEnvAllow,
} from "./bashenv.js";
import { createPathJail, type PathJail } from "./pathjail.js";
import { HostToolError } from "./types.js";
import type { HostTool, HostToolParam } from "./types.js";

// ── Options ──────────────────────────────────────────────────────

export interface BridgeOptions {
  /** Gate mutating tools (bash, edit, write) behind approval. Default: true. */
  gateMutating?: boolean;
  /**
   * Also gate the read tools (read, grep, find, ls) behind approval.
   * Default: false — they are jailed to `cwd` unconditionally, and a prompt
   * on a tool the model calls dozens of times per task is the kind that gets
   * clicked through. Set it for callers who want both (#43).
   */
  gateReads?: boolean;
  /** Passed through to createReadTool. */
  read?: ReadToolOptions;
  /** Passed through to createGrepTool. */
  grep?: GrepToolOptions;
  /** Passed through to createFindTool. */
  find?: FindToolOptions;
  /** Passed through to createLsTool. */
  ls?: LsToolOptions;
  /** Passed through to createBashTool. */
  bash?: BashToolOptions;
  /**
   * Host environment variables `bash` may inherit beyond the standing
   * allowlist, by name. `["*"]` inherits everything — the explicit opt-out.
   * Defaults to `REPL_BASH_ENV_ALLOW` (comma-separated); an explicit `[]`
   * means "no extras" and beats the variable. See docs/bash-env.md (#45).
   */
  bashEnvAllow?: string[];
  /** Passed through to createEditTool. */
  edit?: EditToolOptions;
  /** Passed through to createWriteTool. */
  write?: WriteToolOptions;
  /**
   * Called after every successful built-in execution with the pi tool's own
   * `details`, so they survive the bridge instead of being dropped with the
   * rest of the `AgentToolResult` (#46): `read`, `grep`, `find`, `ls` and
   * `bash` report their truncation, `bash` its full-output path, `edit` its
   * diff and patch; `write` reports `undefined`. `HostTool.execute` still
   * returns the text alone — that is the sandbox's contract — and this is the
   * side channel for the rest. Not called when the tool throws: pi produces
   * no result then, and the sandbox records the failure in the trace itself.
   */
  onDetails?: (event: BridgeToolDetails) => void;
}

/** What `BridgeOptions.onDetails` receives: the tool, the arguments pi ran with, and its `details`. */
export interface BridgeToolDetails {
  tool: string;
  /** Jailed and prepared — the arguments the built-in tool actually saw. */
  args: Record<string, unknown>;
  details: unknown;
}

// ── Tool definitions ────────────────────────────────────────────

/**
 * Seconds a `bash` call runs before pi kills it, when the caller names none.
 *
 * Under the sandbox's default 300 s host wall clock, so a hung command fails
 * as itself — one tool call raising, with the script still live to handle it —
 * rather than as the death of the whole run.
 */
const DEFAULT_BASH_TIMEOUT_SECS = 120;

// ── The cwd jail ────────────────────────────────────────────────

/**
 * Confine pi's read tools to `cwd`.
 *
 * The jail is applied to the `path` argument, before pi sees it, and the
 * canonical path replaces it. That ordering is the whole design: pi's own
 * resolution understands `~`, `file://` URLs, `@` prefixes and unicode
 * spaces, so a check that resolves the *raw* argument its own way is
 * checking a path that is not the one that gets opened. Handing pi an
 * absolute, already-canonical path leaves its resolver nothing to do, which
 * makes this check the only one that decides.
 *
 * `operations` back it up for the paths pi derives itself rather than taking
 * from the model — grep's context reads, ls's per-entry stats — and for
 * `read`, whose open is the one the model points at. Every open below goes
 * through one fd, obtained with `O_NOFOLLOW | O_NONBLOCK`, and is then
 * `fstat`ed: a final-component symlink swap is refused and a FIFO cannot
 * block the threadpool, because the fd — not the name — is what gets read.
 *
 * - `read` supplies `access`, `readFile` and `detectImageMimeType`. pi does
 *   not export its magic-byte sniffer, so the bytes are read through
 *   {@link openJailedFile} and sniffed here — images stay attached without
 *   reopening the path by name.
 * - `find` still gets none: it only consults its operations when they supply
 *   `glob`, which replaces the `fd` subprocess — losing .gitignore handling
 *   and the result caps with it. `fd`, like `rg`, does not follow symlinks
 *   out of the tree it is pointed at.
 */

/** Open a jailed path once, refusing symlinks and never blocking on a FIFO. */
async function openJailed(path: string): Promise<FileHandle> {
  return fsOpen(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
}

/** `fstat` the fd from {@link openJailed}, closing it on the way out. */
async function statJailed(path: string): Promise<Stats> {
  const handle = await openJailed(path);
  try {
    return await handle.stat();
  } finally {
    await handle.close();
  }
}

/** Open a regular file by fd, refusing directories, FIFOs and symlinks. */
async function openJailedFile(path: string): Promise<FileHandle> {
  const handle = await openJailed(path);
  try {
    const st = await handle.stat();
    if (!st.isFile()) {
      throw new HostToolError("OSError", `not a regular file: '${path}'`);
    }
    return handle;
  } catch (e) {
    await handle.close();
    throw e;
  }
}

/** Bytes read for image sniffing — pi sniffs 4100 to see the PNG chunks. */
const IMAGE_SNIFF_BYTES = 4100;

/**
 * Magic-byte detection for the image types the read tool attaches. pi does
 * not export its sniffer (`detectSupportedImageMimeTypeFromFile` is internal
 * and opens by name), so it is replicated here and fed from the jailed fd.
 * Exported for the magic-byte tests.
 */
export function detectImageMimeType(buffer: Buffer): string | null {
  if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) {
    return buffer[3] === 0xf7 ? null : "image/jpeg";
  }
  if (startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
  }
  if (startsWithAscii(buffer, 0, "GIF")) return "image/gif";
  if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
    return "image/webp";
  }
  if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) return "image/bmp";
  return null;
}

function startsWithBytes(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Buffer, offset: number, text: string): boolean {
  if (buffer.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (buffer[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function readUint32BE(buffer: Buffer, offset: number): number {
  return (
    (buffer[offset] ?? 0) * 0x1000000 +
    ((buffer[offset + 1] ?? 0) << 16) +
    ((buffer[offset + 2] ?? 0) << 8) +
    (buffer[offset + 3] ?? 0)
  );
}

function readUint32LE(buffer: Buffer, offset: number): number {
  return (
    (buffer[offset] ?? 0) +
    ((buffer[offset + 1] ?? 0) << 8) +
    ((buffer[offset + 2] ?? 0) << 16) +
    (buffer[offset + 3] ?? 0) * 0x1000000
  );
}

function readUint16LE(buffer: Buffer, offset: number): number {
  return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length >= 16 && readUint32BE(buffer, 8) === 13 && startsWithAscii(buffer, 12, "IHDR")
  );
}

function isAnimatedPng(buffer: Buffer): boolean {
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const chunkLength = readUint32BE(buffer, offset);
    const chunkTypeOffset = offset + 4;
    if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
    if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;
    const nextOffset = offset + 8 + chunkLength + 4;
    if (nextOffset <= offset || nextOffset > buffer.length) return false;
    offset = nextOffset;
  }
  return false;
}

function isBmp(buffer: Buffer): boolean {
  if (buffer.length < 26) return false;
  const declaredFileSize = readUint32LE(buffer, 2);
  const pixelDataOffset = readUint32LE(buffer, 10);
  const dibHeaderSize = readUint32LE(buffer, 14);
  if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
  if (pixelDataOffset < 14 + dibHeaderSize) return false;
  if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;
  let colorPlanes: number;
  let bitsPerPixel: number;
  if (dibHeaderSize === 12) {
    colorPlanes = readUint16LE(buffer, 22);
    bitsPerPixel = readUint16LE(buffer, 24);
  } else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
    if (buffer.length < 30) return false;
    colorPlanes = readUint16LE(buffer, 26);
    bitsPerPixel = readUint16LE(buffer, 28);
  } else {
    return false;
  }
  return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

function jailedReadOperations(jail: PathJail, inherited?: ReadOperations): ReadOperations {
  return {
    access: async (p) => {
      const real = await jail.resolve(p);
      if (inherited?.access) return inherited.access(real);
      const handle = await openJailedFile(real);
      await handle.close();
    },
    readFile: async (p) => {
      const real = await jail.resolve(p);
      if (inherited?.readFile) return inherited.readFile(real);
      const handle = await openJailedFile(real);
      try {
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    },
    detectImageMimeType: async (p) => {
      const real = await jail.resolve(p);
      if (inherited?.detectImageMimeType) return inherited.detectImageMimeType(real);
      const handle = await openJailedFile(real);
      try {
        const buffer = Buffer.alloc(IMAGE_SNIFF_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, IMAGE_SNIFF_BYTES, 0);
        return detectImageMimeType(buffer.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    },
  };
}

function jailedGrepOperations(jail: PathJail, inherited?: GrepOperations): GrepOperations {
  return {
    isDirectory: async (p) => {
      const real = await jail.resolve(p);
      if (inherited) return inherited.isDirectory(real);
      return (await statJailed(real)).isDirectory();
    },
    readFile: async (p) => {
      const real = await jail.resolve(p);
      if (inherited) return inherited.readFile(real);
      const handle = await openJailedFile(real);
      try {
        return await handle.readFile("utf-8");
      } finally {
        await handle.close();
      }
    },
  };
}

function jailedLsOperations(jail: PathJail, inherited?: LsOperations): LsOperations {
  return {
    exists: async (p) => {
      // Outside the root throws rather than answering "no": pi renders a false
      // here as "Path not found", which reads as "try another path" — the
      // opposite of what a refusal should tell the model.
      const real = await jail.resolve(p);
      if (inherited) return inherited.exists(real);
      return await fsAccess(real).then(
        () => true,
        () => false,
      );
    },
    stat: async (p) => {
      const real = await jail.resolve(p);
      return inherited ? inherited.stat(real) : statJailed(real);
    },
    readdir: async (p) => {
      const real = await jail.resolve(p);
      if (inherited) return inherited.readdir(real);
      const st = await statJailed(real);
      if (!st.isDirectory()) {
        throw new HostToolError("NotADirectoryError", `not a directory: '${p}'`);
      }
      return fsReaddir(real);
    },
  };
}

/**
 * Replace `path` with the jail's canonical form, so the path pi opens is the
 * path that was checked. An omitted `path` becomes the root itself rather
 * than being left for pi to default — same reason.
 */
async function jailPathArg(
  args: Record<string, unknown>,
  jail: PathJail,
): Promise<Record<string, unknown>> {
  const raw = args.path;
  if (raw === undefined || raw === null || raw === "") {
    return { ...args, path: await jail.resolve(".") };
  }
  if (typeof raw !== "string") {
    throw new HostToolError("TypeError", `path must be a str, got ${typeof raw}`);
  }
  return { ...args, path: await jail.resolve(raw) };
}

/**
 * Whether a `find` glob is trying to leave the jailed root.
 *
 * The jail holds the `path` argument, and `pattern` is a glob — so an
 * absolute pattern never reaches the resolver and fd answers "no files
 * found" rather than a refusal: an empty result the model reads as fact. A
 * `..` segment is refused for the same reason: it can only describe a search
 * the jail would have rejected had it arrived as `path`.
 */
function escapesSearchRoot(pattern: string): boolean {
  return pattern.startsWith("/") || pattern.split("/").includes("..");
}

interface ToolSpec {
  name: string;
  // pi's tool factories each return a differently-shaped AgentTool and the
  // package exports no common supertype. Narrowing this would mean
  // re-declaring pi's types here, free to drift from the ones that actually
  // run — the failure mode the pinned `typebox` exists to avoid.
  // biome-ignore lint/suspicious/noExplicitAny: no supertype to narrow to
  factory: (cwd: string, opts: BridgeOptions, jail: PathJail) => any;
  params: HostToolParam[];
  mutating: boolean;
  /** Optional arg pre-processing before passing to Pi tool */
  prepareArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
  /**
   * A note appended when the tool fails, or `undefined` for none. Lets a
   * refusal this bridge imposed be told apart from the tool's own failure.
   */
  failureNote?: (opts: BridgeOptions, context: string) => string | undefined;
}

const TOOL_SPECS: ToolSpec[] = [
  {
    name: "read",
    factory: (cwd, opts, jail) =>
      createReadTool(cwd, {
        ...opts.read,
        operations: jailedReadOperations(jail, opts.read?.operations),
      }),
    params: [
      {
        name: "path",
        type: "str",
        description: "File to read, inside the project root (absolute or relative to cwd).",
      },
      {
        name: "offset",
        type: "int",
        description: "Line number to start reading from (1-indexed).",
        optional: true,
      },
      {
        name: "limit",
        type: "int",
        description: "Maximum number of lines to read.",
        optional: true,
      },
    ],
    mutating: false,
  },
  {
    name: "grep",
    factory: (cwd, opts, jail) =>
      createGrepTool(cwd, {
        ...opts.grep,
        operations: jailedGrepOperations(jail, opts.grep?.operations),
      }),
    params: [
      {
        name: "pattern",
        type: "str",
        description: "Regular expression or literal pattern to search for.",
      },
      {
        name: "path",
        type: "str",
        description: "File or directory to search in. Default: current directory.",
        optional: true,
      },
      {
        name: "glob",
        type: "str",
        description: "Glob pattern to filter files (e.g. '*.ts').",
        optional: true,
      },
      {
        name: "ignoreCase",
        type: "bool",
        description: "Case-insensitive search. Default: false.",
        optional: true,
      },
      {
        name: "literal",
        type: "bool",
        description: "Treat pattern as a literal string. Default: false.",
        optional: true,
      },
      {
        name: "context",
        type: "int",
        description: "Number of context lines around each match.",
        optional: true,
      },
      {
        name: "limit",
        type: "int",
        description: "Maximum number of matches to return.",
        optional: true,
      },
    ],
    mutating: false,
  },
  {
    name: "find",
    factory: (cwd, opts) => createFindTool(cwd, opts.find),
    params: [
      { name: "pattern", type: "str", description: "Glob pattern to match files (e.g. '*.ts')." },
      {
        name: "path",
        type: "str",
        description: "Directory to search in. Default: current directory.",
        optional: true,
      },
      { name: "limit", type: "int", description: "Maximum number of results.", optional: true },
    ],
    mutating: false,
    // `path` is jailed above; `pattern` is not a path and never reaches the
    // jail, so a glob pointing outside the root would be answered with "No
    // files found matching pattern" — a refusal-shaped fact the model would
    // act on. Refuse it by name instead (F7).
    prepareArgs: (args) => {
      const pattern = args.pattern;
      if (typeof pattern === "string" && escapesSearchRoot(pattern)) {
        throw new HostToolError(
          "PermissionError",
          `the find pattern '${pattern}' is outside the search root '${String(args.path)}'; ` +
            "find patterns cannot leave the project root — use a project-relative glob",
        );
      }
      return args;
    },
  },
  {
    name: "ls",
    factory: (cwd, opts, jail) =>
      createLsTool(cwd, { ...opts.ls, operations: jailedLsOperations(jail, opts.ls?.operations) }),
    params: [
      {
        name: "path",
        type: "str",
        description: "Directory to list. Default: current directory.",
        optional: true,
      },
      { name: "limit", type: "int", description: "Maximum number of entries.", optional: true },
    ],
    mutating: false,
  },
  {
    name: "bash",
    factory: (cwd, opts) => {
      const allow = resolveBashEnvAllow(opts.bashEnvAllow);
      return createBashTool(cwd, {
        ...opts.bash,
        // PI_* session variables are dropped with everything else: the model
        // has no use for the host's session id, and `PI_SESSION_FILE` points
        // at the transcript on disk, which is the one file a jailed read tool
        // must not be handed a route to. Turning pi's injection off as well
        // keeps the tool's advertised behaviour honest rather than promising
        // variables the filter then removes; the filter still decides.
        exposeSessionEnvironment: opts.bash?.exposeSessionEnvironment ?? false,
        spawnHook: createBashEnvHook(allow, opts.bash?.spawnHook),
      });
    },
    params: [
      { name: "command", type: "str", description: "Shell command to execute." },
      {
        name: "timeout",
        type: "int",
        description: `Timeout in seconds. Default ${DEFAULT_BASH_TIMEOUT_SECS}.`,
        optional: true,
      },
    ],
    mutating: true,
    prepareArgs: (args) => {
      // Pi's schema documents "no default timeout", and it means it: a command
      // that never returns is awaited forever. That hangs the whole run and,
      // since the pooled worker is released only once the run settles, holds a
      // worker for as long as it lasts (#32 item 3). The sandbox's own
      // `maxDurationSecs` cannot help — its clock stops while the interpreter
      // is suspended on this very call.
      //
      // A default here rather than only the host wall clock because the two
      // bound different things: the wall clock ends the *run*, while this ends
      // the *command*, leaving the script running with a failure it can handle.
      if (args.timeout === undefined || args.timeout === null) {
        return { ...args, timeout: DEFAULT_BASH_TIMEOUT_SECS };
      }
      return args;
    },
    // Recomputed from `process.env` rather than recorded by the hook: the
    // filter is a pure function of the host environment, so a second
    // evaluation gives the same answer without a mutable field that two
    // in-flight calls could disagree about.
    failureNote: (opts, context) =>
      describeWithheld(
        filterBashEnv(process.env, resolveBashEnvAllow(opts.bashEnvAllow)).withheld,
        context,
      ),
  },
  {
    name: "edit",
    factory: (cwd, opts) => createEditTool(cwd, opts.edit),
    params: [
      { name: "path", type: "str", description: "File to edit (absolute or relative to cwd)." },
      {
        name: "edits",
        type: "str",
        description:
          "JSON array of {oldText, newText} objects. Each oldText must match exactly one location.",
      },
    ],
    mutating: true,
    prepareArgs: (args) => {
      // Parse edits from JSON string → array that Pi's edit tool expects
      if (typeof args.edits === "string") {
        return { ...args, edits: JSON.parse(args.edits as string) };
      }
      return args;
    },
  },
  {
    name: "write",
    factory: (cwd, opts) => createWriteTool(cwd, opts.write),
    params: [
      { name: "path", type: "str", description: "File path (absolute or relative to cwd)." },
      { name: "content", type: "str", description: "Content to write to the file." },
    ],
    mutating: true,
  },
];

// ── Main API ─────────────────────────────────────────────────────

/**
 * Create HostTool wrappers around Pi's built-in coding tools.
 *
 * Read-only tools (read, grep, find, ls) are jailed to `cwd` and, unless
 * `{ gateReads: true }`, require no approval; a path outside it is refused,
 * `..` and symlinks included. Mutating tools (bash, edit, write) require
 * approval by default; set `{ gateMutating: false }` to skip approval for
 * all. `bash` is therefore the only way to reach outside the root, and it is
 * gated — see docs/path-jail.md.
 *
 * `bash` also runs with an allowlisted environment rather than the host's, so
 * one approved command cannot disclose the credentials the pi process happens
 * to hold — see docs/bash-env.md.
 *
 * Each tool executes against `cwd` — the working directory for
 * relative paths and command execution.
 */
export function createPiBridgeTools(cwd: string, options: BridgeOptions = {}): HostTool[] {
  const gateMutating = options.gateMutating ?? true;
  const gateReads = options.gateReads ?? false;

  // `mustExist: false` leaves a path that is not there for pi to report on,
  // which keeps its filename-variant fallbacks (NFD, curly quotes) working.
  // Those substitute characters; none of them can introduce a separator or a
  // `..`, so the check still decides.
  const jail = createPathJail(cwd, { allowAbsolute: true, mustExist: false });

  return TOOL_SPECS.map((spec) => {
    const agentTool = spec.factory(cwd, options, jail);

    return {
      name: spec.name,
      description: agentTool.description ?? "",
      params: spec.params,
      returns: "str" as const,
      requiresApproval: spec.mutating ? gateMutating : gateReads,
      execute: async (args: Record<string, unknown>): Promise<string> => {
        const jailed = spec.mutating ? args : await jailPathArg(args, jail);
        const processed = spec.prepareArgs ? spec.prepareArgs(jailed) : jailed;
        const result = await agentTool
          .execute(
            randomUUID(),
            // `processed` is a plain Record built from Monty's dynamically-typed
            // args; pi types this parameter per-tool via its own schema. There is
            // nothing to narrow to at this seam — the validation that matters is
            // pi's, inside execute().
            // biome-ignore lint/suspicious/noExplicitAny: per-tool schema, typed inside pi
            processed as any,
            undefined, // signal
            undefined, // onUpdate
          )
          .catch((err: unknown) => {
            // Pi signals a non-zero exit by throwing, with the output as the
            // message. The note rides along on the same string, since that is
            // the only channel the sandbox re-raises into Python. It is shown
            // the command as well as the output, since a shell that dies on an
            // unset variable may name it in either.
            const message = err instanceof Error ? err.message : String(err);
            const note = spec.failureNote?.(
              options,
              `${String(processed.command ?? "")}\n${message}`,
            );
            if (note === undefined) throw err;
            throw new Error(`${message}\n\n${note}`, { cause: err });
          });
        // The details go out of band; the text is the return value (#46).
        options.onDetails?.({ tool: spec.name, args: processed, details: result.details });
        // Extract text blocks from AgentToolResult.content
        const content: Array<{ type: string; text?: string }> = result.content;
        return content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text ?? "")
          .join("");
      },
    };
  });
}
