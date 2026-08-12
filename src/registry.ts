import type { HostTool } from "./types.js";
import { HostToolError } from "./types.js";
import { Monty } from "@pydantic/monty";

// ── ToolRegistry ─────────────────────────────────────────────────

/** Holds host tools and renders Python type stubs for monty's type checker. */
export class ToolRegistry {
  private readonly tools = new Map<string, HostTool>();
  private typeStubCache: string | null = null;

  constructor(tools: HostTool[] = []) {
    for (const tool of tools) this.add(tool);
  }

  add(tool: HostTool): void {
    if (!/^[a-z_][a-z0-9_]*$/i.test(tool.name)) {
      throw new Error(`Tool name '${tool.name}' is not a valid Python identifier`);
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
    this.typeStubCache = null;
  }

  get(name: string): HostTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): HostTool[] {
    return [...this.tools.values()];
  }

  /**
   * Compact stubs for monty's static type checker (`typeCheckPrefixCode`).
   * Each stub is validated against monty itself; a tool whose param/return
   * strings aren't real type expressions degrades to `name: Any = None`.
   * Cached until the next add().
   */
  renderTypeStubs(): string {
    if (this.typeStubCache !== null) return this.typeStubCache;
    this.typeStubCache = this.list()
      .map((tool) => validatedTypeStub(tool))
      .join("\n");
    return this.typeStubCache;
  }
}

// ── Stub rendering helpers ──────────────────────────────────────

function renderParams(tool: HostTool): string {
  return tool.params
    .map((p) => `${p.name}: ${p.type}${p.optional ? " | None = None" : ""}`)
    .join(", ");
}

function validatedTypeStub(tool: HostTool): string {
  const params = renderParams(tool);
  const stub = `def ${tool.name}(${params}) -> ${tool.returns}:\n    raise NotImplementedError`;

  try {
    new Monty("pass", { typeCheck: true, typeCheckPrefixCode: stub });
    return stub;
  } catch {
    return `${tool.name}: Any = None`;
  }
}

// ── Argument helpers ────────────────────────────────────────────

/** Positional-or-keyword argument lookup, Python-style. */
export function arg(
  args: unknown[],
  kwargs: Record<string, unknown>,
  index: number,
  name: string,
): unknown {
  if (index < args.length && name in kwargs) {
    throw new HostToolError("TypeError", `got multiple values for argument '${name}'`);
  }
  return index < args.length ? args[index] : kwargs[name];
}

/** Validate a value is a string, throwing HostToolError otherwise. */
export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new HostToolError("TypeError", `argument '${name}' must be a str`);
  }
  return value;
}

// ── Module probing ──────────────────────────────────────────────

/** Stdlib modules worth probing for monty availability. */
export const CANDIDATE_MODULES = [
  "json",
  "re",
  "datetime",
  "math",
  "os",
  "sys",
  "typing",
  "asyncio",
  "pathlib",
  "time",
  "random",
  "collections",
  "itertools",
  "functools",
  "string",
  "textwrap",
  "base64",
  "hashlib",
  "statistics",
  "io",
  "copy",
  "enum",
  "dataclasses",
  "uuid",
  "csv",
  "urllib",
];

/**
 * Empirically determines which modules the installed monty can import
 * by trying each in a throwaway interpreter.
 */
export function probeImportableModules(candidates: string[] = CANDIDATE_MODULES): string[] {
  return candidates.filter((name) => {
    try {
      new Monty(`import ${name}`).run();
      return true;
    } catch {
      return false;
    }
  });
}

// ── Type checker gap probing ────────────────────────────────────

/**
 * Runtime names monty's bundled type checker historically didn't know.
 * Each is probed before being declared so the workaround self-prunes
 * once ty learns a name.
 */
const TY_GAP_CANDIDATES = [
  "open",
  "bytearray",
  "PermissionError",
  "FileNotFoundError",
  "IsADirectoryError",
  "NotADirectoryError",
];

/**
 * Names the interpreter provides at runtime that its type checker
 * rejects as unresolved. These need `name: Any = None` declarations
 * in any typecheck prefix.
 */
export function probeTypeCheckerGaps(candidates: string[] = TY_GAP_CANDIDATES): string[] {
  return candidates.filter((name) => {
    try {
      new Monty(name, { typeCheck: true });
      return false; // ty resolves it
    } catch {
      return true; // ty rejects it — gap confirmed
    }
  });
}

// ── Python tool rules ───────────────────────────────────────────

/** Examples used in the import restriction rule, filtered against reality. */
const BLOCKED_EXAMPLES = ["time", "random", "collections", "requests", "numpy"];

/**
 * Ground rules for the model writing sandboxed Python. Include alongside
 * the type stubs in the system/tool prompt. Pass the result of
 * `probeImportableModules()` so the import list reflects the installed
 * interpreter.
 */
export function renderPythonToolRules(importableModules: string[]): string {
  const blocked = BLOCKED_EXAMPLES.filter((m) => !importableModules.includes(m));
  return `\
- Call tools as plain functions, WITHOUT \`await\`.
- Use print() to surface anything you need to see; printed output is returned to you.
- The value of the last top-level expression is returned as the result (expressions
  inside if/try blocks are not).
- Imports: ONLY these modules exist: ${importableModules.join(", ")}. Anything else
  (e.g. ${blocked.join(", ")}) raises ModuleNotFoundError — there are no third-party
  packages.
- Class definitions and match statements are not supported.
- Tool failures raise normal Python exceptions you can catch (e.g. ValueError,
  FileNotFoundError, OSError).`;
}
