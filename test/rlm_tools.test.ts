import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRLMTools, type RLMToolOptions } from "../src/rlm_tools.js";
import { SubmitSignal } from "../src/submit_signal.js";
import type { HostTool } from "../src/types.js";

// ── Helpers ─────────────────────────────────────────────────────

function findTool(tools: HostTool[], name: string): HostTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool;
}

// ── createRLMTools — structure ──────────────────────────────────

describe("createRLMTools — structure", () => {
  const opts: RLMToolOptions = {
    onLLMQuery: async () => "llm response",
    onRLMQuery: async () => "rlm response",
  };

  it("returns array of 3 HostTools", () => {
    const tools = createRLMTools(opts);
    assert.equal(tools.length, 3);
  });

  it("each tool is a HostTool with required fields", () => {
    const tools = createRLMTools(opts);
    for (const tool of tools) {
      assert.equal(typeof tool.name, "string");
      assert.ok(tool.name.length > 0);
      assert.equal(typeof tool.description, "string");
      assert.ok(Array.isArray(tool.params));
      assert.ok(tool.returns === "str" || tool.returns === "void");
      assert.equal(typeof tool.execute, "function");
    }
  });

  it("tool names are llm_query, rlm_query, SUBMIT (in order)", () => {
    const tools = createRLMTools(opts);
    assert.equal(tools[0].name, "llm_query");
    assert.equal(tools[1].name, "rlm_query");
    assert.equal(tools[2].name, "SUBMIT");
  });

  it("all tools have requiresApproval: false (or undefined)", () => {
    const tools = createRLMTools(opts);
    for (const tool of tools) {
      assert.ok(!tool.requiresApproval);
    }
  });
});

// ── llm_query params ────────────────────────────────────────────

describe("llm_query params", () => {
  const opts: RLMToolOptions = {
    onLLMQuery: async () => "",
    onRLMQuery: async () => "",
  };

  it("has one required param: prompt (str)", () => {
    const tool = findTool(createRLMTools(opts), "llm_query");
    assert.equal(tool.params.length, 1);
    assert.equal(tool.params[0].name, "prompt");
    assert.equal(tool.params[0].type, "str");
    assert.ok(!tool.params[0].optional);
  });

  it("returns 'str'", () => {
    const tool = findTool(createRLMTools(opts), "llm_query");
    assert.equal(tool.returns, "str");
  });
});

// ── rlm_query params ────────────────────────────────────────────

describe("rlm_query params", () => {
  const opts: RLMToolOptions = {
    onLLMQuery: async () => "",
    onRLMQuery: async () => "",
  };

  it("has two params: query (str, required), context (str, optional)", () => {
    const tool = findTool(createRLMTools(opts), "rlm_query");
    assert.equal(tool.params.length, 2);
    assert.equal(tool.params[0].name, "query");
    assert.equal(tool.params[0].type, "str");
    assert.ok(!tool.params[0].optional);
    assert.equal(tool.params[1].name, "context");
    assert.equal(tool.params[1].type, "str");
    assert.ok(tool.params[1].optional);
  });

  it("returns 'str'", () => {
    const tool = findTool(createRLMTools(opts), "rlm_query");
    assert.equal(tool.returns, "str");
  });
});

// ── SUBMIT params ───────────────────────────────────────────────

describe("SUBMIT params", () => {
  const opts: RLMToolOptions = {
    onLLMQuery: async () => "",
    onRLMQuery: async () => "",
  };

  it("has one required param: answer (str)", () => {
    const tool = findTool(createRLMTools(opts), "SUBMIT");
    assert.equal(tool.params.length, 1);
    assert.equal(tool.params[0].name, "answer");
    assert.equal(tool.params[0].type, "str");
    assert.ok(!tool.params[0].optional);
  });

  it("returns 'void'", () => {
    const tool = findTool(createRLMTools(opts), "SUBMIT");
    assert.equal(tool.returns, "void");
  });
});

// ── llm_query execution ─────────────────────────────────────────

describe("llm_query execution", () => {
  it("calls onLLMQuery with the prompt string", async () => {
    let receivedPrompt = "";
    const opts: RLMToolOptions = {
      onLLMQuery: async (prompt) => {
        receivedPrompt = prompt;
        return "response";
      },
      onRLMQuery: async () => "",
    };
    const tool = findTool(createRLMTools(opts), "llm_query");
    const result = await tool.execute({ prompt: "hello world" });
    assert.equal(result, "response");
    assert.equal(receivedPrompt, "hello world");
  });

  it("returns the callback's return value", async () => {
    const opts: RLMToolOptions = {
      onLLMQuery: async () => "custom response",
      onRLMQuery: async () => "",
    };
    const tool = findTool(createRLMTools(opts), "llm_query");
    const result = await tool.execute({ prompt: "test" });
    assert.equal(result, "custom response");
  });

  it("propagates errors from onLLMQuery", async () => {
    const opts: RLMToolOptions = {
      onLLMQuery: async () => {
        throw new Error("LLM unavailable");
      },
      onRLMQuery: async () => "",
    };
    const tool = findTool(createRLMTools(opts), "llm_query");
    await assert.rejects(
      async () => { await tool.execute({ prompt: "test" }); },
      /LLM unavailable/,
    );
  });
});

// ── rlm_query execution ─────────────────────────────────────────

describe("rlm_query execution", () => {
  it("calls onRLMQuery with query and context", async () => {
    let receivedQuery = "";
    let receivedContext: string | undefined;
    const opts: RLMToolOptions = {
      onLLMQuery: async () => "",
      onRLMQuery: async (query, context) => {
        receivedQuery = query;
        receivedContext = context;
        return "nested result";
      },
    };
    const tool = findTool(createRLMTools(opts), "rlm_query");
    const result = await tool.execute({
      query: "analyze this",
      context: "some data",
    });
    assert.equal(result, "nested result");
    assert.equal(receivedQuery, "analyze this");
    assert.equal(receivedContext, "some data");
  });

  it("context defaults to undefined when not passed", async () => {
    let receivedContext: string | undefined = "SENTINEL";
    const opts: RLMToolOptions = {
      onLLMQuery: async () => "",
      onRLMQuery: async (_query, context) => {
        receivedContext = context;
        return "ok";
      },
    };
    const tool = findTool(createRLMTools(opts), "rlm_query");
    await tool.execute({ query: "test" });
    assert.equal(receivedContext, undefined);
  });

  it("returns the callback's return value", async () => {
    const opts: RLMToolOptions = {
      onLLMQuery: async () => "",
      onRLMQuery: async () => "delegated answer",
    };
    const tool = findTool(createRLMTools(opts), "rlm_query");
    const result = await tool.execute({ query: "test" });
    assert.equal(result, "delegated answer");
  });

  it("propagates errors from onRLMQuery", async () => {
    const opts: RLMToolOptions = {
      onLLMQuery: async () => "",
      onRLMQuery: async () => {
        throw new Error("nested loop failed");
      },
    };
    const tool = findTool(createRLMTools(opts), "rlm_query");
    await assert.rejects(
      async () => { await tool.execute({ query: "test" }); },
      /nested loop failed/,
    );
  });
});

// ── SUBMIT execution ────────────────────────────────────────────

describe("SUBMIT execution", () => {
  const opts: RLMToolOptions = {
    onLLMQuery: async () => "",
    onRLMQuery: async () => "",
  };

  it("throws SubmitSignal with the answer", () => {
    const tool = findTool(createRLMTools(opts), "SUBMIT");
    try {
      tool.execute({ answer: "final answer" });
      assert.fail("expected SubmitSignal to be thrown");
    } catch (err) {
      assert.ok(err instanceof SubmitSignal);
      assert.equal((err as SubmitSignal).answer, "final answer");
    }
  });

  it("SubmitSignal is an instance of Error", () => {
    const tool = findTool(createRLMTools(opts), "SUBMIT");
    try {
      tool.execute({ answer: "x" });
      assert.fail("expected SubmitSignal");
    } catch (err) {
      assert.ok(err instanceof Error);
    }
  });

  it("SubmitSignal.name is 'SubmitSignal'", () => {
    const tool = findTool(createRLMTools(opts), "SUBMIT");
    try {
      tool.execute({ answer: "x" });
      assert.fail("expected SubmitSignal");
    } catch (err) {
      assert.equal((err as SubmitSignal).name, "SubmitSignal");
    }
  });

  it("SubmitSignal.message contains the answer", () => {
    const tool = findTool(createRLMTools(opts), "SUBMIT");
    try {
      tool.execute({ answer: "done!" });
      assert.fail("expected SubmitSignal");
    } catch (err) {
      assert.ok((err as SubmitSignal).message.includes("done!"));
    }
  });
});
