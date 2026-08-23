import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getReplPreamble, readPreamble } from "../src/preamble.js";
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

// ── readPreamble guard ─────────────────────────────────────────

describe("readPreamble guard", () => {
  it("throws a clear error naming the path when the file is missing", () => {
    const missingPath = join(tmpdir(), "repl-simple-missing-preamble.py");

    assert.throws(
      () => readPreamble(missingPath),
      (err: unknown) => {
        assert.ok(err instanceof Error, "expected an Error, not a bare ENOENT throw");
        assert.ok(
          err.message.includes(missingPath),
          `message should name the missing path "${missingPath}", got: ${err.message}`,
        );
        assert.ok(
          err.message.includes("reinstall or rebuild"),
          `message should name the likely cause, got: ${err.message}`,
        );
        const cause = (err as Error & { cause?: unknown }).cause;
        assert.ok(
          cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT",
          `expected the original ENOENT as cause, got: ${String(cause)}`,
        );
        return true;
      },
    );
  });
});
