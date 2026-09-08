import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { runInSandbox } from "../src/sandbox.js";
import { closeSandboxPool } from "../src/pool.js";
import { ToolRegistry } from "../src/registry.js";
import { findShadowingBindings } from "../src/toolstore.js";
import type { HostTool, RunOk, RunError } from "../src/types.js";

// ── The #40 namespace question, answered by measurement ─────────
//
// #54 refuses preambles that bind a registered host-tool name, and recorded on
// #40 the question its own DoD could not answer: does Monty 0.0.21's
// `externalLookup` make host-tool shadowing *structurally* impossible, so that
// the scan becomes belt-and-braces? These tests are the answer, measured on
// the shipped 0.0.21 through `runInSandbox`:
//
//   - Host tools are reached only through name lookup, for names Python has
//     not bound (`src/sandbox.ts`, the `NameLookupSnapshot` branch). Any
//     statement that binds the name at module scope — `def`, `class`,
//     `import … as`, `from … import … as`, a bare `import` of a module with
//     the same name — wins, with ZERO host calls.
//   - The assignment forms are refused, but by `typeCheckStubs`: the stub
//     declares `def echo(text: str) -> str`, and assigning anything else to
//     that name is `error[invalid-assignment]`. That is a type-checker
//     property, not a namespace one — it vanishes with the stub.
//   - Resolution is per lookup: a call before the `def` reaches the host tool,
//     a call after it does not.
//
// So `findShadowingBindings` (`src/toolstore.ts`) is the whole boundary, not a
// belt over structural braces. The last describe pins that the scanner records
// every form the sandbox let shadow.
//
// The file also carries the #66 tests that were still missing on 0.0.21
// (comprehension, dict storage, passed as argument, `map()`, `print(f)`); the
// alias and list-storage forms live in `test/sandbox.test.ts`.

// ── Helpers ─────────────────────────────────────────────────────

/** A host tool whose result names the tool, so a shadow cannot forge it. */
function hostTool(name: string): HostTool {
  return {
    name,
    description: `Host tool ${name}`,
    params: [{ name: "text", type: "str", description: "Text" }],
    returns: "str",
    execute: (args) => `<${name}:${String(args.text)}>`,
  };
}

function ok(result: unknown): asserts result is RunOk {
  assert.equal((result as RunOk).status, "ok", JSON.stringify(result));
}

function err(result: unknown): asserts result is RunError {
  assert.equal((result as RunError).status, "error", JSON.stringify(result));
}

/** The run completed with Python's binding, and the host tool was never called. */
async function assertShadowed(code: string, output: string): Promise<void> {
  const registry = new ToolRegistry([hostTool("echo")]);
  const result = await runInSandbox(code, { registry });
  ok(result);
  assert.equal(result.output, output);
  assert.equal(result.calls.length, 0, "the host tool must not have been called");
}

/** The run was refused at type-check time under `rule`, before anything ran. */
async function assertTypingRefusal(code: string, rule: string): Promise<RunError> {
  const registry = new ToolRegistry([hostTool("echo")]);
  const result = await runInSandbox(code, { registry });
  err(result);
  assert.equal(result.errorKind, "typing");
  assert.match(result.error, new RegExp(`^error\\[${rule}\\]`, "m"));
  assert.equal(result.calls.length, 0, "nothing runs after a type-check refusal");
  return result;
}

after(async () => {
  await closeSandboxPool();
});

// ── Binding forms that shadow: zero host calls ──────────────────

describe("host-tool shadowing — binding forms win, with zero host calls (#40, #54)", () => {
  it("def binds ahead of the host tool", async () => {
    await assertShadowed('def echo(text):\n    return "SHADOWED"\necho("x")', "SHADOWED");
  });

  it("an annotated def matching the stub's signature shadows just the same", async () => {
    await assertShadowed(
      'def echo(text: str) -> str:\n    return "SHADOWED"\necho("x")',
      "SHADOWED",
    );
  });

  it("class binds ahead of the host tool", async () => {
    await assertShadowed(
      [
        "class echo:",
        "    def __init__(self, t):",
        "        self.t = t",
        "    def __str__(self):",
        '        return "<cls:" + self.t + ">"',
        'str(echo("x"))',
      ].join("\n"),
      "<cls:x>",
    );
  });

  it("import … as binds ahead of the host tool", async () => {
    await assertShadowed("import json as echo\necho.dumps([1])", "[1]");
  });

  it("from … import … as binds ahead of the host tool", async () => {
    await assertShadowed("from json import dumps as echo\necho([1])", "[1]");
  });

  it("a bare import of a module named like a host tool binds ahead of it", async () => {
    // No shipped tool shares a name with a Monty module; this pins that the
    // sandbox would not stop it if one did — the scanner has to.
    const registry = new ToolRegistry([hostTool("json")]);
    const result = await runInSandbox("import json\njson.dumps([1])", { registry });
    ok(result);
    assert.equal(result.output, "[1]");
    assert.equal(result.calls.length, 0);
  });
});

// ── Assignment forms: refused by the type checker, not the namespace ──

describe("host-tool shadowing — assignment forms are refused by typeCheckStubs", () => {
  const forms: [string, string][] = [
    ["plain assignment", "echo = 1\nstr(echo)"],
    ["lambda assignment", 'echo = lambda t: "SHADOWED"\necho("x")'],
    [
      "assignment of a same-signature function",
      'def _e(text: str) -> str:\n    return "SHADOWED"\necho = _e\necho("x")',
    ],
    ["walrus", "(echo := 5)\nstr(echo)"],
    ["tuple target", "echo, other = 1, 2\nstr(echo)"],
    ["for target", "for echo in [1, 2]:\n    pass\nstr(echo)"],
    [
      "global statement inside a function",
      "def f():\n    global echo\n    echo = 5\nf()\nstr(echo)",
    ],
  ];

  for (const [label, code] of forms) {
    it(`${label} → error[invalid-assignment], zero host calls`, async () => {
      const result = await assertTypingRefusal(code, "invalid-assignment");
      // The refusal is the stub's doing: the diagnostic names the stub signature.
      assert.match(result.error, /not assignable to `def echo\(text: str\) -> str`/);
    });
  }

  it("augmented assignment → error[unsupported-operator], zero host calls", async () => {
    await assertTypingRefusal("echo += 1", "unsupported-operator");
  });

  it("del unbinds the name: the next reference is an unresolved name, zero host calls", async () => {
    // The one live unbind (#57 pass 2): after `del`, the name resolves to
    // nothing rather than falling back to the host tool.
    const result = await assertTypingRefusal('del echo\necho("x")', "unresolved-reference");
    assert.match(result.error, /Name `echo` used when not defined/);
  });
});

// ── Resolution is per lookup ────────────────────────────────────

describe("host-tool shadowing — resolution is per lookup", () => {
  it("a call before the def reaches the host tool; a call after it does not", async () => {
    const registry = new ToolRegistry([hostTool("echo")]);
    const result = await runInSandbox(
      [
        'a = echo("first")',
        "def echo(text):",
        '    return "SHADOWED"',
        'b = echo("x")',
        'a + "|" + b',
      ].join("\n"),
      { registry },
    );
    ok(result);
    assert.equal(result.output, "<echo:first>|SHADOWED");
    assert.deepEqual(
      result.calls.map((c) => c.tool),
      ["echo"],
      "exactly one host call — the one made before the name was bound",
    );
    assert.deepEqual(result.calls[0].args, ["first"]);
  });

  it("the same with a class: the host tool answers until the name is bound", async () => {
    const registry = new ToolRegistry([hostTool("echo")]);
    const result = await runInSandbox('a = echo("first")\nclass echo:\n    pass\na', { registry });
    ok(result);
    assert.equal(result.output, "<echo:first>");
    assert.deepEqual(
      result.calls.map((c) => c.tool),
      ["echo"],
    );
  });

  it("a nested def shadows only inside its own scope", async () => {
    const registry = new ToolRegistry([hostTool("echo")]);
    const result = await runInSandbox(
      [
        "def outer():",
        "    def echo(t):",
        '        return "INNER"',
        '    return echo("x")',
        'outer() + "|" + echo("y")',
      ].join("\n"),
      { registry },
    );
    ok(result);
    assert.equal(result.output, "INNER|<echo:y>");
    assert.deepEqual(
      result.calls.map((c) => c.tool),
      ["echo"],
    );
  });

  it("a parameter named like a tool is local; the module-level name still resolves to the host", async () => {
    const registry = new ToolRegistry([hostTool("echo")]);
    const result = await runInSandbox(
      'def g(echo):\n    return echo\ng("param") + "|" + echo("y")',
      { registry },
    );
    ok(result);
    assert.equal(result.output, "param|<echo:y>");
    assert.deepEqual(
      result.calls.map((c) => c.tool),
      ["echo"],
    );
  });
});

// ── No dynamic rebinding primitive exists ───────────────────────

describe("host-tool shadowing — the dynamic rebinding primitives do not exist in Monty 0.0.21", () => {
  // The #40 note listed `exec`, `globals()`, `setattr`, walrus and bare
  // `import` as the scanner's feared false negatives. Walrus and bare import
  // are pinned above; these three are not names at all.
  const forms: [string, string][] = [
    ["exec", 'exec("echo = 5")\nstr(echo)'],
    ["globals", 'globals()["echo"] = 5\nstr(echo)'],
    ["setattr", 'import builtins\nsetattr(builtins, "echo", 5)\nstr(echo)'],
  ];

  for (const [name, code] of forms) {
    it(`${name} is an unresolved name`, async () => {
      const result = await assertTypingRefusal(code, "unresolved-reference");
      assert.match(result.error, new RegExp(`Name \`${name}\` used when not defined`));
    });
  }

  it("a wildcard import is refused at runtime, so it cannot bind anything", async () => {
    const registry = new ToolRegistry([hostTool("echo")]);
    const result = await runInSandbox('from json import *\n"ok"', { registry });
    err(result);
    assert.equal(result.errorKind, "runtime");
    assert.match(result.error, /Wildcard imports .* are not supported/);
    assert.equal(result.calls.length, 0);
  });
});

// ── findShadowingBindings is the whole boundary ─────────────────

describe("findShadowingBindings records every form the sandbox let shadow (#54)", () => {
  const reserved = new Set(["echo"]);

  const shadowing: [string, string][] = [
    ["def", 'def echo(text):\n    return "SHADOWED"\necho("x")'],
    ["annotated def", 'def echo(text: str) -> str:\n    return "SHADOWED"\necho("x")'],
    ["class", "class echo:\n    pass\n"],
    ["import as", "import json as echo\necho.dumps([1])"],
    ["from import as", "from json import dumps as echo\necho([1])"],
  ];

  for (const [label, code] of shadowing) {
    it(`records ${label}`, () => {
      assert.deepEqual(findShadowingBindings(code, reserved), ["echo"]);
    });
  }

  const assignments: [string, string][] = [
    ["plain assignment", "echo = 1\nstr(echo)"],
    ["lambda assignment", 'echo = lambda t: "SHADOWED"\necho("x")'],
    ["walrus", "(echo := 5)\nstr(echo)"],
    ["tuple target", "echo, other = 1, 2\nstr(echo)"],
    ["for target", "for echo in [1, 2]:\n    pass\nstr(echo)"],
    ["del", 'del echo\necho("x")'],
  ];

  for (const [label, code] of assignments) {
    it(`records ${label} too — belt over the type checker's braces`, () => {
      assert.deepEqual(findShadowingBindings(code, reserved), ["echo"]);
    });
  }

  it("does not record scoped bindings the sandbox does not shadow with", () => {
    assert.deepEqual(
      findShadowingBindings(
        'def g(echo):\n    return echo\ng("param") + "|" + echo("y")',
        reserved,
      ),
      [],
    );
    assert.deepEqual(findShadowingBindings('f = lambda echo="x": echo\nf()', reserved), []);
  });

  it("records a bare import of a module named like a host tool", {
    todo:
      "the import branch of findShadowingBindings (src/toolstore.ts) records only `as` aliases, " +
      "because no shipped tool shares a name with a Monty module — but the sandbox lets " +
      "`import json` win over a tool named `json` (pinned above). Intended approach: also " +
      "record a plain `import X` / `import X.Y` whose first segment is a reserved name.",
  }, () => {
    assert.deepEqual(findShadowingBindings("import json\njson.dumps([1])", new Set(["json"])), [
      "json",
    ]);
  });
});

// ── Host tools as values: the #66 remainder ─────────────────────

describe("host tools survive being used as values — the #66 remainder", () => {
  it("dispatches a tool reached through a comprehension", async () => {
    const registry = new ToolRegistry([hostTool("echo")]);
    const result = await runInSandbox('[t("x") for t in [echo]][0]', { registry });
    ok(result);
    assert.equal(result.output, "<echo:x>");
    assert.deepEqual(
      result.calls.map((c) => c.tool),
      ["echo"],
    );
  });

  it("dispatches a tool stored in a dict", async () => {
    const registry = new ToolRegistry([hostTool("echo")]);
    const result = await runInSandbox('d = {"e": echo}\nd["e"]("x")', { registry });
    ok(result);
    assert.equal(result.output, "<echo:x>");
    assert.deepEqual(
      result.calls.map((c) => c.tool),
      ["echo"],
    );
  });

  it("dispatches a tool passed as an argument", async () => {
    const registry = new ToolRegistry([hostTool("echo")]);
    const result = await runInSandbox('def call(fn):\n    return fn("x")\ncall(echo)', {
      registry,
    });
    ok(result);
    assert.equal(result.output, "<echo:x>");
    assert.deepEqual(
      result.calls.map((c) => c.tool),
      ["echo"],
    );
  });

  it("map() fails at type-check time as an unresolved name — not a runtime NameError, zero calls", async () => {
    // #66 test 5: docs/REVIEW.md §8 recorded `map(read_file, paths)` failing
    // with `calls.length === 0`. On 0.0.21 that is because `map` itself is not
    // a name the type checker knows — a different failure from the runtime
    // `NameError: SENTINEL` the issue was filed on, and asserted separately.
    const registry = new ToolRegistry([hostTool("read_file")]);
    const result = await runInSandbox('list(map(read_file, ["a", "b"]))', { registry });
    err(result);
    assert.equal(result.errorKind, "typing");
    assert.match(result.error, /^error\[unresolved-reference\]: Name `map` used when not defined/m);
    assert.equal(result.calls.length, 0);
  });

  it("print(f) prints the proxy's repr instead of raising", async () => {
    // #66 test 6. On 0.0.18 `print(f)` on a tool value threw
    // `TypeError: Value is not undefined`; on 0.0.21 the proxy has a repr.
    const registry = new ToolRegistry([hostTool("echo")]);
    const result = await runInSandbox("f = echo\nprint(f)\nstr(echo)", { registry });
    ok(result);
    assert.equal(result.stdout, "<function 'echo' external>\n");
    assert.equal(result.output, "<function 'echo' external>");
    assert.equal(result.calls.length, 0, "printing a tool is not a call");
  });
});
