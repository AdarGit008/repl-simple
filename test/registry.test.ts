import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HostToolError, type HostTool } from "../src/types.js";
import {
  ToolRegistry,
  arg,
  requireString,
  renderPythonToolRules,
  probeImportableModules,
  probeTypeCheckerGaps,
} from "../src/registry.js";

// ── Helpers ─────────────────────────────────────────────────────

function makeTool(overrides: Partial<HostTool> = {}): HostTool {
  return {
    name: "read_file",
    description: "Read a file",
    params: [],
    returns: "str",
    execute: () => "content",
    ...overrides,
  };
}

function makeParamTool(): HostTool {
  return {
    name: "add",
    description: "Add two numbers",
    params: [
      { name: "a", type: "int", description: "First number" },
      { name: "b", type: "int", description: "Second number", optional: true },
    ],
    returns: "str",
    execute: () => "3",
  };
}

// ── ToolRegistry ─────────────────────────────────────────────────

describe("ToolRegistry", () => {
  describe("constructor", () => {
    it("creates an empty registry with no args", () => {
      const reg = new ToolRegistry();
      assert.equal(reg.list().length, 0);
    });

    it("registers tools passed in the constructor", () => {
      const t1 = makeTool({ name: "tool_a" });
      const t2 = makeTool({ name: "tool_b" });
      const reg = new ToolRegistry([t1, t2]);
      assert.equal(reg.list().length, 2);
      assert.ok(reg.has("tool_a"));
      assert.ok(reg.has("tool_b"));
    });
  });

  describe("add", () => {
    it("adds a tool that becomes retrievable via get()", () => {
      const reg = new ToolRegistry();
      const tool = makeTool({ name: "test_tool" });
      reg.add(tool);
      assert.equal(reg.get("test_tool"), tool);
    });

    it("rejects duplicate names", () => {
      const reg = new ToolRegistry();
      reg.add(makeTool({ name: "dup" }));
      assert.throws(
        () => reg.add(makeTool({ name: "dup" })),
        /Tool 'dup' is already registered/,
      );
    });

    it("rejects names that are not valid Python identifiers", () => {
      const reg = new ToolRegistry();
      const invalidNames = ["1foo", "has spaces", "with-dash", ""];

      for (const name of invalidNames) {
        assert.throws(
          () => reg.add(makeTool({ name })),
          /not a valid Python identifier/,
          `name '${name}' should be rejected`,
        );
      }
    });

    it("accepts snake_case names with digits", () => {
      const reg = new ToolRegistry();
      const t = makeTool({ name: "tool_123" });
      reg.add(t);
      assert.ok(reg.has("tool_123"));
    });
  });

  describe("has", () => {
    it("returns true for registered tools", () => {
      const reg = new ToolRegistry();
      reg.add(makeTool({ name: "present" }));
      assert.equal(reg.has("present"), true);
    });

    it("returns false for unregistered tools", () => {
      const reg = new ToolRegistry();
      assert.equal(reg.has("missing"), false);
    });
  });

  describe("get", () => {
    it("returns the tool for a registered name", () => {
      const reg = new ToolRegistry();
      const t = makeTool({ name: "unique" });
      reg.add(t);
      assert.equal(reg.get("unique"), t);
    });

    it("returns undefined for an unregistered name", () => {
      const reg = new ToolRegistry();
      assert.equal(reg.get("nope"), undefined);
    });
  });

  describe("list", () => {
    it("returns all registered tools", () => {
      const reg = new ToolRegistry();
      const a = makeTool({ name: "a" });
      const b = makeTool({ name: "b" });
      reg.add(a);
      reg.add(b);
      const tools = reg.list();
      assert.equal(tools.length, 2);
      assert.ok(tools.includes(a));
      assert.ok(tools.includes(b));
    });

    it("returns a new array each call", () => {
      const reg = new ToolRegistry();
      reg.add(makeTool({ name: "t1" }));
      const first = reg.list();
      const second = reg.list();
      assert.notEqual(first, second);
    });
  });

  describe("renderTypeStubs", () => {
    it("returns a string", () => {
      const reg = new ToolRegistry();
      reg.add(makeTool({ name: "read_file" }));
      const stubs = reg.renderTypeStubs();
      assert.equal(typeof stubs, "string");
    });

    it("includes registered tool names", () => {
      const reg = new ToolRegistry();
      reg.add(makeTool({ name: "my_tool" }));
      const stubs = reg.renderTypeStubs();
      assert.ok(stubs.includes("my_tool"), `stubs should mention 'my_tool', got: ${stubs}`);
    });

    it("includes tool names with params", () => {
      const reg = new ToolRegistry();
      reg.add(makeParamTool());
      const stubs = reg.renderTypeStubs();
      assert.ok(stubs.includes("add"), `stubs should mention 'add', got: ${stubs}`);
    });
  });
});

// ── arg ──────────────────────────────────────────────────────────

describe("arg", () => {
  it("returns positional argument when present", () => {
    assert.equal(arg([42], {}, 0, "x"), 42);
  });

  it("returns keyword argument when positional is absent", () => {
    assert.equal(arg([], { x: "hi" }, 0, "x"), "hi");
  });

  it("throws when positional and keyword both provide same arg", () => {
    // arg([1], {y:2}, 0, "y"): positional at index 0 and keyword "y" both
    // target the same parameter → Python-style duplicate error
    assert.throws(
      () => arg([1], { y: 2 }, 0, "y"),
      HostToolError,
    );
  });

  it("returns undefined when missing from both", () => {
    assert.equal(arg([], {}, 0, "x"), undefined);
  });

  it("throws HostToolError on duplicate (both positional and keyword for same name)", () => {
    assert.throws(
      () => arg([1], { x: 2 }, 0, "x"),
      HostToolError,
    );
  });

  it("throws with pythonType 'TypeError' on duplicate", () => {
    try {
      arg([1], { x: 2 }, 0, "x");
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof HostToolError);
      assert.equal((err as HostToolError).pythonType, "TypeError");
    }
  });

  it("handles multiple positional args, keyword for later param", () => {
    // f(10, y=20): args=[10], kwargs={y:20}
    // arg for "x" at index 0 → 10
    assert.equal(arg([10], { y: 20 }, 0, "x"), 10);
    // arg for "y" at index 1 → kwargs[y]=20
    assert.equal(arg([10], { y: 20 }, 1, "y"), 20);
  });
});

// ── requireString ────────────────────────────────────────────────

describe("requireString", () => {
  it("passes through a string value", () => {
    assert.equal(requireString("hello", "param"), "hello");
  });

  it("throws HostToolError for a non-string value", () => {
    assert.throws(
      () => requireString(42, "count"),
      HostToolError,
    );
  });

  it("throws HostToolError for null", () => {
    assert.throws(
      () => requireString(null, "name"),
      HostToolError,
    );
  });

  it("throws HostToolError for undefined", () => {
    assert.throws(
      () => requireString(undefined, "name"),
      HostToolError,
    );
  });
});

// ── renderPythonToolRules ────────────────────────────────────────

describe("renderPythonToolRules", () => {
  it("returns a string", () => {
    const rules = renderPythonToolRules(["json", "re", "math"]);
    assert.equal(typeof rules, "string");
  });

  it("includes passed module names", () => {
    const rules = renderPythonToolRules(["json", "datetime"]);
    assert.ok(rules.includes("json"));
    assert.ok(rules.includes("datetime"));
  });

  it("mentions blocked/absent modules", () => {
    // Should warn about modules like 'time', 'random' etc. if not importable
    const rules = renderPythonToolRules(["json"]);
    // The rules should mention that some modules are not available
    assert.ok(
      rules.includes("ModuleNotFoundError") || rules.includes("exist"),
      `expected rules to warn about unavailable modules, got: ${rules}`,
    );
  });
});

// ── probeImportableModules / probeTypeCheckerGaps ────────────────
// These functions depend on the @pydantic/monty runtime.
// Tests verify the function signatures and graceful behavior when
// monty is not installed (no crash).

describe("probeImportableModules / probeTypeCheckerGaps", () => {

  it("probeImportableModules is a function", () => {
    assert.equal(typeof probeImportableModules, "function");
  });

  it("probeImportableModules accepts optional candidates and returns string[]", () => {
    const result = probeImportableModules(["json", "this_does_not_exist_xyz"]);
    assert.ok(Array.isArray(result));
    for (const item of result) {
      assert.equal(typeof item, "string");
    }
    // "this_does_not_exist_xyz" should NOT appear
    assert.ok(!result.includes("this_does_not_exist_xyz"));
    // "json" is only importable if monty is installed
    // (no package.json yet — monty not available; result is empty)
  });

  it("probeTypeCheckerGaps is a function", () => {
    assert.equal(typeof probeTypeCheckerGaps, "function");
  });

  it("probeTypeCheckerGaps accepts optional candidates and returns string[]", () => {
    const result = probeTypeCheckerGaps(["PermissionError"]);
    assert.ok(Array.isArray(result));
    for (const item of result) {
      assert.equal(typeof item, "string");
    }
  });
});
