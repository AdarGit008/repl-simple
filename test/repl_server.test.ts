import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Monty } from "@pydantic/monty";
import { ToolRegistry, probeTypeCheckerGaps } from "../src/registry.js";
import { HostToolError } from "../src/types.js";
import type { HostTool } from "../src/types.js";
import { runInSandbox, type SandboxOptions } from "../src/sandbox.js";

// ── Load repl_server.py ─────────────────────────────────────────

const replServerPath = join(fileURLToPath(import.meta.url), "..", "..", "repl", "repl_server.py");
const REPL_SERVER = readFileSync(replServerPath, "utf-8");

// ── RLM HostTool stubs (stand-ins for #12 / #13 tools) ──────────

interface LlmQueryRecord {
  prompt: string;
  response: string;
}

/**
 * Creates a stub llm_query HostTool that returns canned responses
 * and records all calls.
 */
function makeStubLlmQuery(responses: string[] = []): {
  tool: HostTool;
  calls(): LlmQueryRecord[];
} {
  const records: LlmQueryRecord[] = [];
  let i = 0;
  const tool: HostTool = {
    name: "llm_query",
    description: "Ask the sub-LLM a question",
    params: [{ name: "prompt", type: "str", description: "Question" }],
    returns: "str",
    execute: (args) => {
      const prompt = String(args.prompt);
      const response = responses[i] ?? `response to: ${prompt}`;
      records.push({ prompt, response });
      i++;
      return response;
    },
  };
  return { tool, calls: () => records };
}

/** Creates a stub rlm_query HostTool. */
function makeStubRlmQuery(): HostTool {
  return {
    name: "rlm_query",
    description: "Spawn a nested RLM loop",
    params: [
      { name: "query", type: "str", description: "Sub-question" },
      {
        name: "context",
        type: "str",
        description: "Optional context override",
        optional: true,
      },
    ],
    returns: "str",
    execute: (args) => {
      const ctx = args.context ? ` [ctx: ${String(args.context)}]` : "";
      return Promise.resolve(`nested RLM answer for: ${String(args.query)}${ctx}`);
    },
  };
}

/**
 * Creates a stub SUBMIT HostTool that throws SystemExit.
 *
 * Monty v0.0.18 only allows built-in Python exception types for
 * snapshot.resume({ exception: ... }). We use SystemExit as the
 * signal — the RLM loop (#12) detects SUBMIT by checking
 * ToolCallTrace for tool==="SUBMIT" with the answer in the error field.
 */
function makeStubSubmit(): HostTool {
  return {
    name: "SUBMIT",
    description: "Signal completion with the final answer",
    params: [{ name: "answer", type: "str", description: "Final answer" }],
    returns: "void",
    execute: (args) => {
      throw new HostToolError("SystemExit", String(args.answer));
    },
  };
}

/** Build a ToolRegistry with all RLM HostTools. */
function makeRlmRegistry(llmResponses?: string[]): {
  registry: ToolRegistry;
  llmCalls(): LlmQueryRecord[];
} {
  const { tool: llmQuery, calls } = makeStubLlmQuery(llmResponses);
  const registry = new ToolRegistry([llmQuery, makeStubRlmQuery(), makeStubSubmit()]);
  return { registry, llmCalls: calls };
}

// ── Helpers ─────────────────────────────────────────────────────

function ok(result: unknown): asserts result is { status: "ok"; output: string } {
  assert.equal((result as { status: string }).status, "ok");
}

function err(result: unknown): asserts result is {
  status: "error";
  errorKind: string;
} {
  assert.equal((result as { status: string }).status, "error");
}

/** Run repl_server preamble + user code in a sandbox with RLM tools. */
async function runRlmCode(
  userCode: string,
  options: {
    context?: string;
    llmResponses?: string[];
  } = {},
) {
  const { registry, llmCalls } = makeRlmRegistry(options.llmResponses);
  const sandboxOpts: SandboxOptions = { registry };

  const code = `${REPL_SERVER}\n${userCode}`;
  const result = await runInSandbox(code, sandboxOpts, {
    inputs: { context: options.context ?? "" },
    scriptName: "rlm.py",
  });
  return { result, llmCalls };
}

// ── Tests ───────────────────────────────────────────────────────

describe("repl_server.py — parse & preamble", () => {
  it("is valid Python that monty can parse", () => {
    // Should not throw MontySyntaxError
    const m = new Monty(REPL_SERVER);
    // Should not throw — just constructing is enough
    assert.ok(m instanceof Monty);
  });

  it("type-checks with RLM tools + gap declarations", () => {
    const { registry } = makeRlmRegistry();
    const stubs = registry.renderTypeStubs();
    const gaps = probeTypeCheckerGaps();
    const prefix = ["from typing import Any", stubs, ...gaps.map((n) => `${n}: Any = None`)]
      .filter(Boolean)
      .join("\n");

    // Should not throw MontyTypingError
    const m = new Monty("pass", {
      typeCheck: true,
      typeCheckPrefixCode: prefix,
    });
    assert.ok(m instanceof Monty);
  });

  it("can be read as a non-empty string", () => {
    assert.ok(REPL_SERVER.length > 500);
    assert.ok(REPL_SERVER.includes("context_preview"));
    assert.ok(REPL_SERVER.includes("llm_query"));
    assert.ok(REPL_SERVER.includes("rlm_query"));
    assert.ok(REPL_SERVER.includes("SUBMIT"));
  });
});

describe("repl_server.py — utility functions", () => {
  it("context_preview returns full context when short", async () => {
    const { result } = await runRlmCode("context_preview(1000)", {
      context: "hello world",
    });
    ok(result);
    assert.equal(result.output, "hello world");
  });

  it("context_preview truncates long context", async () => {
    const data = "x".repeat(1000);
    const { result } = await runRlmCode("context_preview(200)", {
      context: data,
    });
    ok(result);
    assert.ok((result.output as string).length <= 250); // 200 + "\n...\n" overhead
  });

  it("context_preview on empty context", async () => {
    const { result } = await runRlmCode("context_preview(200)", {
      context: "",
    });
    ok(result);
    assert.equal(result.output, "(empty context)");
  });

  it("context_lines splits into list", async () => {
    const { result } = await runRlmCode("len(context_lines())", { context: "a\nb\nc" });
    ok(result);
    assert.equal(result.output, "3");
  });

  it("context_length returns char count", async () => {
    const { result } = await runRlmCode("context_length()", { context: "12345" });
    ok(result);
    assert.equal(result.output, "5");
  });

  it("context_summary on empty", async () => {
    const { result } = await runRlmCode("context_summary()", {
      context: "",
    });
    ok(result);
    assert.equal(result.output, "context: empty");
  });

  it("context_summary on populated", async () => {
    const { result } = await runRlmCode("context_summary()", {
      context: "line one\nline two\nline three",
    });
    ok(result);
    const out = result.output as string;
    assert.ok(out.includes("chars"));
    assert.ok(out.includes("3 lines"));
  });
});

describe("repl_server.py — HostTool dispatch", () => {
  it("llm_query returns canned response", async () => {
    const { result, llmCalls } = await runRlmCode('llm_query("what is 2+2?")', {
      llmResponses: ["four"],
    });
    ok(result);
    assert.equal(result.output, "four");
    assert.equal(llmCalls().length, 1);
    assert.equal(llmCalls()[0].prompt, "what is 2+2?");
  });

  it("llm_query with multiple calls", async () => {
    const { result, llmCalls } = await runRlmCode(
      'a = llm_query("first")\nb = llm_query("second")\na + " | " + b',
      { llmResponses: ["one", "two"] },
    );
    ok(result);
    assert.equal(result.output, "one | two");
    assert.equal(llmCalls().length, 2);
  });

  it("rlm_query returns nested answer", async () => {
    const { result } = await runRlmCode('rlm_query("investigate X")');
    ok(result);
    assert.equal(result.output, "nested RLM answer for: investigate X");
  });

  it("rlm_query with custom context", async () => {
    const { result } = await runRlmCode('rlm_query("analyze", "custom data")');
    ok(result);
    assert.ok((result.output as string).includes("custom data"));
  });

  it("SUBMIT throws SystemExit that surfaces as runtime error", async () => {
    // SUBMIT throws HostToolError("SystemExit", answer).
    // The sandbox resumes with SystemExit in Python → MontyRuntimeError.
    // The RLM loop (#12) detects SUBMIT by checking ToolCallTrace.
    const { result } = await runRlmCode('SUBMIT("final answer")');
    err(result);
    assert.equal(result.errorKind, "runtime");
  });

  it("SUBMIT answer is captured in ToolCallTrace", async () => {
    // The answer is recorded in the trace even though execution stops.
    // The RLM loop reads it from the SUBMIT trace entry.
    const { result } = await runRlmCode('print("before")\nSUBMIT("the-answer-42")\nprint("after")');
    err(result);
    // Check the trace has the SUBMIT call with the answer
    const submitCall = result.calls.find((c: { tool: string }) => c.tool === "SUBMIT");
    assert.ok(submitCall);
    assert.equal(submitCall.error, "the-answer-42");
  });

  it("Python catches SystemExit from SUBMIT", async () => {
    // Python can catch SystemExit (it's a built-in).
    // The answer string is in the exception message.
    const { result } = await runRlmCode(
      `
try:
    SUBMIT("answer")
    result = "no-error"
except SystemExit as e:
    result = str(e)
result
`,
    );
    ok(result);
    assert.equal(result.output, "answer");
  });
});

describe("repl_server.py — context variable", () => {
  it("context is accessible with non-empty data", async () => {
    const { result } = await runRlmCode("context", {
      context: "the answer is 42",
    });
    ok(result);
    assert.equal(result.output, "the answer is 42");
  });

  it("context is accessible with empty string", async () => {
    const { result } = await runRlmCode("context", { context: "" });
    ok(result);
    assert.equal(result.output, ""); // empty string → monty returns ""
  });

  it("context can be used with re module", async () => {
    const { result } = await runRlmCode(
      `
import re
matches = re.findall(r'\\d+', context)
str(len(matches))
`,
      { context: "abc 123 def 456" },
    );
    ok(result);
    assert.equal(result.output, "2");
  });
});

describe("repl_server.py — full workflow", () => {
  it("explore context with llm_query", async () => {
    // Simulate a simple investigation: read context, ask LLM, process answer
    const { result, llmCalls } = await runRlmCode(
      `
preview = context_preview(200)
# In real RLM loop this code is generated by the root LLM
summary = llm_query("summarize: " + preview)
# Simulate what root LLM would do with the answer
upper = summary.upper()
upper
`,
      {
        context: "The sky is blue.\nGrass is green.\nFire is hot.",
        llmResponses: ["nature facts"],
      },
    );
    ok(result);
    assert.equal(result.output, "NATURE FACTS");
    assert.equal(llmCalls().length, 1);
    assert.ok(llmCalls()[0].prompt.includes("The sky is blue"));
  });
});

describe("repl_server.py — edge cases", () => {
  it("context with special characters", async () => {
    const { result } = await runRlmCode("context", {
      context: 'line1\nline2\t"quoted"\nline3\\backslash',
    });
    ok(result);
    assert.ok((result.output as string).includes("quoted"));
  });

  it("context with unicode", async () => {
    const { result } = await runRlmCode("context", {
      context: "café résumé 🎉",
    });
    ok(result);
    assert.ok((result.output as string).includes("🎉"));
  });

  it("context with very long single line", async () => {
    const longLine = "x".repeat(10000);
    const { result } = await runRlmCode("context_length()", {
      context: longLine,
    });
    ok(result);
    assert.equal(result.output, "10000");
  });
});
