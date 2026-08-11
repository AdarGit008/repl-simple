import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createToolStoreTools,
  loadSavedTools,
  type ToolStoreOptions,
} from "../src/toolstore.js";
import { HostToolError } from "../src/types.js";
import type { HostTool } from "../src/types.js";

// ── Helpers ─────────────────────────────────────────────────────

let tmpDir: string;

function makeTempDir() {
  tmpDir = mkdtempSync(join(tmpdir(), "repl-toolstore-test-"));
  return tmpDir;
}

function cleanup() {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
}

function findTool(tools: HostTool[], name: string): HostTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool;
}

function makeTools(root: string): { tools: HostTool[]; opts: ToolStoreOptions } {
  const opts: ToolStoreOptions = { root };
  const tools = createToolStoreTools(opts);
  return { tools, opts };
}

// ── Structure ──────────────────────────────────────────────────

describe("createToolStoreTools — structure", () => {
  it("returns 4 tools", () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      assert.equal(tools.length, 4);
    } finally {
      cleanup();
    }
  });

  it("tool names are save_tool, delete_tool, list_saved_tools, read_tool", () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      assert.equal(tools[0].name, "save_tool");
      assert.equal(tools[1].name, "delete_tool");
      assert.equal(tools[2].name, "list_saved_tools");
      assert.equal(tools[3].name, "read_tool");
    } finally {
      cleanup();
    }
  });

  it("all tools return 'str'", () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      for (const tool of tools) {
        assert.equal(tool.returns, "str", `tool '${tool.name}' returns 'str'`);
      }
    } finally {
      cleanup();
    }
  });

  it("all tools have valid HostTool shape", () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      for (const tool of tools) {
        assert.equal(typeof tool.name, "string");
        assert.equal(typeof tool.description, "string");
        assert.ok(Array.isArray(tool.params));
        assert.equal(typeof tool.execute, "function");
      }
    } finally {
      cleanup();
    }
  });

  it("default toolsDir is <root>/.pi/code-tools", async () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      const save = findTool(tools, "save_tool");
      await save.execute({ name: "test", code: "def test(): pass", description: "desc" });
      assert.ok(statSync(join(root, ".pi", "code-tools", "test.py")).isFile());
    } finally {
      cleanup();
    }
  });
});

// ── save_tool ──────────────────────────────────────────────────

describe("save_tool", () => {
  it("saves a Python file in the tools directory", async () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      const save = findTool(tools, "save_tool");

      const result = await save.execute({
        name: "my_func",
        code: "def my_func(): return 42",
        description: "Returns the answer",
      });

      assert.ok(result.includes("saved"), result);

      // Verify the file exists and has content
      const content = readFileSync(
        join(root, ".pi", "code-tools", "my_func.py"),
        "utf-8",
      );
      assert.ok(content.includes("def my_func(): return 42"));
      assert.ok(content.includes("Returns the answer"));
    } finally {
      cleanup();
    }
  });

  it("overwrites existing tool", async () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      const save = findTool(tools, "save_tool");

      await save.execute({
        name: "dup",
        code: "def dup(): return 1",
        description: "First version",
      });
      await save.execute({
        name: "dup",
        code: "def dup(): return 2",
        description: "Second version",
      });

      const content = readFileSync(
        join(root, ".pi", "code-tools", "dup.py"),
        "utf-8",
      );
      assert.ok(content.includes("return 2"));
      assert.ok(!content.includes("return 1"));
    } finally {
      cleanup();
    }
  });

  it("rejects invalid tool names", async () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      const save = findTool(tools, "save_tool");

      await assert.rejects(
        async () => {
          await save.execute({
            name: "123bad",
            code: "pass",
            description: "desc",
          });
        },
        HostToolError,
      );

      await assert.rejects(
        async () => {
          await save.execute({
            name: "has-dash",
            code: "pass",
            description: "desc",
          });
        },
        HostToolError,
      );
    } finally {
      cleanup();
    }
  });

  it("rejects empty tool names", async () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      const save = findTool(tools, "save_tool");

      await assert.rejects(
        async () => {
          await save.execute({
            name: "",
            code: "pass",
            description: "desc",
          });
        },
        HostToolError,
      );
    } finally {
      cleanup();
    }
  });

  it("rejects names with path traversal", async () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      const save = findTool(tools, "save_tool");

      await assert.rejects(
        async () => {
          await save.execute({
            name: "../escape",
            code: "pass",
            description: "desc",
          });
        },
        HostToolError,
      );
    } finally {
      cleanup();
    }
  });
});

// ── delete_tool ────────────────────────────────────────────────

describe("delete_tool", () => {
  it("deletes a saved tool", async () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      const save = findTool(tools, "save_tool");
      const del = findTool(tools, "delete_tool");

      await save.execute({
        name: "to_delete",
        code: "def to_delete(): pass",
        description: "Will be removed",
      });

      const result = await del.execute({ name: "to_delete" });
      assert.ok(result.includes("deleted"), result);

      // Verify file is gone
      assert.ok(
        !existsSync(join(root, ".pi", "code-tools", "to_delete.py")),
      );
    } finally {
      cleanup();
    }
  });

  it("throws on nonexistent tool", async () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      const del = findTool(tools, "delete_tool");

      await assert.rejects(
        async () => { await del.execute({ name: "nonexistent" }); },
        /does not exist/,
      );
    } finally {
      cleanup();
    }
  });

  it("rejects invalid names", async () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      const del = findTool(tools, "delete_tool");

      await assert.rejects(
        async () => { await del.execute({ name: "../escape" }); },
        HostToolError,
      );
    } finally {
      cleanup();
    }
  });
});

// ── list_saved_tools ───────────────────────────────────────────

describe("list_saved_tools", () => {
  it("lists saved tools alphabetically", async () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      const save = findTool(tools, "save_tool");
      const list = findTool(tools, "list_saved_tools");

      await save.execute({
        name: "z_tool",
        code: "pass",
        description: "last",
      });
      await save.execute({
        name: "a_tool",
        code: "pass",
        description: "first",
      });

      const result = await list.execute({});
      const names = result.split("\n");
      assert.equal(names[0], "a_tool");
      assert.equal(names[1], "z_tool");
    } finally {
      cleanup();
    }
  });

  it("returns '(no saved tools)' when empty", async () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      const list = findTool(tools, "list_saved_tools");

      const result = await list.execute({});
      assert.equal(result, "(no saved tools)");
    } finally {
      cleanup();
    }
  });

  it("ignores non-.py files", async () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      const save = findTool(tools, "save_tool");
      const list = findTool(tools, "list_saved_tools");

      await save.execute({
        name: "real_tool",
        code: "pass",
        description: "real",
      });

      // Create a non-.py file manually
      mkdirSync(join(root, ".pi", "code-tools"), { recursive: true });
      writeFileSync(
        join(root, ".pi", "code-tools", "readme.md"),
        "not a tool",
      );

      const result = await list.execute({});
      assert.equal(result, "real_tool"); // Only the .py file
    } finally {
      cleanup();
    }
  });
});

// ── read_tool ──────────────────────────────────────────────────

describe("read_tool", () => {
  it("reads a saved tool's source code", async () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      const save = findTool(tools, "save_tool");
      const read = findTool(tools, "read_tool");

      await save.execute({
        name: "greeter",
        code: "def greeter(name):\n    return f'Hello, {name}!'",
        description: "Greets someone by name",
      });

      const result = await read.execute({ name: "greeter" });
      assert.ok(result.includes("def greeter(name):"));
      assert.ok(result.includes("return f'Hello, {name}!'"));
    } finally {
      cleanup();
    }
  });

  it("throws on nonexistent tool", async () => {
    const root = makeTempDir();
    try {
      const { tools } = makeTools(root);
      const read = findTool(tools, "read_tool");

      await assert.rejects(
        async () => { await read.execute({ name: "no_such_tool" }); },
        /does not exist/,
      );
    } finally {
      cleanup();
    }
  });
});

// ── loadSavedTools ─────────────────────────────────────────────

describe("loadSavedTools", () => {
  it("returns concatenated code from all saved tools", async () => {
    const root = makeTempDir();
    try {
      const { tools, opts } = makeTools(root);
      const save = findTool(tools, "save_tool");

      await save.execute({
        name: "add",
        code: "def add(a, b):\n    return a + b",
        description: "Add two numbers",
      });
      await save.execute({
        name: "mul",
        code: "def mul(a, b):\n    return a * b",
        description: "Multiply two numbers",
      });

      const preamble = await loadSavedTools(opts);
      assert.ok(preamble.includes("def add(a, b):"));
      assert.ok(preamble.includes("def mul(a, b):"));
      assert.ok(preamble.includes("Loaded tools"));
    } finally {
      cleanup();
    }
  });

  it("returns empty string when no tools exist", async () => {
    const root = makeTempDir();
    try {
      const { opts } = makeTools(root);
      const preamble = await loadSavedTools(opts);
      assert.equal(preamble, "");
    } finally {
      cleanup();
    }
  });

  it("returns empty string when directory does not exist", async () => {
    const root = makeTempDir();
    try {
      // Don't create any tools — raw directory
      const preamble = await loadSavedTools({ root });
      assert.equal(preamble, "");
    } finally {
      cleanup();
    }
  });
});

// ── Integration with sandbox ───────────────────────────────────

describe("toolstore — sandbox integration", () => {
  it("saved tools are usable in sandbox via preamble injection", async () => {
    const root = makeTempDir();
    try {
      const { tools, opts } = makeTools(root);
      const save = findTool(tools, "save_tool");

      // Save a tool
      await save.execute({
        name: "square",
        code: "def square(x):\n    return x * x",
        description: "Square a number",
      });

      // Load as preamble
      const preamble = await loadSavedTools(opts);
      assert.ok(preamble.includes("def square(x):"));

      // The preamble can be injected into sandbox code
      const fullCode = preamble + "\nSUBMIT(str(square(5)))";
      assert.ok(fullCode.includes("str(square(5))"));
    } finally {
      cleanup();
    }
  });

  it("saved tools execute correctly in sandbox", async () => {
    const root = makeTempDir();
    try {
      const { tools, opts } = makeTools(root);
      const save = findTool(tools, "save_tool");

      // Save a function
      await save.execute({
        name: "add",
        code: "def add(a, b):\n    return a + b",
        description: "Add two numbers",
      });

      const preamble = await loadSavedTools(opts);
      const code = preamble + "\nresult = add(3, 4)\nSUBMIT(str(result))";

      // Run in real sandbox
      const { runInSandbox } = await import("../src/sandbox.js");
      const { ToolRegistry } = await import("../src/registry.js");
      const { createRLMTools } = await import("../src/rlm_tools.js");

      const rlmTools = createRLMTools({
        onLLMQuery: async (p: string) => `reply: ${p}`,
        onRLMQuery: async (q: string) => `nested: ${q}`,
      });
      const registry = new ToolRegistry([...tools, ...rlmTools]);

      const result = await runInSandbox(code, { registry });
      assert.equal(result.status, "ok");

      // SUBMIT should have been called with "7"
      const submitCall = result.calls.find((c) => c.tool === "SUBMIT");
      assert.ok(submitCall, "SUBMIT should have been called");
      assert.equal(result.output, "7");
    } finally {
      cleanup();
    }
  });
});
