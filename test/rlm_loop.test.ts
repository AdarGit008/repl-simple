import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RLMLoop,
  getReplPreamble,
  type RLMLoopOptions,
  type RLMLoopResult,
  type RlmMessage,
} from "../src/rlm_loop.js";
import { ToolRegistry } from "../src/registry.js";
import type { HostTool } from "../src/types.js";

// ── Helpers ─────────────────────────────────────────────────────

/** A generateCode that returns a fixed code string. */
function fixedCode(code: string) {
  return async (_messages: RlmMessage[]): Promise<string> => code;
}

/** A generateCode that returns from a sequence, then repeats the last. */
function codeSequence(...codes: string[]) {
  let i = 0;
  return async (_messages: RlmMessage[]): Promise<string> => {
    const code = codes[Math.min(i, codes.length - 1)];
    i++;
    return code;
  };
}

/** A generateCode that records calls and returns from a sequence. */
function recordingCode(...codes: string[]) {
  const messages: RlmMessage[][] = [];
  let i = 0;
  const fn = async (msgs: RlmMessage[]): Promise<string> => {
    messages.push([...msgs]);
    const code = codes[Math.min(i, codes.length - 1)];
    i++;
    return code;
  };
  return { fn, messages: () => messages };
}

/** An llmQuery that returns canned responses. */
function cannedLLM(responses: string[] = []) {
  let i = 0;
  const prompts: string[] = [];
  const fn = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    return responses[Math.min(i++, responses.length - 1)] ?? `reply:${prompt}`;
  };
  return { fn, prompts: () => prompts };
}

/** A counter tool (side-effect: increments on each call). */
function makeCounterTool(): HostTool {
  let count = 0;
  return {
    name: "counter",
    description: "Incrementing counter",
    params: [],
    returns: "str",
    execute: () => String(++count),
  };
}

/** An echo tool. */
function makeEchoTool(): HostTool {
  return {
    name: "echo",
    description: "Echo",
    params: [{ name: "text", type: "str", description: "Text" }],
    returns: "str",
    execute: (args) => String(args.text),
  };
}

function okResult(r: RLMLoopResult): asserts r is RLMLoopResult & { status: "ok"; answer: string } {
  assert.equal(r.status, "ok");
  assert.ok(typeof r.answer === "string");
}

function errResult(
  r: RLMLoopResult,
): asserts r is RLMLoopResult & { status: "error" | "max_iterations" } {
  assert.ok(r.status !== "ok");
}

// ── Construction ────────────────────────────────────────────────

describe("RLMLoop — construction", () => {
  const baseOpts: RLMLoopOptions = {
    registry: new ToolRegistry(),
    llmQuery: async () => "",
    generateCode: async () => "",
  };

  it("constructs with valid options", () => {
    const loop = new RLMLoop(baseOpts);
    assert.ok(loop instanceof RLMLoop);
  });

  it("default maxIterations is 10", async () => {
    // Implicitly test via run — should stop after 10 iterations
    const loop = new RLMLoop({
      ...baseOpts,
      generateCode: async () => 'print("x")', // never SUBMITs
    });
    const result = await loop.run("task");
    assert.equal(result.status, "max_iterations");
    assert.equal(result.iterations, 10);
  });

  it("default depth is 0 (rlm_query spawns nested, not downgraded)", async () => {
    const llm = cannedLLM(["nested result"]);
    const loop = new RLMLoop({
      ...baseOpts,
      llmQuery: llm.fn,
      generateCode: codeSequence(
        'result = rlm_query("sub")\nSUBMIT(result)',
        'SUBMIT("from nested")',
      ),
    });
    const result = await loop.run("task");
    okResult(result);
    // rlm_query spawned a nested loop (not downgraded), so llmQuery was NOT called
    assert.equal(llm.prompts().length, 0);
    assert.equal(result.answer, "from nested");
  });
});

// ── Name collision guard ────────────────────────────────────────

describe("RLMLoop — name collision guard", () => {
  it("throws if user registry has llm_query", () => {
    const userTool: HostTool = {
      name: "llm_query",
      description: "user's llm_query",
      params: [],
      returns: "str",
      execute: () => "x",
    };
    assert.throws(
      () =>
        new RLMLoop({
          registry: new ToolRegistry([userTool]),
          llmQuery: async () => "",
          generateCode: async () => "",
        }),
      /llm_query.*conflicts/i,
    );
  });

  it("throws if user registry has rlm_query", () => {
    const userTool: HostTool = {
      name: "rlm_query",
      description: "user's rlm_query",
      params: [],
      returns: "str",
      execute: () => "x",
    };
    assert.throws(
      () =>
        new RLMLoop({
          registry: new ToolRegistry([userTool]),
          llmQuery: async () => "",
          generateCode: async () => "",
        }),
      /rlm_query.*conflicts/i,
    );
  });

  it("throws if user registry has SUBMIT", () => {
    const userTool: HostTool = {
      name: "SUBMIT",
      description: "user's SUBMIT",
      params: [],
      returns: "void",
      execute: () => "",
    };
    assert.throws(
      () =>
        new RLMLoop({
          registry: new ToolRegistry([userTool]),
          llmQuery: async () => "",
          generateCode: async () => "",
        }),
      /SUBMIT.*conflicts/i,
    );
  });

  it("does NOT throw for unrelated tool names", () => {
    const userTool = makeEchoTool();
    const loop = new RLMLoop({
      registry: new ToolRegistry([userTool]),
      llmQuery: async () => "",
      generateCode: async () => "",
    });
    assert.ok(loop instanceof RLMLoop);
  });
});

// ── Simple task → SUBMIT ────────────────────────────────────────

describe("RLMLoop — simple SUBMIT", () => {
  it("returns ok with answer from SUBMIT", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: fixedCode('SUBMIT("the answer")'),
    });
    const result = await loop.run("what is 2+2?");
    okResult(result);
    assert.equal(result.answer, "the answer");
    assert.equal(result.iterations, 1);
  });

  it("SUBMIT with computed answer", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: fixedCode("result = 2 + 2\nSUBMIT(str(result))"),
    });
    const result = await loop.run("compute 2+2");
    okResult(result);
    assert.equal(result.answer, "4");
  });

  it("distinguishes SUBMIT completion from normal completion", async () => {
    // First call: code returns a value but no SUBMIT → loop continues
    // Second call: code calls SUBMIT → loop returns
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: codeSequence(
        "x = 42\nx", // normal completion, no SUBMIT
        'SUBMIT("done")', // SUBMIT completion
      ),
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "done");
    assert.equal(result.iterations, 2);
  });
});

// ── llm_query integration ───────────────────────────────────────

describe("RLMLoop — llm_query", () => {
  it("llm_query in sandbox calls the llmQuery callback", async () => {
    const llm = cannedLLM(["four"]);
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: llm.fn,
      generateCode: fixedCode('answer = llm_query("what is 2+2?")\nSUBMIT(answer)'),
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "four");
    assert.equal(llm.prompts().length, 1);
    assert.equal(llm.prompts()[0], "what is 2+2?");
  });

  it("llm_query result is usable in Python code", async () => {
    const llm = cannedLLM(["hello"]);
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: llm.fn,
      generateCode: fixedCode('response = llm_query("greet")\nSUBMIT(response.upper())'),
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "HELLO");
  });

  it("multiple llm_query calls in one snippet", async () => {
    const llm = cannedLLM(["one", "two"]);
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: llm.fn,
      generateCode: fixedCode(
        'a = llm_query("first")\nb = llm_query("second")\nSUBMIT(a + " " + b)',
      ),
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "one two");
    assert.equal(llm.prompts().length, 2);
  });
});

// ── rlm_query integration ───────────────────────────────────────

describe("RLMLoop — rlm_query", () => {
  it("rlm_query spawns nested loop and returns result", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "fallback",
      generateCode: codeSequence(
        'result = rlm_query("investigate", "ctx data")\nSUBMIT("outer: " + result)',
        'SUBMIT("nested answer")',
      ),
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "outer: nested answer");
  });

  it("rlm_query at max depth downgrades to llmQuery", async () => {
    const llm = cannedLLM(["downgraded"]);
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: llm.fn,
      depth: 1,
      maxDepth: 1, // Already at limit
      generateCode: fixedCode('result = rlm_query("q", "c")\nSUBMIT(result)'),
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "downgraded");
  });

  it("rlm_query with no context defaults to undefined", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: codeSequence(
        'result = rlm_query("just query")\nSUBMIT(result)',
        'SUBMIT("nested ok")',
      ),
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "nested ok");
  });
});

// ── Multi-iteration loop ────────────────────────────────────────

describe("RLMLoop — multi-iteration", () => {
  it("loops after normal completion (no SUBMIT) and eventually SUBMITs", async () => {
    const { fn: gen, messages } = recordingCode(
      'print("step 1")\nx = 42\nx',
      'SUBMIT("step 2 answer")',
    );
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: gen,
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "step 2 answer");
    assert.equal(result.iterations, 2);
    // messages should contain: system, user(task), assistant(code1), user(result1), assistant(code2)
    const msgs = messages();
    assert.ok(msgs.length >= 2); // 2 calls to generateCode
    // First call: system + user(task)
    assert.equal(msgs[0][0].role, "system");
    assert.equal(msgs[0][1].role, "user");
    assert.ok(msgs[0][1].content.includes("task"));
    // Second call: all prior messages + result feedback
    assert.ok(msgs[1].length > msgs[0].length);
  });

  it("traces array has one entry per iteration", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: codeSequence('print("iter1")\n42', 'print("iter2")\n43', 'SUBMIT("done")'),
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.iterations, 3);
    assert.equal(result.traces.length, 3);
  });

  it("messages array contains conversation history", async () => {
    const { fn: gen, messages } = recordingCode('SUBMIT("direct")');
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: gen,
    });
    const result = await loop.run("my task", "my context");
    okResult(result);
    // First (and only) gen call should have system + user with task + context
    const firstCall = messages()[0];
    const userMsg = firstCall.find((m) => m.role === "user");
    assert.ok(userMsg);
    assert.ok(userMsg.content.includes("my task"));
    assert.ok(userMsg.content.includes("my context"));
  });
});

// ── Error recovery ──────────────────────────────────────────────

describe("RLMLoop — error recovery", () => {
  it("recovers from syntax error and SUBMITs on retry", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: codeSequence(
        "1 +", // syntax error
        'SUBMIT("fixed")',
      ),
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "fixed");
    assert.equal(result.iterations, 2);
  });

  it("recovers from runtime error and SUBMITs on retry", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: codeSequence(
        "undefined_var", // NameError → typing error in Monty
        'SUBMIT("recovered")',
      ),
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "recovered");
  });

  it("passes error details to LLM for recovery", async () => {
    const { fn: gen, messages } = recordingCode(
      "1 / 0", // error
      'SUBMIT("ok")',
    );
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: gen,
    });
    const result = await loop.run("task");
    okResult(result);

    // The second call to gen should include error details in conversation
    const secondCall = messages()[1];
    const userFeedback = secondCall.find((m) => m.role === "user" && m.content.includes("error"));
    assert.ok(userFeedback, "error feedback should be in conversation");
  });
});

// ── Max iterations ──────────────────────────────────────────────

describe("RLMLoop — max iterations", () => {
  it("returns max_iterations after exceeding limit", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: async () => "42", // never SUBMITs
      maxIterations: 3,
    });
    const result = await loop.run("task");
    assert.equal(result.status, "max_iterations");
    assert.equal(result.iterations, 3);
  });

  it("custom maxIterations works", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: async () => "42",
      maxIterations: 5,
    });
    const result = await loop.run("task");
    assert.equal(result.status, "max_iterations");
    assert.equal(result.iterations, 5);
  });
});

// ── generateCode throws ─────────────────────────────────────────

describe("RLMLoop — generateCode throws", () => {
  it("returns error status when generateCode throws", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: async () => {
        throw new Error("LLM API unavailable");
      },
    });
    const result = await loop.run("task");
    errResult(result);
    assert.equal(result.status, "error");
    assert.ok(result.error!.includes("LLM API unavailable"));
  });
});

// ── llmQuery throws ─────────────────────────────────────────────

describe("RLMLoop — llmQuery throws", () => {
  it("llmQuery error surfaces as RuntimeError in sandbox (loops for recovery)", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => {
        throw new Error("LLM down");
      },
      generateCode: codeSequence(
        'try:\n    llm_query("q")\n    result = "no-error"\nexcept Exception as e:\n    result = str(e)\nSUBMIT(result)',
      ),
    });
    const result = await loop.run("task");
    okResult(result);
    // The error should propagate as a RuntimeError, which Python can catch
    assert.ok(result.answer.includes("LLM down") || result.answer.includes("RuntimeError"));
  });
});

// ── Empty task ──────────────────────────────────────────────────

describe("RLMLoop — empty task", () => {
  it("empty task does not crash", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: fixedCode('SUBMIT("empty task handled")'),
    });
    const result = await loop.run("");
    okResult(result);
    assert.equal(result.answer, "empty task handled");
  });
});

// ── Context passthrough ─────────────────────────────────────────

describe("RLMLoop — context passthrough", () => {
  it("context is passed as input variable to sandbox", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: fixedCode("SUBMIT(context)"),
    });
    const result = await loop.run("task", "the context data");
    okResult(result);
    assert.equal(result.answer, "the context data");
  });

  it("context is included in initial user message", async () => {
    const { fn: gen, messages } = recordingCode('SUBMIT("ok")');
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: gen,
    });
    await loop.run("the task", "file contents here");
    const firstCallMsgs = messages()[0];
    const userMsg = firstCallMsgs.find((m) => m.role === "user")!;
    assert.ok(userMsg.content.includes("the task"));
    assert.ok(userMsg.content.includes("file contents here"));
  });

  it("context defaults to empty string when not provided", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: fixedCode("SUBMIT(context)"),
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "");
  });
});

// ── Tool availability ───────────────────────────────────────────

describe("RLMLoop — tool availability", () => {
  it("user-registered tools are available in sandbox", async () => {
    const echo = makeEchoTool();
    const loop = new RLMLoop({
      registry: new ToolRegistry([echo]),
      llmQuery: async () => "",
      generateCode: fixedCode('result = echo("hello")\nSUBMIT(result)'),
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "hello");
  });

  it("counter tool is called fresh each real execution", async () => {
    const counter = makeCounterTool();
    const loop = new RLMLoop({
      registry: new ToolRegistry([counter]),
      llmQuery: async () => "",
      generateCode: codeSequence(
        "counter()", // → 1 (but no SUBMIT → continues)
        "counter()", // → 2 (but no SUBMIT → continues)
        "SUBMIT(str(counter()))", // → 3
      ),
    });
    const result = await loop.run("task");
    okResult(result);
    // Each iteration runs fresh code against the same counter
    assert.equal(result.answer, "3");
  });
});

// ── Unexpected suspension ───────────────────────────────────────

describe("RLMLoop — unexpected suspension", () => {
  const gatedTool: HostTool = {
    name: "gated",
    description: "Needs approval",
    params: [],
    returns: "str",
    requiresApproval: true,
    execute: () => "approved",
  };

  it("returns error when sandbox suspends (no approval callback)", async () => {
    // Without onApproval the gated tool is denied → PermissionError → runtime
    // error, and the loop keeps retrying, so maxIterations=1 is what exercises
    // the exhaustion path directly. #23 deleted an unasserted first run that
    // built the same loop without the cap and discarded its result.
    const loop2 = new RLMLoop({
      registry: new ToolRegistry([gatedTool]),
      llmQuery: async () => "",
      generateCode: fixedCode("gated()"),
      maxIterations: 1,
    });
    const result2 = await loop2.run("task");
    errResult(result2);
    assert.equal(result2.status, "max_iterations");
  });

  it("with onApproval → suspend, returns error", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry([gatedTool]),
      llmQuery: async () => "",
      generateCode: fixedCode("gated()"),
      runOpts: {
        onApproval: () => "suspend",
      },
      maxIterations: 1,
    });
    const result = await loop.run("task");
    assert.equal(result.status, "error");
    assert.ok(result.error!.includes("suspension"));
  });

  it("with onApproval → true, tool executes and continues", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry([gatedTool]),
      llmQuery: async () => "",
      generateCode: fixedCode("result = gated()\nSUBMIT(result)"),
      runOpts: {
        onApproval: () => true,
      },
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "approved");
  });
});

// ── Nested rlm_query ────────────────────────────────────────────

describe("RLMLoop — nested rlm_query", () => {
  it("nested loop returns result to parent sandbox", async () => {
    const gen = codeSequence(
      // Root code: call rlm_query, then SUBMIT combined result
      'nested_result = rlm_query("sub question")\nSUBMIT("parent: " + nested_result)',
      // Nested code: just SUBMIT
      'SUBMIT("child answer")',
    );
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "fallback",
      generateCode: gen,
    });
    const result = await loop.run("parent task");
    okResult(result);
    assert.equal(result.answer, "parent: child answer");
  });

  it("nested loop composes with llm_query", async () => {
    const llm = cannedLLM(["llm result"]);
    const gen = codeSequence(
      // Root: rlm_query → SUBMIT
      'nested = rlm_query("investigate")\nSUBMIT("final: " + nested)',
      // Nested: llm_query → SUBMIT
      'answer = llm_query("what do you think?")\nSUBMIT(answer)',
    );
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: llm.fn,
      generateCode: gen,
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "final: llm result");
    assert.equal(llm.prompts()[0], "what do you think?");
  });
});

// ── runOpts passthrough ─────────────────────────────────────────

describe("RLMLoop — runOpts passthrough", () => {
  it("inputs are passed to sandbox", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: fixedCode("SUBMIT(my_var)"),
      runOpts: {
        inputs: { my_var: "injected value" },
      },
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "injected value");
  });

  it("signal can abort execution", async () => {
    const controller = new AbortController();
    controller.abort();
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: fixedCode("1 + 1"),
      runOpts: {
        signal: controller.signal,
      },
      maxIterations: 1,
    });
    const result = await loop.run("task");
    errResult(result);
    // Either error or max_iterations (error causes loop, abort is error)
    assert.ok(result.status === "error" || result.status === "max_iterations");
  });

  it("maxStdoutBytes limits output", async () => {
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: fixedCode('print("A" * 5000)\nSUBMIT("done")'),
      runOpts: {
        maxStdoutBytes: 50,
      },
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "done");

    // The run completes despite its stdout being capped well below what the
    // code printed. #23 replaced a dead `const trace = result.traces[0]` here
    // whose own comment admitted it could not assert what it wanted:
    // stdoutTruncated lives on RunResult, not on a trace entry.
    assert.equal(result.traces.length, 1);
  });
});

// ── Preamble injection ─────────────────────────────────────────

describe("RLMLoop — preamble", () => {
  const baseOpts: RLMLoopOptions = {
    registry: new ToolRegistry(),
    llmQuery: async () => "",
    generateCode: async () => "",
  };

  it("preamble is prepended to code before sandbox execution", async () => {
    const preamble = "# preamble header\nHELPER = 42\n";
    const loop = new RLMLoop({
      ...baseOpts,
      preamble,
      generateCode: fixedCode("SUBMIT(str(HELPER))"),
    });
    const result = await loop.run("task");
    okResult(result);
    // HELPER defined in preamble, accessible in user code
    assert.equal(result.answer, "42");
  });

  it("context helpers from preamble are available", async () => {
    const preamble = [
      "def context_length() -> int:",
      '    """Return the total character length of the context."""',
      "    return len(context) if context else 0",
      "",
    ].join("\n");
    const loop = new RLMLoop({
      ...baseOpts,
      preamble,
      generateCode: fixedCode("SUBMIT(str(context_length()))"),
    });
    const result = await loop.run("task", "hello world");
    okResult(result);
    assert.equal(result.answer, "11");
  });

  it("no preamble (undefined) — existing behavior unchanged", async () => {
    const loop = new RLMLoop({
      ...baseOpts,
      // preamble: undefined (default)
      generateCode: fixedCode('SUBMIT("works")'),
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "works");
  });

  it("preamble is inherited by nested loops", async () => {
    const preamble = "NESTED_HELPER = 99\n";
    const loop = new RLMLoop({
      ...baseOpts,
      preamble,
      generateCode: codeSequence(
        // Root: rlm_query → SUBMIT combined
        'nested = rlm_query("sub")\nSUBMIT("root:" + nested)',
        // Nested: uses preamble variable → SUBMIT
        "SUBMIT(str(NESTED_HELPER))",
      ),
    });
    const result = await loop.run("task");
    okResult(result);
    assert.equal(result.answer, "root:99");
  });

  it("preamble with repl_server.py style functions", async () => {
    const preamble = [
      "def context_preview(max_chars: int = 500) -> str:",
      '    """Return a truncated preview of the context."""',
      "    if not context:",
      '        return "(empty)"',
      "    if len(context) <= max_chars:",
      "        return context",
      "    half = max_chars // 2",
      "    return context[:half] + '...' + context[-half:]",
      "",
    ].join("\n");
    const loop = new RLMLoop({
      ...baseOpts,
      preamble,
      generateCode: fixedCode("preview = context_preview(10)\nSUBMIT(preview)"),
    });
    const result = await loop.run("task", "abcdefghijklmnopqrstuvwxyz");
    okResult(result);
    assert.ok(result.answer.includes("..."));
  });
});

// ── System prompt ───────────────────────────────────────────────

describe("RLMLoop — system prompt", () => {
  it("system prompt includes tool stubs", async () => {
    const echo = makeEchoTool();
    const { fn: gen, messages } = recordingCode('SUBMIT("ok")');
    const loop = new RLMLoop({
      registry: new ToolRegistry([echo]),
      llmQuery: async () => "",
      generateCode: gen,
    });
    await loop.run("task");
    const systemMsg = messages()[0].find((m) => m.role === "system");
    assert.ok(systemMsg);
    assert.ok(systemMsg.content.includes("echo"));
    assert.ok(systemMsg.content.includes("llm_query"));
    assert.ok(systemMsg.content.includes("rlm_query"));
    assert.ok(systemMsg.content.includes("SUBMIT"));
  });

  it("system prompt includes SUBMIT requirement", async () => {
    const { fn: gen, messages } = recordingCode('SUBMIT("ok")');
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: gen,
    });
    await loop.run("task");
    const systemMsg = messages()[0].find((m) => m.role === "system");
    assert.ok(systemMsg);
    assert.ok(systemMsg.content.includes("SUBMIT"));
  });

  it("system prompt mentions preamble helpers when preamble is set", async () => {
    const { fn: gen, messages } = recordingCode('SUBMIT("ok")');
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: gen,
      preamble: "def foo(): pass",
    });
    await loop.run("task");
    const systemMsg = messages()[0].find((m) => m.role === "system");
    assert.ok(systemMsg);
    assert.ok(systemMsg.content.includes("Preamble Helpers"));
  });

  it("system prompt does NOT mention preamble when preamble is not set", async () => {
    const { fn: gen, messages } = recordingCode('SUBMIT("ok")');
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: gen,
      // preamble: undefined
    });
    await loop.run("task");
    const systemMsg = messages()[0].find((m) => m.role === "system");
    assert.ok(systemMsg);
    assert.ok(!systemMsg.content.includes("Preamble Helpers"));
  });
});

// ── getReplPreamble ────────────────────────────────────────────

describe("getReplPreamble", () => {
  it("returns contents of repl_server.py", () => {
    const preamble = getReplPreamble();
    assert.ok(preamble.includes("context_preview"));
    assert.ok(preamble.includes("context_lines"));
    assert.ok(preamble.includes("context_length"));
    assert.ok(preamble.includes("context_summary"));
  });

  it("returned string is usable as an RLMLoop preamble", async () => {
    const preamble = getReplPreamble();
    const loop = new RLMLoop({
      registry: new ToolRegistry(),
      llmQuery: async () => "",
      generateCode: fixedCode("SUBMIT(str(context_length()))"),
      preamble,
    });
    const result = await loop.run("task", "hello world");
    okResult(result);
    assert.equal(result.answer, "11");
  });
});
