import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { requireString } from "./registry.js";
import { HostToolError } from "./types.js";
import type { HostTool } from "./types.js";

// ── Options ──────────────────────────────────────────────────────

export interface ToolStoreOptions {
  /** Workspace root. Defaults to '.' if not set. */
  root: string;
  /** Directory for saved tools. Defaults to '<root>/.pi/code-tools'. */
  toolsDir?: string;
}

// ── Helpers ──────────────────────────────────────────────────────

/** Sanitize a tool name: alphanumeric + underscore, no path traversal. */
function validateToolName(name: unknown): string {
  const s = requireString(name, "name");
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) {
    throw new HostToolError(
      "ValueError",
      `invalid tool name '${s}': must be a valid Python identifier`,
    );
  }
  return s;
}

/** Resolve a tool file path from a name. */
function toolPath(toolsDir: string, name: string): string {
  return join(toolsDir, `${name}.py`);
}

// ── createToolStoreTools ────────────────────────────────────────

/**
 * Create HostTools for managing saved Python tools.
 *
 * Tools are stored as `.py` files in the configured tools directory
 * (default: `<root>/.pi/code-tools`). Agents use these to persist
 * reusable Python functions across sessions.
 */
export function createToolStoreTools(options: ToolStoreOptions): HostTool[] {
  const root = resolve(options.root);
  const toolsDir = options.toolsDir ?? join(root, ".pi", "code-tools");

  const ensureDir = async () => {
    await mkdir(toolsDir, { recursive: true });
  };

  // ── save_tool ──────────────────────────────────────────────

  const saveTool: HostTool = {
    name: "save_tool",
    description:
      "Save a Python function as a reusable tool. The tool will be " +
      "auto-loaded into future sessions. Overwrites if the tool " +
      "already exists.",
    params: [
      {
        name: "name",
        type: "str",
        description: "Tool name (a valid Python identifier).",
      },
      {
        name: "code",
        type: "str",
        description: "Python source code (function definition).",
      },
      {
        name: "description",
        type: "str",
        description: "Human-readable description of what the tool does.",
      },
    ],
    returns: "str",
    async execute(args) {
      const name = validateToolName(args.name);
      const code = requireString(args.code, "code");
      const description = requireString(args.description, "description");

      await ensureDir();

      // Wrap with docstring comment
      const docComment = description
        .split("\n")
        .map((line) => `# ${line}`)
        .join("\n");
      const content = [
        `# Tool: ${name}`,
        docComment,
        "# Auto-saved by toolstore. Do not edit manually.",
        "",
        code.trim(),
        "",
      ].join("\n");

      await writeFile(toolPath(toolsDir, name), content, "utf-8");
      return `Tool '${name}' saved.`;
    },
  };

  // ── delete_tool ────────────────────────────────────────────

  const deleteTool: HostTool = {
    name: "delete_tool",
    description: "Remove a saved tool.",
    params: [
      {
        name: "name",
        type: "str",
        description: "Name of the tool to delete.",
      },
    ],
    returns: "str",
    async execute(args) {
      const name = validateToolName(args.name);
      const path = toolPath(toolsDir, name);

      try {
        await rm(path, { force: false });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new HostToolError("FileNotFoundError", `tool '${name}' does not exist`);
        }
        throw new HostToolError("OSError", (err as Error).message);
      }

      return `Tool '${name}' deleted.`;
    },
  };

  // ── list_saved_tools ───────────────────────────────────────

  const listSavedTools: HostTool = {
    name: "list_saved_tools",
    description: "List all saved tools.",
    params: [],
    returns: "str",
    async execute(_args) {
      await ensureDir();

      let entries: string[];
      try {
        entries = await readdir(toolsDir);
      } catch {
        return "(no saved tools)";
      }

      const names = entries
        .filter((e) => extname(e) === ".py")
        .map((e) => e.slice(0, -3)) // strip .py
        .sort();

      if (names.length === 0) return "(no saved tools)";
      return names.join("\n");
    },
  };

  // ── read_tool ──────────────────────────────────────────────

  const readTool: HostTool = {
    name: "read_tool",
    description: "Read a saved tool's source code.",
    params: [
      {
        name: "name",
        type: "str",
        description: "Name of the tool to read.",
      },
    ],
    returns: "str",
    async execute(args) {
      const name = validateToolName(args.name);
      const path = toolPath(toolsDir, name);

      try {
        return await readFile(path, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new HostToolError("FileNotFoundError", `tool '${name}' does not exist`);
        }
        throw new HostToolError("OSError", (err as Error).message);
      }
    },
  };

  return [saveTool, deleteTool, listSavedTools, readTool];
}

// ── Preamble limits ───────────────────────────────────────────────

/**
 * Caps on how much saved code may be prepended to a run.
 *
 * These are a **resource control, not a security control** — the security
 * gate is project trust, applied by the caller (`ReplRunner`, #53). A trusted
 * project is not thereby entitled to inject a megabyte of Python before every
 * single run: the preamble is re-executed on each `run()`, so its cost is paid
 * per call, by Monty's parser and type checker, on the user's latency.
 *
 * Both apply in trusted and untrusted projects alike, because a cap that only
 * held for code that never runs would be no cap at all.
 */
export interface PreambleLimits {
  /** Most `.py` files to load, in sorted order. */
  maxFiles: number;
  /** Most bytes of tool source to load, summed across files. */
  maxBytes: number;
}

/**
 * 32 files and 64 KiB.
 *
 * Sized against what the toolstore is for — a handful of small helpers the
 * agent saved — rather than against what a disk can hold. A project that hits
 * either number is not using saved tools, it is using the preamble as a
 * module system, and the honest failure is to say so on the result.
 */
export const DEFAULT_PREAMBLE_LIMITS: PreambleLimits = {
  maxFiles: 32,
  maxBytes: 64 * 1024,
};

/** The outcome of loading saved tools: what ran, and what did not. */
export interface SavedToolsPreamble {
  /** Python source to prepend to user code. `""` when nothing loaded. */
  preamble: string;
  /** Tool names in the preamble, in load order. */
  loaded: string[];
  /**
   * Tool names present on disk but left out because a limit was reached.
   *
   * Non-empty means the caller **must tell the model**: a tool that is on
   * disk, listed by `list_saved_tools` and absent from the interpreter is a
   * `NameError` the model has no way to explain.
   */
  skipped: string[];
}

// ── savedToolNames ────────────────────────────────────────────────

/**
 * Names of the saved tools on disk, without reading any of their code.
 *
 * This is the untrusted-project path (#53): the names are needed to tell the
 * model what was withheld, and reading a directory listing is not reading —
 * still less executing — the hostile file the listing names.
 *
 * Returns `[]` when the directory does not exist.
 */
export async function savedToolNames(options: ToolStoreOptions): Promise<string[]> {
  const root = resolve(options.root);
  const toolsDir = options.toolsDir ?? join(root, ".pi", "code-tools");

  let entries: string[];
  try {
    entries = await readdir(toolsDir);
  } catch {
    return []; // Directory doesn't exist — no tools to name
  }

  return entries
    .filter((e) => extname(e) === ".py")
    .map((e) => e.slice(0, -3))
    .sort();
}

// ── loadSavedTools ────────────────────────────────────────────────

/**
 * Load saved tools as a Python code preamble.
 *
 * Reads the `.py` files in the tools directory, in name order, up to
 * {@link PreambleLimits}, and returns their concatenated content.
 *
 * **This returns code that will execute with full host-tool access.** Call it
 * only for a project whose code the user has agreed to run — see
 * `docs/project-trust.md`. `savedToolNames` is the safe half of this function
 * for callers that only need to know what is there.
 */
export async function loadSavedTools(
  options: ToolStoreOptions,
  limits: PreambleLimits = DEFAULT_PREAMBLE_LIMITS,
): Promise<SavedToolsPreamble> {
  const root = resolve(options.root);
  const toolsDir = options.toolsDir ?? join(root, ".pi", "code-tools");

  const names = await savedToolNames({ root, toolsDir });
  if (names.length === 0) return { preamble: "", loaded: [], skipped: [] };

  const loaded: string[] = [];
  const skipped: string[] = [];
  const sources: string[] = [];
  let bytes = 0;

  for (const name of names) {
    if (loaded.length >= limits.maxFiles) {
      skipped.push(name);
      continue;
    }

    const content = await readFile(join(toolsDir, `${name}.py`), "utf-8");
    const size = Buffer.byteLength(content, "utf-8");

    // Skipped whole, never truncated: half a Python file is a SyntaxError,
    // and a SyntaxError in the preamble takes every later tool down with it.
    if (bytes + size > limits.maxBytes) {
      skipped.push(name);
      continue;
    }

    bytes += size;
    loaded.push(name);
    sources.push(content);
  }

  if (loaded.length === 0) return { preamble: "", loaded: [], skipped };

  const header = [
    "# ── Loaded tools ──",
    `# ${loaded.length} tool(s) from ${toolsDir}`,
    ...(skipped.length > 0
      ? [`# ${skipped.length} not loaded — preamble limit reached: ${skipped.join(", ")}`]
      : []),
    "",
  ];

  return {
    preamble: [...header, ...sources.flatMap((s) => [s, ""])].join("\n"),
    loaded,
    skipped,
  };
}
