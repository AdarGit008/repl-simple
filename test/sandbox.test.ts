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
import type { HostTool, RunOk, RunError, RunSuspended } from "../src/types.js";

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
    // Monty calls printCallback once per print, no trailing newline
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
// (`correctSyntaxErrorText` is a no-op on text with no locations), and leak
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
    // Monty sends newlines as separate callbacks: ('a','\n','b','\n')
    const joined = prints.join("");
    assert.ok(joined.includes("a"));
    assert.ok(joined.includes("b"));
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
  // The loop is 5,000,000 iterations rather than 200,000 because the duration
  // clock inverted with the move to a worker. On 0.0.18 `maxDurationSecs` was
  // wall clock and the 250 ms sleep alone consumed a 200 ms budget, so a short
  // loop only had to run long enough to *notice*. 0.0.21's clock advances only
  // while the interpreter executes and stops while the sandbox is suspended on
  // a host call, so the sleep now contributes nothing and the loop has to
  // spend the whole budget by itself (measured: 200,000 iterations cost ~67 ms
  // of interpreter time, 5,000,000 cost ~555 ms).
  const OVERRUN_THEN_LOOP = [
    "slow()",
    "total = 0",
    "for i in range(5000000):",
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
    assert.ok(result.output.startsWith("0,1,2,3"), "head lost");
    assert.ok(result.output.endsWith("4999"), "tail lost");
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
  const UNCHECKPOINTED_RUNAWAY = "x = 10 ** 100000000\n1";

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
      }),
      { maxDurationSecs: 3, maxMemory: 7 * 1_048_576, gcInterval: 500, maxRecursionDepth: 64 },
    );

    // Unset knobs take the default; `maxWallClockSecs` is the host's and is not
    // Monty's to receive.
    const defaults = limitsConfig();
    assert.deepEqual(toResourceLimits({ maxWallClockSecs: 9 }), {
      maxDurationSecs: defaults.maxDurationSecs,
      maxMemory: defaults.maxMemory,
      gcInterval: undefined,
      maxRecursionDepth: undefined,
    });

    // The one path to no limits at all, and it has to be typed.
    assert.equal(toResourceLimits("unbounded"), undefined);
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
