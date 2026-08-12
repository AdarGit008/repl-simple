import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInSandbox } from "../src/sandbox.js";
import { ToolRegistry } from "../src/registry.js";
import { HostToolError, SubmitSignal } from "../src/index.js";
import type {
  LlmClient,
  HostTool,
  RlmIteration,
  RlmOptions,
  RlmResult,
} from "../src/types.js";

import { createRLMTools } from "../src/rlm_tools.js";
import { runRlm, extractPythonCode, DEFAULT_RLM_SYSTEM_PROMPT } from "../src/rlm.js";

// ── Helpers ─────────────────────────────────────────────────────

/** Mock LlmClient that returns responses from a canned array. */
function makeMockLlm(responses: string[] = []): {
  llm: LlmClient & { calls(): Array<{ systemPrompt: string; messages: Array<{ role: string; content: string }> }> };
} {
  const callRecords: Array<{
    systemPrompt: string;
    messages: Array<{ role: string; content: string }>;
  }> = [];
  let i = 0;
  const llm: LlmClient & {
    calls(): Array<{ systemPrompt: string; messages: Array<{ role: string; content: string }> }>;
  } = {
    async query(systemPrompt, messages) {
      callRecords.push({
        systemPrompt,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      });
      return responses[i++] ?? "";
    },
    calls() {
      return callRecords;
    },
  };
  return { llm };
}

/** Get a tool by name from an array. */
function getTool(tools: HostTool[], name: string): HostTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool;
}

/**
 * Create RLM tools using main's createRLMTools, wired to a mock LlmClient.
 * llm_query calls the mock LLM directly. rlm_query also delegates to the
 * mock LLM (no nested sandbox in these tests — that's the RLMLoop's job).
 */
function makeRlmTools(llmMock: ReturnType<typeof makeMockLlm>["llm"]): HostTool[] {
  return createRLMTools({
    onLLMQuery: async (prompt: string) => {
      return await llmMock.query(
        "You are a helpful assistant. Answer concisely.",
        [{ role: "user", content: prompt }],
      );
    },
    onRLMQuery: async (query: string, context?: string) => {
      const ctx = context ? `\nContext: ${context}` : "";
      const prompt = `Investigate: ${query}${ctx}`;
      return await llmMock.query(
        "You are a helpful assistant. Answer concisely.",
        [{ role: "user", content: prompt }],
      );
    },
  });
}

/** Load repl_server.py for preamble tests. */
const replServerPath = join(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "repl",
  "repl_server.py",
);
const REPL_SERVER = readFileSync(replServerPath, "utf-8");

// ── Section 5.1: RLM tools — unit tests (no sandbox) ────────────

describe("RLM tools — createRLMTools()", () => {
  it("5.1.1 returns 3 tools with correct metadata", () => {
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    assert.equal(tools.length, 3);

    const names = tools.map((t: { name: string }) => t.name);
    assert.deepEqual(names, ["llm_query", "rlm_query", "SUBMIT"]);

    // llm_query metadata
    const lq = getTool(tools, "llm_query");
    assert.equal(lq.returns, "str");
    assert.equal(lq.params.length, 1);
    assert.equal(lq.params[0].name, "prompt");
    assert.equal(lq.params[0].type, "str");
    assert.equal(lq.params[0].optional, undefined);
    assert.equal(lq.requiresApproval, undefined);

    // rlm_query metadata
    const rq = getTool(tools, "rlm_query");
    assert.equal(rq.returns, "str");
    assert.equal(rq.params.length, 2);
    assert.equal(rq.params[0].name, "query");
    assert.equal(rq.params[1].name, "context");
    assert.equal(rq.params[1].optional, true);
    assert.equal(rq.params[1].type, "str");
    assert.equal(rq.requiresApproval, undefined);

    // SUBMIT metadata
    const sub = getTool(tools, "SUBMIT");
    assert.equal(sub.returns, "void");
    assert.equal(sub.params.length, 1);
    assert.equal(sub.params[0].name, "answer");
    assert.equal(sub.params[0].type, "str");
    assert.equal(sub.requiresApproval, undefined);
  });

  it("5.1.2 llm_query calls onLLMQuery with correct argument", async () => {
    let capturedPrompt = "";
    const tools = createRLMTools({
      onLLMQuery: async (prompt) => {
        capturedPrompt = prompt;
        return "four";
      },
      onRLMQuery: async () => "",
    });
    const lq = getTool(tools, "llm_query");

    const result = await lq.execute({ prompt: "what is 2+2?" });
    assert.equal(capturedPrompt, "what is 2+2?");
    assert.equal(result, "four");
  });

  it("5.1.3 llm_query returns onLLMQuery response", async () => {
    const tools = createRLMTools({
      onLLMQuery: async () => "response text",
      onRLMQuery: async () => "",
    });
    const lq = getTool(tools, "llm_query");

    const result = await lq.execute({ prompt: "any prompt" });
    assert.equal(result, "response text");
  });

  it("5.1.4 llm_query with empty prompt", async () => {
    let captured = "";
    const tools = createRLMTools({
      onLLMQuery: async (prompt) => {
        captured = prompt;
        return "still responds";
      },
      onRLMQuery: async () => "",
    });
    const lq = getTool(tools, "llm_query");

    const result = await lq.execute({ prompt: "" });
    assert.equal(captured, "");
    assert.equal(result, "still responds");
  });

  it("5.1.5 SUBMIT throws SubmitSignal", () => {
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    const sub = getTool(tools, "SUBMIT");

    assert.throws(
      () => sub.execute({ answer: "the answer" }),
      (e: unknown) => {
        if (!(e instanceof SubmitSignal)) return false;
        return e.answer === "the answer";
      },
    );
  });

  it("5.1.6 SUBMIT with empty answer", () => {
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    const sub = getTool(tools, "SUBMIT");

    assert.throws(
      () => sub.execute({ answer: "" }),
      (e: unknown) => {
        if (!(e instanceof SubmitSignal)) return false;
        return e.answer === "";
      },
    );
  });

  it("5.1.7 rlm_query calls onRLMQuery with correct arguments", async () => {
    let capturedQuery = "";
    let capturedContext: string | undefined;
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async (query, context) => {
        capturedQuery = query;
        capturedContext = context;
        return "nested answer";
      },
    });
    const rq = getTool(tools, "rlm_query");

    const result = await rq.execute({ query: "investigate X" });
    assert.equal(result, "nested answer");
    assert.equal(capturedQuery, "investigate X");
    assert.equal(capturedContext, undefined);
  });

  it("5.1.8 rlm_query with context", async () => {
    let capturedContext: string | undefined;
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async (_query, context) => {
        capturedContext = context;
        return "analyzed";
      },
    });
    const rq = getTool(tools, "rlm_query");

    await rq.execute({ query: "analyze", context: "custom data" });
    assert.equal(capturedContext, "custom data");
  });
});

// ── Section 5.2: extractPythonCode() — unit tests ────────────────

describe("extractPythonCode()", () => {
  it("5.2.1 Python fence", () => {
    assert.equal(
      extractPythonCode("```python\nprint('hi')\n```"),
      "print('hi')",
    );
  });

  it("5.2.2 Generic fence", () => {
    assert.equal(
      extractPythonCode("```\nx=1\n```"),
      "x=1",
    );
  });

  it("5.2.3 Naked code (no fence)", () => {
    assert.equal(
      extractPythonCode("print('hi')"),
      "print('hi')",
    );
  });

  it("5.2.4 Python fence wins over generic", () => {
    const response = [
      "```python",
      "print('only this')",
      "```",
      "some text",
      "```",
      "print('not this')",
      "```",
    ].join("\n");
    assert.equal(
      extractPythonCode(response),
      "print('only this')",
    );
  });

  it("5.2.5 Empty code", () => {
    assert.equal(extractPythonCode(""), "");
    assert.equal(extractPythonCode("```python\n\n```"), "");
  });

  it("5.2.6 Windows line endings", () => {
    assert.equal(
      extractPythonCode("```python\r\nprint('hi')\r\n```"),
      "print('hi')",
    );
  });

  it("5.2.x Multiline Python code", () => {
    const code = [
      "```python",
      "x = 1",
      "y = 2",
      "print(x + y)",
      "```",
    ].join("\n");
    assert.equal(extractPythonCode(code), "x = 1\ny = 2\nprint(x + y)");
  });

  it("5.2.x Trailing whitespace stripped", () => {
    assert.equal(
      extractPythonCode("```python\nprint('hi')   \n\n```"),
      "print('hi')",
    );
  });

  it("5.2.x Only whitespace between fences", () => {
    assert.equal(extractPythonCode("```python\n   \n```"), "");
  });
});

// ── Mock LlmClient for RLM loop tests ───────────────────────────

/** Create a mock LlmClient that returns code from a canned array. */
function mockLlmCodeGen(codes: string[]): {
  llm: LlmClient & {
    calls(): Array<{ systemPrompt: string; messages: Array<{ role: string; content: string }> }>;
  };
} {
  const callRecords: Array<{
    systemPrompt: string;
    messages: Array<{ role: string; content: string }>;
  }> = [];
  let i = 0;
  const llm: LlmClient & {
    calls(): Array<{ systemPrompt: string; messages: Array<{ role: string; content: string }> }>;
  } = {
    async query(systemPrompt, messages) {
      callRecords.push({
        systemPrompt,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      });
      return codes[i++] ?? "";
    },
    calls() {
      return callRecords;
    },
  };
  return { llm };
}

// ── Section 5.3: RLM loop — integration tests ───────────────────

describe("runRlm()", () => {
  it("5.3.1 single iteration with SUBMIT", async () => {
    const { llm } = mockLlmCodeGen([
      '```python\nSUBMIT("the answer is 42")\n```',
    ]);
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    const registry = new ToolRegistry(tools);

    const result = await runRlm("what is the answer?", {
      llmClient: llm,
      registry,
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "the answer is 42");
    assert.equal(result.iterations.length, 1);
    // SUBMIT → sandbox returns status:"ok" with output=answer
    assert.equal(result.iterations[0].result.status, "ok");
    assert.ok(result.iterations[0].code.includes('SUBMIT("the answer is 42")'));
  });

  it("5.3.2 two iterations: first explores, second submits", async () => {
    const { llm } = mockLlmCodeGen([
      '```python\nprint("exploring...")\nresult = 42\nprint(result)\n```',
      '```python\nSUBMIT("42")\n```',
    ]);
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    const registry = new ToolRegistry(tools);

    const result = await runRlm("calculate", {
      llmClient: llm,
      registry,
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "42");
    assert.equal(result.iterations.length, 2);

    // Iteration 0: explored
    assert.equal(result.iterations[0].result.status, "ok");
    const stdout0 = result.iterations[0].result.stdout;
    assert.ok(stdout0.includes("exploring"));
    assert.ok(stdout0.includes("42"));

    // Iteration 1: SUBMIT call in trace
    const submitCall = result.iterations[1].result.calls.find(
      (c: { tool: string }) => c.tool === "SUBMIT",
    );
    assert.ok(submitCall);
    assert.equal(submitCall.ok, true);
  });

  it("5.3.3 error recovery: syntax error → LLM fixes → SUBMIT", async () => {
    const { llm } = mockLlmCodeGen([
      "```python\nprint(hello  # missing paren\n```",
      "```python\nprint('hello')\nSUBMIT('done')\n```",
    ]);
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    const registry = new ToolRegistry(tools);

    const result = await runRlm("test", {
      llmClient: llm,
      registry,
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "done");
    assert.equal(result.iterations.length, 2);

    // Iteration 0: syntax error
    assert.equal(result.iterations[0].result.status, "error");
    assert.equal(result.iterations[0].result.errorKind, "syntax");

    // Iteration 1: SUBMIT
    const submitCall = result.iterations[1].result.calls.find(
      (c: { tool: string }) => c.tool === "SUBMIT",
    );
    assert.ok(submitCall);
  });

  it("5.3.4 error recovery: runtime error → LLM fixes → SUBMIT", async () => {
    const { llm } = mockLlmCodeGen([
      "```python\n1/0\n```",
      "```python\nSUBMIT('fixed')\n```",
    ]);
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    const registry = new ToolRegistry(tools);

    const result = await runRlm("test", {
      llmClient: llm,
      registry,
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "fixed");
    assert.equal(result.iterations.length, 2);

    // Iteration 0: runtime error (ZeroDivisionError)
    assert.equal(result.iterations[0].result.status, "error");
    assert.equal(result.iterations[0].result.errorKind, "runtime");
  });

  it("5.3.5 max iterations reached (no SUBMIT)", async () => {
    const exploitCode = "```python\nprint('still working...')\n```";
    const { llm } = mockLlmCodeGen([
      exploitCode,
      exploitCode,
      exploitCode,
    ]);
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    const registry = new ToolRegistry(tools);

    const result = await runRlm("endless", {
      llmClient: llm,
      registry,
      maxIterations: 3,
    });

    assert.equal(result.status, "max_iterations");
    assert.equal(result.iterations.length, 3);
    assert.ok(result.answer.length > 0);
  });

  it("5.3.6 SUBMIT cannot be caught by Python — SubmitSignal is JS-level", async () => {
    // SubmitSignal is thrown by SUBMIT.execute() and caught by the
    // sandbox loop at the JS level. Python code running in the sandbox
    // cannot catch it — it terminates execution immediately.
    // This is a design difference from the lane-2 approach (which used
    // HostToolError → Python SystemExit that Python could catch).
    const { llm } = mockLlmCodeGen([
      [
        "```python",
        "SUBMIT('immediate')",
        "print('never runs')",
        "```",
      ].join("\n"),
    ]);
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    const registry = new ToolRegistry(tools);

    const result = await runRlm("test", {
      llmClient: llm,
      registry,
      maxIterations: 5,
    });

    // SUBMIT terminates immediately — answer is "immediate"
    assert.equal(result.status, "ok");
    assert.equal(result.answer, "immediate");
    assert.equal(result.iterations.length, 1);

    // print('never runs') should NOT appear in stdout
    const stdout = result.iterations[0].result.stdout;
    assert.ok(!stdout.includes("never runs"));
  });

  it("5.3.7 empty LLM response", async () => {
    const { llm } = mockLlmCodeGen(["", '```python\nSUBMIT("done")\n```']);
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    const registry = new ToolRegistry(tools);

    const result = await runRlm("test", {
      llmClient: llm,
      registry,
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "done");
    assert.equal(result.iterations.length, 2);
    assert.equal(result.iterations[0].code, "");
  });

  it("5.3.8 LLM returns only non-code text (interpreted as Python)", async () => {
    const { llm } = mockLlmCodeGen([
      "I think the answer is 42. Let me submit.",
      '```python\nSUBMIT("42")\n```',
    ]);
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    const registry = new ToolRegistry(tools);

    const result = await runRlm("test", {
      llmClient: llm,
      registry,
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "42");
    assert.equal(result.iterations.length, 2);
    // First iteration should be an error (invalid Python)
    assert.equal(result.iterations[0].result.status, "error");
  });

  it("5.3.9 onIteration callback", async () => {
    const { llm } = mockLlmCodeGen([
      '```python\nSUBMIT("done")\n```',
    ]);
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    const registry = new ToolRegistry(tools);

    const recorded: RlmIteration[] = [];
    const result = await runRlm("test", {
      llmClient: llm,
      registry,
      maxIterations: 5,
      onIteration: (iter: RlmIteration) => recorded.push(iter),
    });

    assert.equal(result.status, "ok");
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].index, 0);
    assert.equal(typeof recorded[0].code, "string");
    assert.equal(typeof recorded[0].llmResponse, "string");
    assert.ok(recorded[0].result);
  });

  it("5.3.10 abort signal", async () => {
    const { llm } = mockLlmCodeGen([
      "```python\nprint('iteration 0')\n```",
      "```python\nprint('iteration 1')\n```",
    ]);
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    const registry = new ToolRegistry(tools);

    const controller = new AbortController();

    const resultPromise = runRlm("test", {
      llmClient: llm,
      registry,
      maxIterations: 10,
      signal: controller.signal,
      onIteration: () => {
        controller.abort();
      },
    });

    await assert.rejects(
      resultPromise,
      (e: unknown) => {
        const err = e as Error & { name?: string };
        return err.name === "AbortError" || err.message.includes("abort") || err.message.includes("AbortError");
      },
    );
  });

  it("5.3.11 preamble injection", async () => {
    const preamble = 'context = "hello world"\n';
    const { llm } = mockLlmCodeGen([
      '```python\nSUBMIT(str(len(context)))\n```',
    ]);
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    const registry = new ToolRegistry(tools);

    const result = await runRlm("how long?", {
      llmClient: llm,
      registry,
      preamble,
      inputs: { context: "hello world" },
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "11");
    assert.equal(result.iterations.length, 1);
  });
});

// ── Section 5.4: Edge cases ─────────────────────────────────────

describe("runRlm() edge cases", () => {
  it("5.4.1 missing required options throws", async () => {
    await assert.rejects(
      runRlm("q", { llmClient: null as unknown as LlmClient, registry: new ToolRegistry([]) }),
      /llmClient|required|valid/i,
    );
  });

  it("5.4.2 deep conversation (many iterations)", async () => {
    const codes = Array.from({ length: 5 }, (_, i) =>
      i < 4
        ? `\`\`\`python\nprint('iteration ${i}')\n\`\`\``
        : '```python\nSUBMIT("final")\n```',
    );
    const { llm } = mockLlmCodeGen(codes);
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    const registry = new ToolRegistry(tools);

    const result = await runRlm("test", {
      llmClient: llm,
      registry,
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "final");
    assert.equal(result.iterations.length, 5);

    const calls = llm.calls();
    assert.equal(calls.length, 5);
    for (let i = 1; i < calls.length; i++) {
      assert.ok(
        calls[i].messages.length >= 2,
        `call ${i} should have at least 2 messages`,
      );
    }
  });

  it("5.4.3 very long stdout", async () => {
    const longPrint = "```python\nprint('x' * 100000)\n```";
    const { llm } = mockLlmCodeGen([longPrint, '```python\nSUBMIT("done")\n```']);
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    const registry = new ToolRegistry(tools);

    const result = await runRlm("test", {
      llmClient: llm,
      registry,
      maxIterations: 5,
      runOptions: { maxStdoutBytes: 1024 },
    });

    assert.equal(result.status, "ok");
    assert.equal(result.iterations.length, 2);
    assert.ok(result.iterations[0].result.stdoutTruncated);
  });

  it("5.4.4 suspended status treated as error", async () => {
    // Simulate: run code with a gated tool that suspends
    const writeTool: HostTool = {
      name: "write",
      description: "Write a file",
      params: [
        { name: "path", type: "str", description: "Path" },
        { name: "content", type: "str", description: "Content" },
      ],
      returns: "str",
      requiresApproval: true,
      execute: async (args) => `wrote ${args.path}`,
    };

    const registry = new ToolRegistry([writeTool]);
    const result = await runInSandbox(
      'write("test.txt", "hello")',
      { registry },
      {
        scriptName: "test.py",
        onApproval: () => "suspend",
      },
    );

    assert.equal(result.status, "suspended");
  });

  it("5.4.5 SUBMIT followed by more code — code after SUBMIT never runs", async () => {
    const { llm } = mockLlmCodeGen([
      '```python\nSUBMIT("answer")\nprint("after submit")\n```',
    ]);
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    const registry = new ToolRegistry(tools);

    const result = await runRlm("test", {
      llmClient: llm,
      registry,
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "answer");
    assert.equal(result.iterations.length, 1);

    // print("after submit") should NOT appear in stdout
    const stdout = result.iterations[0].result.stdout;
    assert.ok(!stdout.includes("after submit"));

    // SUBMIT call should be in trace with ok=true (caught as SubmitSignal)
    const submitCall = result.iterations[0].result.calls.find(
      (c: { tool: string }) => c.tool === "SUBMIT",
    );
    assert.ok(submitCall);
    assert.equal(submitCall.ok, true);
  });
});

// ── Section 5.x: DEFAULT_RLM_SYSTEM_PROMPT ──────────────────────

describe("DEFAULT_RLM_SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    assert.ok(DEFAULT_RLM_SYSTEM_PROMPT.length > 100);
  });

  it("mentions SUBMIT", () => {
    assert.ok(DEFAULT_RLM_SYSTEM_PROMPT.includes("SUBMIT"));
  });

  it("mentions Python", () => {
    assert.ok(
      DEFAULT_RLM_SYSTEM_PROMPT.toLowerCase().includes("python"),
    );
  });

  it("mentions code fences", () => {
    assert.ok(DEFAULT_RLM_SYSTEM_PROMPT.includes("```"));
  });
});
