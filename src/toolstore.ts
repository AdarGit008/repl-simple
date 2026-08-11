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
          throw new HostToolError(
            "FileNotFoundError",
            `tool '${name}' does not exist`,
          );
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
          throw new HostToolError(
            "FileNotFoundError",
            `tool '${name}' does not exist`,
          );
        }
        throw new HostToolError("OSError", (err as Error).message);
      }
    },
  };

  return [saveTool, deleteTool, listSavedTools, readTool];
}

// ── loadSavedTools ────────────────────────────────────────────────

/**
 * Load all saved tools as a Python code preamble.
 *
 * Reads every `.py` file in the tools directory and returns their
 * concatenated content. Use this as the preamble in sandbox execution
 * to make saved tools available to user code.
 *
 * Returns "" if the directory doesn't exist or has no `.py` files.
 */
export async function loadSavedTools(options: ToolStoreOptions): Promise<string> {
  const root = resolve(options.root);
  const toolsDir = options.toolsDir ?? join(root, ".pi", "code-tools");

  let entries: string[];
  try {
    entries = await readdir(toolsDir);
  } catch {
    return ""; // Directory doesn't exist — no tools to load
  }

  const pyFiles = entries
    .filter((e) => extname(e) === ".py")
    .sort();

  if (pyFiles.length === 0) return "";

  const parts: string[] = [
    "# ── Loaded tools ──",
    `# ${pyFiles.length} tool(s) from ${toolsDir}`,
    "",
  ];

  for (const file of pyFiles) {
    const content = await readFile(join(toolsDir, file), "utf-8");
    parts.push(content, "");
  }

  return parts.join("\n");
}
