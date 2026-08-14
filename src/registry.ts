import type { HostTool } from "./types.js";
import { HostToolError } from "./types.js";
import { MontyRuntimeError, MontySyntaxError, MontyTypingError } from "@pydantic/monty/node";
import { withSandboxSession } from "./pool.js";

// ── ToolRegistry ─────────────────────────────────────────────────

/** Holds host tools and renders Python type stubs for monty's type checker. */
export class ToolRegistry {
  private readonly tools = new Map<string, HostTool>();
  /**
   * The in-flight or completed stub render, not its result.
   *
   * Caching the promise is what keeps the cache honest now that rendering is
   * async. Storing the resolved string instead means writing it back *after*
   * an await, so an `add()` that lands during the render clears the cache and
   * then has its clearing overwritten by the pre-`add` result — leaving the
   * new tool missing from the stub file until some later `add()` clears it
   * again. It also means two concurrent first callers each pay the worker
   * round trip; this way the second awaits the first.
   */
  private typeStubCache: Promise<string> | null = null;

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
   * Compact stubs for monty's static type checker (`typeCheckStubs`).
   * A tool whose rendered stub does not parse degrades to `name: Any = None`
   * rather than corrupting the stub file for every other tool.
   * Cached until the next add().
   */
  async renderTypeStubs(): Promise<string> {
    if (this.typeStubCache === null) {
      this.typeStubCache = validateStubs(this.list().map((tool) => typeStub(tool))).catch(
        (err: unknown) => {
          // A render that failed is not an answer. Dropping it lets the next
          // call retry rather than every later call awaiting the same
          // rejection.
          this.typeStubCache = null;
          throw err;
        },
      );
    }
    return await this.typeStubCache;
  }
}

// ── Stub rendering helpers ──────────────────────────────────────

function renderParams(tool: HostTool): string {
  return tool.params
    .map((p) => `${p.name}: ${p.type}${p.optional ? " | None = None" : ""}`)
    .join(", ");
}

/** One tool's stub, and the `Any` fallback its name degrades to. */
interface Stub {
  name: string;
  source: string;
}

function typeStub(tool: HostTool): Stub {
  const params = renderParams(tool);
  return {
    name: tool.name,
    source: `def ${tool.name}(${params}) -> ${tool.returns}:\n    raise NotImplementedError`,
  };
}

/**
 * Replace any stub that does not parse with `name: Any = None`.
 *
 * On 0.0.18 this validated by *type checking* each stub in its own
 * interpreter, which caught both syntax errors and unresolved type names. Two
 * things changed. Unresolved names in a stub are now silently tolerated —
 * measured: `def broken(p: NotAType) -> AlsoNotAType: ...` type-checks clean
 * and lets `broken("x")` through — so that half is no longer detectable here,
 * and #67 carries it.
 *
 * The half that survives is the one that does damage. A stub that does not
 * parse is not dropped: `def echo(class: str) -> str: ...` yields an `echo`
 * the checker believes takes **no** arguments, so a correct `echo("x")` in
 * user code is reported as `too-many-positional-arguments` — a false
 * diagnostic against source the user did write, caused by a stub they did not.
 *
 * The whole file is checked in one feed, and only a failure costs a second
 * pass to find which stub is responsible. Type checking is off: a stub file
 * that parses is all this can still establish, and asking the checker instead
 * would flag `-> str` against a `raise NotImplementedError` body.
 */
async function validateStubs(stubs: Stub[]): Promise<string> {
  if (stubs.length === 0) return "";
  const whole = stubs.map((s) => s.source).join("\n");
  if (await parsesAsPython(whole)) return whole;

  const checked = await Promise.all(
    stubs.map(async (s) => ((await parsesAsPython(s.source)) ? s.source : `${s.name}: Any = None`)),
  );
  return checked.join("\n");
}

/** Whether `source` is syntactically valid Python, per monty's own parser. */
async function parsesAsPython(source: string): Promise<boolean> {
  return await withSandboxSession({ typeCheck: false }, async (session) => {
    try {
      await session.feedStart(source);
      return true;
    } catch (err) {
      if (err instanceof MontySyntaxError) return false;
      // Anything else — the stub raised at definition time, say — is not a
      // parse failure, and silently degrading the tool would hide it.
      return true;
    }
  });
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

// ── Probe memoisation ───────────────────────────────────────────
//
// Both probes below describe the *interpreter*, which does not change while
// the process lives, and both were re-running on every call: the module probe
// once per `RLMLoop.run()`, the gap probe once per `runInSandbox()`. That is
// #68, filed as ~97 ms of wasted work per call.
//
// On 0.0.18 it was also a memory bug, which is what made it urgent: a Monty
// whose type check *failed* leaked ~6.9 MB no GC reclaimed, and since every
// `TY_GAP_CANDIDATES` entry is a gap by definition, all six threw and the gap
// probe leaked ~41 MB per sandbox run. That leak is gone with the constructor
// it lived in — measured on 0.0.21, 60 failing type checks hold host RSS flat.
// The memoisation stays for the reason it was filed under: the work is
// per-process-constant and the probes now cost worker round trips.
//
// Each probe reuses **one** session across its whole candidate list rather
// than taking one per candidate. Both a `MontyTypingError` and a failed import
// leave the session usable, so a fresh worker per candidate would buy nothing.
//
// Only the default candidate lists are cached. A caller passing its own list is
// asking a different question and gets a fresh answer.

let importableMemo: string[] | null = null;
let tyGapMemo: string[] | null = null;
let probeRuns = { importable: 0, tyGap: 0 };

/**
 * How many times each probe has actually executed. Exists so the memo can be
 * asserted with a counter rather than a timer — a timing-based test would pass
 * on a fast machine with the memo removed.
 */
export function probeInvocations(): { importable: number; tyGap: number } {
  return { ...probeRuns };
}

/** Drops both memos. Without this the memoisation itself is untestable. */
export function resetProbeMemos(): void {
  importableMemo = null;
  tyGapMemo = null;
  probeRuns = { importable: 0, tyGap: 0 };
}

/**
 * Empirically determines which modules the installed monty can import
 * by trying each in a throwaway interpreter. Memoised per process.
 */
export async function probeImportableModules(
  candidates: string[] = CANDIDATE_MODULES,
): Promise<string[]> {
  if (candidates === CANDIDATE_MODULES && importableMemo !== null) return importableMemo;
  probeRuns.importable++;
  const found = await withSandboxSession({ typeCheck: false }, async (session) => {
    const importable: string[] = [];
    for (const name of candidates) {
      try {
        await session.feedStart(`import ${name}`);
        importable.push(name);
      } catch (err) {
        // A failed import is a `MontyRuntimeError` (`ModuleNotFoundError`) and
        // leaves the session usable, so the loop keeps going. Anything else
        // means the session itself is gone — a dead worker poisons it, and
        // every remaining candidate would throw on the way in. Swallowing that
        // would answer "these modules do not exist" for a list this never
        // managed to ask about, and then memoise it.
        if (!(err instanceof MontyRuntimeError)) throw err;
      }
    }
    return importable;
  });
  if (candidates === CANDIDATE_MODULES) importableMemo = found;
  return found;
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
 * in the type-check stubs.
 *
 * The gaps did **not** close on 0.0.21 — measured, all six still report
 * `unresolved-reference`. What changed is where the declaration goes: into
 * out-of-band `typeCheckStubs` rather than a prefix prepended to the user's
 * source, so it no longer shifts the line numbers in reported diagnostics
 * (#77).
 */
export async function probeTypeCheckerGaps(
  candidates: string[] = TY_GAP_CANDIDATES,
): Promise<string[]> {
  if (candidates === TY_GAP_CANDIDATES && tyGapMemo !== null) return tyGapMemo;
  probeRuns.tyGap++;
  const gaps = await withSandboxSession({ typeCheck: true }, async (session) => {
    const found: string[] = [];
    for (const name of candidates) {
      try {
        await session.feedStart(name);
        // ty resolves it — and the name was evaluated, which is harmless for
        // every candidate here (a builtin or an exception class).
      } catch (err) {
        if (err instanceof MontyTypingError) found.push(name);
        // A runtime error means ty resolved the name and evaluating it failed;
        // resolution is the question here, so that is not a gap. Anything else
        // means the session is gone, and the remaining candidates would all
        // throw on entry — caching "no gaps" on that basis would strip every
        // `name: Any = None` declaration from the stub file for the life of
        // the process, so every later run touching `open` or `PermissionError`
        // would fail type-checking. Fail the probe instead; the next call
        // retries against a fresh worker.
        else if (!(err instanceof MontyRuntimeError)) throw err;
      }
    }
    return found;
  });
  if (candidates === TY_GAP_CANDIDATES) tyGapMemo = gaps;
  return gaps;
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
