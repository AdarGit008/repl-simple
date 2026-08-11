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
  type GrepToolOptions,
  type LsToolOptions,
  type ReadToolOptions,
  type WriteToolOptions,
} from "@earendil-works/pi-coding-agent";
import type { HostTool, HostToolParam } from "./types.js";

// ── Options ──────────────────────────────────────────────────────

export interface BridgeOptions {
  /** Gate mutating tools (bash, edit, write) behind approval. Default: true. */
  gateMutating?: boolean;
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

interface ToolSpec {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: (cwd: string, opts: BridgeOptions) => any;
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
      { name: "path", type: "str", description: "File to read (absolute or relative to cwd)." },
      { name: "offset", type: "int", description: "Line number to start reading from (1-indexed).", optional: true },
      { name: "limit", type: "int", description: "Maximum number of lines to read.", optional: true },
    ],
    mutating: false,
  },
  {
    name: "grep",
    factory: (cwd, opts) => createGrepTool(cwd, opts.grep),
    params: [
      { name: "pattern", type: "str", description: "Regular expression or literal pattern to search for." },
      { name: "path", type: "str", description: "File or directory to search in. Default: current directory.", optional: true },
      { name: "glob", type: "str", description: "Glob pattern to filter files (e.g. '*.ts').", optional: true },
      { name: "ignoreCase", type: "bool", description: "Case-insensitive search. Default: false.", optional: true },
      { name: "literal", type: "bool", description: "Treat pattern as a literal string. Default: false.", optional: true },
      { name: "context", type: "int", description: "Number of context lines around each match.", optional: true },
      { name: "limit", type: "int", description: "Maximum number of matches to return.", optional: true },
    ],
    mutating: false,
  },
  {
    name: "find",
    factory: (cwd, opts) => createFindTool(cwd, opts.find),
    params: [
      { name: "pattern", type: "str", description: "Glob pattern to match files (e.g. '*.ts')." },
      { name: "path", type: "str", description: "Directory to search in. Default: current directory.", optional: true },
      { name: "limit", type: "int", description: "Maximum number of results.", optional: true },
    ],
    mutating: false,
  },
  {
    name: "ls",
    factory: (cwd, opts) => createLsTool(cwd, opts.ls),
    params: [
      { name: "path", type: "str", description: "Directory to list. Default: current directory.", optional: true },
      { name: "limit", type: "int", description: "Maximum number of entries.", optional: true },
    ],
    mutating: false,
  },
  {
    name: "bash",
    factory: (cwd, opts) => createBashTool(cwd, opts.bash),
    params: [
      { name: "command", type: "str", description: "Shell command to execute." },
      { name: "timeout", type: "int", description: "Timeout in seconds.", optional: true },
    ],
    mutating: true,
  },
  {
    name: "edit",
    factory: (cwd, opts) => createEditTool(cwd, opts.edit),
    params: [
      { name: "path", type: "str", description: "File to edit (absolute or relative to cwd)." },
      { name: "edits", type: "str", description: "JSON array of {oldText, newText} objects. Each oldText must match exactly one location." },
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
 * Read-only tools (read, grep, find, ls) never require approval.
 * Mutating tools (bash, edit, write) require approval by default;
 * set `{ gateMutating: false }` to skip approval for all.
 *
 * Each tool executes against `cwd` — the working directory for
 * relative paths and command execution.
 */
export function createPiBridgeTools(
  cwd: string,
  options: BridgeOptions = {},
): HostTool[] {
  const gateMutating = options.gateMutating ?? true;

  return TOOL_SPECS.map((spec) => {
    const agentTool = spec.factory(cwd, options);

    return {
      name: spec.name,
      description: agentTool.description ?? "",
      params: spec.params,
      returns: "str" as const,
      requiresApproval: spec.mutating ? gateMutating : false,
      execute: async (args: Record<string, unknown>): Promise<string> => {
        const processed = spec.prepareArgs ? spec.prepareArgs(args) : args;
        const result = await agentTool.execute(
          randomUUID(),
          processed as any,
          undefined, // signal
          undefined, // onUpdate
        );
        // Extract text blocks from AgentToolResult.content
        const content: Array<{ type: string; text?: string }> =
          result.content;
        return content
          .filter(
            (c): c is { type: "text"; text: string } => c.type === "text",
          )
          .map((c) => c.text ?? "")
          .join("");
      },
    };
  });
}
