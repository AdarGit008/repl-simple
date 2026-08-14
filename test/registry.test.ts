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
  probeInvocations,
  resetProbeMemos,
  CANDIDATE_MODULES,
} from "../src/registry.js";
import { runInSandbox } from "../src/sandbox.js";

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
      assert.throws(() => reg.add(makeTool({ name: "dup" })), /Tool 'dup' is already registered/);
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
    it("returns a string", async () => {
      const reg = new ToolRegistry();
      reg.add(makeTool({ name: "read_file" }));
      const stubs = await reg.renderTypeStubs();
      assert.equal(typeof stubs, "string");
    });

    it("includes registered tool names", async () => {
      const reg = new ToolRegistry();
      reg.add(makeTool({ name: "my_tool" }));
      const stubs = await reg.renderTypeStubs();
      assert.ok(stubs.includes("my_tool"), `stubs should mention 'my_tool', got: ${stubs}`);
    });

    it("includes tool names with params", async () => {
      const reg = new ToolRegistry();
      reg.add(makeParamTool());
      const stubs = await reg.renderTypeStubs();
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
    assert.throws(() => arg([1], { y: 2 }, 0, "y"), HostToolError);
  });

  it("returns undefined when missing from both", () => {
    assert.equal(arg([], {}, 0, "x"), undefined);
  });

  it("throws HostToolError on duplicate (both positional and keyword for same name)", () => {
    assert.throws(() => arg([1], { x: 2 }, 0, "x"), HostToolError);
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
    assert.throws(() => requireString(42, "count"), HostToolError);
  });

  it("throws HostToolError for null", () => {
    assert.throws(() => requireString(null, "name"), HostToolError);
  });

  it("throws HostToolError for undefined", () => {
    assert.throws(() => requireString(undefined, "name"), HostToolError);
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
// Both ask the installed interpreter a question, so both assert against a
// real answer. The pair used to check only that the functions existed and
// returned arrays of strings, on the premise that monty might not be
// installed — it is a dependency, and a probe that returns an empty list
// because nothing ran passes a shape assertion just as well as one that
// worked.

describe("probeImportableModules / probeTypeCheckerGaps", () => {
  it("reports a module the interpreter has, and not one it lacks", async () => {
    const result = await probeImportableModules(["json", "this_does_not_exist_xyz"]);
    assert.ok(result.includes("json"), `expected json to be importable, got: ${result}`);
    assert.ok(!result.includes("this_does_not_exist_xyz"));
  });

  it("reports a name the type checker cannot resolve", async () => {
    // Still a gap on 0.0.21 — measured, along with the other five candidates.
    // If this ever goes green upstream the probe self-prunes and this test is
    // the thing that notices.
    const result = await probeTypeCheckerGaps(["PermissionError"]);
    assert.deepEqual(result, ["PermissionError"]);
  });

  it("reports nothing for a name the type checker resolves", async () => {
    assert.deepEqual(await probeTypeCheckerGaps(["len"]), []);
  });
});

// ── Probe memoisation (#68) ─────────────────────────────────────

describe("probe memoisation", () => {
  // Counters, not timers: a timing assertion passes on a fast machine with the
  // memo removed, which is exactly the regression this has to catch.

  it("probeTypeCheckerGaps executes once across multiple runInSandbox calls", async () => {
    resetProbeMemos();
    const registry = new ToolRegistry([]);
    for (let i = 0; i < 3; i++) await runInSandbox("1 + 1", { registry });
    assert.equal(probeInvocations().tyGap, 1);
  });

  it("probeImportableModules executes once across repeated calls", async () => {
    resetProbeMemos();
    for (let i = 0; i < 3; i++) await probeImportableModules();
    assert.equal(probeInvocations().importable, 1);
  });

  it("the memo can be reset", async () => {
    resetProbeMemos();
    await probeTypeCheckerGaps();
    await probeImportableModules();
    assert.deepEqual(probeInvocations(), { importable: 1, tyGap: 1 });
    resetProbeMemos();
    assert.deepEqual(probeInvocations(), { importable: 0, tyGap: 0 });
    await probeTypeCheckerGaps();
    assert.equal(probeInvocations().tyGap, 1, "a reset memo re-probes");
  });

  it("a caller-supplied candidate list is never served from the memo", async () => {
    resetProbeMemos();
    await probeImportableModules();
    await probeImportableModules(["json"]);
    await probeImportableModules([...CANDIDATE_MODULES]); // same contents, different array
    assert.equal(probeInvocations().importable, 3, "only the default list is cached");
  });

  it("memoised results are still correct", async () => {
    resetProbeMemos();
    const first = await probeTypeCheckerGaps();
    const second = await probeTypeCheckerGaps();
    assert.deepEqual(second, first);
    assert.ok(first.every((n) => typeof n === "string"));
  });
});

// ── Stub validation ─────────────────────────────────────────────

describe("renderTypeStubs — a stub that does not parse", () => {
  // A tool name is checked against a Python identifier on `add`, but nothing
  // checks the *parameter* names or the type strings, so a caller can produce
  // a stub file that does not parse. It must not be handed to the type checker
  // as-is: a signature the parser cannot read is not dropped, it is
  // misunderstood, and the resulting diagnostics are reported against the
  // user's own source (measured — `def echo(class: str)` makes a correct
  // `echo("x")` fail as `too-many-positional-arguments`).

  function toolWithParam(name: string, param: string): HostTool {
    return {
      name,
      description: "d",
      params: [{ name: param, type: "str", description: "p" }],
      returns: "str",
      execute: () => "",
    };
  }

  it("degrades the offending stub to an Any declaration", async () => {
    const reg = new ToolRegistry([toolWithParam("broken", "class")]);
    const stubs = await reg.renderTypeStubs();
    assert.equal(stubs, "broken: Any = None");
  });

  it("leaves the other tools' stubs intact", async () => {
    const reg = new ToolRegistry([
      toolWithParam("broken", "class"),
      toolWithParam("healthy", "text"),
    ]);
    const stubs = await reg.renderTypeStubs();

    assert.ok(stubs.includes("broken: Any = None"), `got: ${stubs}`);
    assert.ok(stubs.includes("def healthy(text: str) -> str:"), `got: ${stubs}`);
  });

  it("caches the validated result rather than re-checking per call", async () => {
    const reg = new ToolRegistry([toolWithParam("broken", "class")]);
    assert.equal(await reg.renderTypeStubs(), await reg.renderTypeStubs());
  });
});

// ── Stub cache invalidation ─────────────────────────────────────

describe("renderTypeStubs — cache invalidation", () => {
  it("includes a tool added while an earlier render was in flight", async () => {
    // Rendering is async, so a result written back *after* its await can
    // overwrite the invalidation that `add()` performed during it, stranding
    // the new tool outside the stub file until some later `add()`.
    const reg = new ToolRegistry([makeTool({ name: "first" })]);
    const inFlight = reg.renderTypeStubs();
    reg.add(makeTool({ name: "second" }));
    await inFlight;

    const stubs = await reg.renderTypeStubs();
    assert.ok(stubs.includes("second"), `'second' should be present, got: ${stubs}`);
    assert.ok(stubs.includes("first"), `'first' should still be present, got: ${stubs}`);
  });

  it("serves concurrent callers from one render", async () => {
    const reg = new ToolRegistry([makeTool({ name: "shared" })]);
    const [a, b] = await Promise.all([reg.renderTypeStubs(), reg.renderTypeStubs()]);
    assert.equal(a, b);
  });
});
