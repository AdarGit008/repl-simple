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
  type ReadToolOptions,
  type WriteToolOptions,
} from "@earendil-works/pi-coding-agent";
import {
  access as fsAccess,
  stat as fsStat,
  readFile as fsReadFile,
  readdir as fsReaddir,
} from "node:fs/promises";
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
  /** Passed through to createEditTool. */
  edit?: EditToolOptions;
  /** Passed through to createWriteTool. */
  write?: WriteToolOptions;
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
 * from the model — grep's context reads, ls's per-entry stats. Neither
 * `read` nor `find` gets one, for reasons that are not symmetry:
 *
 * - `read` would have to supply `detectImageMimeType`, and pi does not export
 *   its sniffer. Omitting it means every image is decoded as UTF-8 text into
 *   the model's context. `read` opens exactly the one path it is given, which
 *   the argument jail has already canonicalised.
 * - `find` only consults its operations when they supply `glob`, which
 *   replaces the `fd` subprocess — losing .gitignore handling and the result
 *   caps with it. `fd`, like `rg`, does not follow symlinks out of the tree
 *   it is pointed at.
 */
function jailedGrepOperations(jail: PathJail, inherited?: GrepOperations): GrepOperations {
  return {
    isDirectory: async (p) => {
      const real = await jail.resolve(p);
      if (inherited) return inherited.isDirectory(real);
      return (await fsStat(real)).isDirectory();
    },
    readFile: async (p) => {
      const real = await jail.resolve(p);
      if (inherited) return inherited.readFile(real);
      return fsReadFile(real, "utf-8");
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
      return inherited ? inherited.stat(real) : fsStat(real);
    },
    readdir: async (p) => {
      const real = await jail.resolve(p);
      if (inherited) return inherited.readdir(real);
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
}

const TOOL_SPECS: ToolSpec[] = [
  {
    name: "read",
    factory: (cwd, opts) => createReadTool(cwd, opts.read),
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
    factory: (cwd, opts) => createBashTool(cwd, opts.bash),
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
 * Read-only tools (read, grep, find, ls) are jailed to `cwd` and require no
 * approval; a path outside it is refused, `..` and symlinks included.
 * Mutating tools (bash, edit, write) require approval by default;
 * set `{ gateMutating: false }` to skip approval for all. `bash` is
 * therefore the only way to reach outside the root, and it is gated —
 * see docs/path-jail.md.
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
        const result = await agentTool.execute(
          randomUUID(),
          // `processed` is a plain Record built from Monty's dynamically-typed
          // args; pi types this parameter per-tool via its own schema. There is
          // nothing to narrow to at this seam — the validation that matters is
          // pi's, inside execute().
          // biome-ignore lint/suspicious/noExplicitAny: per-tool schema, typed inside pi
          processed as any,
          undefined, // signal
          undefined, // onUpdate
        );
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
