import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getReplPreamble } from "../src/preamble.js";
import { runRlm, type LlmClient } from "../src/rlm.js";
import { ToolRegistry } from "../src/registry.js";

// ── getReplPreamble ────────────────────────────────────────────

describe("getReplPreamble", () => {
  it("returns contents of repl_server.py", () => {
    const preamble = getReplPreamble();
    assert.ok(preamble.includes("context_preview"));
    assert.ok(preamble.includes("context_lines"));
    assert.ok(preamble.includes("context_length"));
    assert.ok(preamble.includes("context_summary"));
  });

  it("returned string is usable as a runRlm preamble", async () => {
    const preamble = getReplPreamble();
    const llmClient: LlmClient = {
      async query() {
        return "```python\nSUBMIT(str(context_length()))\n```";
      },
    };
    const result = await runRlm("task", {
      llmClient,
      registry: new ToolRegistry([]),
      preamble,
      inputs: { context: "hello world" },
      maxIterations: 5,
    });
    assert.equal(result.status, "ok");
    assert.equal(result.answer, "11");
  });
});
