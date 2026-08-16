import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolRegistry } from "../src/registry.js";
import type { LlmClient, RlmIteration, RunErrorKind } from "../src/types.js";

import { createRLMTools } from "../src/rlm_tools.js";
import { runRlm, extractPythonCode, buildFeedback } from "../src/rlm.js";

// ── Load repl_server.py — the shipped RLM preamble ──────────────

const replServerPath = join(fileURLToPath(import.meta.url), "..", "..", "repl", "repl_server.py");
const REPL_SERVER = readFileSync(replServerPath, "utf-8");

// ── Section 5.2: extractPythonCode() — unit tests ────────────────

describe("extractPythonCode()", () => {
  it("5.2.1 Python fence", () => {
    assert.equal(extractPythonCode("```python\nprint('hi')\n```"), "print('hi')");
  });

  it("5.2.2 Generic fence", () => {
    assert.equal(extractPythonCode("```\nx=1\n```"), "x=1");
  });

  it("5.2.3 Naked code (no fence)", () => {
    assert.equal(extractPythonCode("print('hi')"), "print('hi')");
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
    assert.equal(extractPythonCode(response), "print('only this')");
  });

  it("5.2.5 Empty code", () => {
    assert.equal(extractPythonCode(""), "");
    assert.equal(extractPythonCode("```python\n\n```"), "");
  });

  it("5.2.6 Windows line endings", () => {
    assert.equal(extractPythonCode("```python\r\nprint('hi')\r\n```"), "print('hi')");
  });

  it("5.2.x Multiline Python code", () => {
    const code = ["```python", "x = 1", "y = 2", "print(x + y)", "```"].join("\n");
    assert.equal(extractPythonCode(code), "x = 1\ny = 2\nprint(x + y)");
  });

  it("5.2.x Trailing whitespace stripped", () => {
    assert.equal(extractPythonCode("```python\nprint('hi')   \n\n```"), "print('hi')");
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
    const { llm } = mockLlmCodeGen(['```python\nSUBMIT("the answer is 42")\n```']);
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
    const { llm } = mockLlmCodeGen(["```python\n1/0\n```", "```python\nSUBMIT('fixed')\n```"]);
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
    const { llm } = mockLlmCodeGen([exploitCode, exploitCode, exploitCode]);
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
      ["```python", "SUBMIT('immediate')", "print('never runs')", "```"].join("\n"),
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
    const { llm } = mockLlmCodeGen(['```python\nSUBMIT("done")\n```']);
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

    await assert.rejects(resultPromise, (e: unknown) => {
      const err = e as Error & { name?: string };
      return (
        err.name === "AbortError" ||
        err.message.includes("abort") ||
        err.message.includes("AbortError")
      );
    });
  });

  it("5.3.11 preamble injection", async () => {
    const preamble = 'context = "hello world"\n';
    const { llm } = mockLlmCodeGen(["```python\nSUBMIT(str(len(context)))\n```"]);
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
      i < 4 ? `\`\`\`python\nprint('iteration ${i}')\n\`\`\`` : '```python\nSUBMIT("final")\n```',
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
      assert.ok(calls[i].messages.length >= 2, `call ${i} should have at least 2 messages`);
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

  it("5.4.5 SUBMIT followed by more code — code after SUBMIT never runs", async () => {
    const { llm } = mockLlmCodeGen(['```python\nSUBMIT("answer")\nprint("after submit")\n```']);
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

// ── The advertised context configuration (#72) ─────────────────

describe("runRlm() — context input", () => {
  /** Registry with the three RLM tools, wired to no-op callbacks. */
  function rlmRegistry(): ToolRegistry {
    return new ToolRegistry(
      createRLMTools({
        onLLMQuery: async () => "",
        onRLMQuery: async () => "",
      }),
    );
  }

  it("9.2.1 succeeds with the shipped repl_server.py preamble and no inputs", async () => {
    // The documented production configuration: preamble + no `inputs`.
    // The preamble's helpers reference the bare name `context`, which only
    // type-checks when it is declared as a sandbox input.
    const { llm } = mockLlmCodeGen([
      "```python\nprint(context_summary())\nSUBMIT(str(context_length()))\n```",
    ]);

    const result = await runRlm("how much context is there?", {
      llmClient: llm,
      registry: rlmRegistry(),
      preamble: REPL_SERVER,
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "0");
    assert.equal(result.iterations.length, 1);
  });

  it("9.2.2 declares context as an empty string when no inputs are passed", async () => {
    // No preamble: `context` resolves only if the sandbox input is declared.
    const { llm } = mockLlmCodeGen(["```python\nSUBMIT(str(len(context)))\n```"]);

    const result = await runRlm("how long is the context?", {
      llmClient: llm,
      registry: rlmRegistry(),
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "0");
  });

  it("9.2.3 forwards a caller-supplied context into the sandbox", async () => {
    // Guards M4 ("never forward inputs to the sandbox"): the value can only
    // arrive through runOpts.inputs, and it must win over the "" default.
    const { llm } = mockLlmCodeGen(["```python\nSUBMIT(str(len(context)))\n```"]);

    const result = await runRlm("how long?", {
      llmClient: llm,
      registry: rlmRegistry(),
      inputs: { context: "hello world" },
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "11");
  });

  it("9.2.4 declares and forwards a non-context input", async () => {
    const { llm } = mockLlmCodeGen(["```python\nSUBMIT(other_data)\n```"]);

    const result = await runRlm("what is the payload?", {
      llmClient: llm,
      registry: rlmRegistry(),
      inputs: { other_data: "the payload" },
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "the payload");
  });

  it("9.2.5 names every input key in the initial prompt", async () => {
    // Assert on prompt content, not message count: data present in the
    // sandbox but unnamed in the instructions is invisible to the model.
    const { llm } = mockLlmCodeGen(['```python\nSUBMIT("done")\n```']);

    const result = await runRlm("question?", {
      llmClient: llm,
      registry: rlmRegistry(),
      inputs: { context: "ctx-value", other_data: "od-value" },
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    const prompt = llm.calls()[0].messages[0].content;
    assert.ok(prompt.includes("`context`"), `prompt does not name context:\n${prompt}`);
    assert.ok(prompt.includes("`other_data`"), `prompt does not name other_data:\n${prompt}`);
    assert.ok(prompt.includes("ctx-value"), `prompt omits the context value:\n${prompt}`);
    assert.ok(prompt.includes("od-value"), `prompt omits the other_data value:\n${prompt}`);
    // The two recorded rendering contracts: `context` keeps its legacy
    // header, every other key gets the parallel `# Input` header.
    assert.ok(
      prompt.includes("# Context (available as `context` variable)"),
      `context lost its legacy header:\n${prompt}`,
    );
    assert.ok(
      prompt.includes("# Input (available as `other_data` variable)"),
      `other_data lost the # Input header:\n${prompt}`,
    );
  });

  it("9.2.7 renders the default empty context header-only", async () => {
    // The default `context: ""` is announced (the preamble ships context_*
    // helpers) but must not render an empty code fence.
    const { llm } = mockLlmCodeGen(['```python\nSUBMIT("done")\n```']);

    const result = await runRlm("q", {
      llmClient: llm,
      registry: rlmRegistry(),
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    const prompt = llm.calls()[0].messages[0].content;
    assert.ok(prompt.includes("# Context (available as `context` variable)"));
    assert.ok(!prompt.includes("```\n\n```"), `empty value rendered an empty fence:\n${prompt}`);
  });

  it("9.2.8 forwards runOptions.inputs when options.inputs is absent", async () => {
    // The recorded deviation from RLMLoop.run: runOptions.inputs.context
    // survives when options.inputs has no context.
    const { llm } = mockLlmCodeGen(['```python\nSUBMIT(str(len(context)))\n```']);

    const result = await runRlm("how long?", {
      llmClient: llm,
      registry: rlmRegistry(),
      runOptions: { inputs: { context: "from-run" } },
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "8");
  });

  it("9.2.9 options.inputs wins over runOptions.inputs for the same key", async () => {
    const { llm } = mockLlmCodeGen(['```python\nSUBMIT(str(len(context)))\n```']);

    const result = await runRlm("how long?", {
      llmClient: llm,
      registry: rlmRegistry(),
      inputs: { context: "winner" },
      runOptions: { inputs: { context: "loser" } },
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "6");
  });

  it("9.2.6 previews a long context head-and-tail, not the middle", async () => {
    const head = "H".repeat(2500);
    const tail = "T".repeat(2500);
    const { llm } = mockLlmCodeGen(['```python\nSUBMIT("done")\n```']);

    const result = await runRlm("q", {
      llmClient: llm,
      registry: rlmRegistry(),
      inputs: { context: `${head}MIDDLE${tail}` },
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    const prompt = llm.calls()[0].messages[0].content;
    assert.ok(prompt.includes(head), "prompt should include the head");
    assert.ok(prompt.includes(tail), "prompt should include the tail");
    assert.ok(!prompt.includes("MIDDLE"), "prompt should elide the middle");

    // Boundary pin: exactly 5000 chars is not elided (only > 5000 is).
    const boundary = "B".repeat(5000);
    const { llm: llm2 } = mockLlmCodeGen(['```python\nSUBMIT("done")\n```']);
    const result2 = await runRlm("q", {
      llmClient: llm2,
      registry: rlmRegistry(),
      inputs: { context: boundary },
      maxIterations: 5,
    });
    assert.equal(result2.status, "ok");
    const prompt2 = llm2.calls()[0].messages[0].content;
    assert.ok(prompt2.includes(boundary), "a 5000-char value must render whole");
    assert.ok(!prompt2.includes("..."), `5000-char value was elided:\n${prompt2.slice(0, 200)}`);
  });
});

// ── Feedback for a lost sandbox ─────────────────────────────────

describe("runRlm() — a crashed sandbox", () => {
  it("tells the model its state is gone rather than to fix an error", async () => {
    // `crashed` was added to `RunErrorKind` when execution moved into worker
    // subprocesses. Without its own branch the feedback chain falls through
    // and the model is told nothing at all, then retries against state that no
    // longer exists.
    const { llm } = mockLlmCodeGen([
      "```python\nx = 10 ** 100000000\n1\n```",
      '```python\nSUBMIT("recovered")\n```',
    ]);
    const tools = createRLMTools({
      onLLMQuery: async () => "",
      onRLMQuery: async () => "",
    });
    const result = await runRlm("q", {
      llmClient: llm,
      registry: new ToolRegistry(tools),
      maxIterations: 2,
      runOptions: { limits: { maxDurationSecs: 0.5 } },
    });

    const feedback = llm
      .calls()[1]
      .messages.map((m) => m.content)
      .join("\n");
    assert.match(feedback, /state was lost/, `got: ${feedback}`);
    assert.equal(result.answer, "recovered", "the loop recovers on the next iteration");
  });
});

// ── Feedback for a breached ceiling ─────────────────────────────

describe("runRlm() — a run that hit a limit", () => {
  // `timeout` and `memory` were both flattened into `runtime` until #32, which
  // is why they need branches of their own here: "fix the runtime error, check
  // your logic" is advice for a bug, and neither of these is one. The code may
  // be perfectly correct and simply too expensive, and a model hunting for a
  // defect that is not there will rewrite the wrong thing.
  const CASES = [
    {
      name: "duration",
      code: "total = 0\nfor i in range(50000000):\n    total += i\ntotal",
      limits: { maxDurationSecs: 0.3 },
      kind: "timeout",
      advice: /out of time/,
    },
    {
      name: "memory",
      code: "x = [0] * 20000000\nlen(x)",
      limits: { maxDurationSecs: 30, maxMemory: 16 * 1024 * 1024 },
      kind: "memory",
      advice: /out of memory/,
    },
  ] as const;

  for (const c of CASES) {
    it(`tells the model it ran out of ${c.name}, not to check its logic`, async () => {
      const { llm } = mockLlmCodeGen([
        `\`\`\`python\n${c.code}\n\`\`\``,
        '```python\nSUBMIT("recovered")\n```',
      ]);
      const tools = createRLMTools({
        onLLMQuery: async () => "",
        onRLMQuery: async () => "",
      });

      const result = await runRlm("q", {
        llmClient: llm,
        registry: new ToolRegistry(tools),
        maxIterations: 2,
        runOptions: { limits: c.limits },
      });

      assert.equal(result.iterations[0].result.status, "error");
      assert.equal(
        (result.iterations[0].result as { errorKind?: string }).errorKind,
        c.kind,
        "a ceiling this library imposes has to be named, not flattened to 'runtime'",
      );
      const feedback = llm
        .calls()[1]
        .messages.map((m) => m.content)
        .join("\n");
      assert.match(feedback, c.advice, `got: ${feedback}`);
      assert.doesNotMatch(feedback, /Check your logic/, "there is no logic error to find");
      assert.equal(result.answer, "recovered");
    });
  }

  it("says something specific for every error kind", async () => {
    // Including `unavailable`, which is only reachable in anger by starving a
    // real pool. A kind with no branch here does not fail loudly: the model is
    // handed the raw error and no instruction at all, and retries blind.
    const KINDS: Array<[RunErrorKind, RegExp]> = [
      ["syntax", /syntax error/],
      ["typing", /type error/],
      ["runtime", /Check your logic/],
      ["timeout", /out of time/],
      ["memory", /out of memory/],
      ["aborted", /aborted/],
      ["crashed", /state was lost/],
      ["unavailable", /not your code/],
    ];

    for (const [errorKind, advice] of KINDS) {
      const feedback = buildFeedback({
        status: "error",
        error: "boom",
        errorKind,
        stdout: "",
        stdoutTruncated: false,
        calls: [],
      });
      assert.match(feedback, advice, `${errorKind}: got ${feedback}`);
    }
  });
});

// ── A SUBMIT that never resolved ────────────────────────────────

describe("runRlm() — a SUBMIT call that failed to resolve", () => {
  // The loop used to stop on *any* SUBMIT entry in the trace, `ok` unchecked.
  // A malformed call is recorded `ok: false` and re-raised into Python as a
  // TypeError, so a bad call from the model ended the run and handed back
  // either the TypeError text or whatever the script evaluated to last —
  // presented as the final answer, with no signal that it was not one (#71).
  //
  // The splat is load-bearing. #71's repro was the literal `SUBMIT("a",
  // answer="b")`, which Monty 0.0.21 now rejects statically — `resolveToolArgs`
  // is never reached, no trace entry is written, and the loop continues for a
  // reason that has nothing to do with this fix. Written that way the test
  // would pass against the unfixed code and guard nothing. `**{...}` is opaque
  // to the checker, so resolution still happens at call time and the defective
  // path is the one under test. Any future shape that reaches a host tool with
  // arguments the checker did not vet lands here too.
  const MALFORMED = 'SUBMIT("a", **{"answer": "b"})';

  /** Registry with the three RLM tools. */
  function rlmRegistry(): ToolRegistry {
    return new ToolRegistry(
      createRLMTools({
        onLLMQuery: async () => "the sub-LLM said something",
        onRLMQuery: async () => "",
      }),
    );
  }

  it("keeps iterating after a malformed SUBMIT and returns the real answer", async () => {
    const { llm } = mockLlmCodeGen([
      `\`\`\`python\n${MALFORMED}\n\`\`\``,
      '```python\nSUBMIT("the real answer")\n```',
    ]);

    const result = await runRlm("q", {
      llmClient: llm,
      registry: rlmRegistry(),
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "the real answer");
    assert.equal(result.iterations.length, 2, "the malformed call must not end the run");

    // Iteration 0 recorded the SUBMIT — but as a failure.
    const failed = result.iterations[0].result.calls.find((c) => c.tool === "SUBMIT");
    assert.ok(failed);
    assert.equal(failed.ok, false);
  });

  it("does not end the run when Python swallows the TypeError", async () => {
    // The swallowed case is the dangerous one: the run reports `ok`, so the
    // answer became the script's last expression value.
    const { llm } = mockLlmCodeGen([
      [
        "```python",
        "try:",
        `    ${MALFORMED}`,
        "except TypeError:",
        "    pass",
        '"GARBAGE"',
        "```",
      ].join("\n"),
      '```python\nSUBMIT("the real answer")\n```',
    ]);

    const result = await runRlm("q", {
      llmClient: llm,
      registry: rlmRegistry(),
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "the real answer");
    assert.doesNotMatch(result.answer, /GARBAGE/, "a stray expression value is not an answer");
    assert.equal(result.iterations.length, 2);
    assert.equal(
      result.iterations[0].result.status,
      "ok",
      "Python caught the error, so the run is ok",
    );
  });

  it("still ends the run on the first valid SUBMIT", async () => {
    // Guards against over-correcting: requiring `ok` must not make a good
    // SUBMIT invisible.
    const { llm } = mockLlmCodeGen([
      '```python\nSUBMIT("done")\n```',
      '```python\nSUBMIT("never reached")\n```',
    ]);

    const result = await runRlm("q", {
      llmClient: llm,
      registry: rlmRegistry(),
      maxIterations: 5,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.answer, "done");
    assert.equal(result.iterations.length, 1);
  });

  it("does not treat some other tool's success as a submission", async () => {
    // The other half of the predicate. `ok` alone is not the condition — every
    // successful host-tool call carries it — and a guard that dropped the name
    // check would end the run on the first `llm_query`, handing back whatever
    // the script happened to evaluate to.
    const { llm } = mockLlmCodeGen([
      '```python\nanswer = llm_query("hi")\nprint(answer)\n```',
      '```python\nSUBMIT("the real answer")\n```',
    ]);

    const result = await runRlm("q", {
      llmClient: llm,
      registry: rlmRegistry(),
      maxIterations: 5,
    });

    assert.equal(result.answer, "the real answer");
    assert.equal(result.iterations.length, 2, "a successful llm_query is not a submission");

    const called = result.iterations[0].result.calls.find((c) => c.tool === "llm_query");
    assert.ok(called, "the run has to reach the tool for this to be testing anything");
    assert.equal(called.ok, true);
  });

  it("feeds the TypeError back so the next iteration can fix it", async () => {
    // Continuing without telling the model why wastes the iteration it just
    // bought.
    const { llm } = mockLlmCodeGen([
      `\`\`\`python\n${MALFORMED}\n\`\`\``,
      '```python\nSUBMIT("the real answer")\n```',
    ]);

    await runRlm("q", {
      llmClient: llm,
      registry: rlmRegistry(),
      maxIterations: 5,
    });

    const feedback = llm
      .calls()[1]
      .messages.map((m) => m.content)
      .join("\n");
    assert.match(feedback, /got multiple values for argument 'answer'/, `got: ${feedback}`);
  });
});
