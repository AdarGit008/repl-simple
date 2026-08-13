import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { runInSandbox, resumeSuspended, memoryGuardConfig } from "../src/sandbox.js";
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
  it("passes mount to Monty (does not crash)", async () => {
    const registry = new ToolRegistry();
    const result = await runInSandbox(
      "42",
      { registry },
      {
        mount: { "/data": "/tmp" },
      },
    );
    ok(result);
    assert.equal(result.output, "42");
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
  // Python following it completes `ok`, which is what once made the duration
  // clock look like it measured compute rather than wall time.
  const OVERRUN_THEN_LOOP = [
    "slow()",
    "total = 0",
    "for i in range(200000):",
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
    },
    {
      name: "memory",
      limits: { maxDurationSecs: 30, maxMemory: 1024 * 1024 },
      code: CALL_THEN_ALLOCATE,
      toolMs: 1,
      expected: /MemoryError/,
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
    it(`runInSandbox: a ${kind.name} breach returns a runtime RunError`, async () => {
      const registry = new ToolRegistry([sleepTool(kind.toolMs)]);
      const result = await noThrow("runInSandbox", () =>
        runInSandbox(kind.code, { registry }, { limits: kind.limits }),
      );

      err(result);
      assert.equal(result.errorKind, "runtime");
      assert.match(result.error, kind.expected);
    });

    it(`resumeSuspended: a ${kind.name} breach returns a runtime RunError`, async () => {
      // The limit rides on the *initial* run, not the resume. Monty's
      // `SnapshotLoadOptions` carries only a `printCallback` — there is no
      // `limits` field — so the budget in force after a resume is the one
      // `monty.start()` was given, restored with the snapshot.
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
      assert.equal(result.errorKind, "runtime");
      assert.match(result.error, kind.expected);
    });
  }

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
        assert.equal(result.errorKind, "runtime", where);
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
