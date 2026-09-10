import { describe, it } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  runInSandbox,
  resumeSuspended,
  memoryGuardConfig,
  limitsConfig,
  toResourceLimits,
} from "../src/sandbox.js";
import { closeSandboxPool } from "../src/pool.js";
import { ToolRegistry } from "../src/registry.js";
import { HostToolError } from "../src/types.js";
import { createRLMTools } from "../src/rlm_tools.js";
import { SubmitSignal } from "../src/submit_signal.js";
import { STDOUT_MAX_LINES, OUTPUT_MAX_BYTES, VALUE_RECOVERY, formatSize } from "../src/truncate.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  HostTool,
  RunOk,
  RunError,
  RunSuspended,
} from "../src/types.js";
// The finding-5 tripwire drives Monty directly: the fact under test is the
// binding's, not the sandbox's.
import { MAX_VALUE_DEPTH, Monty, MontyComplete, type PrintCallback } from "@pydantic/monty/node";

const byteSize = (s: string) => Buffer.byteLength(s, "utf8");

// ── Helpers ─────────────────────────────────────────────────────

function makeTool(overrides: Partial<HostTool> = {}): HostTool {
  return {
    name: "echo",
    description: "Echo back the input",
    params: [{ name: "text", type: "str", description: "Text to echo" }],
    returns: "str",
    execute: (args) => String(args.text),
    ...overrides,
  };
}

function makeAddTool(): HostTool {
  return {
    name: "add",
    description: "Add two integers",
    params: [
      { name: "a", type: "int", description: "First" },
      { name: "b", type: "int", description: "Second" },
    ],
    returns: "str",
    execute: (args) => String(Number(args.a) + Number(args.b)),
  };
}

function echoTool(): HostTool {
  return makeTool();
}

function ok(result: unknown, message?: string): asserts result is RunOk {
  assert.equal((result as RunOk).status, "ok", message);
}

function err(result: unknown): asserts result is RunError {
  assert.equal((result as RunError).status, "error");
}

function suspended(result: unknown): asserts result is RunSuspended {
  assert.equal((result as RunSuspended).status, "suspended");
}

// ── Pure computation ────────────────────────────────────────────

describe("runInSandbox — pure computation", () => {
  const registry = new ToolRegistry();

  it("evaluates a simple expression", async () => {
    const result = await runInSandbox("1 + 2", { registry });
    ok(result);
    assert.equal(result.output, "3");
    assert.equal(result.stdout, "");
    assert.equal(result.calls.length, 0);
  });

  it("captures print() output", async () => {
    const result = await runInSandbox('print("hello")', { registry });
    ok(result);
    assert.equal(result.output, "None");
    // Monty's printCallback includes a trailing newline after each print
    assert.ok(result.stdout.startsWith("hello"));
  });

  it("returns the last expression value", async () => {
    const result = await runInSandbox("x = 5\nx * 2", { registry });
    ok(result);
    assert.equal(result.output, "10");
  });

  it("formats Python None as 'None'", async () => {
    const result = await runInSandbox("print('hi')", { registry });
    ok(result);
    // print() returns None in Python → output should be "None"
    assert.equal(result.output, "None");
  });

  it("handles multi-line with print and expression", async () => {
    const result = await runInSandbox('print("a")\nprint("b")\n42', { registry });
    ok(result);
    assert.equal(result.output, "42");
    // One callback per print, newline included (0.0.21; the D122 tripwire
    // below pins the exact shape). 0.0.18 delivered fragments.
    assert.ok(result.stdout.includes("a"));
    assert.ok(result.stdout.includes("b"));
  });
});

// ── Error handling ──────────────────────────────────────────────

describe("runInSandbox — error handling", () => {
  const registry = new ToolRegistry();

  it("syntax error → errorKind 'syntax'", async () => {
    const result = await runInSandbox("1 +", { registry });
    err(result);
    assert.equal(result.errorKind, "syntax");
  });

  it("type error → errorKind 'typing'", async () => {
    const result = await runInSandbox('x: int = "hello"', { registry });
    err(result);
    assert.equal(result.errorKind, "typing");
  });

  it("runtime error → errorKind 'runtime'", async () => {
    const result = await runInSandbox("1 / 0", { registry });
    err(result);
    assert.equal(result.errorKind, "runtime");
  });

  it("undefined name → errorKind 'typing' (caught by type checker)", async () => {
    const result = await runInSandbox("nonexistent_var", { registry });
    err(result);
    assert.equal(result.errorKind, "typing");
  });

  it("error result has stdout captured before the error", async () => {
    const result = await runInSandbox('print("before")\n1 / 0', { registry });
    err(result);
    assert.equal(result.errorKind, "runtime");
    assert.ok(result.stdout.includes("before"));
  });
});

// ── lineOffset: syntax-error correction ─────────────────────────
//
// The sandbox runs whatever script the caller assembles, prefix included, so
// a syntax error reports line numbers counted from the top of the prefix and
// echoes prefix source lines as context. `lineOffset` tells the sandbox how
// many prefix lines to subtract so the model only ever sees line numbers (and
// source) relative to its own code.

describe("runInSandbox — lineOffset syntax-error correction", () => {
  const registry = new ToolRegistry();

  function prefixOf(n: number): string {
    return Array.from({ length: n }, (_, i) => `PREFIX_MARKER_77 = ${i}`).join("\n");
  }

  for (const n of [1, 3, 7]) {
    it(`reports a user-line-1 syntax error at line 1 with a ${n}-line prefix (lineOffset=${n})`, async () => {
      const result = await runInSandbox(`${prefixOf(n)}\n1 +`, { registry }, { lineOffset: n });
      err(result);
      assert.equal(result.errorKind, "syntax");
      assert.match(result.error, /^error\[invalid-syntax\]: Expected an expression$/m);
      assert.match(result.error, / --> <repl>:1:/, "the diagnostic location is line 1");
      assert.match(result.error, /^1 \| 1 \+$/m, "the excerpt line is line 1");
      assert.doesNotMatch(result.error, /PREFIX_MARKER_77/, "no prefix source reaches the caller");
    });
  }

  it("renumbers every diagnostic block and lines after the error line", async () => {
    // `def f(:` yields two diagnostics, each echoing the line after the error
    // (`5 |     pass`), so both block relocation and after-line renumbering
    // are exercised.
    const result = await runInSandbox(
      `${prefixOf(3)}\ndef f(:\n    pass`,
      { registry },
      { lineOffset: 3 },
    );
    err(result);
    assert.equal(result.errorKind, "syntax");
    assert.deepEqual(result.error.match(/ --> <repl>:\d+:\d+/g), [
      " --> <repl>:1:7",
      " --> <repl>:1:8",
    ]);
    assert.match(result.error, /^1 \| def f\(:$/m, "the error line is excerpt line 1");
    assert.match(result.error, /^2 \| {5}pass$/m, "the after-line is renumbered too");
    assert.doesNotMatch(result.error, /PREFIX_MARKER_77/);
  });

  it("leaves the diagnostic untouched when lineOffset is absent", async () => {
    const result = await runInSandbox(`${prefixOf(3)}\n1 +`, { registry });
    err(result);
    assert.match(result.error, / --> <repl>:4:/, "assembled line 4, no correction applied");
    assert.match(result.error, /PREFIX_MARKER_77/, "prefix source appears without a lineOffset");
  });

  it("strips a blank prefix-region excerpt line (prefix ends with an empty line)", async () => {
    // Monty renders a blank source line as `N |` — no trailing space, no
    // text after the pipe. When the blank line belongs to the prefix, it
    // must be stripped like any other prefix excerpt line.
    const result = await runInSandbox(`${prefixOf(2)}\n\n1 +`, { registry }, { lineOffset: 3 });
    err(result);
    assert.equal(result.errorKind, "syntax");
    assert.match(result.error, / --> <repl>:1:/, "the user's error is line 1");
    assert.match(result.error, /^1 \| 1 \+$/m, "the excerpt line is line 1");
    assert.doesNotMatch(result.error, /^\s*\d+ \|$/m, "no blank excerpt line survives");
    assert.doesNotMatch(result.error, /PREFIX_MARKER_77/);
  });

  it("renumbers a blank user-region excerpt line (user code starts with an empty line)", async () => {
    // The same `N |` shape, but on a line the user owns: it must be
    // renumbered like any other user excerpt line.
    const result = await runInSandbox(`${prefixOf(2)}\n\n1 +`, { registry }, { lineOffset: 2 });
    err(result);
    assert.equal(result.errorKind, "syntax");
    assert.match(result.error, / --> <repl>:2:/, "the user's error is user line 2");
    assert.match(result.error, /^1 \|$/m, "the blank user line is renumbered to 1");
    assert.match(result.error, /^2 \| 1 \+$/m, "the error excerpt line is 2");
    assert.doesNotMatch(result.error, /^3 \|$/m, "no unrenumbered excerpt line survives");
    assert.doesNotMatch(result.error, /PREFIX_MARKER_77/);
  });

  it("preserves gutter padding when renumbering a blank user-region excerpt line", async () => {
    // A 3-digit-wide gutter (from the 98-line prefix) right-aligns short
    // numbers; the renumbered blank line keeps the width.
    const wide = Array.from({ length: 98 }, (_, i) => `PREFIX_MARKER_77 = ${i}`).join("\n");
    const result = await runInSandbox(`${wide}\n\n1 +`, { registry }, { lineOffset: 98 });
    err(result);
    assert.equal(result.errorKind, "syntax");
    assert.match(result.error, / --> <repl>:2:4/, "the user's error is user line 2");
    assert.match(result.error, /^ {2}1 \|$/m, "the blank user line is 1, gutter padded to 3");
    assert.match(result.error, /^ {2}2 \| 1 \+$/m, "the error excerpt line is 2, gutter padded");
    assert.doesNotMatch(result.error, /99 \|/, "no unrenumbered excerpt line survives");
    assert.doesNotMatch(result.error, /PREFIX_MARKER_77/);
  });

  it("reads the line number after a digit-ending scriptName (digit-collision regression)", async () => {
    // A filename ending in digits sits flush against the location's line
    // colon: ` --> file0:3:4`. The location regex must read the digits after
    // the final colon of the prefix as the line number — the lazy-prefix
    // version captured the trailing `0` of the name, and a prefix-region
    // location was then dropped instead of corrected.
    const result = await runInSandbox(
      `${prefixOf(2)}\n1 +`,
      { registry },
      { scriptName: "file0", lineOffset: 2 },
    );
    err(result);
    assert.equal(result.errorKind, "syntax");
    assert.match(
      result.error,
      / --> file0:1:4/,
      "the filename survives intact and the location is the user's line 1",
    );
    assert.match(result.error, /^1 \| 1 \+$/m, "the excerpt line is line 1");
    assert.doesNotMatch(result.error, /PREFIX_MARKER_77/);
  });
});

// ── lineOffset: typing-error correction ────────────────────────
//
// The stub file's contribution is removed out-of-band (`typeCheckStubs`),
// but the prefix the caller assembled around the code still shifts typing
// diagnostics exactly as it shifts syntax ones — the `"full"` typing render
// uses the same ` --> file:line:col` / `<n> |` excerpt shapes (measured).
// `lineOffset` corrects them the same way.

describe("runInSandbox — lineOffset typing-error correction", () => {
  const registry = new ToolRegistry();

  function prefixOf(n: number): string {
    return Array.from({ length: n }, (_, i) => `PREFIX_MARKER_77 = ${i}`).join("\n");
  }

  for (const n of [1, 3, 7]) {
    it(`reports a user-line-1 typing error at line 1 with a ${n}-line prefix (lineOffset=${n})`, async () => {
      const result = await runInSandbox(
        `${prefixOf(n)}\nx: int = 'oops'`,
        { registry },
        { lineOffset: n },
      );
      err(result);
      assert.equal(result.errorKind, "typing");
      assert.match(result.error, / --> <repl>:1:/, "the diagnostic location is line 1");
      assert.match(result.error, /^1 \| x: int = 'oops'$/m, "the excerpt line is line 1");
      assert.match(result.error, /Incompatible value/, "the caret annotation rows pass through");
      assert.doesNotMatch(result.error, /PREFIX_MARKER_77/, "no prefix source reaches the caller");
    });
  }

  it("leaves the diagnostic untouched when lineOffset is absent", async () => {
    const result = await runInSandbox(`${prefixOf(3)}\nx: int = 'oops'`, { registry });
    err(result);
    assert.equal(result.errorKind, "typing");
    assert.match(result.error, / --> <repl>:4:/, "assembled line 4, no correction applied");
    assert.match(result.error, /PREFIX_MARKER_77/, "prefix source appears without a lineOffset");
  });

  it("drops a location inside the prefix instead of emitting a non-positive line number", async () => {
    // A caller that overstates the offset (here: 3, against code with no
    // prefix at all) must not get ` --> <repl>:0:` or ` --> <repl>:-2:` rows.
    // A location whose line is at or before the offset is prefix-position
    // information and is dropped, like its excerpt rows.
    const result = await runInSandbox("x: int = 'oops'", { registry }, { lineOffset: 3 });
    err(result);
    assert.equal(result.errorKind, "typing");
    assert.match(result.error, /^error\[invalid-assignment\]/m, "the heading survives");
    assert.doesNotMatch(result.error, / --> <repl>:(?:0|-)/, "no non-positive line number");
    assert.doesNotMatch(result.error, /^\d+ \|/m, "no excerpt row survives the oversized offset");
  });
});

// ── lineOffset: runtime-error correction ────────────────────────
//
// A runtime error surfaces as a `MontyRuntimeError` whose `traceback()`
// frames are numbered against the assembled script, prefix included, with a
// `sourceLine` preview on each frame. `lineOffset` tells the sandbox how many
// prefix lines to subtract: frames inside the prefix are dropped (preview
// included), the survivors are re-rendered under the untouched
// `<type>: msg` heading, and the model only ever sees its own code.

describe("runInSandbox — lineOffset runtime-error correction", () => {
  const registry = new ToolRegistry();

  function prefixOf(n: number): string {
    return Array.from({ length: n }, (_, i) => `PREFIX_MARKER_77 = ${i}`).join("\n");
  }

  for (const n of [1, 3, 7]) {
    it(`reports a runtime error at the user's line 2 with a ${n}-line prefix (lineOffset=${n})`, async () => {
      const result = await runInSandbox(
        `${prefixOf(n)}\nx = 1\ny = 1 / 0`,
        { registry },
        { lineOffset: n },
      );
      err(result);
      assert.equal(result.errorKind, "runtime");
      assert.match(
        result.error,
        /^ZeroDivisionError: division by zero$/m,
        "the <type>: msg heading is preserved",
      );
      assert.match(result.error, /File "<python-input-0>", line 2, in <module>/);
      assert.ok(result.error.includes("y = 1 / 0"), "the surviving frame keeps its source preview");
      assert.doesNotMatch(result.error, /PREFIX_MARKER_77/, "no prefix source reaches the caller");
    });
  }

  it("re-renders multi-frame tracebacks with the user's line numbers", async () => {
    const user = "def f():\n    raise ValueError('boom')\nf()";
    const result = await runInSandbox(`${prefixOf(3)}\n${user}`, { registry }, { lineOffset: 3 });
    err(result);
    assert.equal(result.errorKind, "runtime");
    assert.match(result.error, /^ValueError: boom$/m);
    assert.match(
      result.error,
      /File "<python-input-0>", line 3, in <module>/,
      "the call site is line 3",
    );
    assert.match(
      result.error,
      /File "<python-input-0>", line 2, in f/,
      "the raising frame is line 2",
    );
    assert.match(result.error, /^ {4}~~~$/m, "the call site keeps its caret marker");
    assert.doesNotMatch(result.error, /PREFIX_MARKER_77/);
  });

  it("drops frames that live inside the prefix, source previews included", async () => {
    // The prefix defines a function that raises on its own line 2; the user
    // code only calls it. The call frame (user line 1) survives; the raising
    // frame and its preview are prefix source and must never reach the caller.
    const prefix =
      "def prefix_boom():\n    raise ValueError('prefix raised')\nPREFIX_MARKER_77 = 3";
    const result = await runInSandbox(`${prefix}\nprefix_boom()`, { registry }, { lineOffset: 3 });
    err(result);
    assert.equal(result.errorKind, "runtime");
    assert.match(result.error, /^ValueError: prefix raised$/m);
    assert.match(result.error, /File "<python-input-0>", line 1, in <module>/);
    assert.ok(result.error.includes("prefix_boom()"), "the call frame keeps its source preview");
    assert.doesNotMatch(
      result.error,
      /raise ValueError\('prefix raised'\)/,
      "the prefix frame's preview is dropped",
    );
    assert.doesNotMatch(result.error, /PREFIX_MARKER_77/);
  });

  it("corrects runtime errors raised from a host tool on the user's line", async () => {
    // The dispatch-loop resume path: a tool that raises is re-raised in Python
    // as a `MontyRuntimeError`, whose frames point at the call site.
    const boom: HostTool = {
      name: "boom",
      description: "always raises",
      params: [],
      returns: "str",
      execute: () => {
        throw new HostToolError("ValueError", "tool exploded");
      },
    };
    const reg = new ToolRegistry([boom]);
    const result = await runInSandbox(
      `${prefixOf(3)}\nboom()`,
      { registry: reg },
      { lineOffset: 3 },
    );
    err(result);
    assert.equal(result.errorKind, "runtime");
    assert.match(result.error, /^ValueError: tool exploded$/m);
    assert.match(result.error, /File "<python-input-0>", line 1, in <module>/);
    assert.doesNotMatch(result.error, /PREFIX_MARKER_77/);
  });

  it("leaves the message untouched when lineOffset is absent", async () => {
    const result = await runInSandbox(`${prefixOf(3)}\n1 / 0`, { registry });
    err(result);
    assert.equal(result.errorKind, "runtime");
    assert.equal(
      result.error,
      "ZeroDivisionError: division by zero",
      "no traceback is added without a lineOffset",
    );
  });

  it("falls back to the bare message when the error carries no frames", async () => {
    // Interpreter-raised ceilings such as `TimeoutError` have an empty
    // `traceback()` — measured — so the message path is the only option.
    const result = await runInSandbox(
      `${prefixOf(3)}\nwhile True:\n    pass`,
      { registry },
      { lineOffset: 3, limits: { maxDurationSecs: 0.2 } },
    );
    err(result);
    assert.equal(result.errorKind, "timeout");
    assert.match(result.error, /^TimeoutError:/);
    assert.doesNotMatch(result.error, /Traceback/);
  });

  it("falls back to the bare message when every frame lies inside the prefix", async () => {
    const result = await runInSandbox(
      "raise ValueError('prefix-only')\nPREFIX_MARKER_77 = 1\nPREFIX_MARKER_77 = 2\n1 + 1",
      { registry },
      { lineOffset: 3 },
    );
    err(result);
    assert.equal(result.errorKind, "runtime");
    assert.equal(
      result.error,
      "ValueError: prefix-only",
      "no frame survives, so the heading alone is rendered",
    );
  });
});

// ── lineOffset: the plain MontySyntaxError branch ────────────────
//
// `classifyStartError` corrects two shapes: the `MontyTypingError`
// display-with-`invalid-syntax` render every syntax test above arrives
// through, and a plain `MontySyntaxError`, which still reaches the feed from
// paths that do not go through the type checker's diagnostic render. On
// 0.0.21 the only such path reachable from the public API is input-name
// validation: `feedStart` refuses an input whose name is not a valid Python
// identifier by raising a native `SyntaxError`, which the bridge maps to
// `MontySyntaxError` (measured). Its message is the bare heading —
// `SyntaxError: Input name '...' not a valid identifier` — with no
// ` --> file:line` location and no excerpt rows (the line information lives
// in `tracebackText`, which this branch does not render), so there is no
// line number to correct. The test pins what the branch must do with such
// an error: keep kind `syntax`, pass the heading through uncorrupted
// (`correctDiagnosticText` is a no-op on text with no locations), and leak
// no prefix source.

describe("runInSandbox — lineOffset on the plain MontySyntaxError branch", () => {
  it("classifies an input-name validation failure as syntax, message intact, no prefix source", async () => {
    const registry = new ToolRegistry();
    // The validation failure fires at feed start, before any of this code
    // runs; the prefix still guards the branch against leaking prefix source
    // into whatever MontySyntaxError text survives the correction.
    const result = await runInSandbox(
      "PREFIX_MARKER_77 = 1\nPREFIX_MARKER_77 = 2\nPREFIX_MARKER_77 = 3\n1 + 1",
      { registry },
      { lineOffset: 3, inputs: { "not a name": "x" } },
    );
    err(result);
    assert.equal(result.errorKind, "syntax");
    assert.equal(
      result.error,
      "SyntaxError: Input name 'not a name' not a valid identifier",
      "the plain MontySyntaxError message passes through uncorrupted",
    );
    assert.doesNotMatch(result.error, /PREFIX_MARKER_77/, "no prefix source reaches the caller");
  });
});

// ── Host tool execution ─────────────────────────────────────────

describe("runInSandbox — host tool execution", () => {
  it("tool returns a string to Python", async () => {
    const registry = new ToolRegistry([echoTool()]);
    const result = await runInSandbox('echo("hi")', { registry });
    ok(result);
    assert.equal(result.output, "hi");
  });

  it("tool with two params receives both args", async () => {
    const add = makeAddTool();
    const registry = new ToolRegistry([add]);
    const result = await runInSandbox("add(3, 4)", { registry });
    ok(result);
    assert.equal(result.output, "7");
  });

  it("ToolCallTrace records ok=true with duration", async () => {
    const registry = new ToolRegistry([echoTool()]);
    const result = await runInSandbox('echo("trace")', { registry });
    ok(result);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].tool, "echo");
    assert.equal(result.calls[0].ok, true);
    assert.ok(result.calls[0].durationMs >= 0);
    assert.deepEqual(result.calls[0].args, ["trace"]);
  });

  it("tool returns empty string for void-like tools", async () => {
    const voidTool: HostTool = {
      name: "do_thing",
      description: "Does a thing",
      params: [],
      returns: "void",
      execute: () => "",
    };
    const registry = new ToolRegistry([voidTool]);
    const result = await runInSandbox("do_thing()", { registry });
    ok(result);
    assert.equal(result.output, "");
  });

  it("tool returning null → output 'None'", async () => {
    const nullTool: HostTool = {
      name: "get_null",
      description: "Returns null",
      params: [],
      returns: "str",
      execute: () => null as unknown as string,
    };
    const registry = new ToolRegistry([nullTool]);
    // null in JS → Python None → formatOutput("None")
    const result = await runInSandbox("get_null()", { registry });
    ok(result);
    assert.equal(result.output, "None");
  });
});

// ── Host tool errors ────────────────────────────────────────────

describe("runInSandbox — host tool errors", () => {
  it("HostToolError surfaces as Python exception", async () => {
    const failingTool: HostTool = {
      name: "fragile",
      description: "Always fails",
      params: [],
      returns: "str",
      execute: () => {
        throw new HostToolError("ValueError", "bad value");
      },
    };
    const registry = new ToolRegistry([failingTool]);

    // Python code that catches the exception
    const result = await runInSandbox(
      `
try:
    fragile()
    result = "no-error"
except ValueError as e:
    result = str(e)
result
`,
      { registry },
    );
    ok(result);
    assert.equal(result.output, "bad value");
  });

  it("HostToolError recorded in ToolCallTrace", async () => {
    const failingTool: HostTool = {
      name: "fragile",
      description: "Always fails",
      params: [],
      returns: "str",
      execute: () => {
        throw new HostToolError("OSError", "disk full");
      },
    };
    const registry = new ToolRegistry([failingTool]);

    const result = await runInSandbox("fragile()", { registry });
    err(result);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].ok, false);
    assert.equal(result.calls[0].error, "disk full");
  });

  it("regular Error → RuntimeError in Python", async () => {
    const jsErrorTool: HostTool = {
      name: "js_fail",
      description: "Throws a JS error",
      params: [],
      returns: "str",
      execute: () => {
        throw new Error("something broke");
      },
    };
    const registry = new ToolRegistry([jsErrorTool]);

    const result = await runInSandbox(
      `
try:
    js_fail()
    result = "no-error"
except RuntimeError as e:
    result = str(e)
result
`,
      { registry },
    );
    ok(result);
    assert.equal(result.output, "something broke");
  });
});

// ── Approval flow ───────────────────────────────────────────────

describe("runInSandbox — approval flow", () => {
  const gatedTool: HostTool = {
    name: "sensitive",
    description: "Needs approval",
    params: [{ name: "x", type: "str", description: "Some param" }],
    returns: "str",
    requiresApproval: true,
    execute: (args) => `got ${args.x}`,
  };

  it("approved → executes and records approved=true", async () => {
    const registry = new ToolRegistry([gatedTool]);
    const result = await runInSandbox(
      'sensitive("data")',
      { registry },
      {
        onApproval: () => true,
      },
    );
    ok(result);
    assert.equal(result.output, "got data");
    assert.equal(result.calls[0].approved, true);
    assert.equal(result.calls[0].ok, true);
  });

  it("denied → PermissionError in Python", async () => {
    const registry = new ToolRegistry([gatedTool]);
    const result = await runInSandbox(
      `
try:
    sensitive("data")
    result = "no-error"
except PermissionError:
    result = "denied"
result
`,
      { registry },
      { onApproval: () => false },
    );
    ok(result);
    assert.equal(result.output, "denied");
  });

  it("suspended → RunSuspended result", async () => {
    const registry = new ToolRegistry([gatedTool]);
    const result = await runInSandbox(
      'sensitive("data")',
      { registry },
      {
        onApproval: () => "suspend",
      },
    );
    suspended(result);
    assert.equal(result.suspendedCall.tool, "sensitive");
    assert.deepEqual(result.suspendedCall.args, ["data"]);
  });

  it("approvalNote is appended to the dialog description", async () => {
    const notedTool: HostTool = {
      ...gatedTool,
      approvalNote: "this runs automatically later",
    };
    const registry = new ToolRegistry([notedTool]);
    let description: string | undefined;
    const result = await runInSandbox(
      'sensitive("data")',
      { registry },
      {
        onApproval: (req) => {
          description = req.description;
          return false;
        },
      },
    );
    assert.equal(result.status, "error");
    assert.ok(description, "onApproval should have been called");
    assert.match(description, /this runs automatically later/);
    assert.match(description, /^sensitive\(x="data"\)/);
  });

  it("no onApproval callback → denied", async () => {
    const registry = new ToolRegistry([gatedTool]);
    const result = await runInSandbox(
      `
try:
    sensitive("data")
    result = "no-error"
except PermissionError:
    result = "blocked"
result
`,
      { registry },
    );
    ok(result);
    assert.equal(result.output, "blocked");
  });

  it("non-gated tool skips approval", async () => {
    const normalTool = echoTool();
    const registry = new ToolRegistry([normalTool]);
    const result = await runInSandbox(
      'echo("hi")',
      { registry },
      {
        onApproval: () => {
          // Should never be called
          throw new Error("approval should not be requested");
        },
      },
    );
    ok(result);
    assert.equal(result.output, "hi");
    assert.equal(result.calls[0].approved, undefined);
  });
});

// ── Stdout truncation ───────────────────────────────────────────

describe("runInSandbox — stdout truncation", () => {
  const registry = new ToolRegistry();

  it("stdoutTruncated true when output exceeds limit", async () => {
    const result = await runInSandbox('print("A" * 200)', { registry }, { maxStdoutBytes: 10 });
    ok(result);
    assert.equal(result.stdoutTruncated, true);
  });

  it("stdoutTruncated false when within limit", async () => {
    const result = await runInSandbox('print("hi")', { registry }, { maxStdoutBytes: 1000 });
    ok(result);
    assert.equal(result.stdoutTruncated, false);
  });

  it("onPrint callback receives each print", async () => {
    const prints: string[] = [];
    const result = await runInSandbox(
      'print("a")\nprint("b")',
      { registry },
      { onPrint: (text) => prints.push(text) },
    );
    ok(result);
    // Every print reaches the live stream, in order and byte for byte. How the
    // stream is chunked is Monty's: 0.0.21 called back once per print
    // (`'a\n', 'b\n'`, which this test used to pin), 0.0.23 batches a burst
    // (`'a\nb\n'`, measured). The shape is the D122 tripwire's to pin; this
    // test only asks that nothing is lost, duplicated or reordered.
    assert.equal(prints.join(""), "a\nb\n");
    assert.equal(result.stdout, "a\nb\n");
  });
});

// ── Abort ────────────────────────────────────────────────────────

describe("runInSandbox — abort", () => {
  const registry = new ToolRegistry();

  it("aborted before start → errorKind 'aborted'", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runInSandbox(
      "1 + 1",
      { registry },
      {
        signal: controller.signal,
      },
    );
    err(result);
    assert.equal(result.errorKind, "aborted");
  });
});

// ── Multiple tool calls ─────────────────────────────────────────

describe("runInSandbox — multiple tool calls", () => {
  it("records two ToolCallTrace entries", async () => {
    const registry = new ToolRegistry([echoTool()]);
    const result = await runInSandbox('echo("a")\necho("b")', { registry });
    ok(result);
    assert.equal(result.calls.length, 2);
    assert.equal(result.calls[0].tool, "echo");
    assert.equal(result.calls[1].tool, "echo");
    assert.deepEqual(result.calls[0].args, ["a"]);
    assert.deepEqual(result.calls[1].args, ["b"]);
  });

  it("Python catches tool exception and continues", async () => {
    const fragileTool: HostTool = {
      name: "may_fail",
      description: "Sometimes fails",
      params: [],
      returns: "str",
      execute: () => {
        throw new HostToolError("ValueError", "nope");
      },
    };
    const registry = new ToolRegistry([fragileTool, echoTool()]);
    const result = await runInSandbox(
      `
try:
    may_fail()
    result = "no-error"
except ValueError:
    result = echo("recovered")
result
`,
      { registry },
    );
    ok(result);
    assert.equal(result.output, "recovered");
    // Two calls: may_fail (failed) + echo (success)
    assert.equal(result.calls.length, 2);
    assert.equal(result.calls[0].ok, false);
    assert.equal(result.calls[1].ok, true);
  });
});

// ── Inputs ────────────────────────────────────────────────────────

describe("runInSandbox — inputs", () => {
  it("passes input variables to Python", async () => {
    const registry = new ToolRegistry();
    // Inputs are strings; Python concatenates them
    const result = await runInSandbox(
      "x + y",
      { registry },
      {
        inputs: { x: "Hello", y: "World" },
      },
    );
    ok(result);
    assert.equal(result.output, "HelloWorld");
  });

  // Retitled and given real inputs in #23. The old title and comment claimed
  // the tool "wins" over a same-named input; executed, the opposite is true —
  // the input shadows the tool. The old test passed no inputs at all, so it
  // asserted nothing in either direction, and a v1 review filed the finding
  // backwards on the strength of its title.
  it("an input shadows a tool of the same name", async () => {
    const registry = new ToolRegistry([echoTool()]);

    // Baseline: with no colliding input, the tool is callable.
    const toolOnly = await runInSandbox('echo("wins")', { registry });
    ok(toolOnly);
    assert.equal(toolOnly.output, "wins");

    // With a colliding input, the name binds to the input value — which is a
    // string, so calling it fails. The tool is not reachable under that name.
    const shadowed = await runInSandbox(
      'echo("wins")',
      { registry },
      {
        inputs: { echo: "SHADOW" },
      },
    );
    err(shadowed);
    assert.match(shadowed.error, /not callable/);

    // And the bare name resolves to the input, confirming which binding won.
    const bare = await runInSandbox(
      "echo",
      { registry },
      {
        inputs: { echo: "SHADOW" },
      },
    );
    ok(bare);
    assert.equal(bare.output, "SHADOW");
  });
});

// ── Mount ─────────────────────────────────────────────────────────

describe("runInSandbox — mount", () => {
  // These read through the mount. The previous test ran `42` with a mount
  // configured and asserted the result was 42, which held whether the mount
  // worked, was ignored, or was never built — and a mount that silently does
  // nothing is exactly the failure this has to catch, because under `feedStart`
  // a filesystem call reaches the host as a snapshot and it is our dispatch
  // loop, not the interpreter, that decides whether the mounts get to answer.

  /** A temp dir holding one known file, cleaned up by the caller. */
  function mountFixture(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-mount-"));
    writeFileSync(join(dir, "note.txt"), "MOUNTED\n");
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("reads a file through a mounted directory", async () => {
    const { dir, cleanup } = mountFixture();
    try {
      const result = await runInSandbox(
        'open("/data/note.txt").read()',
        { registry: new ToolRegistry() },
        { mount: { "/data": dir } },
      );
      ok(result);
      assert.equal(result.output, "MOUNTED\n");
    } finally {
      cleanup();
    }
  });

  it("denies a path outside the mount", async () => {
    const { dir, cleanup } = mountFixture();
    try {
      const result = await runInSandbox(
        'try:\n    open("/elsewhere/note.txt").read()\nexcept Exception as e:\n    r = type(e).__name__\nr',
        { registry: new ToolRegistry() },
        { mount: { "/data": dir } },
      );
      ok(result);
      assert.match(result.output, /Error$/);
    } finally {
      cleanup();
    }
  });

  it("keeps the mount readable across a suspend and resume", async () => {
    // The mount has to be handed back at resume: host paths are not carried in
    // the dump, and a snapshot restored without them keeps running with every
    // read turned into a `PermissionError`. That silence is the whole risk —
    // hence an assertion on the file's contents after the resume, not on the
    // run merely completing.
    const { dir, cleanup } = mountFixture();
    try {
      const gate: HostTool = {
        name: "confirm",
        description: "Gated",
        params: [],
        returns: "str",
        requiresApproval: true,
        execute: () => "yes",
      };
      const registry = new ToolRegistry([gate]);
      const runOpts = { mount: { "/data": dir } };

      const susp = await runInSandbox(
        'confirm()\nopen("/data/note.txt").read()',
        { registry },
        { ...runOpts, onApproval: () => "suspend" as const },
      );
      suspended(susp);

      const result = await resumeSuspended(susp, true, { registry }, runOpts);
      ok(result);
      assert.equal(result.output, "MOUNTED\n");
    } finally {
      cleanup();
    }
  });
});

// ── resumeSuspended ──────────────────────────────────────────────

describe("resumeSuspended", () => {
  it("resume with approve → executes and continues", async () => {
    const gatedTool: HostTool = {
      name: "gated_echo",
      description: "Needs approval",
      params: [{ name: "x", type: "str", description: "Some value" }],
      returns: "str",
      requiresApproval: true,
      execute: (args) => `echo: ${args.x}`,
    };
    const registry = new ToolRegistry([gatedTool]);

    // First: suspend
    const susp = await runInSandbox(
      'gated_echo("hello")',
      { registry },
      { onApproval: () => "suspend" },
    );
    suspended(susp);
    assert.equal(susp.suspendedCall.tool, "gated_echo");
    assert.ok(susp.snapshot instanceof Buffer);
    assert.ok(susp.snapshot.length > 0);

    // Resume with approve
    const result = await resumeSuspended(susp, true, { registry });
    ok(result);
    assert.equal(result.output, "echo: hello");
  });

  it("resume with deny → PermissionError", async () => {
    const gatedTool: HostTool = {
      name: "gated_op",
      description: "Needs approval",
      params: [],
      returns: "str",
      requiresApproval: true,
      execute: () => "secret",
    };
    const registry = new ToolRegistry([gatedTool]);

    const susp = await runInSandbox(
      `
try:
    gated_op()
    result = "no-error"
except PermissionError:
    result = "blocked"
result
`,
      { registry },
      { onApproval: () => "suspend" },
    );
    suspended(susp);

    // Resume with deny
    const result = await resumeSuspended(susp, false, { registry });
    ok(result);
    assert.equal(result.output, "blocked");
  });

  it("resume with suspend again → RunSuspended", async () => {
    const gatedTool: HostTool = {
      name: "double_gate",
      description: "Needs approval",
      params: [],
      returns: "str",
      requiresApproval: true,
      execute: () => "ok",
    };
    const registry = new ToolRegistry([gatedTool]);

    const susp = await runInSandbox("double_gate()", { registry }, { onApproval: () => "suspend" });
    suspended(susp);

    // Resume with suspend again
    const result = await resumeSuspended(susp, "suspend", { registry });
    suspended(result);
    assert.equal(result.suspendedCall.tool, "double_gate");
    assert.ok(result.snapshot instanceof Buffer);
  });

  it("resume records ToolCallTrace with approved=true", async () => {
    const gatedTool: HostTool = {
      name: "traced",
      description: "Traced tool",
      params: [{ name: "v", type: "str", description: "Value" }],
      returns: "str",
      requiresApproval: true,
      execute: (args) => `got ${args.v}`,
    };
    const registry = new ToolRegistry([gatedTool]);

    const susp = await runInSandbox('traced("x")', { registry }, { onApproval: () => "suspend" });
    suspended(susp);

    const result = await resumeSuspended(susp, true, { registry });
    ok(result);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].tool, "traced");
    assert.equal(result.calls[0].ok, true);
    assert.equal(result.calls[0].approved, true);
  });

  it("resume continues execution after approval", async () => {
    const gatedTool: HostTool = {
      name: "first_step",
      description: "First step",
      params: [{ name: "x", type: "str", description: "Value" }],
      returns: "str",
      requiresApproval: true,
      execute: (args) => `step1: ${args.x}`,
    };
    const normalTool = echoTool();
    const registry = new ToolRegistry([gatedTool, normalTool]);

    // Python: call gated tool (suspends), then echo
    const susp = await runInSandbox(
      'x = first_step("a")\necho(x)',
      { registry },
      { onApproval: () => "suspend" },
    );
    suspended(susp);

    // Resume with approve → first_step executes, then echo runs
    const result = await resumeSuspended(susp, true, { registry });
    ok(result);
    // echo output = "step1: a" (the value first_step returned)
    assert.equal(result.output, "step1: a");
    assert.equal(result.calls.length, 2);
    assert.equal(result.calls[0].tool, "first_step");
    assert.equal(result.calls[1].tool, "echo");
  });

  it("resume preserves stdout from before and after suspension", async () => {
    const gatedTool: HostTool = {
      name: "gated",
      description: "Gated",
      params: [],
      returns: "str",
      requiresApproval: true,
      execute: () => "done",
    };
    const registry = new ToolRegistry([gatedTool]);

    const susp = await runInSandbox(
      'print("before")\ngated()\nprint("after")',
      { registry },
      { onApproval: () => "suspend" },
    );
    suspended(susp);
    assert.ok(susp.stdout.includes("before"));

    const result = await resumeSuspended(susp, true, { registry });
    ok(result);
    assert.ok(result.stdout.includes("before"));
    // Post-resume stdout IS captured because SnapshotLoadOptions.printCallback
    // re-attaches the callback during MontySnapshot.load()
    assert.ok(result.stdout.includes("after"));
  });
});

// ── SUBMIT integration ──────────────────────────────────────────

describe("SUBMIT in sandbox", () => {
  const rlmOpts = {
    onLLMQuery: async (p: string) => `llm:${p}`,
    onRLMQuery: async (q: string) => `rlm:${q}`,
  };

  it("returns status ok with the submitted answer", async () => {
    const rlmTools = createRLMTools(rlmOpts);
    const echo: HostTool = {
      name: "echo",
      description: "echo",
      params: [{ name: "text", type: "str", description: "" }],
      returns: "str",
      execute: (args) => String(args.text),
    };
    const registry = new ToolRegistry([...rlmTools, echo]);

    const result = await runInSandbox('x = echo("hello")\nSUBMIT(x)', { registry });

    ok(result);
    assert.equal(result.output, "hello");
  });

  it("SUBMIT call appears in calls with ok: true", async () => {
    const rlmTools = createRLMTools(rlmOpts);
    const registry = new ToolRegistry([...rlmTools]);

    const result = await runInSandbox('SUBMIT("done")', { registry });

    ok(result);
    assert.equal(result.output, "done");
    const submitCalls = result.calls.filter((c) => c.tool === "SUBMIT");
    assert.equal(submitCalls.length, 1);
    assert.equal(submitCalls[0].ok, true);
  });

  it("code after SUBMIT does not execute", async () => {
    const rlmTools = createRLMTools(rlmOpts);
    const echo: HostTool = {
      name: "echo",
      description: "echo",
      params: [{ name: "text", type: "str", description: "" }],
      returns: "str",
      execute: (args) => String(args.text),
    };
    const registry = new ToolRegistry([...rlmTools, echo]);

    const result = await runInSandbox('SUBMIT("first")\necho("never runs")', { registry });

    ok(result);
    assert.equal(result.output, "first");
    // echo should not be in the calls
    const echoCalls = result.calls.filter((c) => c.tool === "echo");
    assert.equal(echoCalls.length, 0);
  });

  it("first SUBMIT wins when called twice", async () => {
    const rlmTools = createRLMTools(rlmOpts);
    const registry = new ToolRegistry([...rlmTools]);

    const result = await runInSandbox('SUBMIT("first")\nSUBMIT("second")', { registry });

    ok(result);
    assert.equal(result.output, "first");
  });

  it("SUBMIT in resumeSuspended path works", async () => {
    // Use a gated tool before SUBMIT to force a suspend/resume cycle
    const rlmTools = createRLMTools(rlmOpts);
    const gatedTool: HostTool = {
      name: "gated",
      description: "Gated",
      params: [{ name: "val", type: "str", description: "" }],
      returns: "str",
      requiresApproval: true,
      execute: (args) => `gated:${args.val}`,
    };
    const registry = new ToolRegistry([...rlmTools, gatedTool]);

    // First: suspend on gated call
    const susp = await runInSandbox(
      'x = gated("foo")\nSUBMIT(x)',
      { registry },
      { onApproval: () => "suspend" },
    );
    suspended(susp);
    assert.equal(susp.suspendedCall.tool, "gated");

    // Resume with approval — execution should continue, then SUBMIT
    const result = await resumeSuspended(susp, true, { registry });
    ok(result);
    assert.equal(result.output, "gated:foo");
    const submitCalls = result.calls.filter((c) => c.tool === "SUBMIT");
    assert.equal(submitCalls.length, 1);
    assert.equal(submitCalls[0].ok, true);
  });

  it("SUBMIT with llm_query interaction", async () => {
    const rlmTools = createRLMTools(rlmOpts);
    const registry = new ToolRegistry([...rlmTools]);

    const result = await runInSandbox('response = llm_query("what is pi?")\nSUBMIT(response)', {
      registry,
    });

    ok(result);
    assert.equal(result.output, "llm:what is pi?");
  });

  it("SUBMIT with rlm_query interaction", async () => {
    const rlmTools = createRLMTools(rlmOpts);
    const registry = new ToolRegistry([...rlmTools]);

    const result = await runInSandbox('result = rlm_query("analyze", "data")\nSUBMIT(result)', {
      registry,
    });

    ok(result);
    assert.equal(result.output, "rlm:analyze");
  });
});

// ── Accumulator ownership (#27) ──────────────────────────────────
//
// `printCallback` and `onAbort` write to `acc`, and every early return
// reads `acc`. Before #27 both call sites built `DispatchAccumulators`
// by value from locals the callbacks kept mutating, so stdout produced
// after the first loop-dispatched tool call was discarded and a
// mid-run abort was a complete no-op.
//
// The pre-existing coverage does not reach any of this:
//   - "resume preserves stdout" (above) prints in `resumeSuspended`'s
//     prologue, before `acc` is built. One more tool call catches it.
//   - "aborted before start" (above) sets the flag at the pre-abort
//     check, also before `acc` is built — the one abort case the bug
//     leaves working.

describe("accumulator ownership — stdout after a dispatched tool call", () => {
  it("runInSandbox keeps stdout printed after loop-dispatched tool calls", async () => {
    const registry = new ToolRegistry([echoTool()]);
    const result = await runInSandbox(
      [
        'print("BEFORE_TOOL")',
        'x = echo("hi")',
        'print("AFTER_TOOL_1")',
        'y = echo("yo")',
        'print("AFTER_TOOL_2")',
      ].join("\n"),
      { registry },
    );
    ok(result);
    assert.equal(result.calls.length, 2);
    assert.ok(
      result.stdout.includes("BEFORE_TOOL"),
      `stdout lost pre-tool output: ${JSON.stringify(result.stdout)}`,
    );
    assert.ok(
      result.stdout.includes("AFTER_TOOL_1"),
      `stdout lost output after tool call 1: ${JSON.stringify(result.stdout)}`,
    );
    assert.ok(
      result.stdout.includes("AFTER_TOOL_2"),
      `stdout lost output after tool call 2: ${JSON.stringify(result.stdout)}`,
    );
  });

  it("resumeSuspended keeps stdout printed after loop-dispatched tool calls", async () => {
    const gatedTool: HostTool = {
      name: "gated",
      description: "Gated",
      params: [],
      returns: "str",
      requiresApproval: true,
      execute: () => "done",
    };
    const registry = new ToolRegistry([gatedTool, echoTool()]);

    const susp = await runInSandbox(
      [
        'print("BEFORE_SUSPEND")',
        "gated()",
        'print("PROLOGUE_AFTER")',
        'echo("x")',
        'print("LOOP_AFTER")',
      ].join("\n"),
      { registry },
      { onApproval: () => "suspend" },
    );
    suspended(susp);

    const result = await resumeSuspended(susp, true, { registry });
    ok(result);
    assert.equal(result.calls.length, 2);
    // Prologue output — captured even before #27.
    assert.ok(
      result.stdout.includes("PROLOGUE_AFTER"),
      `stdout lost prologue output: ${JSON.stringify(result.stdout)}`,
    );
    // Loop output — discarded before #27.
    assert.ok(
      result.stdout.includes("LOOP_AFTER"),
      `stdout lost output after the dispatched tool call: ${JSON.stringify(result.stdout)}`,
    );
  });

  it("reports stdoutTruncated when the overflow happens after a tool call", async () => {
    const registry = new ToolRegistry([echoTool()]);
    const result = await runInSandbox(
      ['echo("hi")', 'print("B" * 500)'].join("\n"),
      { registry },
      { maxStdoutBytes: 100 },
    );
    ok(result);
    assert.equal(
      result.stdoutTruncated,
      true,
      "stdoutTruncated must be true when post-tool output overflows the cap",
    );
  });
});

describe("accumulator ownership — mid-run abort", () => {
  /** A tool that aborts the signal the first time it is invoked. */
  function abortingTool(controller: AbortController): HostTool {
    let invocations = 0;
    return {
      name: "slow",
      description: "Aborts on first call",
      params: [],
      returns: "str",
      execute: async () => {
        invocations++;
        if (invocations === 1) controller.abort();
        await new Promise((resolve) => setImmediate(resolve));
        return `slow:${invocations}`;
      },
    };
  }

  it("runInSandbox stops the loop and skips the remaining tool calls", async () => {
    const controller = new AbortController();
    const registry = new ToolRegistry([abortingTool(controller)]);

    const result = await runInSandbox(
      ["a = slow()", "b = slow()", "c = slow()", '"finished-all-three"'].join("\n"),
      { registry },
      { signal: controller.signal },
    );

    err(result);
    assert.equal(result.errorKind, "aborted");
    assert.equal(
      result.calls.length,
      1,
      `abort fired during call 1; later calls must not run (ran ${result.calls.length})`,
    );
  });

  it("resumeSuspended stops the loop and skips the remaining tool calls", async () => {
    const controller = new AbortController();
    const gatedTool: HostTool = {
      name: "gated",
      description: "Gated",
      params: [],
      returns: "str",
      requiresApproval: true,
      execute: () => "done",
    };
    const registry = new ToolRegistry([gatedTool, abortingTool(controller)]);

    const susp = await runInSandbox(
      ["gated()", "a = slow()", "b = slow()", '"finished-both"'].join("\n"),
      { registry },
      { onApproval: () => "suspend" },
    );
    suspended(susp);

    const result = await resumeSuspended(
      susp,
      true,
      { registry },
      {
        signal: controller.signal,
      },
    );

    err(result);
    assert.equal(result.errorKind, "aborted");
    // gated (prologue) + slow #1 — slow #2 must not run.
    assert.equal(
      result.calls.length,
      2,
      `abort fired during the first dispatched call; later calls must not run (ran ${result.calls.length})`,
    );
  });
});

describe("abort before the resume prologue", () => {
  // The prologue runs the approved call *before* the dispatch loop, so the
  // loop's own abort check at its top is reached only once the side effect has
  // already happened. Every tool that reaches this path is a gated one — in the
  // shipped registry, `bash`, `write` or `edit` (#28).

  it("approve + aborted signal → aborted, and the gated tool never executes", async () => {
    let invocations = 0;
    const gatedTool: HostTool = {
      name: "gated_write",
      description: "Gated side effect",
      params: [],
      returns: "str",
      requiresApproval: true,
      execute: () => {
        invocations++;
        return "side-effect-happened";
      },
    };
    const registry = new ToolRegistry([gatedTool]);

    const susp = await runInSandbox("gated_write()", { registry }, { onApproval: () => "suspend" });
    suspended(susp);
    assert.equal(invocations, 0, "suspending must not run the tool");

    const controller = new AbortController();
    controller.abort();

    const result = await resumeSuspended(susp, true, { registry }, { signal: controller.signal });

    err(result);
    assert.equal(result.errorKind, "aborted");
    // The assertion the issue exists for: status alone would pass even if the
    // shell command had already run.
    assert.equal(
      invocations,
      0,
      `an aborted resume must not execute the gated tool (it ran ${invocations}x)`,
    );
    assert.deepEqual(result.calls, [], "no trace entry for a call that never ran");
  });

  it("deny + aborted signal → aborted, without resuming Python", async () => {
    const gatedTool: HostTool = {
      name: "gated_op",
      description: "Needs approval",
      params: [],
      returns: "str",
      requiresApproval: true,
      execute: () => "secret",
    };
    const registry = new ToolRegistry([gatedTool]);

    const susp = await runInSandbox(
      [
        "try:",
        "    gated_op()",
        '    result = "no-error"',
        "except PermissionError:",
        '    result = "blocked"',
        "result",
      ].join("\n"),
      { registry },
      { onApproval: () => "suspend" },
    );
    suspended(susp);

    const controller = new AbortController();
    controller.abort();

    const result = await resumeSuspended(susp, false, { registry }, { signal: controller.signal });

    // Resuming Python with the PermissionError would return ok/"blocked".
    err(result);
    assert.equal(result.errorKind, "aborted");
    assert.deepEqual(result.calls, [], "a denial that was never delivered leaves no trace entry");
  });
});

describe("resource-limit breach on the resume after a host tool call", () => {
  // The tool *succeeds*; the limit is breached by the Python that runs after it,
  // on the resume. Before #36 that resume sat inside the `try` guarding
  // `tool.execute`, so the breach reached a handler written for tool faults: it
  // pushed a second trace entry for a call already recorded `ok: true`, resumed
  // the already-consumed snapshot, and threw the resulting `GenericFailure` out
  // of a function typed to return a discriminated union.

  /** Sleeps, so wall-clock passes without Python executing an instruction. */
  function sleepTool(ms: number, overrides: Partial<HostTool> = {}): HostTool {
    return {
      name: "slow",
      description: "Sleeps for a while",
      params: [],
      returns: "str",
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return "done";
      },
      ...overrides,
    };
  }

  // Limits are only checked as Python executes instructions, so each snippet
  // has to keep working *after* the call returns — a tool that overruns with no
  // Python following it completes `ok`.
  //
  // The loop has to spend the whole 0.2 s budget by itself. Since 0.0.21 the
  // duration clock advances only while the interpreter executes and stops while
  // the sandbox is suspended on a host call, so the 250 ms sleep contributes
  // nothing (on 0.0.18 it was wall clock, and the sleep alone breached).
  //
  // So the loop's size is a bet on interpreter speed, and 5,000,000 lost it.
  // Measured: that loop took a median 752 ms on 0.0.21 and 463 ms on 0.0.23
  // on a Linux x64 dev box (~92 ns an iteration); on the macOS arm64 CI runner
  // the whole test took ~457 ms on 0.0.21 (250 ms sleep, loop cut off at
  // 0.2 s) but ~408 ms on 0.0.23 — the loop finished in ~158 ms, under the
  // budget, and the run came back `ok` (PR #218, run 34462982174).
  //
  // 200,000,000 is sized for hardware nobody here has: ~18.8 s of interpreter
  // time on that dev box, ~6.3 s at the arm64 runner's 0.0.23 rate (32x the
  // budget), and still ~0.94 s on a machine 20x faster than the dev box (4.7x).
  // It is bounded rather than `while True` on purpose: a broken duration limit
  // must fail as an assertion (the loop completes, the run is `ok`, `err()`
  // fails) in seconds, not hold a worker until the 300 s host wall clock.
  // Working limits cut it at 0.2 s whatever its size.
  const OVERRUN_THEN_LOOP = [
    "slow()",
    "total = 0",
    "for i in range(200000000):",
    "    total += i",
    "total",
  ].join("\n");
  const CALL_THEN_ALLOCATE = ["slow()", "big = [0] * 20000000", "len(big)"].join("\n");

  // The two limit kinds, each paired with the code that breaches it. Driving
  // the cases from one table is what makes this a property over limit kinds
  // rather than three examples that happen to agree.
  const LIMIT_KINDS = [
    {
      name: "duration",
      limits: { maxDurationSecs: 0.2 },
      code: OVERRUN_THEN_LOOP,
      toolMs: 250,
      expected: /TimeoutError/,
      errorKind: "timeout",
    },
    {
      // 16 MB, not 1 MB: a bare session now holds ~8.7 MB before the user's
      // first instruction, so a 1 MB ceiling is breached by the sandbox
      // starting up and the run fails before it can reach the gated call.
      name: "memory",
      limits: { maxDurationSecs: 30, maxMemory: 16 * 1024 * 1024 },
      code: CALL_THEN_ALLOCATE,
      toolMs: 1,
      expected: /MemoryError/,
      errorKind: "memory",
    },
  ] as const;

  /** Fails with the defect named, rather than letting the rejection bubble. */
  async function noThrow<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return assert.fail(`${label} threw instead of returning a RunError: ${message}`);
    }
  }

  for (const kind of LIMIT_KINDS) {
    it(`runInSandbox: a ${kind.name} breach returns a ${kind.errorKind} RunError`, async () => {
      const registry = new ToolRegistry([sleepTool(kind.toolMs)]);
      const result = await noThrow("runInSandbox", () =>
        runInSandbox(kind.code, { registry }, { limits: kind.limits }),
      );

      err(result);
      assert.equal(result.errorKind, kind.errorKind);
      assert.match(result.error, kind.expected);
    });

    it(`resumeSuspended: a ${kind.name} breach returns a ${kind.errorKind} RunError`, async () => {
      // The limit rides on the *initial* run, not the resume: `resumeSuspended`
      // is called with no `runOpts` at all here. `loadSnapshot` takes no
      // `limits` either — they belong to the checkout — so the budget in force
      // after a resume is the one the suspended feed was given, restored with
      // the snapshot and, on 0.0.21, still holding whatever it had already
      // spent.
      const registry = new ToolRegistry([sleepTool(kind.toolMs, { requiresApproval: true })]);
      const susp = await runInSandbox(
        kind.code,
        { registry },
        { limits: kind.limits, onApproval: () => "suspend" },
      );
      suspended(susp);

      const result = await noThrow("resumeSuspended", () =>
        resumeSuspended(susp, true, { registry }),
      );

      err(result);
      assert.equal(result.errorKind, kind.errorKind);
      assert.match(result.error, kind.expected);
    });
  }

  it("does not charge host-call time to the duration budget", async () => {
    // The inverted clock, asserted rather than assumed — it is the reason the
    // loop above had to grow, and the reason #32's host-side wall clock stops
    // being something `maxDurationSecs` covers by accident. A 400 ms sleep
    // under a 0.2 s budget, with almost no Python around it, completes.
    const registry = new ToolRegistry([sleepTool(400)]);
    const result = await noThrow("runInSandbox", () =>
      runInSandbox("slow()", { registry }, { limits: { maxDurationSecs: 0.2 } }),
    );

    assert.equal(result.status, "ok", "host-suspended time must not consume the budget");
  });

  it("traces the breached call exactly once, as the success it was", async () => {
    // The assertion the issue exists for. The old handler recorded the same
    // call twice — once `ok: true` from the success path, then again `ok: false`
    // when the resume's breach landed in the tool-fault branch.
    const registry = new ToolRegistry([sleepTool(250)]);
    const result = await noThrow("runInSandbox", () =>
      runInSandbox(OVERRUN_THEN_LOOP, { registry }, { limits: { maxDurationSecs: 0.2 } }),
    );

    err(result);
    assert.equal(result.calls.length, 1, `one call, one trace entry (got ${result.calls.length})`);
    assert.equal(result.calls[0].tool, "slow");
    assert.equal(result.calls[0].ok, true, "the tool returned; the breach was Python's, not its");
    assert.equal(result.calls[0].error, undefined);
  });

  it("holds for every limit kind across both entry points", async () => {
    for (const kind of LIMIT_KINDS) {
      const direct = await noThrow(`runInSandbox/${kind.name}`, () =>
        runInSandbox(
          kind.code,
          { registry: new ToolRegistry([sleepTool(kind.toolMs)]) },
          { limits: kind.limits },
        ),
      );

      const registry = new ToolRegistry([sleepTool(kind.toolMs, { requiresApproval: true })]);
      const susp = await runInSandbox(
        kind.code,
        { registry },
        { limits: kind.limits, onApproval: () => "suspend" },
      );
      suspended(susp);
      const resumed = await noThrow(`resumeSuspended/${kind.name}`, () =>
        resumeSuspended(susp, true, { registry }),
      );

      for (const [entry, result] of [
        ["runInSandbox", direct],
        ["resumeSuspended", resumed],
      ] as const) {
        const where = `${entry} / ${kind.name}`;
        err(result);
        assert.equal(result.errorKind, kind.errorKind, where);
        assert.match(result.error, kind.expected, where);
        assert.equal(result.calls.length, 1, `${where}: one trace entry`);
      }
    }
  });

  it("an uncaught PermissionError from a denied resume returns, rather than throwing", async () => {
    // The prologue's deny resume was outside any `try`. Every other deny test
    // wraps the call in Python `try/except`, so the uncaught path — the one a
    // model writes by default — was never exercised. Guarding it here is a
    // consequence of routing both prologue branches through one resume; the
    // session-wedging half of that defect stays with #50.
    const gated: HostTool = {
      name: "gated_op",
      description: "Needs approval",
      params: [],
      returns: "str",
      requiresApproval: true,
      execute: () => "secret",
    };
    const registry = new ToolRegistry([gated]);

    const susp = await runInSandbox("gated_op()", { registry }, { onApproval: () => "suspend" });
    suspended(susp);

    const result = await noThrow("resumeSuspended", () =>
      resumeSuspended(susp, false, { registry }),
    );

    err(result);
    assert.equal(result.errorKind, "runtime");
    assert.match(result.error, /PermissionError/);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].ok, false);
  });
});

describe("accumulator ownership — SubmitSignal in the resume prologue", () => {
  it("returns the SUBMIT answer and keeps the trace and stdout", async () => {
    const submitTool: HostTool = {
      name: "finish",
      description: "Submits an answer",
      params: [{ name: "answer", type: "str", description: "Answer" }],
      returns: "str",
      requiresApproval: true,
      execute: (args) => {
        throw new SubmitSignal(String(args.answer));
      },
    };
    const registry = new ToolRegistry([submitTool]);

    const susp = await runInSandbox(
      ['print("BEFORE_SUBMIT")', 'finish("the-answer")'].join("\n"),
      { registry },
      { onApproval: () => "suspend" },
    );
    suspended(susp);

    const result = await resumeSuspended(susp, true, { registry });
    ok(result);
    assert.equal(result.output, "the-answer");
    assert.ok(result.stdout.includes("BEFORE_SUBMIT"));
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].tool, "finish");
    assert.equal(result.calls[0].ok, true);
    assert.equal(result.calls[0].approved, true);
  });
});

// ── Stdout truncation policy (#29) ───────────────────────────────
//
// Asserts docs/truncation-policy.md through the sandbox. The unit-level
// coverage of the truncator itself lives in test/truncate.test.ts; these are
// the properties that must survive the trip through Monty's print callback and
// both entry points.

describe("stdout truncation — the budget is a ceiling", () => {
  const registry = new ToolRegistry();
  const size = (s: string) => Buffer.byteLength(s, "utf8");

  it("stays within a 10-byte cap on 50 multibyte characters (M1)", async () => {
    // Before: 42 bytes / 32 chars returned. A byte budget was handed to
    // String.slice, which counts characters — 10 chars of "é" is 20 bytes —
    // and the 22-byte marker was appended after the budget was spent.
    const result = await runInSandbox('print("é" * 50)', { registry }, { maxStdoutBytes: 10 });
    ok(result);
    assert.ok(
      size(result.stdout) <= 10,
      `got ${size(result.stdout)} bytes / ${result.stdout.length} chars for a 10-byte cap`,
    );
    assert.ok(!result.stdout.includes("\uFFFD"), "truncation introduced U+FFFD");
    assert.equal(result.stdoutTruncated, true);
  });

  it("holds for every character width, on both entry points (M11/M12)", async () => {
    const gated: HostTool = {
      name: "gated",
      description: "Gated",
      params: [],
      returns: "str",
      requiresApproval: true,
      execute: () => "done",
    };

    for (const char of ["A", "é", "日", "😀"]) {
      for (const cap of [64, 200, 1024, 4096]) {
        const direct = await runInSandbox(
          `print(${JSON.stringify(char)} * 5000)`,
          { registry },
          { maxStdoutBytes: cap },
        );
        ok(direct);
        assert.ok(
          size(direct.stdout) <= cap,
          `runInSandbox ${char} @ ${cap}: ${size(direct.stdout)} bytes`,
        );
        assert.ok(!direct.stdout.includes("\uFFFD"), `runInSandbox ${char} @ ${cap}: U+FFFD`);

        const susp = await runInSandbox(
          `gated()\nprint(${JSON.stringify(char)} * 5000)`,
          { registry: new ToolRegistry([gated]) },
          { onApproval: () => "suspend", maxStdoutBytes: cap },
        );
        suspended(susp);
        const resumed = await resumeSuspended(
          susp,
          true,
          { registry: new ToolRegistry([gated]) },
          { maxStdoutBytes: cap },
        );
        ok(resumed);
        assert.ok(
          size(resumed.stdout) <= cap,
          `resumeSuspended ${char} @ ${cap}: ${size(resumed.stdout)} bytes`,
        );
        assert.ok(!resumed.stdout.includes("\uFFFD"), `resumeSuspended ${char} @ ${cap}: U+FFFD`);
      }
    }
  });

  it("keeps both ends of a long stream", async () => {
    const result = await runInSandbox(
      'print("FIRST_LINE")\nfor i in range(20000):\n    print("filler", i)\nprint("LAST_LINE")',
      { registry },
      { maxStdoutBytes: 4096 },
    );
    ok(result);
    assert.ok(result.stdout.includes("FIRST_LINE"), "head lost");
    assert.ok(result.stdout.includes("LAST_LINE"), "tail lost");
    assert.ok(size(result.stdout) <= 4096);
  });

  it("the marker states the true magnitude and a recovery route", async () => {
    const result = await runInSandbox(
      'for i in range(20000):\n    print("a line of output", i)',
      { registry },
      { maxStdoutBytes: 4096 },
    );
    ok(result);
    assert.match(result.stdout, /\[… [\d.]+KB of [\d.]+KB elided \(lines \d+-\d+ of \d+\)\./);
    assert.match(result.stdout, /Re-run with a narrower print to see more/);
  });
});

describe("stdout truncation — onPrint is not the model's budget (M9)", () => {
  const registry = new ToolRegistry();

  it("keeps streaming to onPrint after the model's copy is truncated", async () => {
    // Before: `if (stdoutTruncated) return;` sat above the onPrint call, so
    // the human's terminal went silent the moment the model's cap was hit.
    const prints: string[] = [];
    const result = await runInSandbox(
      'for i in range(2000):\n    print("line", i)',
      { registry },
      { maxStdoutBytes: 200, onPrint: (text) => prints.push(text) },
    );
    ok(result);
    assert.equal(result.stdoutTruncated, true);
    const streamed = prints.join("");
    assert.ok(
      Buffer.byteLength(streamed) > 200,
      `onPrint stopped at the model's cap: ${Buffer.byteLength(streamed)} bytes`,
    );
    assert.ok(streamed.includes("line 1999"), "the last line never reached onPrint");
  });
});

// ── Exactly at the cap is within it (bucket 2, exit criterion 4) ──
//
// `Truncator.overBudget` compares with `>` on bytes and on lines. Mutating
// either to `>=` left test/truncate.test.ts and this file green (#24's M11 and
// M12 survivors): every test overshot the cap by a wide margin or stayed well
// under it. These sit exactly on the boundary, on both entry points, so the
// mutant fails. Guards — green immediately.

describe("stdout truncation — exactly at the cap is not truncated (bucket 2, exit criterion 4)", () => {
  const registry = new ToolRegistry();
  const size = (s: string) => Buffer.byteLength(s, "utf8");
  const gated: HostTool = {
    name: "gated",
    description: "Gated",
    params: [],
    returns: "str",
    requiresApproval: true,
    execute: () => "done",
  };

  it("runInSandbox: stdout of exactly maxStdoutBytes is whole and not truncated", async () => {
    // Nine bytes of payload plus the newline `print` appends: 10 against 10.
    const result = await runInSandbox('print("A" * 9)', { registry }, { maxStdoutBytes: 10 });
    ok(result);
    assert.equal(result.stdout, `${"A".repeat(9)}\n`);
    assert.equal(size(result.stdout), 10);
    assert.equal(result.stdoutTruncated, false, "exactly at the cap is within it");
  });

  it("resumeSuspended: stdout of exactly maxStdoutBytes after the resume is whole and not truncated", async () => {
    const gatedRegistry = new ToolRegistry([gated]);
    const susp = await runInSandbox(
      'gated()\nprint("A" * 9)',
      { registry: gatedRegistry },
      { onApproval: () => "suspend", maxStdoutBytes: 10 },
    );
    suspended(susp);
    assert.equal(susp.stdout, "", "nothing may be printed before the gate");

    const result = await resumeSuspended(
      susp,
      true,
      { registry: gatedRegistry },
      { maxStdoutBytes: 10 },
    );
    ok(result);
    assert.equal(result.stdout, `${"A".repeat(9)}\n`);
    assert.equal(result.stdoutTruncated, false, "exactly at the cap is within it");
  });

  it("a multibyte stream landing exactly on the cap is not truncated", async () => {
    // Four 2-byte characters plus the newline: 9 against 9.
    const result = await runInSandbox('print("é" * 4)', { registry }, { maxStdoutBytes: 9 });
    ok(result);
    assert.equal(result.stdout, "éééé\n");
    assert.equal(result.stdoutTruncated, false);
  });

  it("exactly STDOUT_MAX_LINES lines is not truncated, and one more is", async () => {
    const atCap = await runInSandbox(
      `for i in range(${STDOUT_MAX_LINES}):\n    print("x")`,
      { registry },
      { maxStdoutBytes: 64 * 1024 },
    );
    ok(atCap);
    assert.equal(atCap.stdout, "x\n".repeat(STDOUT_MAX_LINES));
    assert.equal(atCap.stdoutTruncated, false, "exactly the line budget is within it");

    const over = await runInSandbox(
      `for i in range(${STDOUT_MAX_LINES + 1}):\n    print("x")`,
      { registry },
      { maxStdoutBytes: 64 * 1024 },
    );
    ok(over);
    assert.equal(over.stdoutTruncated, true, "one line past the budget is truncated");
  });
});

// ── Output truncation policy (#34) ───────────────────────────────

describe("output truncation — the [result] field is bounded", () => {
  const registry = new ToolRegistry();
  const size = (s: string) => Buffer.byteLength(s, "utf8");

  it("caps a 2 MB final expression at 16 KiB (M2)", async () => {
    // Before: `output` had no cap of any kind, so a bare expression put
    // 2,000,000 bytes straight into the model's context.
    const result = await runInSandbox("'A' * 2000000", { registry });
    ok(result);
    assert.ok(
      size(result.output) <= 16 * 1024,
      `got ${size(result.output)} bytes for a 16 KiB budget`,
    );
    assert.equal(result.outputTruncated, true);
  });

  it("holds the ceiling for every character width", async () => {
    for (const char of ["A", "é", "日", "😀"]) {
      for (const cap of [200, 1024, 4096, 16 * 1024]) {
        const result = await runInSandbox(
          `${JSON.stringify(char)} * 50000`,
          { registry },
          { maxOutputBytes: cap },
        );
        ok(result);
        assert.ok(size(result.output) <= cap, `${char} @ ${cap}: ${size(result.output)} bytes`);
        assert.ok(
          !result.output.includes("\uFFFD"),
          `${char} @ ${cap}: truncation introduced U+FFFD`,
        );
      }
    }
  });

  it("keeps both ends of the value, 50/50", async () => {
    // A head-only cut of a long list looks exactly like a short list.
    const result = await runInSandbox(
      "x = [i for i in range(5000)]\nx",
      { registry },
      { maxOutputBytes: 1024 },
    );
    ok(result);
    // W3-1: the list renders as Python spells it and is elided between its
    // elements (D140); before, `String(list)` gave `0,1,2,3` and a flat cut.
    assert.ok(result.output.startsWith("[0, 1, 2, 3"), "head lost");
    assert.ok(result.output.endsWith("4999]"), "tail lost");
    const marker = result.output.indexOf("[…");
    assert.ok(marker > 0, "marker missing");
    assert.ok(result.output.indexOf("4999") > marker, "the marker must sit between head and tail");
  });

  it("the marker states magnitude and a recovery route that exists", async () => {
    const result = await runInSandbox("'A' * 2000000", { registry }, { maxOutputBytes: 1024 });
    ok(result);
    assert.match(result.output, /\[… [\d.]+MB of [\d.]+MB elided\./);
    assert.match(result.output, /Assign the value to a name and slice it/);
    // No line range: a single value has no lines.
    assert.ok(!result.output.includes("lines "));
  });

  it("leaves a small value untouched", async () => {
    const result = await runInSandbox("1 + 1", { registry });
    ok(result);
    assert.equal(result.output, "2");
    assert.equal(result.outputTruncated, false);
  });

  it("caps the SUBMIT path on the same terms", async () => {
    // One field, one policy: a second truncation rule reachable through a
    // different return site is the drift the policy document exists to stop.
    const submitTool: HostTool = {
      name: "finish",
      description: "Submits an answer",
      params: [{ name: "answer", type: "str", description: "Answer" }],
      returns: "str",
      execute: (args) => {
        throw new SubmitSignal(String(args.answer));
      },
    };
    const result = await runInSandbox(
      'finish("Z" * 100000)',
      { registry: new ToolRegistry([submitTool]) },
      { maxOutputBytes: 1024 },
    );
    ok(result);
    assert.ok(size(result.output) <= 1024, `got ${size(result.output)} bytes`);
    assert.equal(result.outputTruncated, true);
  });

  it("caps the SUBMIT path through resumeSuspended too", async () => {
    const submitTool: HostTool = {
      name: "finish",
      description: "Submits an answer",
      params: [{ name: "answer", type: "str", description: "Answer" }],
      returns: "str",
      requiresApproval: true,
      execute: (args) => {
        throw new SubmitSignal(String(args.answer));
      },
    };
    const registryWithSubmit = new ToolRegistry([submitTool]);
    const susp = await runInSandbox(
      'finish("Z" * 100000)',
      { registry: registryWithSubmit },
      { onApproval: () => "suspend" },
    );
    suspended(susp);
    const result = await resumeSuspended(
      susp,
      true,
      { registry: registryWithSubmit },
      { maxOutputBytes: 1024 },
    );
    ok(result);
    assert.ok(size(result.output) <= 1024, `got ${size(result.output)} bytes`);
  });
});

describe("output truncation — the total tool-result budget", () => {
  const registry = new ToolRegistry();
  const size = (s: string) => Buffer.byteLength(s, "utf8");

  it("bounds one result at 48 KiB, split 32/16 with no borrowing", async () => {
    // Fixed sub-budgets, deliberately: with borrowing, the same code truncates
    // differently depending on how much the other field happened to use, and a
    // truncation bug stops being reproducible.
    const result = await runInSandbox(
      'for i in range(50000):\n    print("a line of output", i)\n"B" * 2000000',
      { registry },
    );
    ok(result);
    assert.ok(size(result.stdout) <= 32 * 1024, `stdout: ${size(result.stdout)} bytes`);
    assert.ok(size(result.output) <= 16 * 1024, `output: ${size(result.output)} bytes`);
    assert.ok(
      size(result.stdout) + size(result.output) <= 48 * 1024,
      `total: ${size(result.stdout) + size(result.output)} bytes`,
    );
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.outputTruncated, true);
  });

  it("a large output does not shrink the stdout budget", async () => {
    const withBigOutput = await runInSandbox(
      'for i in range(50000):\n    print("a line of output", i)\n"B" * 2000000',
      { registry },
    );
    const withSmallOutput = await runInSandbox(
      'for i in range(50000):\n    print("a line of output", i)\n1',
      { registry },
    );
    ok(withBigOutput);
    ok(withSmallOutput);
    assert.equal(
      size(withBigOutput.stdout),
      size(withSmallOutput.stdout),
      "stdout must not depend on how much output used",
    );
  });
});

describe("memory guards", () => {
  const registry = new ToolRegistry([]);

  /** Restores whatever the env held, including "was not set at all". */
  async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      return await fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  // A ceiling of 1 MB is below any live node process, so this fires on the
  // first call without having to actually leak 5 GB to prove the point.
  it("refuses to run when the process is at its RSS ceiling", async () => {
    await withEnv({ REPL_MEMORY_CEILING_MB: "1" }, async () => {
      await assert.rejects(
        () => runInSandbox("1 + 1", { registry }),
        (e: Error) => e.name === "SandboxMemoryError" && /ceiling/.test(e.message),
      );
    });
  });

  // Symmetrically, a floor larger than any plausible host trips immediately.
  // Skipped where MemAvailable cannot be read, since the guard is a no-op there.
  it("refuses to run when the host is below its available-memory floor", async (t) => {
    if (!existsSync("/proc/meminfo")) return t.skip("no /proc/meminfo on this platform");
    await withEnv({ REPL_MEMORY_CEILING_MB: "0", REPL_MEMORY_FLOOR_MB: "999999999" }, async () => {
      await assert.rejects(
        () => runInSandbox("1 + 1", { registry }),
        (e: Error) => e.name === "SandboxMemoryError" && /floor/.test(e.message),
      );
    });
  });

  it("both guards are disabled by zero", async () => {
    await withEnv({ REPL_MEMORY_CEILING_MB: "0", REPL_MEMORY_FLOOR_MB: "0" }, async () => {
      assert.deepEqual(
        memoryGuardConfig(),
        { ceilingMb: 0, floorMb: 0 },
        "0 disables, not defaults",
      );
      const result = await runInSandbox("1 + 1", { registry });
      assert.equal(result.status, "ok");
    });
  });

  // Without this, shipping both defaults as 0 — the feature entirely off —
  // passes every other test in this block, because they all set the
  // environment explicitly. This is the test that fails on that change.
  it("the shipped default ceiling is live, and the floor is opt-in", () => {
    const { ceilingMb, floorMb } = memoryGuardConfig();
    assert.ok(ceilingMb >= 1024, `default ceiling must be a real limit, got ${ceilingMb} MB`);
    assert.equal(floorMb, 0, "the host floor is deliberately opt-in for a shipped library");
  });

  // /proc/meminfo is not namespaced, so a container's limit is invisible to it.
  it("a cgroup limit is accounted for where one exists", () => {
    if (!existsSync("/sys/fs/cgroup/memory.max") && !existsSync("/proc/self/cgroup")) return;
    const { ceilingMb } = memoryGuardConfig();
    assert.ok(ceilingMb > 0 && Number.isFinite(ceilingMb));
  });

  // The guard has to sit on resume too: a suspended run resumes into the same
  // leaking interpreter, and #36 made resume a first-class entry point.
  it("guards resumeSuspended as well as runInSandbox", async () => {
    const gated = new ToolRegistry([makeTool({ requiresApproval: true })]);
    const susp = await runInSandbox(
      'echo("hi")',
      { registry: gated },
      {
        onApproval: () => "suspend",
      },
    );
    suspended(susp);
    await withEnv({ REPL_MEMORY_CEILING_MB: "1" }, async () => {
      await assert.rejects(
        () => resumeSuspended(susp, true, { registry: gated }),
        (e: Error) => e.name === "SandboxMemoryError",
      );
    });
  });
});

// ── Tool names as values (#66) ──────────────────────────────────

describe("host tools survive being used as values", () => {
  // On 0.0.18 a name lookup was answered with a shared `SENTINEL` function and
  // the real tool was recovered from the *call*, so a tool only worked when
  // called directly by its own name. Anything that stored it first — an alias,
  // a list, an argument — called the sentinel and raised
  // `NameError: SENTINEL` (#66). 0.0.21 resolves the lookup to the name
  // itself, so the sandbox holds a proxy that reports the right name whenever
  // it is eventually called.
  //
  // These are the regression tests bucket 8 requires before #66 can be closed
  // as fixed upstream; closing it is not this change's business.

  it("dispatches a tool reached through an alias", async () => {
    const registry = new ToolRegistry([echoTool()]);
    const result = await runInSandbox('f = echo\nf("aliased")', { registry });

    ok(result);
    assert.match(result.output, /aliased/);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].tool, "echo");
  });

  it("dispatches a tool stored in a collection", async () => {
    const registry = new ToolRegistry([echoTool()]);
    const result = await runInSandbox('tools = [echo]\ntools[0]("via list")', { registry });

    ok(result);
    assert.match(result.output, /via list/);
    assert.equal(result.calls[0].tool, "echo");
  });

  it("raises NameError when an unregistered name is read as a value", async () => {
    const registry = new ToolRegistry([echoTool()]);
    const result = await runInSandbox("f = definitely_not_a_tool\nf()", { registry });

    err(result);
    assert.deepEqual(result.calls, [], "a name that resolves to nothing is not a call");
  });
});

// ── Class instances as tool arguments (Monty 0.0.23) ─────────────
//
// 0.0.21 turned an instance into Monty's repr string before a host tool saw
// it: the tool received "<C object at 0x2>" or "P(x=1)" (measured by review).
// 0.0.23 hands over a `MontyClassProxy`, whose JSON carries a fresh uuid on
// every run and every attribute, and every consumer of the arguments — the
// tool, the replay cache key, the approval description, the trace persisted
// through `details` — saw that JSON. An untyped helper parameter carries an
// instance past the type checker, so ordinary model code does this.

describe("a class instance passed to a host tool arrives as its repr, never as a proxy (0.0.23)", () => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
  const DC = "from dataclasses import dataclass\n@dataclass\nclass P:\n    x: int\n";
  /** JSON that spells a Map as an object, so a uuid inside a dict argument is visible. */
  const json = (value: unknown) =>
    JSON.stringify(value, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v));

  /** A one-parameter tool that records exactly what `execute` received. */
  function recordingTool(name = "echo", overrides: Partial<HostTool> = {}) {
    const received: unknown[] = [];
    const tool = makeTool({
      name,
      execute: (args) => {
        received.push(args.text);
        return "ok";
      },
      ...overrides,
    });
    return { tool, received };
  }

  it("a plain instance through an untyped helper: the tool and the trace see `<C object>`, no attributes", async () => {
    const { tool, received } = recordingTool();
    const result = await runInSandbox(
      "class C:\n    def __init__(self):\n        self.password = 'hunter2'\ndef g(v):\n    return echo(v)\ng(C())",
      { registry: new ToolRegistry([tool]) },
    );
    ok(result);
    assert.deepEqual(received, ["<C object>"]);
    assert.deepEqual(result.calls[0].args, ["<C object>"]);
    assert.doesNotMatch(json(result.calls), UUID);
    assert.doesNotMatch(json(result.calls), /hunter2|password/, "an attribute reached the trace");
  });

  it("a dataclass arrives as its field repr, passed by keyword too", async () => {
    const { tool, received } = recordingTool();
    const result = await runInSandbox(`${DC}def g(v):\n    return echo(text=v)\ng(P(1))`, {
      registry: new ToolRegistry([tool]),
    });
    ok(result);
    assert.deepEqual(received, ["P(x=1)"]);
    // Spread: Monty's kwargs record has a null prototype, and normalising keeps it.
    assert.deepEqual({ ...result.calls[0].kwargs }, { text: "P(x=1)" });
    assert.doesNotMatch(json(result.calls), UUID);
  });

  it("instances nested inside a list or a dict argument are each replaced in place", async () => {
    const { tool, received } = recordingTool();
    const result = await runInSandbox(
      `${DC}class C:\n    pass\ndef g(v):\n    return echo(v)\ng([C(), {'k': P(2)}, 'plain'])`,
      { registry: new ToolRegistry([tool]) },
    );
    ok(result);
    const [arg] = received as [unknown[]];
    assert.equal(arg[0], "<C object>");
    assert.ok(arg[1] instanceof Map, `a dict argument must stay a dict: ${json(arg[1])}`);
    assert.equal((arg[1] as Map<string, unknown>).get("k"), "P(x=2)");
    assert.equal(arg[2], "plain");
    assert.doesNotMatch(json(received), UUID);
    assert.doesNotMatch(json(result.calls), UUID);
  });

  it("a gated tool is asked about the repr, with no uuid and no attribute dump", async () => {
    const { tool, received } = recordingTool("gate", { requiresApproval: true });
    const asked: ApprovalRequest[] = [];
    const result = await runInSandbox(
      "class C:\n    def __init__(self):\n        self.token = 'sk-secret'\ndef g(v):\n    return gate(v)\ng(C())",
      { registry: new ToolRegistry([tool]) },
      {
        onApproval: (request) => {
          asked.push(request);
          return true;
        },
      },
    );
    ok(result);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].description, 'gate(text="<C object>")');
    assert.deepEqual(asked[0].args, ["<C object>"]);
    assert.doesNotMatch(json(asked), UUID);
    assert.doesNotMatch(json(asked), /sk-secret|token/);
    assert.deepEqual(received, ["<C object>"]);
  });

  it("a suspended call carries the repr across resumeSuspended", async () => {
    const { tool, received } = recordingTool("gate", { requiresApproval: true });
    const registry = new ToolRegistry([tool]);
    const paused = await runInSandbox(
      `${DC}def g(v):\n    return gate(v)\ng(P(3))`,
      { registry },
      { onApproval: () => "suspend" },
    );
    suspended(paused);
    assert.equal(paused.suspendedCall.description, 'gate(text="P(x=3)")');
    ok(await resumeSuspended(paused, true, { registry }));
    assert.deepEqual(received, ["P(x=3)"]);
  });
});

// ── Calls that never reach a tool ───────────────────────────────

describe("dispatch failures before a tool runs", () => {
  it("raises TypeError when an argument arrives twice", async () => {
    // Unpacked through `**kwargs`, because the static check sees the stub and
    // rejects a literal `echo("a", text="b")` before anything runs. This is
    // the shape that reaches argument resolution at runtime, and it is where
    // the host's own duplicate-argument message comes from rather than ty's.
    const registry = new ToolRegistry([echoTool()]);
    const result = await runInSandbox(
      'kw = {"text": "b"}\ntry:\n    echo("a", **kw)\nexcept TypeError as e:\n    r = "caught: " + str(e)\nr',
      { registry },
    );

    ok(result);
    assert.match(result.output, /got multiple values for argument 'text'/);
    assert.equal(result.calls.length, 1, "the attempt is traced");
    assert.equal(result.calls[0].ok, false);
  });
});

// ── Type-check diagnostics reach the caller whole ───────────────

describe("typing errors report every diagnostic", () => {
  // `MontyTypingError.message` keeps only the first line of the rendered
  // diagnostics; the rest — including the source echo that `typeCheckFormat`
  // is chosen for — lives on `display()`. Reporting `message` looks correct on
  // any single-error snippet, which is why this asserts on one with two.

  it("reports both unresolved names, not just the first", async () => {
    const result = await runInSandbox("print(alpha)\nprint(beta)", {
      registry: new ToolRegistry(),
    });

    err(result);
    assert.equal(result.errorKind, "typing");
    assert.match(result.error, /alpha/);
    assert.match(result.error, /beta/, "the second diagnostic must survive");
  });

  it("includes the offending source line", async () => {
    const result = await runInSandbox("x: int = 'nope'", { registry: new ToolRegistry() });

    err(result);
    assert.match(result.error, /x: int = 'nope'/, "the source echo must survive");
  });
});

// ── A worker that dies ──────────────────────────────────────────

describe("a crashed sandbox worker", () => {
  // The in-sandbox duration limit is only checked at interpreter checkpoints,
  // so a single long primitive runs straight past it; the host watchdog then
  // kills the worker `durationLimitGrace` later. That is the one path to
  // `MontyCrashedError`, and it has no 0.0.18 analogue — there the same code
  // froze the event loop until something SIGKILLed the whole process.
  //
  // The primitive has to outlast the kill point (the 0.5 s budget plus the
  // watchdog's grace: `crashed` after ~1.55 s, measured) on any runner.
  // `10 ** 100000000` finished in ~43 s unenforced on a Linux x64 dev box, which
  // left ~10x on the macOS arm64 CI runner and ~1.4x on a machine 20x faster
  // than that box. `10 ** 200000000` was still computing when a 60 s budget
  // killed it (measured), so at least 40x here, and it still ends in a crash
  // at ~1.5 s whatever its size.
  const UNCHECKPOINTED_RUNAWAY = "x = 10 ** 200000000\n1";

  it("returns errorKind 'crashed', not 'runtime'", async () => {
    const result = await runInSandbox(
      UNCHECKPOINTED_RUNAWAY,
      { registry: new ToolRegistry() },
      { limits: { maxDurationSecs: 0.5 } },
    );

    err(result);
    assert.equal(result.errorKind, "crashed");
    assert.match(result.error, /time budget/, "a watchdog kill says so");
  });

  it("leaves the pool able to serve the next run", async () => {
    // The point of worker isolation: the dead session is replaced, and the
    // caller after it is unaffected. `withSandboxSession` has to survive
    // closing a session whose worker is already gone for this to hold.
    await runInSandbox(
      UNCHECKPOINTED_RUNAWAY,
      { registry: new ToolRegistry() },
      { limits: { maxDurationSecs: 0.5 } },
    );

    const after = await runInSandbox("1 + 1", { registry: new ToolRegistry() });
    ok(after);
    assert.equal(after.output, "2");
  });
});

// ── Default resource limits ─────────────────────────────────────

describe("the shipped resource limits", () => {
  // Before #32 a caller who passed no `limits` got none, and nothing in this
  // repository passed any — so the shipped configuration was an unbounded
  // sandbox. On 0.0.21 that is not merely permissive: an unbounded runaway
  // never returns and never releases its pooled worker, so
  // `REPL_POOL_MAX_PROCESSES` of them deny service to every later caller in
  // the process, including one running `1 + 1`.
  //
  // Every test here that relies on a default sets it small through the
  // environment. A suite that waited out the real 30 s budget would be a suite
  // nobody runs, and one that asserted only explicit limits would have passed
  // against the fail-open version.

  const registry = new ToolRegistry();

  /** Runs `fn` with env vars applied, restoring whatever was there before. */
  async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
    const prior: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      prior[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("ships a finite duration, memory and wall-clock budget", () => {
    // The assertion every other test here cannot make, because every other
    // test sets its own: shipping all three as unlimited would pass them all.
    const { maxDurationSecs, maxMemory, maxWallClockSecs } = limitsConfig();
    assert.ok(maxDurationSecs > 0 && Number.isFinite(maxDurationSecs));
    assert.ok(maxMemory > 0 && Number.isFinite(maxMemory));
    assert.ok(maxWallClockSecs > 0 && Number.isFinite(maxWallClockSecs));
  });

  it("reads the environment at call time, rejecting values that are not positive", async () => {
    const shipped = limitsConfig();
    await withEnv({ REPL_MAX_DURATION_SECS: "7", REPL_MAX_MEMORY_MB: "64" }, async () => {
      assert.equal(limitsConfig().maxDurationSecs, 7);
      assert.equal(limitsConfig().maxMemory, 64 * 1_048_576);
    });
    for (const bad of ["0", "-1", "not-a-number", ""]) {
      await withEnv({ REPL_MAX_DURATION_SECS: bad }, async () => {
        assert.equal(
          limitsConfig().maxDurationSecs,
          shipped.maxDurationSecs,
          `'${bad}' should not become the duration budget — a 0 s budget runs nothing`,
        );
      });
    }
  });

  it("a runaway loop with no limits argument times out on the default budget", async () => {
    // Test 1 of the issue. `while True: pass` is the case that motivated all of
    // this: no host timer can interrupt it, no abort signal reaches it, and
    // before #32 it ran until the process was killed.
    await withEnv({ REPL_MAX_DURATION_SECS: "1" }, async () => {
      const started = Date.now();
      const result = await runInSandbox("while True: pass", { registry });

      err(result);
      assert.equal(result.errorKind, "timeout");
      assert.match(result.error, /TimeoutError/);
      assert.ok(
        Date.now() - started < 15_000,
        "the default budget has to bound it, not the test runner's patience",
      );
    });
  });

  it("a memory bomb with no limits argument fails on the default ceiling", async () => {
    // Test 2. Enforced inside the worker as a catchable error rather than an
    // OOM kill, so the host survives and the caller is told why.
    await withEnv({ REPL_MAX_MEMORY_MB: "32" }, async () => {
      const result = await runInSandbox("x = [0] * 20000000\nlen(x)", { registry });

      err(result);
      assert.equal(result.errorKind, "memory");
      assert.match(result.error, /MemoryError/);
    });
  });

  it("limits: 'unbounded' genuinely disables the ceiling", async () => {
    // Test 3. An escape hatch that quietly kept enforcing would be worse than
    // none: the caller believes they opted out. Paired with the same code under
    // the same environment, so the only difference is the opt-out itself.
    await withEnv({ REPL_MAX_MEMORY_MB: "32" }, async () => {
      const bounded = await runInSandbox("x = [0] * 20000000\nlen(x)", { registry });
      err(bounded);
      assert.equal(
        bounded.errorKind,
        "memory",
        "the default has to be enforcing for this to mean anything",
      );

      const unbounded = await runInSandbox(
        "x = [0] * 20000000\nlen(x)",
        { registry },
        {
          limits: "unbounded",
        },
      );
      ok(unbounded);
      assert.equal(unbounded.output, "20000000");
    });
  });

  it("passes every knob the caller sets through to Monty", async () => {
    // Test 6, the field-by-field half. `gcInterval` has no observable effect at
    // this level, so a silent drop of it — precisely the defect #32 fixes — is
    // catchable only against the mapping itself.
    assert.deepEqual(
      toResourceLimits({
        maxDurationSecs: 3,
        maxMemory: 7 * 1_048_576,
        gcInterval: 500,
        maxRecursionDepth: 64,
        maxSuspensions: 11,
      }),
      {
        maxDurationSecs: 3,
        maxMemory: 7 * 1_048_576,
        gcInterval: 500,
        maxRecursionDepth: 64,
        maxSuspensions: 11,
      },
    );

    // Unset knobs take the default; `maxWallClockSecs` is the host's and is not
    // Monty's to receive.
    const defaults = limitsConfig();
    assert.deepEqual(toResourceLimits({ maxWallClockSecs: 9 }), {
      maxDurationSecs: defaults.maxDurationSecs,
      maxMemory: defaults.maxMemory,
      gcInterval: undefined,
      maxRecursionDepth: undefined,
      maxSuspensions: defaults.maxSuspensions,
    });

    // The one path to no limits at all, and it has to be typed. Not
    // `undefined` any more: on 0.0.23 an omitted `maxSuspensions` is a
    // 1000-call ceiling, so "no limits" has to name a count no run reaches.
    assert.deepEqual(toResourceLimits("unbounded"), { maxSuspensions: Number.MAX_SAFE_INTEGER });
    assert.notEqual(toResourceLimits(undefined), undefined);
  });

  it("enforces a caller's maxRecursionDepth", async () => {
    // Test 6, behavioural half — and the one knob whose loss a default would
    // hide: Monty's own ceiling of 1000 raises `RecursionError` too, so the
    // recursion here is 100 deep. It completes under the default and fails only
    // if the caller's 50 actually arrived.
    const recurse = "def f(n):\n    return 0 if n == 0 else f(n - 1)\nf(100)";

    const bounded = await runInSandbox(
      recurse,
      { registry },
      {
        limits: { maxRecursionDepth: 50 },
      },
    );
    err(bounded);
    assert.equal(
      bounded.errorKind,
      "runtime",
      "the caller's own recursion is not a ceiling of ours",
    );
    assert.match(bounded.error, /RecursionError/);

    const unbounded = await runInSandbox(recurse, { registry });
    ok(unbounded, "100 frames is well inside Monty's default of 1000");
  });

  // ── The suspension budget (Monty 0.0.23 `maxSuspensions`) ──
  //
  // 0.0.23 counts every time a checkout hands control to the host — each
  // host-tool call is one (measured) — and aborts the feed past
  // `maxSuspensions`, which defaults to 1000 when the field is omitted.
  // Omitted is what this repository passed, so a plain loop of 1001 `echo`
  // calls, and a `Session` replaying a full call cache, started failing on
  // the bump with `RuntimeError: suspension limit 1000 exceeded`.

  /** An echo that counts what actually executed: the budget is about calls. */
  function countingEcho(): { registry: ToolRegistry; executions: () => number } {
    let executions = 0;
    const tool = makeTool({
      execute: (args) => {
        executions++;
        return String(args.text);
      },
    });
    return { registry: new ToolRegistry([tool]), executions: () => executions };
  }

  /** `n` sequential `echo` calls in a loop. */
  const echoLoop = (n: number) => `for i in range(${n}):\n    echo(str(i))\nlen("done")`;

  it("suspensions: a run making more than 1000 host-tool calls completes on the default budget", async () => {
    const prior = process.env.REPL_MAX_SUSPENSIONS;
    delete process.env.REPL_MAX_SUSPENSIONS;
    try {
      const { registry: echoes, executions } = countingEcho();
      const result = await runInSandbox(echoLoop(1500), { registry: echoes });
      ok(result, `expected ok, got ${JSON.stringify((result as RunError).error)}`);
      assert.equal(result.calls.length, 1500);
      assert.equal(executions(), 1500);
    } finally {
      if (prior !== undefined) process.env.REPL_MAX_SUSPENSIONS = prior;
    }
  });

  it("suspensions: a caller's maxSuspensions is enforced — uncatchable, `runtime`, the trace stops at the budget", async () => {
    const { registry: echoes, executions } = countingEcho();
    const result = await runInSandbox(
      `try:\n    for i in range(10):\n        echo(str(i))\nexcept BaseException:\n    pass\nlen("swallowed")`,
      { registry: echoes },
      { limits: { maxSuspensions: 5 } },
    );
    err(result);
    assert.equal(result.errorKind, "runtime");
    assert.match(result.error, /suspension limit 5 exceeded/);
    assert.equal(executions(), 5, "a call past the budget reached the host");
    assert.equal(result.calls.length, 5);
  });

  it("suspensions: REPL_MAX_SUSPENSIONS is read at call time, rejecting values that are not positive", async () => {
    const shipped = limitsConfig().maxSuspensions;
    assert.ok(Number.isSafeInteger(shipped) && shipped > 0, `shipped ${shipped}`);
    await withEnv({ REPL_MAX_SUSPENSIONS: "7" }, async () => {
      assert.equal(limitsConfig().maxSuspensions, 7);
      assert.equal(toResourceLimits(undefined).maxSuspensions, 7);
    });
    for (const bad of ["0", "-1", "not-a-number", ""]) {
      await withEnv({ REPL_MAX_SUSPENSIONS: bad }, async () => {
        assert.equal(
          limitsConfig().maxSuspensions,
          shipped,
          `'${bad}' should not become the suspension budget — 0 permits no host call at all`,
        );
      });
    }
  });

  it("suspensions: limits 'unbounded' does not leave Monty's 1000 default in force", async () => {
    // Paired like the memory test: the same environment enforces on the
    // default path, so the only difference is the opt-out itself.
    await withEnv({ REPL_MAX_SUSPENSIONS: "5" }, async () => {
      const bounded = await runInSandbox(echoLoop(10), countingEcho());
      err(bounded);
      assert.match(bounded.error, /suspension limit 5 exceeded/, "the env default must enforce");

      const { registry: echoes, executions } = countingEcho();
      const unbounded = await runInSandbox(
        echoLoop(1500),
        { registry: echoes },
        { limits: "unbounded" },
      );
      ok(unbounded, `expected ok, got ${JSON.stringify((unbounded as RunError).error)}`);
      assert.equal(executions(), 1500);
    });
  });

  it("suspensions: a name lookup and a mounted-file read each spend one, like a call", async () => {
    // What the budget counts, pinned so the README's list stays true: aliasing
    // a tool is a name lookup the host answers, and a mounted read is an OS
    // call `resumeAuto()` answers — neither is a tool call in the trace.
    const aliased = "f = echo\nf('a')\nf('b')";
    const tight = await runInSandbox(aliased, countingEcho(), { limits: { maxSuspensions: 2 } });
    err(tight);
    assert.match(tight.error, /suspension limit 2 exceeded/, "the lookup was free");
    assert.equal(tight.calls.length, 1);
    ok(await runInSandbox(aliased, countingEcho(), { limits: { maxSuspensions: 3 } }));

    const dir = mkdtempSync(join(tmpdir(), "repl-suspensions-"));
    try {
      writeFileSync(join(dir, "x.txt"), "hello");
      const reads =
        "from pathlib import Path\n[Path('/mnt/data/x.txt').read_text() for _ in range(3)]";
      const runOpts = (maxSuspensions: number) => ({
        mount: { "/mnt/data": dir },
        limits: { maxSuspensions },
      });
      const short = await runInSandbox(reads, { registry }, runOpts(2));
      err(short);
      assert.match(short.error, /suspension limit 2 exceeded/, "a mounted read was free");
      assert.equal(short.calls.length, 0, "a mounted read is not a traced tool call");
      const enough = await runInSandbox(reads, { registry }, runOpts(3));
      ok(enough);
      assert.equal(enough.output, "['hello', 'hello', 'hello']");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("suspensions: a resume cannot lift the suspended run's budget, and its count restarts", async () => {
    // Measured on 0.0.23: a restored snapshot is held to the lower of the
    // dump's `maxSuspensions` and the resuming checkout's, and the count
    // starts again at the restore with the pending call counted as one. So
    // the resume below — on the default budget — still stops at the run's 3,
    // and it gets there only after two more calls, not at once.
    const gate: HostTool = { ...echoTool(), name: "gate", requiresApproval: true };
    const gated = new ToolRegistry([echoTool(), gate]);
    const paused = await runInSandbox(
      `echo("a")\necho("b")\ngate("g")\n${echoLoop(4)}`,
      { registry: gated },
      { limits: { maxSuspensions: 3 }, onApproval: () => "suspend" },
    );
    suspended(paused);
    const finished = await resumeSuspended(paused, true, { registry: gated });
    err(finished);
    assert.match(finished.error, /suspension limit 3 exceeded/);
    assert.deepEqual(
      finished.calls.map((c) => [c.tool, c.args]),
      [
        ["echo", ["a"]],
        ["echo", ["b"]],
        ["gate", ["g"]],
        ["echo", ["0"]],
        ["echo", ["1"]],
      ],
    );
  });
});

// ── The host wall clock ─────────────────────────────────────────

describe("the host wall clock", () => {
  /** A tool that never returns within the life of a test. */
  function hangingTool(): HostTool {
    return {
      name: "hang",
      description: "Never returns",
      params: [],
      returns: "str",
      execute: () => new Promise<string>(() => {}),
    };
  }

  it("interrupts a host tool that Monty's clock cannot", async () => {
    // Test 4, and the whole point of the issue. `maxDurationSecs` is armed and
    // irrelevant: the sandbox clock advances only while the interpreter
    // executes, and the interpreter is suspended waiting for this tool. Nothing
    // inside the worker can end this run.
    const registry = new ToolRegistry([hangingTool()]);
    const started = Date.now();

    const result = await runInSandbox(
      "hang()",
      { registry },
      {
        limits: { maxDurationSecs: 30, maxWallClockSecs: 1 },
      },
    );

    err(result);
    assert.equal(result.errorKind, "timeout");
    assert.match(result.error, /host wall-clock/);
    assert.ok(Date.now() - started < 10_000, `returned in ${Date.now() - started}ms`);
  });

  it("returns the worker, so a hung run cannot starve the pool", async () => {
    // Test 7's sibling for the tool-hang route, and the reason the deadline is
    // load-bearing rather than a convenience: `withSandboxSession` releases the
    // worker in a `finally` that is reached only once the run settles. Losing
    // the race is what settles it.
    await closeSandboxPool();
    const prior = process.env.REPL_POOL_MAX_PROCESSES;
    process.env.REPL_POOL_MAX_PROCESSES = "2";
    try {
      const registry = new ToolRegistry([hangingTool()]);
      for (let i = 0; i < 3; i++) {
        const hung = await runInSandbox(
          "hang()",
          { registry },
          {
            limits: { maxWallClockSecs: 1 },
          },
        );
        err(hung);
        assert.equal(hung.errorKind, "timeout", `hang ${i}`);
      }

      const after = await runInSandbox("1 + 1", { registry: new ToolRegistry() });
      ok(after, "a well-behaved caller must not pay for the hangs before it");
      assert.equal(after.output, "2");
    } finally {
      if (prior === undefined) delete process.env.REPL_POOL_MAX_PROCESSES;
      else process.env.REPL_POOL_MAX_PROCESSES = prior;
      await closeSandboxPool();
    }
  });

  it("an aborted signal ends a run parked in a host tool", async () => {
    // The dispatch loop checks `acc.aborted` between iterations, and a run
    // waiting on a tool is between iterations by definition — so before the
    // race, an abort was noticed only once the tool it was meant to interrupt
    // had returned.
    const registry = new ToolRegistry([hangingTool()]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await runInSandbox("hang()", { registry }, { signal: controller.signal });

    err(result);
    assert.equal(result.errorKind, "aborted");
  });

  // ── A dialog is off the clock ──
  //
  // Found live on pi 0.85.1: a dialog nobody answered ended its `repl` call at
  // 300.003 s with `run exceeded its host wall-clock budget` and an empty trace.
  // The budget (300 s) had been counting the dialog, and beat the dialog's own
  // timeout (300 s) to it, so the expiry that should have denied the call never
  // got the chance. The budget bounds host tools; a person reading a dialog is
  // not one.

  /** A gated tool that says what it ran with. */
  function gateTool(): HostTool {
    return {
      name: "gate",
      description: "Needs approval",
      params: [{ name: "x", type: "str", description: "Value" }],
      returns: "str",
      requiresApproval: true,
      execute: (args) => `ran ${args.x}`,
    };
  }

  /** Host time, not compute: Monty's clock does not advance while it waits. */
  function napTool(ms: number): HostTool {
    return {
      name: "nap",
      description: "Sleeps on the host",
      params: [],
      returns: "str",
      execute: () => new Promise((resolve) => setTimeout(() => resolve("napped"), ms)),
    };
  }

  /** An `onApproval` that answers `ms` after it is asked — a person reading the dialog. */
  function answersAfter(ms: number, decision: ApprovalDecision): () => Promise<ApprovalDecision> {
    return () => new Promise((resolve) => setTimeout(() => resolve(decision), ms));
  }

  it("dialogs answered after the budget ran out still decide their calls", async () => {
    // Deterministic on the side that matters (D132). Four dialogs of 750 ms are
    // 3 s of waiting under a 2 s budget: a clock that counted them expires
    // before the third answer, and one that stopped for the first alone still
    // expires before the last. Nothing else in the run spends host time.
    const registry = new ToolRegistry([gateTool()]);

    const result = await runInSandbox(
      'gate("a")\ngate("b")\ngate("c")\ngate("d")',
      { registry },
      { limits: { maxWallClockSecs: 2 }, onApproval: answersAfter(750, true) },
    );

    ok(result, (result as RunError).error);
    assert.equal(result.output, "ran d");
    assert.deepEqual(
      result.calls.map((c) => [c.tool, c.ok, c.approved]),
      Array.from({ length: 4 }, () => ["gate", true, true]),
    );
  });

  it("host-tool time either side of a dialog is still one budget", async () => {
    // Stopped, not restarted. Two 700 ms naps are 1.4 s of host-tool time under
    // a 1 s budget, whatever the dialog between them costs — deterministic on
    // the timeout side. A deadline the answer started afresh would give the
    // second nap a whole second and let the run finish.
    const registry = new ToolRegistry([gateTool(), napTool(700)]);

    const result = await runInSandbox(
      'nap()\ngate("x")\nnap()',
      { registry },
      { limits: { maxWallClockSecs: 1 }, onApproval: answersAfter(1200, true) },
    );

    err(result);
    assert.equal(result.errorKind, "timeout");
  });

  it("a host tool that never returns after a dialog still times out", {
    timeout: 20_000,
  }, async () => {
    // The clock runs again once the answer is in: a deadline stopped for the
    // dialog and never restarted would park this run for good.
    const registry = new ToolRegistry([gateTool(), hangingTool()]);

    const result = await runInSandbox(
      'gate("x")\nhang()',
      { registry },
      { limits: { maxWallClockSecs: 1 }, onApproval: answersAfter(1200, true) },
    );

    err(result);
    assert.equal(result.errorKind, "timeout");
    assert.match(result.error, /host wall-clock/);
  });

  it("an abort ends a run waiting on a dialog past its budget", { timeout: 20_000 }, async () => {
    // Off the clock is not off the signal. The dialog never settles and the
    // abort lands after the 1 s budget would have run out, so the abort race is
    // the only thing that can end this run — and it ends it as aborted.
    const registry = new ToolRegistry([gateTool()]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1200);

    const result = await runInSandbox(
      'gate("x")',
      { registry },
      {
        signal: controller.signal,
        limits: { maxWallClockSecs: 1 },
        onApproval: () => new Promise<ApprovalDecision>(() => {}),
      },
    );

    err(result);
    assert.equal(result.errorKind, "aborted", result.error);
  });

  it("a dialog in a resumed continuation is off the clock too", async () => {
    // `resumeSuspended` runs the continuation under a deadline of its own, and
    // every gated call after the pending one is asked inside it.
    const registry = new ToolRegistry([gateTool()]);
    const susp = await runInSandbox(
      'gate("a")\ngate("b")',
      { registry },
      { onApproval: () => "suspend" },
    );
    suspended(susp);

    const result = await resumeSuspended(
      susp,
      true,
      { registry },
      { limits: { maxWallClockSecs: 2 }, onApproval: answersAfter(2500, true) },
    );

    ok(result, (result as RunError).error);
    assert.equal(result.output, "ran b");
    assert.deepEqual(
      result.calls.map((c) => [c.tool, c.ok, c.approved]),
      [
        ["gate", true, true],
        ["gate", true, true],
      ],
    );
  });
});

// ── An exhausted pool ───────────────────────────────────────────

describe("a pool with no worker to give", () => {
  it("a runaway does not cost the pool a worker", async () => {
    // Test 7. Fails against the fail-open version at the checkout timeout,
    // with `no monty worker became available`, on a caller running `1 + 1`.
    // The default limits are what end each runaway and hand its worker back.
    await closeSandboxPool();
    const prior = {
      procs: process.env.REPL_POOL_MAX_PROCESSES,
      dur: process.env.REPL_MAX_DURATION_SECS,
    };
    process.env.REPL_POOL_MAX_PROCESSES = "2";
    process.env.REPL_MAX_DURATION_SECS = "1";
    try {
      const registry = new ToolRegistry();
      for (let i = 0; i < 3; i++) {
        const runaway = await runInSandbox("while True: pass", { registry });
        err(runaway);
        assert.equal(runaway.errorKind, "timeout", `runaway ${i}`);
      }

      const after = await runInSandbox("1 + 1", { registry });
      ok(after, "the caller after three runaways was never at fault");
      assert.equal(after.output, "2");
    } finally {
      if (prior.procs === undefined) delete process.env.REPL_POOL_MAX_PROCESSES;
      else process.env.REPL_POOL_MAX_PROCESSES = prior.procs;
      if (prior.dur === undefined) delete process.env.REPL_MAX_DURATION_SECS;
      else process.env.REPL_MAX_DURATION_SECS = prior.dur;
      await closeSandboxPool();
    }
  });

  it("an exhausted pool returns a RunError rather than throwing", async () => {
    // #36's contract, arriving by a route #36 never covered: the refusal comes
    // from `buildTypeCheckStubs` reaching the pool before any user code exists,
    // so it escapes from outside every `classify*` guard. A caller with no
    // reason to be in a `try` gets a `RunResult` like every other outcome.
    await closeSandboxPool();
    const prior = {
      procs: process.env.REPL_POOL_MAX_PROCESSES,
      checkout: process.env.REPL_POOL_CHECKOUT_TIMEOUT_SECS,
    };
    process.env.REPL_POOL_MAX_PROCESSES = "1";
    process.env.REPL_POOL_CHECKOUT_TIMEOUT_SECS = "1";
    try {
      const holdTool: HostTool = {
        name: "hold",
        description: "Holds the only worker",
        params: [],
        returns: "str",
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 4000));
          return "held";
        },
      };
      const holder = runInSandbox("hold()", { registry: new ToolRegistry([holdTool]) });
      // Let the holder check the single worker out before competing for it.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const refused = await runInSandbox("1 + 1", { registry: new ToolRegistry() });
      err(refused);
      assert.equal(refused.errorKind, "unavailable");
      assert.match(refused.error, /no monty worker became available/);

      await holder;
    } finally {
      if (prior.procs === undefined) delete process.env.REPL_POOL_MAX_PROCESSES;
      else process.env.REPL_POOL_MAX_PROCESSES = prior.procs;
      if (prior.checkout === undefined) delete process.env.REPL_POOL_CHECKOUT_TIMEOUT_SECS;
      else process.env.REPL_POOL_CHECKOUT_TIMEOUT_SECS = prior.checkout;
      await closeSandboxPool();
    }
  });
});

// ── The print callback's shape, and the byte mark that rides on it (#61) ──
//
// `Session` de-duplicates stdout across replays with a byte mark: the
// number of bytes the replayed prefix printed, handed to the sandbox as
// `RunOptions.stdoutSkipBytes` and dropped before `onPrint` and the
// accumulator see anything (D121). The mark is a byte count, so it is
// indifferent to how a deterministic stream is chunked; what it and the
// trace's `stdoutOffset` do rely on is *when* bytes arrive — before a host
// call, and by the end of the feed. The shape is pinned here as a tripwire
// (D122): if an upstream bump changes it, this is the test that says so,
// rather than a session quietly swallowing or re-emitting a line. Re-pinned
// for 0.0.23, which batches output (the evidence for accepting that is the
// "print batching" block below).

describe("print callback shape — the tripwire under the stdout mark (#61 D122)", () => {
  const registry = new ToolRegistry([echoTool()]);

  it("batches a burst into fewer callbacks than prints, every byte in order (0.0.23)", async () => {
    // 0.0.21 fired once per print, and this test pinned
    // ['a\n', 'b c\n', 'x\ny\n', '0\n', '1\n', '2\n']. 0.0.23 holds output for
    // up to 5 ms (`printFlushInterval`) and measured one callback for these
    // six prints and one for a thousand; `printFlushInterval: 0` gives one per
    // *line*, splitting `x\ny`. The split is timing, so the bytes are pinned
    // exactly and the batching by a burst no timing can deliver line by line.
    const prints: string[] = [];
    const result = await runInSandbox(
      'print("a")\nprint("b", "c")\nprint("x\\ny")\nfor i in range(3):\n    print(i)',
      { registry },
      { onPrint: (text) => prints.push(text) },
    );
    ok(result);
    assert.equal(prints.join(""), "a\nb c\nx\ny\n0\n1\n2\n");

    const burst: string[] = [];
    ok(
      await runInSandbox(
        "for i in range(1000):\n    print(i)",
        { registry },
        { onPrint: (text) => burst.push(text) },
      ),
    );
    assert.equal(burst.join(""), Array.from({ length: 1000 }, (_, i) => `${i}\n`).join(""));
    assert.ok(
      burst.length < 1000,
      `one callback per print (${burst.length}): batching is off — re-read what the mark assumes`,
    );
  });

  it("delivers a partial line at a host boundary, at the end, and once the flush interval lapses", async () => {
    const merged: string[] = [];
    ok(
      await runInSandbox(
        'print("a", end="")\nprint("b", end="")\nprint("c")',
        { registry },
        { onPrint: (text) => merged.push(text) },
      ),
    );
    // 0.0.21 held a partial until the next newline, and this pinned ['abc\n'].
    // 0.0.23 still gives that here, but only because the three prints fall
    // inside one flush interval — so the bytes are what is pinned.
    assert.equal(merged.join(""), "abc\n");

    const lapsed: string[] = [];
    ok(
      await runInSandbox(
        // 10,000,000 iterations, because the busy loop has to outlast the 5 ms
        // flush interval on any runner: ~900 ms on a Linux x64 dev box, ~45 ms
        // (9x the interval) on a machine 20x faster. Measured with the interval
        // stretched to stand in for faster hardware: 1,000,000 (~95 ms) merges
        // into ['ab\n'] from a 0.1 s interval up; 10,000,000 still separates at
        // 0.5 s and merges only at 1 s.
        'print("a", end="")\nn = 0\nfor i in range(10000000):\n    n += i\nprint("b")',
        { registry },
        { onPrint: (text) => lapsed.push(text) },
      ),
    );
    assert.deepEqual(
      lapsed,
      ["a", "b\n"],
      "a partial is no longer held past the flush interval (line-buffered, printFlushInterval 0: ['ab\\n'])",
    );

    const flushed: string[] = [];
    ok(
      await runInSandbox(
        'print("x", end="")\necho("t")\nprint("y")',
        { registry },
        {
          onPrint: (text) => flushed.push(text),
        },
      ),
    );
    assert.deepEqual(flushed, ["x", "y\n"], "a host call flushes the partial");

    const trailing: string[] = [];
    const result = await runInSandbox(
      'print("d", end="")',
      { registry },
      {
        onPrint: (text) => trailing.push(text),
      },
    );
    ok(result);
    assert.deepEqual(trailing, ["d"], "the end of the run flushes the partial");
    assert.equal(result.stdout, "d");
  });

  it("delivers one large print in 8 KiB chunks", async () => {
    const prints: string[] = [];
    const result = await runInSandbox(
      'print("Z" * 20000)',
      { registry },
      {
        onPrint: (text) => prints.push(text),
      },
    );
    ok(result);
    // 20 001 bytes (the newline) → 8192 + 8192 + 3617.
    assert.deepEqual(
      prints.map((p) => Buffer.byteLength(p)),
      [8192, 8192, 3617],
      "the chunk size the mark arithmetic is indifferent to, but the skip slicing is not",
    );
  });

  it("flushes a partial at a gate in the original call and in a replay alike", async () => {
    // A partial straddling a suspension must produce the same byte stream in
    // the segments of the original call as it does when the same code is
    // replayed without a suspension — otherwise the mark taken from the
    // original call would not describe the replay.
    const gate: HostTool = {
      name: "gate",
      description: "Gated",
      params: [],
      returns: "str",
      requiresApproval: true,
      execute: () => "g",
    };
    const gatedRegistry = new ToolRegistry([gate]);
    const code = 'print("x", end="")\ngate()\nprint("y")';

    const before: string[] = [];
    const paused = await runInSandbox(
      code,
      { registry: gatedRegistry },
      {
        onApproval: () => "suspend",
        onPrint: (text) => before.push(text),
      },
    );
    suspended(paused);
    const after: string[] = [];
    const finished = await resumeSuspended(
      paused,
      true,
      { registry: gatedRegistry },
      {
        onPrint: (text) => after.push(text),
      },
    );
    ok(finished);
    assert.deepEqual(before, ["x"]);
    assert.deepEqual(after, ["y\n"]);
    assert.equal(finished.stdout, "xy\n");

    const replayed: string[] = [];
    ok(
      await runInSandbox(
        code,
        { registry: gatedRegistry },
        {
          onApproval: () => true,
          onPrint: (text) => replayed.push(text),
        },
      ),
    );
    assert.deepEqual(replayed, ["x", "y\n"], "the replay flushes at the same boundary");
    assert.equal(
      Buffer.byteLength(before.join("") + after.join("")),
      Buffer.byteLength(replayed.join("")),
      "the mark taken across the suspension must equal the replay's byte count",
    );
  });
});

// ── Print batching (Monty 0.0.23, pydantic/monty#809): what stdout is built on ──
//
// 0.0.23 holds `print()` output in the worker for up to
// `CheckoutOptions.printFlushInterval` (5 ms by default) and hands a burst to
// the print callback as one chunk; `printFlushInterval: 0` would restore one
// callback per line. These tests are the evidence the sandbox keeps upstream's
// default: every property stdout, the trace and the replay mark rely on is
// asserted against the batched stream. Where a property only means something
// if a chunk really spanned several prints, the test also checks that it did,
// so it cannot pass by the stream happening to arrive line by line.

describe("print batching — the properties stdout is built on hold on the batched stream (0.0.23)", () => {
  /** `n` numbered lines printed in a tight loop, and the exact bytes they make. */
  const burst = (n: number, label = "line") => ({
    code: `for i in range(${n}):\n    print("${label}", i)`,
    text: Array.from({ length: n }, (_, i) => `${label} ${i}\n`).join(""),
  });

  /** A no-argument tool that records what the live stream held when it ran. */
  function probeTool(chunks: string[], seen: string[]): HostTool {
    return makeTool({
      name: "probe",
      params: [],
      execute: () => {
        seen.push(chunks.join(""));
        return "p";
      },
    });
  }

  it("a burst printed before a host call is delivered before the call runs, and traced below it", async () => {
    const before = burst(200);
    const chunks: string[] = [];
    const seen: string[] = [];
    const result = await runInSandbox(
      `${before.code}\nprint("partial", end="")\nprobe()\nprint("after")`,
      { registry: new ToolRegistry([probeTool(chunks, seen)]) },
      { onPrint: (text) => chunks.push(text) },
    );
    ok(result);
    assert.ok(chunks.length < 200, `not batched (${chunks.length} callbacks for 202 prints)`);
    const printedBefore = `${before.text}partial`;
    assert.deepEqual(seen, [printedBefore], "output printed before the call arrived after it ran");
    assert.equal(result.calls[0].stdoutOffset, byteSize(printedBefore));
    assert.equal(result.stdout, `${printedBefore}after\n`);
  });

  it("every call in an interleaved loop sees exactly what preceded it", async () => {
    const chunks: string[] = [];
    const seen: string[] = [];
    const result = await runInSandbox(
      'for i in range(30):\n    print("a", i)\n    print("b", i, end="")\n    print("")\n    probe()',
      { registry: new ToolRegistry([probeTool(chunks, seen)]) },
      { onPrint: (text) => chunks.push(text) },
    );
    ok(result);
    const perIteration = (i: number) => `a ${i}\nb ${i}\n`;
    const prefixes = Array.from({ length: 30 }, (_, n) =>
      Array.from({ length: n + 1 }, (_, i) => perIteration(i)).join(""),
    );
    assert.deepEqual(seen, prefixes);
    assert.deepEqual(
      result.calls.map((c) => c.stdoutOffset),
      prefixes.map(byteSize),
    );
  });

  it("the stdout budget holds when one batched chunk straddles the cap", async () => {
    const stream = burst(400);
    const cap = 256;
    const chunks: string[] = [];
    const result = await runInSandbox(
      stream.code,
      { registry: new ToolRegistry() },
      { maxStdoutBytes: cap, onPrint: (text) => chunks.push(text) },
    );
    ok(result);
    // The case under test: a single callback carries bytes from both sides of
    // the cap.
    let offset = 0;
    const straddles = chunks.some((chunk) => {
      const start = offset;
      offset += byteSize(chunk);
      return start < cap && offset > cap && chunk.split("\n").length > 2;
    });
    assert.ok(straddles, `no multi-line chunk spans the cap: ${chunks.map(byteSize).join(",")}`);

    assert.equal(chunks.join(""), stream.text, "the live stream is not the model's budget (M9)");
    assert.equal(result.stdoutTruncated, true);
    assert.ok(byteSize(result.stdout) <= cap, `${byteSize(result.stdout)} bytes for a ${cap} cap`);
    const [head, tail] = result.stdout.split(/\n?\[… [^\]]*…\]\n?/);
    assert.ok(stream.text.startsWith(head), `head is not the stream's: ${JSON.stringify(head)}`);
    assert.ok(stream.text.endsWith(tail), `tail is not the stream's: ${JSON.stringify(tail)}`);
    assert.match(
      result.stdout,
      new RegExp(
        `of ${formatSize(byteSize(stream.text)).replace(".", "\\.")} elided \\(lines \\d+-\\d+ of 400\\)`,
      ),
    );
  });

  it("an abort mid-output returns everything printed before it, the batched burst included", async () => {
    const controller = new AbortController();
    const stop = makeTool({
      name: "stop",
      params: [],
      execute: () => {
        controller.abort();
        return "s";
      },
    });
    const before = burst(300);
    const chunks: string[] = [];
    const result = await runInSandbox(
      `${before.code}\nstop()\n${burst(300, "after").code}`,
      { registry: new ToolRegistry([stop]) },
      { signal: controller.signal, onPrint: (text) => chunks.push(text) },
    );
    err(result);
    assert.equal(result.errorKind, "aborted");
    assert.ok(chunks.length < 300, `not batched (${chunks.length} callbacks)`);
    assert.ok(result.stdout.startsWith(before.text), "output printed before the abort is missing");
    assert.equal(result.stdoutTruncated, false);
  });

  it("an abort during a print loop with no host call returns what the flush interval delivered", async () => {
    // No host call ever flushes this stream: only the interval does. The run is
    // cut off by the abort race, so what it reports is whatever had arrived.
    // The 1 s budget is only what hands the worker back afterwards; the abort
    // (300 ms, plus the 250 ms settle grace) ends the run well before it.
    const controller = new AbortController();
    let delivered = 0;
    const pending = runInSandbox(
      'i = 0\nwhile True:\n    print("tick", i)\n    i += 1',
      { registry: new ToolRegistry() },
      {
        signal: controller.signal,
        limits: { maxDurationSecs: 1 },
        onPrint: (text) => {
          delivered += byteSize(text);
        },
      },
    );
    setTimeout(() => controller.abort(), 300);
    const result = await pending;
    err(result);
    assert.equal(result.errorKind, "aborted");
    assert.ok(delivered > 0, "300 ms of printing delivered nothing");
    assert.ok(result.stdout.startsWith("tick 0\ntick 1\n"), result.stdout.slice(0, 80));
  });
});

describe("runInSandbox — stdoutSkipBytes drops the replayed prefix's output (#61 D121)", () => {
  const registry = new ToolRegistry();

  it("drops exactly that many leading bytes before onPrint and the accumulator", async () => {
    const prints: string[] = [];
    const result = await runInSandbox(
      'print("abc")\nprint("de")',
      { registry },
      {
        stdoutSkipBytes: 4,
        onPrint: (text) => prints.push(text),
      },
    );
    ok(result);
    assert.equal(result.stdout, "de\n", "the accumulator saw the prefix's output");
    assert.deepEqual(prints, ["de\n"], "the live stream saw the prefix's output");
    assert.equal(result.stdoutTruncated, false);
  });

  it("slices a callback that straddles the mark", async () => {
    // The prefix printed a partial line in its own run; on replay that partial
    // merges with this call's first print into one callback, so the mark lands
    // inside a callback and the tail beyond it is this call's.
    const prints: string[] = [];
    const result = await runInSandbox(
      'print("ab", end="")\nprint("cd")',
      { registry },
      {
        stdoutSkipBytes: 2,
        onPrint: (text) => prints.push(text),
      },
    );
    ok(result);
    assert.equal(result.stdout, "cd\n");
    assert.deepEqual(prints, ["cd\n"]);
  });

  it("applies the truncation budget to what is left, not to what was skipped", async () => {
    const result = await runInSandbox(
      'print("A" * 5000)\nprint("kept")',
      { registry },
      { stdoutSkipBytes: 5001, maxStdoutBytes: 100 },
    );
    ok(result);
    assert.equal(result.stdout, "kept\n");
    assert.equal(result.stdoutTruncated, false, "the skipped bytes counted against the budget");
  });

  it("a mark beyond everything printed yields empty stdout, and zero is a no-op", async () => {
    const beyond = await runInSandbox('print("only")', { registry }, { stdoutSkipBytes: 10_000 });
    ok(beyond);
    assert.equal(beyond.stdout, "");
    const zero = await runInSandbox('print("only")', { registry }, { stdoutSkipBytes: 0 });
    ok(zero);
    assert.equal(zero.stdout, "only\n");
  });
});

// ── The output contract (#65, #69; decision 15, D139–D142) ───────
//
// `RunOk.output` is declared a string. Until W3-1 it was one by luck:
// `formatOutput` was `String(value)` — `[object Map]` for a dict, `1,2,3` for
// a list, `true` for `True` — and the two SUBMIT sites capped `err.answer`
// straight from a cast, so a runtime non-string answer threw an uncaught
// `ERR_INVALID_ARG_TYPE` out of `runInSandbox`, and `SUBMIT(**{})` returned
// an `ok` result with an empty output that `runRlm` accepted as the answer.

/** The RLM tools with inert callbacks: SUBMIT is the one under test. */
function rlmRegistry(...extra: HostTool[]): ToolRegistry {
  return new ToolRegistry([
    ...extra,
    ...createRLMTools({ onLLMQuery: async () => "", onRLMQuery: async () => "" }),
  ]);
}

/** A gated tool that ends the run with whatever `answer` it was handed, as SUBMIT does. */
function gatedSubmit(name = "finish"): HostTool {
  return {
    name,
    description: "Submits an answer",
    params: [{ name: "answer", type: "str", description: "Answer" }],
    returns: "void",
    requiresApproval: true,
    execute: (args) => {
      throw new SubmitSignal(args.answer);
    },
  };
}

describe("RunOk.output is always a string, rendered as Python (#65 test 4, #69 finding 1)", () => {
  const registry = rlmRegistry(echoTool());

  const table: Array<[code: string, rendered: string]> = [
    ["{'a': 1, 'b': 2}", "{'a': 1, 'b': 2}"],
    ["{}", "{}"],
    ["[1, 2, 3]", "[1, 2, 3]"],
    ["{1, 2}", "{1, 2}"],
    ["set()", "set()"],
    ["True", "True"],
    ["None", "None"],
    ["42", "42"],
    ["2.5", "2.5"],
    ["(1, 2.0)", "[1, 2]"],
    ["()", "[]"],
    ["b'ab'", "b'ab'"],
    ["1e400", "inf"],
    ["float('nan')", "nan"],
    ["10**20", "100000000000000000000"],
    ["'hi'", "hi"],
    ['"it\'s"', "it's"],
    ["['it\\'s', \"q\\\"\"]", `["it's", 'q"']`],
    ["{'a': (1, 2.0), 'b': [None, True]}", "{'a': [1, 2], 'b': [None, True]}"],
    ["[(1, 2.0), {'k': {1}}, b'\\x00', 1e400, None]", "[[1, 2], {'k': {1}}, b'\\x00', inf, None]"],
    ["ValueError('bad')", "ValueError('bad')"],
    ["type(1)", "<class 'int'>"],
    // Instances: 0.0.21 sent Monty's repr string, 0.0.23 sends a
    // MontyClassProxy (the address is not carried; see the policy's losses).
    ["class C:\n    def __init__(self):\n        self.x = 1\nC()", "<C object>"],
    ["class C:\n    pass\n[C(), C()]", "[<C object>, <C object>]"],
    [
      "from dataclasses import dataclass\n@dataclass\nclass P:\n    x: int\n    y: str\nP(1, 'a')",
      "P(x=1, y='a')",
    ],
    ["print('x')", "None"],
    ["echo('hi')", "hi"],
    ["SUBMIT('done')", "done"],
  ];

  for (const [code, rendered] of table) {
    it(`${code} → ${JSON.stringify(rendered)}`, async () => {
      const result = await runInSandbox(code, { registry });
      ok(result);
      assert.equal(typeof result.output, "string");
      assert.equal(result.output, rendered);
      assert.equal(result.outputTruncated, false);
    });
  }

  it("an empty dict and a populated one are distinguishable (the collision behind the misdiagnosis)", async () => {
    const empty = await runInSandbox("{}", { registry });
    const full = await runInSandbox("{'a': 1}", { registry });
    ok(empty);
    ok(full);
    assert.notEqual(empty.output, full.output);
    assert.equal(empty.output, "{}");
    assert.equal(full.output, "{'a': 1}");
  });

  it("Monty breaks a self-referential structure itself; the repr shows what arrived", async () => {
    // A list that contains itself crosses the boundary as `["[...]"]` — the
    // inner reference is Monty's own placeholder string — so the repr quotes
    // it. Documented in the policy; the point is that nothing throws.
    const result = await runInSandbox("a = []\na.append(a)\na", { registry });
    ok(result);
    assert.equal(result.output, "['[...]']");
  });

  // ── What 0.0.23 changed about instances in `output`, pinned so a bump says so ──

  it("a user-defined __repr__ does not reach output (0.0.23 loss); repr() inside the sandbox does", async () => {
    // 0.0.21 sent Monty's repr string, so `C()` rendered `CUSTOM` and the
    // dataclass `PCUSTOM` (measured by review). 0.0.23's proxy carries the
    // class name and the attributes, not the method, and the host cannot call
    // back into a finished feed to run it.
    const custom = "class C:\n    def __repr__(self):\n        return 'CUSTOM'\n";
    const bare = await runInSandbox(`${custom}C()`, { registry });
    ok(bare);
    assert.equal(bare.output, "<C object>");
    const called = await runInSandbox(`${custom}repr(C())`, { registry });
    ok(called);
    assert.equal(called.output, "CUSTOM", "the workaround the policy documents");
    const dataclass = await runInSandbox(
      "from dataclasses import dataclass\n@dataclass\nclass P:\n    x: int\n    def __repr__(self):\n        return 'PCUSTOM'\nP(1)",
      { registry },
    );
    ok(dataclass);
    assert.equal(dataclass.output, "P(x=1)");
  });

  it("a cycle inside an instance renders quoted, exactly like a real '...' string (0.0.23)", async () => {
    // Monty breaks the cycle itself and sends the string '...' in its place,
    // which is the same value a real '...' attribute arrives as (measured on
    // the raw pool: both `{"x":"..."}`). Spelling it `N(x=...)` as 0.0.21 did
    // would misspell genuine data, so the placeholder shows as what arrived.
    const DC =
      "from dataclasses import dataclass\nfrom typing import Any\n@dataclass\nclass N:\n    x: Any\n";
    const cycle = await runInSandbox(`${DC}n = N(None)\nn.x = n\nn`, { registry });
    ok(cycle);
    assert.equal(cycle.output, "N(x='...')");
    const real = await runInSandbox(`${DC}N('...')`, { registry });
    ok(real);
    assert.equal(real.output, "N(x='...')");
    const inList = await runInSandbox(`${DC}n = N([])\nn.x.append(n)\nn`, { registry });
    ok(inList);
    assert.equal(inList.output, "N(x=['...'])");
  });

  it("output nests a list 48 deep and an instance 24 deep; one more fails the whole run (0.0.23)", async () => {
    // Monty's native value conversion is capped at MAX_VALUE_DEPTH, and no
    // option sets it. A nested instance hits the cap at half a list's depth
    // (measured by bisection: 24 ok / 25 fails, lists 48 / 49). Past it the run
    // fails with `RuntimeError: Max output depth exceeded` when the value is
    // handed over — after its side effects. 0.0.21 had the same list ceiling but
    // sent instances as repr strings, so instances returned 256 deep.
    const list = (d: number) => `v = None\nfor i in range(${d}):\n    v = [v]\nv`;
    const instance = (d: number) =>
      `class C:\n    def __init__(self, x):\n        self.x = x\nv = None\nfor i in range(${d}):\n    v = C(v)\nv`;
    assert.equal(MAX_VALUE_DEPTH, 48, "the native ceiling moved: re-bisect and update the policy");
    ok(await runInSandbox(list(48), { registry }));
    ok(await runInSandbox(instance(24), { registry }));
    for (const code of [list(49), instance(25)]) {
      const result = await runInSandbox(`echo('side effect')\n${code}`, { registry });
      err(result);
      assert.equal(result.errorKind, "runtime");
      assert.match(result.error, /Max output depth exceeded/);
      assert.equal(result.calls.length, 1, "the side effect before the value still happened");
    }
  });

  it("holds through resumeSuspended: the resumed expression renders the same way", async () => {
    const gate: HostTool = { ...echoTool(), name: "gate", requiresApproval: true };
    const gated = new ToolRegistry([gate]);
    const susp = await runInSandbox(
      "gate('x')\n{'k': [1, (2, 3)], 'n': None}",
      {
        registry: gated,
      },
      { onApproval: () => "suspend" },
    );
    suspended(susp);
    const result = await resumeSuspended(susp, true, { registry: gated });
    ok(result);
    assert.equal(typeof result.output, "string");
    assert.equal(result.output, "{'k': [1, [2, 3]], 'n': None}");
  });
});

describe("the output repr elides between elements under the budget (#69, policy Q4)", () => {
  const registry = new ToolRegistry();

  it("a 300 000-element list is elided between its elements, both ends kept, under OUTPUT_MAX_BYTES", async () => {
    const result = await runInSandbox("list(range(300000))", { registry });
    ok(result);
    assert.equal(result.outputTruncated, true);
    assert.ok(byteSize(result.output) <= OUTPUT_MAX_BYTES, `${byteSize(result.output)} bytes`);
    assert.ok(result.output.startsWith("[0, 1, 2, "), result.output.slice(0, 30));
    assert.ok(result.output.endsWith(", 299999]"), result.output.slice(-30));
    assert.match(result.output, /\[… \d+ of 300000 elements elided\. /);
    assert.ok(result.output.includes(VALUE_RECOVERY), "the marker names the recovery route");
  });

  it("a dict elides entries; a long string still takes the flat cut", async () => {
    const dict = await runInSandbox("{str(i): i for i in range(100000)}", { registry });
    ok(dict);
    assert.ok(dict.output.startsWith("{'0': 0, '1': 1, "));
    assert.match(dict.output, /\[… \d+ of 100000 entries elided\. /);

    const text = await runInSandbox("'x' * 100000", { registry }, { maxOutputBytes: 1024 });
    ok(text);
    assert.equal(text.outputTruncated, true);
    assert.ok(byteSize(text.output) <= 1024);
    assert.match(text.output, /\[… [\d.]+KB of [\d.]+KB elided\. /);
  });

  it("the caller's maxOutputBytes is the budget the repr elides under", async () => {
    const result = await runInSandbox("list(range(5000))", { registry }, { maxOutputBytes: 256 });
    ok(result);
    assert.ok(byteSize(result.output) <= 256, `${byteSize(result.output)} bytes`);
    assert.match(result.output, /^\[0, 1, .*\[… \d+ of 5000 elements elided\. .* …\], .*, 4999\]$/);
  });
});

describe("SUBMIT rejects a non-str answer with a Python TypeError (#65 tests 1-2, D141)", () => {
  const registry = rlmRegistry();

  // `**json.loads(...)` is the form the type checker cannot see through; a
  // dict literal is refused at check time (pinned below).
  const runtimeShapes: Array<[json: string, pytype: string]> = [
    ["42", "int"],
    ["1.5", "float"],
    ["[1, 2]", "list"],
    ['{"a": 1}', "dict"],
    ["true", "bool"],
    ["null", "NoneType"],
  ];

  for (const [json, pytype] of runtimeShapes) {
    it(`SUBMIT(**json.loads('{"answer": ${json}}')) is a RunError naming ${pytype}, never a throw or an empty ok`, async () => {
      const result = await runInSandbox(
        `import json\nSUBMIT(**json.loads('{"answer": ${json}}'))`,
        { registry },
      );
      err(result);
      assert.equal(result.errorKind, "runtime");
      assert.match(
        result.error,
        new RegExp(`TypeError: SUBMIT\\(\\) answer must be str, not ${pytype}`),
      );
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].tool, "SUBMIT");
      assert.equal(result.calls[0].ok, false, "a rejected SUBMIT must not be traced ok");
      assert.equal(result.calls[0].error, `SUBMIT() answer must be str, not ${pytype}`);
    });
  }

  it("SUBMIT(instance) submits the instance's repr, as 0.0.21 did — an instance is not a non-str answer", async () => {
    // 0.0.21 converted the instance to its repr string before SUBMIT saw it,
    // so the answer was "<C object at 0x2>" (measured by review). 0.0.23's
    // proxy made it `TypeError: … not C`. The dispatch boundary normalises
    // every tool argument, SUBMIT's included, so the 0.0.21 answer is back —
    // minus the address, which does not cross.
    const result = await runInSandbox(
      "class C:\n    pass\nfrom typing import Any\nv: Any = C()\nSUBMIT(v)",
      { registry },
    );
    ok(result);
    assert.equal(result.output, "<C object>");
    assert.equal(result.calls[0].ok, true);
  });

  it("the model can catch it and carry on — it is a Python exception, not a host fault", async () => {
    const result = await runInSandbox(
      [
        "import json",
        "try:",
        "    SUBMIT(**json.loads('{\"answer\": 42}'))",
        "except TypeError as e:",
        "    print('caught:', e)",
        "'continued'",
      ].join("\n"),
      { registry },
    );
    ok(result);
    assert.equal(result.output, "continued");
    assert.match(result.stdout, /caught: SUBMIT\(\) answer must be str, not int/);
    assert.equal(result.calls[0].ok, false);
  });

  it("SUBMIT(**{}) is a TypeError for the missing answer, never an ok with an empty output", async () => {
    const result = await runInSandbox("SUBMIT(**{})", { registry });
    err(result);
    assert.equal(result.errorKind, "runtime");
    assert.match(
      result.error,
      /TypeError: SUBMIT\(\) missing 1 required positional argument: 'answer'/,
    );
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].tool, "SUBMIT");
    assert.equal(result.calls[0].ok, false);
  });

  it("a str answer through **kwargs still submits", async () => {
    const result = await runInSandbox(`import json\nSUBMIT(**json.loads('{"answer": "ok"}'))`, {
      registry,
    });
    ok(result);
    assert.equal(result.output, "ok");
    assert.equal(result.calls[0].ok, true);
  });

  it("the resume prologue applies the same guard to a gated submit", async () => {
    // `finish` is gated, so its SubmitSignal is raised from the approval
    // replay in `resumeSuspended` — the second SUBMIT site.
    const gated = new ToolRegistry([gatedSubmit()]);
    const susp = await runInSandbox(
      `import json\nfinish(**json.loads('{"answer": [1, 2]}'))\n'after'`,
      { registry: gated },
      { onApproval: () => "suspend" },
    );
    suspended(susp);
    const result = await resumeSuspended(susp, true, { registry: gated });
    err(result);
    assert.equal(result.errorKind, "runtime");
    assert.match(result.error, /TypeError: SUBMIT\(\) answer must be str, not list/);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].ok, false);
    assert.equal(
      result.calls[0].approved,
      true,
      "the user did approve; the answer was the problem",
    );

    // And a str answer through the same prologue is the ok result it always was.
    const good = await runInSandbox(
      "finish('the-answer')",
      { registry: gated },
      {
        onApproval: () => "suspend",
      },
    );
    suspended(good);
    const done = await resumeSuspended(good, true, { registry: gated });
    ok(done);
    assert.equal(done.output, "the-answer");
  });

  it("the type checker refuses the direct forms before anything runs (#65 test 5, pin)", async () => {
    // D103 gave SUBMIT a real `-> None` stub, so `SUBMIT()` and `SUBMIT(42)`
    // never reach the runtime guard. Green on main; pinned so a stub
    // regression is caught here and not by a runtime TypeError.
    const none = await runInSandbox("SUBMIT()", { registry });
    err(none);
    assert.equal(none.errorKind, "typing");
    assert.match(none.error, /missing-argument/);
    const num = await runInSandbox("SUBMIT(42)", { registry });
    err(num);
    assert.equal(num.errorKind, "typing");
    assert.match(num.error, /invalid-argument-type/);
    const literal = await runInSandbox("SUBMIT(**{'answer': None})", { registry });
    err(literal);
    assert.equal(literal.errorKind, "typing");
    assert.equal(none.calls.length + num.calls.length + literal.calls.length, 0);
  });
});

describe("a missing required argument on any tool is a Python TypeError (#65 test 3, D142)", () => {
  const registry = new ToolRegistry([echoTool(), makeAddTool()]);

  it("echo(**{}) and echo(*[]) raise, and are traced ok:false", async () => {
    for (const code of ["echo(**{})", "echo(*[])"]) {
      const result = await runInSandbox(code, { registry });
      err(result);
      assert.equal(result.errorKind, "runtime");
      assert.match(
        result.error,
        /TypeError: echo\(\) missing 1 required positional argument: 'text'/,
        code,
      );
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].ok, false);
      assert.equal(result.calls[0].error, "echo() missing 1 required positional argument: 'text'");
    }
  });

  it("a second tool: add(**{'a': 1}) names b, add(**{}) names both", async () => {
    const one = await runInSandbox("add(**{'a': 1})", { registry });
    err(one);
    assert.match(one.error, /TypeError: add\(\) missing 1 required positional argument: 'b'/);
    const both = await runInSandbox("add(**{})", { registry });
    err(both);
    assert.match(
      both.error,
      /TypeError: add\(\) missing 2 required positional arguments: 'a' and 'b'/,
    );
  });

  it("the exception is catchable in Python and the tool never executed", async () => {
    let executed = 0;
    const counting: HostTool = {
      ...echoTool(),
      execute: (args) => {
        executed++;
        return String(args.text);
      },
    };
    const result = await runInSandbox(
      "try:\n    echo(**{})\nexcept TypeError as e:\n    print(e)\necho('ran')",
      { registry: new ToolRegistry([counting]) },
    );
    ok(result);
    assert.equal(result.output, "ran");
    assert.equal(result.stdout, "echo() missing 1 required positional argument: 'text'\n");
    assert.equal(executed, 1, "the failed call must not have reached execute");
  });
});

describe("SubmitSignal — the answer is unknown until the sandbox checks it (100% floor)", () => {
  it("a string answer keeps the historical message", () => {
    const signal = new SubmitSignal("x");
    assert.equal(signal.message, "SUBMIT: x");
    assert.equal(signal.answer, "x");
    assert.equal(signal.name, "SubmitSignal");
  });

  it("a non-string answer is carried as it is, and the message names its Python type", () => {
    const signal = new SubmitSignal(42);
    assert.equal(signal.answer, 42);
    assert.equal(signal.message, "SUBMIT: <non-str answer (int)>");
    assert.equal(new SubmitSignal(null).message, "SUBMIT: <non-str answer (NoneType)>");
  });
});

// ── Ordering: seq and stdoutOffset (#69 finding 4, D143) ─────────
//
// Every entry the sandbox pushes now says where in the run it happened:
// `seq`, a per-run counter that is strictly increasing across every push
// site, and `stdoutOffset`, the byte of this call's stdout at which the call
// was dispatched — so a consumer can put the trace back into the stream.

describe("ToolCallTrace.seq and stdoutOffset", () => {
  it("seq counts every call in dispatch order; stdoutOffset is the stdout position at the call", async () => {
    const registry = new ToolRegistry([echoTool()]);
    const result = await runInSandbox(
      'print("P1")\necho("a")\nprint("x", end="")\necho("b")\nprint("y")\necho("c")',
      { registry },
    );
    ok(result);
    assert.equal(result.stdout, "P1\nxy\n");
    assert.deepEqual(
      result.calls.map((c) => c.seq),
      [0, 1, 2],
    );
    // "P1\n" is 3 bytes; the partial "x" Monty flushes at the host boundary
    // is already in the accumulator when `echo("b")` is dispatched (measured).
    assert.deepEqual(
      result.calls.map((c) => c.stdoutOffset),
      [3, 4, 6],
    );
  });

  it("every push site stamps one: ok, thrown, denied, unresolved, SUBMIT", async () => {
    const thrower: HostTool = {
      ...echoTool(),
      name: "boom",
      execute: () => {
        throw new HostToolError("ValueError", "boom");
      },
    };
    const gate: HostTool = { ...echoTool(), name: "gate", requiresApproval: true };
    const registry = rlmRegistry(echoTool(), thrower, gate);
    const result = await runInSandbox(
      [
        "echo('ok')",
        "try:",
        "    boom('x')",
        "except ValueError:",
        "    pass",
        "try:",
        "    gate('x')",
        "except PermissionError:",
        "    pass",
        "try:",
        "    echo(**{})",
        "except TypeError:",
        "    pass",
        "SUBMIT('done')",
      ].join("\n"),
      { registry },
      { onApproval: () => false },
    );
    ok(result);
    assert.deepEqual(
      result.calls.map((c) => [c.tool, c.ok]),
      [
        ["echo", true],
        ["boom", false],
        ["gate", false],
        ["echo", false],
        ["SUBMIT", true],
      ],
    );
    assert.deepEqual(
      result.calls.map((c) => c.seq),
      [0, 1, 2, 3, 4],
    );
    for (const call of result.calls) assert.equal(call.stdoutOffset, 0);
  });

  it("is preserved across resumeSuspended and continues after the carried entries", async () => {
    const gate: HostTool = { ...echoTool(), name: "gate", requiresApproval: true };
    const registry = new ToolRegistry([echoTool(), gate]);
    const susp = await runInSandbox(
      'echo("a")\nprint("pre")\necho("b")\ngate("g")\nprint("post")\necho("c")',
      { registry },
      { onApproval: () => "suspend" },
    );
    suspended(susp);
    assert.deepEqual(
      susp.calls.map((c) => c.seq),
      [0, 1],
    );
    const result = await resumeSuspended(susp, true, { registry });
    ok(result);
    assert.deepEqual(
      result.calls.map((c) => [c.tool, c.seq, c.stdoutOffset]),
      [
        ["echo", 0, 0],
        ["echo", 1, 4],
        ["gate", 2, 4],
        ["echo", 3, 9],
      ],
    );
    assert.equal(result.stdout, "pre\npost\n");
  });

  it("the resume prologue's other outcomes stamp one too: denied, thrown, SUBMIT", async () => {
    const gate: HostTool = { ...echoTool(), name: "gate", requiresApproval: true };
    const thrower: HostTool = {
      ...gate,
      name: "boom",
      execute: () => {
        throw new HostToolError("ValueError", "boom");
      },
    };
    const registry = new ToolRegistry([echoTool(), gate, thrower, gatedSubmit()]);
    const suspend = () => ({ onApproval: () => "suspend" as const });

    const denied = await runInSandbox('echo("a")\ngate("g")', { registry }, suspend());
    suspended(denied);
    const d = await resumeSuspended(denied, false, { registry });
    err(d);
    assert.deepEqual(
      d.calls.map((c) => [c.tool, c.ok, c.seq]),
      [
        ["echo", true, 0],
        ["gate", false, 1],
      ],
    );

    const thrown = await runInSandbox('echo("a")\nboom("g")', { registry }, suspend());
    suspended(thrown);
    const t = await resumeSuspended(thrown, true, { registry });
    err(t);
    assert.deepEqual(
      t.calls.map((c) => [c.tool, c.ok, c.seq]),
      [
        ["echo", true, 0],
        ["boom", false, 1],
      ],
    );

    const submitted = await runInSandbox('echo("a")\nfinish("ans")', { registry }, suspend());
    suspended(submitted);
    const s = await resumeSuspended(submitted, true, { registry });
    ok(s);
    assert.equal(s.output, "ans");
    assert.deepEqual(
      s.calls.map((c) => [c.tool, c.ok, c.seq]),
      [
        ["echo", true, 0],
        ["finish", true, 1],
      ],
    );
  });

  it("entries restored without the fields (a loaded dump) are continued from their count", async () => {
    // `Session.load()` rebuilds suspended calls through a validator that
    // knows neither field, so a resume may find carried entries without
    // them. Numbering continues from the count, so the run stays strictly
    // increasing when the bare entries are read by index.
    const gate: HostTool = { ...echoTool(), name: "gate", requiresApproval: true };
    const registry = new ToolRegistry([echoTool(), gate]);
    const susp = await runInSandbox(
      'echo("a")\necho("b")\ngate("g")\necho("c")',
      { registry },
      {
        onApproval: () => "suspend",
      },
    );
    suspended(susp);
    const bare = {
      ...susp,
      calls: susp.calls.map(({ seq: _seq, stdoutOffset: _at, ...rest }) => rest),
    };
    const result = await resumeSuspended(bare, true, { registry });
    ok(result);
    assert.deepEqual(
      result.calls.map((c) => c.seq),
      [undefined, undefined, 2, 3],
    );
  });

  it("stdoutOffset counts this call's own bytes: the replay mark is not in it", async () => {
    const registry = new ToolRegistry([echoTool()]);
    const result = await runInSandbox(
      'print("replayed")\nprint("own")\necho("x")',
      { registry },
      { stdoutSkipBytes: 9 },
    );
    ok(result);
    assert.equal(result.stdout, "own\n");
    assert.equal(result.calls[0].stdoutOffset, 4);
  });

  it("survives an in-process copy but is not serialised — the dump validator's shape is", async () => {
    const registry = new ToolRegistry([echoTool()]);
    const result = await runInSandbox('echo("a")', { registry });
    ok(result);
    const [call] = result.calls;
    assert.equal(call.seq, 0);
    assert.equal(call.stdoutOffset, 0);
    // Spread and structuredClone keep them: the trace API's alignment copies
    // entries by spread.
    assert.equal({ ...call }.seq, 0);
    assert.equal(structuredClone(call).stdoutOffset, 0);
    // JSON does not: `Session.dump()` writes `calls` verbatim and
    // `Session.load()` refuses a key its validator does not know.
    const persisted = JSON.parse(JSON.stringify(result.calls))[0];
    assert.deepEqual(Object.keys(persisted).sort(), ["args", "durationMs", "kwargs", "ok", "tool"]);
    assert.equal(JSON.stringify([call]), JSON.stringify(result.calls));
  });

  it("filtering the trace by any predicate keeps seq strictly increasing (what replay filtering must preserve)", async () => {
    const registry = new ToolRegistry([echoTool()]);
    const result = await runInSandbox(
      Array.from({ length: 6 }, (_, i) => `echo("${i}")`).join("\n"),
      { registry },
    );
    ok(result);
    const seqs = result.calls.map((c) => c.seq);
    assert.deepEqual(seqs, [0, 1, 2, 3, 4, 5]);
    for (const keep of [
      (_c: unknown, i: number) => i % 2 === 0,
      (_c: unknown, i: number) => i > 2,
      (_c: unknown, i: number) => i !== 3,
    ]) {
      const filtered = result.calls.filter(keep).map((c) => c.seq as number);
      for (let i = 1; i < filtered.length; i++) {
        assert.ok(filtered[i] > filtered[i - 1], `not increasing: ${filtered.join(",")}`);
      }
    }
  });

  // Residual (todo, decision 9): the fields do not survive a dump.
  it("seq and stdoutOffset survive JSON serialisation, so a Session dump keeps the ordering", {
    todo:
      "src/session.ts `traces()` is a closed validator that refuses unknown keys and `dump()` " +
      "writes `result.calls` verbatim, so the entries hide the two fields from JSON (`toJSON`) " +
      "to keep a suspended session loadable. Intended approach: the validator accepts `seq` and " +
      "`stdoutOffset` as optional finite numbers, then the `toJSON` in src/sandbox.ts is deleted.",
  }, async () => {
    const registry = new ToolRegistry([echoTool()]);
    const result = await runInSandbox('echo("a")', { registry });
    ok(result);
    const persisted = JSON.parse(JSON.stringify(result.calls))[0];
    assert.equal(persisted.seq, 0);
    assert.equal(persisted.stdoutOffset, 0);
  });
});

// ── #69 findings 3 and 5, pinned against the shipped Monty (D147) ──

describe("there is no stderr: every route to it fails, and nothing reaches stdout (#69 finding 3)", () => {
  const registry = new ToolRegistry();
  const forms: Array<[code: string, kind: string, message: RegExp]> = [
    [
      "import sys\nprint('e', file=sys.stderr)",
      "runtime",
      /TypeError: print\(\) 'file' argument is not supported/,
    ],
    ["import sys\nsys.stderr.write('e')", "runtime", /AttributeError: .* has no attribute 'write'/],
    ["import sys\nsys.stdout.write('o')", "runtime", /AttributeError: .* has no attribute 'write'/],
    ["import os\nos.write(2, b'e')", "typing", /unresolved-attribute/],
    ["import warnings\nwarnings.warn('w')", "typing", /unresolved-import/],
  ];

  for (const [code, kind, message] of forms) {
    it(`${code.replace(/\n/g, "; ")} → ${kind}`, async () => {
      const prints: string[] = [];
      const result = await runInSandbox(code, { registry }, { onPrint: (t) => prints.push(t) });
      err(result);
      assert.equal(result.errorKind, kind);
      assert.match(result.error, message);
      assert.equal(result.stdout, "");
      assert.deepEqual(prints, []);
    });
  }

  it("the sys.stderr object exists and is write-less — a print()-only I/O model", async () => {
    const result = await runInSandbox("import sys\nsys.stderr", { registry });
    ok(result);
    assert.equal(result.output, "<stderr>");
  });
});

describe("the print callback's return value is ignored on 0.0.21 (#69 finding 5, dissolved)", () => {
  it("a callback returning a value neither throws nor changes the run", async () => {
    // 0.0.18 threw `TypeError: Value is not undefined` at a callback that
    // returned anything, which made the block-bodied arrow in
    // `makePrintCallback` load-bearing by accident. Measured on 0.0.21 through
    // a raw session: tolerated. Pinned so a version bump that reinstates the
    // rule fails here, with the reason, rather than in every print test.
    const monty = await Monty.create({});
    try {
      const session = await monty.checkout({ scriptName: "finding-5" });
      try {
        const seen: string[] = [];
        const snapshot = await session.feedStart('print("hi")\n1', {
          printCallback: ((_stream: string, text: string) => {
            seen.push(text);
            return "not undefined";
          }) as unknown as PrintCallback,
        });
        assert.ok(snapshot instanceof MontyComplete, "the run did not complete");
        assert.equal(snapshot.output, 1);
        assert.deepEqual(seen, ["hi\n"]);
      } finally {
        await session.close();
      }
    } finally {
      await monty.close();
    }
  });
});
