import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HostToolError, type HostTool } from "../src/types.js";
import {
  ToolRegistry,
  requireString,
  renderPythonToolRules,
  probeImportableModules,
  probeTypeCheckerGaps,
  probeInvocations,
  resetProbeMemos,
  CANDIDATE_MODULES,
} from "../src/registry.js";
import { runInSandbox } from "../src/sandbox.js";
// The #67 / #169 exports are reached through the namespace so that, run
// against a `src/` without them, only their tests fail rather than this
// whole file failing to link (D109).
import * as registryModule from "../src/registry.js";
import { createBuiltinTools } from "../src/builtins.js";
import { createPiBridgeTools } from "../src/bridge.js";
import { createRLMTools } from "../src/rlm_tools.js";
import { createToolStoreTools } from "../src/toolstore.js";
import { SandboxUnavailableError, closeSandboxPool, withSandboxSession } from "../src/pool.js";

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

// ── Dead public API (#85, decision 14, D133/D134) ───────────────
//
// `arg()` was a positional-or-keyword lookup that no production code called:
// eighteen test references, zero consumers, re-exported from the barrel as if
// it were API. The live resolver is `resolveToolArgs` in src/sandbox.ts
// (direct matrix: test/resolve_tool_args.test.ts). The function, its seven
// tests and the re-export went together; these pins make a re-introduction a
// decision rather than drift. `CANDIDATE_MODULES`, filed alongside it, is
// live — the default and the memo identity of `probeImportableModules`.

describe("dead public API (#85)", () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it("arg() is gone from src/registry.ts — resolveToolArgs is the one argument resolver", () => {
    assert.equal("arg" in registryModule, false, "arg() is dead API (decision 14)");
  });

  it("the barrel does not re-export arg", () => {
    const barrel = readFileSync(join(here, "..", "src", "index.ts"), "utf-8");
    assert.doesNotMatch(barrel, /^\s*arg,?\s*$/m, "src/index.ts still lists `arg`");
  });

  it("CANDIDATE_MODULES is live: it is the default list probeImportableModules answers for", async () => {
    // Green on main by design — the re-scope: the issue counted it as
    // referenced nowhere, but #68 made it the memo's identity key.
    resetProbeMemos();
    assert.deepEqual(
      await probeImportableModules(),
      await probeImportableModules([...CANDIDATE_MODULES]),
    );
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

  it("tells the truth about classes: a plain class runs on 0.0.21, only inheritance and match do not", {
    todo:
      "the rules say 'Class definitions and match statements are not supported'; measured on " +
      "Monty 0.0.21 a plain class with __init__ and a method runs (A(3).get() -> 3) and only " +
      "class inheritance / metaclasses / match raise NotImplementedError (README agrees). The " +
      "line is model-facing prompt text, so rewording it is a behaviour change outside this " +
      "chunk's scope (#86 comment sweep) — W3-2 rewords it to name inheritance and match.",
  }, () => {
    const rules = renderPythonToolRules(["json"]);
    assert.doesNotMatch(rules, /Class definitions .* are not supported/);
    assert.match(rules, /inheritance/);
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

// ── Degraded stubs are counted and reported (#67, D102–D104) ────
//
// Two of #67's three degradation paths are ours. Path 1: a stub that does not
// parse falls back to `name: Any = None` and the tool is unchecked from then
// on. Path 3: 0.0.21 tolerates an unresolved type name, so `-> void` (the
// HostTool spelling of "returns nothing") rendered verbatim and silently
// unchecked the return type. Path 2 — the interpreter names the checker
// cannot resolve — is deliberate and documented per entry. Nothing counted
// any of them: a registry where every stub degraded looked exactly like one
// where none did.

describe("ToolRegistry.degradedStubs() (#67)", () => {
  function toolWithParam(name: string, param: string): HostTool {
    return {
      name,
      description: "d",
      params: [{ name: param, type: "str", description: "p" }],
      returns: "str",
      execute: () => "",
    };
  }

  /** What the extension and runRlm register, minus nothing this process can build. */
  function shippedTools(): HostTool[] {
    return [
      ...createBuiltinTools({ root: process.cwd() }),
      ...createPiBridgeTools(process.cwd()),
      ...createToolStoreTools({ root: process.cwd() }),
      ...createRLMTools({ onLLMQuery: async () => "", onRLMQuery: async () => "" }),
    ];
  }

  it("reports a tool whose stub does not parse as unparseable (path 1, issue test 2)", async () => {
    const reg = new ToolRegistry([
      toolWithParam("broken", "class"),
      toolWithParam("healthy", "text"),
    ]);
    const report = await reg.degradedStubs();
    assert.deepEqual(
      report.tools.map((t) => ({ name: t.name, kind: t.kind })),
      [{ name: "broken", kind: "unparseable" }],
    );
    assert.match(report.tools[0].detail, /Any/, "the detail names the fallback");
  });

  it("renders a void return as Python None and does not count it as degraded (path 3)", async () => {
    // `void` is HostTool vocabulary; the Python spelling is `None`. Rendered
    // verbatim it is an unresolved name the checker tolerates, so the return
    // type of every void tool — SUBMIT included — went unchecked.
    const reg = new ToolRegistry([makeTool({ name: "fire", returns: "void" })]);
    const stubs = await reg.renderTypeStubs();
    assert.ok(stubs.includes("def fire() -> None:"), `got: ${stubs}`);
    assert.ok(!stubs.includes("void"), `void leaked into the stub file: ${stubs}`);
    assert.deepEqual((await reg.degradedStubs()).tools, []);
  });

  it("reports a type name the checker cannot resolve as unknown-type (path 3)", async () => {
    // The unions on HostToolParam.type / HostTool.returns are closed, so an
    // unknown name can only arrive through a cast — which is exactly what a
    // JavaScript caller or a future widening of the union does.
    const tool: HostTool = {
      name: "odd",
      description: "d",
      params: [{ name: "p", type: "NotAType" as "str", description: "p" }],
      returns: "str",
      execute: () => "",
    };
    const reg = new ToolRegistry([tool]);
    const report = await reg.degradedStubs();
    assert.equal(report.tools.length, 1);
    assert.equal(report.tools[0].name, "odd");
    assert.equal(report.tools[0].kind, "unknown-type");
    assert.match(report.tools[0].detail, /NotAType/);
    // The stub still parses and still renders — the checker tolerates the
    // name — so without the report the degradation is invisible.
    assert.ok((await reg.renderTypeStubs()).includes("p: NotAType"));
  });

  it("the shipped registry has zero degraded tools (issue test 3)", async () => {
    const report = await new ToolRegistry(shippedTools()).degradedStubs();
    assert.deepEqual(report.tools, [], `degraded stubs: ${JSON.stringify(report.tools)}`);
  });

  it("the zero-degraded assertion fires when a broken stub is injected", async () => {
    const report = await new ToolRegistry([
      ...shippedTools(),
      toolWithParam("broken", "class"),
    ]).degradedStubs();
    assert.equal(report.tools.length, 1, "exactly the injected tool degrades");
    assert.equal(report.tools[0].name, "broken");
    // Every shipped tool still renders checked beside it.
    const stubs = await new ToolRegistry([
      ...shippedTools(),
      toolWithParam("broken", "class"),
    ]).renderTypeStubs();
    assert.ok(stubs.includes("def SUBMIT(answer: str) -> None:"), stubs.slice(0, 400));
  });

  it("every deliberate checker gap has a documented reason, and the live gaps are among them (path 2)", async () => {
    const { TY_GAP_CANDIDATES, TY_GAP_REASONS } = registryModule;
    assert.ok(TY_GAP_CANDIDATES.length > 0);
    for (const name of TY_GAP_CANDIDATES) {
      assert.equal(typeof TY_GAP_REASONS[name], "string", `${name} has no documented reason`);
      assert.ok(TY_GAP_REASONS[name].length > 0, `${name} has an empty reason`);
    }
    const report = await new ToolRegistry([]).degradedStubs();
    for (const gap of report.checkerGaps) {
      assert.ok(TY_GAP_CANDIDATES.includes(gap), `undocumented gap reported: ${gap}`);
    }
    assert.deepEqual(report.checkerGaps, await probeTypeCheckerGaps());
  });
});

// ── Stub-validation memo across registries (#169, D106) ─────────
//
// `runRlm` builds a fresh ToolRegistry per call and per nesting level, so the
// per-instance cache never hit across calls: every loop and every child paid
// a worker round trip to validate stubs that had not changed. The memo is
// module-level and content-addressed, like the probe memos — and, like them,
// asserted with a counter rather than a timer.

describe("stub-validation memo (#169)", () => {
  const tools = () => [makeTool({ name: "alpha" }), makeParamTool()];

  async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("two registries with identical stubs validate once", async () => {
    registryModule.resetStubValidationMemo();
    const a = await new ToolRegistry(tools()).renderTypeStubs();
    const b = await new ToolRegistry(tools()).renderTypeStubs();
    assert.equal(a, b);
    assert.equal(registryModule.stubValidationInvocations(), 1);
  });

  it("a different stub set validates again", async () => {
    registryModule.resetStubValidationMemo();
    await new ToolRegistry(tools()).renderTypeStubs();
    await new ToolRegistry([makeTool({ name: "beta" })]).renderTypeStubs();
    assert.equal(registryModule.stubValidationInvocations(), 2);
  });

  it("an empty registry never validates", async () => {
    registryModule.resetStubValidationMemo();
    assert.equal(await new ToolRegistry([]).renderTypeStubs(), "");
    assert.equal(registryModule.stubValidationInvocations(), 0);
  });

  it("the reset hook re-validates", async () => {
    registryModule.resetStubValidationMemo();
    await new ToolRegistry(tools()).renderTypeStubs();
    registryModule.resetStubValidationMemo();
    assert.equal(registryModule.stubValidationInvocations(), 0);
    await new ToolRegistry(tools()).renderTypeStubs();
    assert.equal(registryModule.stubValidationInvocations(), 1, "a reset memo re-validates");
  });

  it("a rejected validation is never cached", { timeout: 20_000 }, async () => {
    // Force the rejection: a single-worker pool with a 1 s checkout timeout,
    // held by this test while the render asks for a second worker. The
    // validation rejects with SandboxUnavailableError; a memo that kept that
    // promise would hand every later caller the same rejection for the life
    // of the process.
    registryModule.resetStubValidationMemo();
    await closeSandboxPool();
    try {
      await withEnv(
        { REPL_POOL_MAX_PROCESSES: "1", REPL_POOL_CHECKOUT_TIMEOUT_SECS: "1" },
        async () => {
          await withSandboxSession({ typeCheck: false }, async () => {
            await assert.rejects(
              () => new ToolRegistry([makeTool({ name: "held" })]).renderTypeStubs(),
              SandboxUnavailableError,
            );
          });
          assert.equal(registryModule.stubValidationInvocations(), 1);
          // The worker is back. A fresh registry with the same stubs must
          // re-run the validation and get a real answer, not the rejection.
          const stubs = await new ToolRegistry([makeTool({ name: "held" })]).renderTypeStubs();
          assert.ok(stubs.includes("def held() -> str:"), `got: ${stubs}`);
          assert.equal(registryModule.stubValidationInvocations(), 2);
        },
      );
    } finally {
      // Built with a cap of 1; do not leave it for the next test.
      await closeSandboxPool();
    }
  });
});
