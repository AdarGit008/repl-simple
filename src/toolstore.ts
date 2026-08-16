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
  /**
   * Names a saved tool's code must not bind — the session's host-tool names.
   *
   * One list, two gates. `save_tool` refuses code that defines one of these
   * at write time (#56), and `loadSavedTools` refuses a preamble containing
   * such a file at load time (#54) — because the preamble runs before host
   * tools resolve and would silently replace them. Caller-supplied so the
   * list derives from the live registry rather than a hardcoded set that
   * drifts. Omitted (or `[]`) means no check: for a standalone caller that
   * cannot name the registry, `loadSavedTools` still loads, and the caller
   * owns the security decision.
   */
  hostToolNames?: readonly string[];
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

// ── Shadowing detection ────────────────────────────────────────

/** Index of every `=` that assigns (as opposed to `==`, `!=`, `:=`, `+=`, …). */
function assignmentEquals(s: string): number[] {
  const eqs: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "=") continue;
    if (s[i + 1] === "=") {
      i++; // `==`
      continue;
    }
    const prev = s[i - 1];
    if (
      prev === "!" ||
      prev === "<" ||
      prev === ">" ||
      prev === ":" ||
      prev === "+" ||
      prev === "-" ||
      prev === "*" ||
      prev === "/" ||
      prev === "%" ||
      prev === "@"
    ) {
      continue; // `!=` `<=` `>=` `:=` `+=` `-=` `*=` `/=` `%=` `@=`
    }
    eqs.push(i);
  }
  return eqs;
}

/**
 * Names from `reserved` that `source` binds, in first-appearance order.
 *
 * Detects the binding forms a saved tool could use to shadow a host tool:
 * `def`/`async def`, `class`, assignment (plain, annotated, tuple, chained),
 * `for … in`, `with/except … as`, `import … as`, and `from … import …`.
 *
 * A **best-effort scan, not a parser** (#54 lists the forms; the write-time
 * gate is #56). It is conservative on false *positives* — a match refuses
 * even inside a triple-quoted string, which is the safe direction — but it
 * has false *negatives*: `exec(...)`, `globals()["name"] = …`, `setattr`,
 * walrus (`:=`), `del name`, `match`/`case` captures, and a plain
 * `import mod` (no alias) are not caught. Those are the load-time check's
 * job (#54), which runs over every `.py` in `.pi/code-tools` and is the
 * authoritative control; this write-time check only refuses what it can see.
 * Comment lines are excluded for free — a binding form must start the line,
 * and `# def read_file` starts with `#`.
 *
 * Two Python tokenizer rules are honoured so a line break cannot hide a
 * binding: the source is split on **universal newlines** (`\r`, `\r\n`, `\n`)
 * and backslash continuations are joined first, exactly as CPython/Monty
 * tokenize them.
 */
export function findShadowingBindings(source: string, reserved: ReadonlySet<string>): string[] {
  if (reserved.size === 0) return [];

  const found: string[] = [];
  const seen = new Set<string>();
  const record = (name: string): void => {
    if (reserved.has(name) && !seen.has(name)) {
      seen.add(name);
      found.push(name);
    }
  };

  // A backslash immediately before a line break is an explicit line join in
  // Python — the two lines are one statement, so `def \` + `read_file():`
  // binds `read_file`. Joining can only merge statements, which cannot hide a
  // binding (a merged line is still scanned), and a join that would produce a
  // syntax error is one the sandbox refuses loudly anyway.
  const joined = source.replace(/\\\r?\n/g, "");

  // Split into logical statements on universal newlines and `;`. A `;` inside
  // a string over-splits, which only ever over-refuses — the safe direction.
  for (const line of joined.split(/\r\n|\r|\n/)) {
    for (const raw of line.split(";")) {
      const s = raw.trim();
      if (s === "") continue;

      const def = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(s);
      if (def) {
        record(def[1]);
        continue;
      }

      const cls = /^class\s+([A-Za-z_]\w*)/.exec(s);
      if (cls) {
        record(cls[1]);
        continue;
      }

      // `for a, read_file in items` binds both — every identifier between
      // `for` and `in` is a target, so all of them are recorded (a nested
      // structure identifier that is merely read, not bound, over-refuses,
      // which is the safe direction).
      const forHead = /^for\s+(.+?)\s+in\b/.exec(s);
      if (forHead) {
        for (const m of forHead[1].matchAll(/[A-Za-z_]\w*/g)) record(m[0]);
        continue;
      }

      // `with open(p) as f` and `except X as e` bind the `as` name. (Python 3
      // unbinds an `except … as` name after the block, but over-refusing here
      // is the safe side, and Monty's behaviour is not worth betting on.)
      if (/^(?:(?:async\s+)?with|except)\b/.test(s)) {
        for (const m of s.split("#")[0].matchAll(/\bas\s+([A-Za-z_]\w*)/g)) record(m[1]);
        continue;
      }

      if (/^import\s/.test(s)) {
        // `import x as read_file`; also `import a, b as read_file`. A plain
        // `import read_file` binds a module name, but no stdlib module shares a
        // host-tool name, so only the alias form is a shadow here (#54's list).
        for (const m of s.split("#")[0].matchAll(/\bas\s+([A-Za-z_]\w*)/g)) record(m[1]);
        continue;
      }

      const from = /^from\s+[\w.]+\s+import\s+(.*)$/.exec(s);
      if (from) {
        // `from m import f as read_file` binds the alias; `from m import read_file`
        // binds the name itself. Parens wrap multi-name imports. `import *`
        // binds no single reserved name.
        const clause = from[1].split("#")[0].replace(/^\(|\)$/g, "");
        for (const item of clause.split(",")) {
          const as = /\bas\s+([A-Za-z_]\w*)\s*$/.exec(item.trim());
          if (as) {
            record(as[1]);
          } else {
            const plain = /^([A-Za-z_]\w*)/.exec(item.trim());
            if (plain) record(plain[1]);
          }
        }
        continue;
      }

      // Assignment. The statement must *begin* with a target expression — an
      // identifier, or one wrapped in parens/brackets or star-unpacked — so a
      // call with keyword args (`foo(x = 1)`) or a comparison (`x == y`) is
      // not mistaken for a binding.
      const start = /^[([]*\s*(?:\*\s*)?([A-Za-z_]\w*)/.exec(s);
      if (start) {
        const after = s.slice(start[0].length);
        if (/^[\])]*\s*(?::[^=;\n]*)?\s*(?:=(?!=)|,)/.test(after)) {
          const eqs = assignmentEquals(s);
          // Every identifier before the first `=` is a target (annotated,
          // tuple, parenthesized and starred targets included; an identifier
          // that only appears inside an annotation over-refuses — the safe
          // direction). In a chain (`a = b = c`) the identifier between each
          // `=` is a target too. The value after the last `=` is not.
          for (const m of s.slice(0, eqs[0]).matchAll(/[A-Za-z_]\w*/g)) record(m[0]);
          for (let k = 1; k < eqs.length; k++) {
            const tm = /^([A-Za-z_]\w*)/.exec(s.slice(eqs[k - 1] + 1, eqs[k]).trim());
            if (tm) record(tm[1]);
          }
        }
      }
    }
  }

  return found;
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
  const reservedNames = new Set(options.hostToolNames ?? []);

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
    // This is the write primitive the bridge already gates (`write`,
    // `edit`) — but the file it writes does not just sit there, it executes
    // at the start of every future session. Ungated, `save_tool` would be a
    // self-persisting write with auto-execution, strictly worse than `write`
    // (#56).
    requiresApproval: true,
    approvalNote: "the saved code executes automatically at the start of every future session",
    async execute(args) {
      const name = validateToolName(args.name);
      const code = requireString(args.code, "code");
      const description = requireString(args.description, "description");

      // Refuse to persist a tool that would shadow a host tool, rather than
      // letting it bind the name on every later run (#54, #56).
      const shadowing = findShadowingBindings(code, reservedNames);
      if (shadowing.length > 0) {
        throw new HostToolError(
          "ValueError",
          `cannot save tool '${name}': its code defines ${shadowing.map((n) => `'${n}'`).join(", ")}, ` +
            `which would shadow a host tool`,
        );
      }

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

  // Deliberately NOT gated (#56). Deletion is destructive, but its blast
  // radius is one `.py` file under `.pi/code-tools` — it cannot execute code,
  // write files, or reach the network — and it is the primary recovery path
  // for a bad tool, which must be removable without an extra dialog.
  // `validateToolName` bounds it to deleting one named file, so it cannot wipe
  // arbitrary paths. Gating it would be net-negative.
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
  /**
   * Files whose code binds a host-tool name, refused at load time (#54).
   *
   * Non-empty means **nothing** was loaded — `preamble` is `""`, `loaded` and
   * `skipped` are `[]` — and the caller must tell the model which file and
   * symbol to fix. Partial injection would produce a session whose behaviour
   * nobody can predict from the source, so one offender refuses the whole
   * preamble rather than the offending file.
   */
  refused: RefusedTool[];
}

/**
 * One saved tool the preamble must not run: its code shadows a host tool.
 *
 * A preamble definition **silently replaces** a host tool — host tools resolve
 * only for names Python has not already bound, and the preamble runs first,
 * so binding the name wins for the whole session (#54).
 */
export interface RefusedTool {
  /** The `.py` file whose code binds a host-tool name. */
  file: string;
  /** The host-tool names the file binds, in first-appearance order. */
  symbols: string[];
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
 *
 * When `options.hostToolNames` is set, every file that could load is scanned
 * with {@link findShadowingBindings} before anything is returned: a file that
 * binds a host-tool name refuses the **whole** preamble (#54), reported in
 * `refused` with the offending file and symbols and nothing loaded.
 *
 * Files the caps drop are neither read nor scanned — code that never loads
 * cannot shadow, and reading it anyway would be unbounded I/O the caps exist
 * to prevent. The scan still refuses a capped-out shadow the moment it *would*
 * load: session creation re-runs the loader, so the first session in which the
 * file fits is the first session that refuses it.
 */
export async function loadSavedTools(
  options: ToolStoreOptions,
  limits: PreambleLimits = DEFAULT_PREAMBLE_LIMITS,
): Promise<SavedToolsPreamble> {
  const root = resolve(options.root);
  const toolsDir = options.toolsDir ?? join(root, ".pi", "code-tools");

  const names = await savedToolNames({ root, toolsDir });
  if (names.length === 0) return { preamble: "", loaded: [], skipped: [], refused: [] };

  const reservedNames = new Set(options.hostToolNames ?? []);

  const loaded: string[] = [];
  const skipped: string[] = [];
  const refused: RefusedTool[] = [];
  const sources: string[] = [];
  let bytes = 0;

  for (const name of names) {
    if (loaded.length >= limits.maxFiles) {
      skipped.push(name);
      continue;
    }

    const content = await readFile(join(toolsDir, `${name}.py`), "utf-8");

    // Read on after an offender: all of them are collected in one pass, so
    // the developer fixes once rather than one refusal per fix. Files beyond
    // `maxFiles` are never read — code that cannot load cannot shadow.
    const shadowing = findShadowingBindings(content, reservedNames);
    if (shadowing.length > 0) {
      refused.push({ file: `${name}.py`, symbols: shadowing });
      continue;
    }

    // Skipped whole, never truncated: half a Python file is a SyntaxError,
    // and a SyntaxError in the preamble takes every later tool down with it.
    const size = Buffer.byteLength(content, "utf-8");
    if (bytes + size > limits.maxBytes) {
      skipped.push(name);
      continue;
    }

    bytes += size;
    loaded.push(name);
    sources.push(content);
  }

  // One offender refuses everything. Partial injection — the benign siblings
  // without the hostile file — produces a session whose behaviour nobody can
  // predict from the source, and the issue forbids both that and doing
  // nothing silently. The caller must turn `refused` into a notice.
  if (refused.length > 0) return { preamble: "", loaded: [], skipped: [], refused };

  if (loaded.length === 0) return { preamble: "", loaded: [], skipped, refused };

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
    refused,
  };
}
