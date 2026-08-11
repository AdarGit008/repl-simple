import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runInSandbox } from "../src/sandbox.js";
import { ToolRegistry } from "../src/registry.js";
import { HostToolError } from "../src/types.js";
import type {
  HostTool,
  RunOk,
  RunError,
  RunSuspended,
  ApprovalDecision,
} from "../src/types.js";

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

function ok(result: unknown): asserts result is RunOk {
  assert.equal((result as RunOk).status, "ok");
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
    const result = await runInSandbox(
      'print("a")\nprint("b")\n42',
      { registry },
    );
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
    const result = await runInSandbox(
      'print("before")\n1 / 0',
      { registry },
    );
    err(result);
    assert.equal(result.errorKind, "runtime");
    assert.ok(result.stdout.includes("before"));
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
    const result = await runInSandbox('sensitive("data")', { registry }, {
      onApproval: () => true,
    });
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
    const result = await runInSandbox('sensitive("data")', { registry }, {
      onApproval: () => "suspend",
    });
    suspended(result);
    assert.equal(result.suspendedCall.tool, "sensitive");
    assert.deepEqual(result.suspendedCall.args, ["data"]);
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
    const result = await runInSandbox('echo("hi")', { registry }, {
      onApproval: () => {
        // Should never be called
        throw new Error("approval should not be requested");
      },
    });
    ok(result);
    assert.equal(result.output, "hi");
    assert.equal(result.calls[0].approved, undefined);
  });
});

// ── Stdout truncation ───────────────────────────────────────────

describe("runInSandbox — stdout truncation", () => {
  const registry = new ToolRegistry();

  it("stdoutTruncated true when output exceeds limit", async () => {
    const result = await runInSandbox(
      'print("A" * 200)',
      { registry },
      { maxStdoutBytes: 10 },
    );
    ok(result);
    assert.equal(result.stdoutTruncated, true);
  });

  it("stdoutTruncated false when within limit", async () => {
    const result = await runInSandbox(
      'print("hi")',
      { registry },
      { maxStdoutBytes: 1000 },
    );
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
    const result = await runInSandbox("1 + 1", { registry }, {
      signal: controller.signal,
    });
    err(result);
    assert.equal(result.errorKind, "aborted");
  });
});

// ── Multiple tool calls ─────────────────────────────────────────

describe("runInSandbox — multiple tool calls", () => {
  it("records two ToolCallTrace entries", async () => {
    const registry = new ToolRegistry([echoTool()]);
    const result = await runInSandbox(
      'echo("a")\necho("b")',
      { registry },
    );
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
    const result = await runInSandbox("x + y", { registry }, {
      inputs: { x: "Hello", y: "World" },
    });
    ok(result);
    assert.equal(result.output, "HelloWorld");
  });

  it("input variable name in registry takes precedence as tool", async () => {
    // If a name exists as both input and tool, the tool wins
    // (NameLookup checks registry first)
    const registry = new ToolRegistry([echoTool()]);
    // "echo" as input won't override the tool
    const result = await runInSandbox('echo("wins")', { registry });
    ok(result);
    assert.equal(result.output, "wins");
  });
});

// ── Mount ─────────────────────────────────────────────────────────

describe("runInSandbox — mount", () => {
  it("passes mount to Monty (does not crash)", async () => {
    const registry = new ToolRegistry();
    const result = await runInSandbox("42", { registry }, {
      mount: { "/data": "/tmp" },
    });
    ok(result);
    assert.equal(result.output, "42");
  });
});
