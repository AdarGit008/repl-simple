import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveToolArgs } from "../src/sandbox.js";
import { HostToolError, type HostTool } from "../src/types.js";

// ── resolveToolArgs — the contract #65 builds on (#85, D136) ─────
//
// `resolveToolArgs` (src/sandbox.ts) is the one place a Python call's
// positional and keyword arguments become the flat record every host tool's
// `execute` receives. It is exported, called on both dispatch paths and on
// resume. W2-3 pinned the matrix as it stood; W3-1 (#65, D142) flipped the
// two `missing` rows — a missing required parameter is now the `TypeError`
// a real Python call would raise — and the surplus rows still pin today's
// behaviour and say so.
//
// The file lives apart from test/sandbox.test.ts because it tests the
// function directly, without a sandbox run.

/** A tool with the named parameters; a second tuple element marks one optional. */
function tool(...params: Array<[name: string, optional?: boolean]>): HostTool {
  return {
    name: "add",
    description: "Add two numbers",
    params: params.map(([name, optional]) => ({
      name,
      type: "int",
      description: name,
      ...(optional ? { optional } : {}),
    })),
    returns: "str",
    execute: () => "",
  };
}

/** `add(a, b=None)` — one required, one optional. */
const AB = tool(["a"], ["b", true]);

// ── Positional and keyword binding ──────────────────────────────

describe("resolveToolArgs — positional and keyword arguments", () => {
  it("binds positionals in parameter order", () => {
    assert.deepEqual(resolveToolArgs(AB, [1, 2], {}), { a: 1, b: 2 });
  });

  it("binds keywords by name", () => {
    assert.deepEqual(resolveToolArgs(AB, [], { a: 1, b: 2 }), { a: 1, b: 2 });
  });

  it("keyword order does not matter", () => {
    assert.deepEqual(resolveToolArgs(AB, [], { b: 2, a: 1 }), { a: 1, b: 2 });
  });

  it("mixes positionals and keywords, Python-style — positionals first, keywords fill the rest", () => {
    assert.deepEqual(resolveToolArgs(AB, [1], { b: 2 }), { a: 1, b: 2 });
  });

  it("carries values through untouched — no coercion, no copying", () => {
    const payload = { nested: [1, 2] };
    const resolved = resolveToolArgs(AB, [payload], { b: null });
    assert.equal(resolved.a, payload, "the same object, not a clone");
    assert.equal(resolved.b, null);
  });

  it("a tool with no parameters resolves to an empty record", () => {
    assert.deepEqual(resolveToolArgs(tool(), [], {}), {});
  });
});

// ── Duplicate arguments ─────────────────────────────────────────

describe("resolveToolArgs — duplicate arguments", () => {
  it("a positional and a keyword for the same parameter is a Python TypeError", () => {
    assert.throws(
      () => resolveToolArgs(AB, [1], { a: 2 }),
      (err: unknown) => {
        assert.ok(err instanceof HostToolError);
        assert.equal(err.pythonType, "TypeError");
        assert.equal(err.message, "add() got multiple values for argument 'a'");
        return true;
      },
    );
  });

  it("the duplicate is named for a later parameter too", () => {
    assert.throws(
      () => resolveToolArgs(AB, [1, 2], { b: 3 }),
      /add\(\) got multiple values for argument 'b'/,
    );
  });
});

// ── Missing arguments — the #65 contract (D142) ─────────────────
//
// A missing *required* parameter is a `TypeError` at this layer, worded as
// CPython words it, so `echo(**{})` and `SUBMIT(**{})` — the forms the type
// checker cannot see through — fail in Python instead of reaching `execute`
// with an undefined argument. `optional` is what makes a parameter omittable;
// the tool's `execute` still supplies the default for those.

/** The `TypeError` `resolveToolArgs` raises, asserted by its Python type and message. */
function missing(fn: () => unknown, message: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof HostToolError, "not a HostToolError");
    assert.equal(err.pythonType, "TypeError");
    assert.equal(err.message, message);
    return true;
  });
}

describe("resolveToolArgs — missing arguments (#65 test 3)", () => {
  it("a missing required parameter is a Python TypeError naming it", () => {
    missing(
      () => resolveToolArgs(AB, [], { b: 2 }),
      "add() missing 1 required positional argument: 'a'",
    );
  });

  it("nothing at all names the required parameter and not the optional one", () => {
    missing(() => resolveToolArgs(AB, [], {}), "add() missing 1 required positional argument: 'a'");
  });

  it("two and three missing use CPython's list wording", () => {
    missing(
      () => resolveToolArgs(tool(["a"], ["b"]), [], {}),
      "add() missing 2 required positional arguments: 'a' and 'b'",
    );
    missing(
      () => resolveToolArgs(tool(["a"], ["b"], ["c"]), [], {}),
      "add() missing 3 required positional arguments: 'a', 'b', and 'c'",
    );
    // Only the missing ones are named, in parameter order.
    missing(
      () => resolveToolArgs(tool(["a"], ["b"], ["c"]), [], { b: 2 }),
      "add() missing 2 required positional arguments: 'a' and 'c'",
    );
  });

  it("a missing optional parameter is left out — the caller supplies the default", () => {
    assert.deepEqual(resolveToolArgs(AB, [1], {}), { a: 1 });
  });

  it("an explicit undefined keyword counts as provided", () => {
    const resolved = resolveToolArgs(AB, [1], { b: undefined });
    assert.equal(Object.hasOwn(resolved, "b"), true);
    assert.equal(resolved.b, undefined);
  });

  it("a duplicate is reported before a missing one, as Python does", () => {
    assert.throws(
      () => resolveToolArgs(tool(["a"], ["b"]), [1], { a: 2 }),
      /add\(\) got multiple values for argument 'a'/,
    );
  });
});

// ── Surplus arguments — today's behaviour, pinned ───────────────

describe("resolveToolArgs — surplus arguments (today's behaviour, pinned)", () => {
  it("positionals beyond the parameter list are dropped silently", () => {
    assert.deepEqual(resolveToolArgs(AB, [1, 2, 3], {}), { a: 1, b: 2 });
  });

  it("keywords the tool does not declare are dropped silently", () => {
    assert.deepEqual(resolveToolArgs(AB, [1], { b: 2, verbose: true }), { a: 1, b: 2 });
  });
});

// ── Keyword presence is own-property presence (W2-3's residual, closed) ──

describe("resolveToolArgs — a keyword is present only when kwargs owns it", () => {
  it("a parameter named like an Object.prototype member is not seen as a provided keyword", () => {
    // `param.name in kwargs` walked the prototype chain, so an empty kwargs
    // object 'had' `constructor` / `toString` / `valueOf`: a positional for
    // such a parameter was refused as a duplicate and the keyword lookup
    // handed back the prototype member.
    const ctor = tool(["constructor"]);
    assert.deepEqual(resolveToolArgs(ctor, [1], {}), { constructor: 1 });
    missing(
      () => resolveToolArgs(ctor, [], {}),
      "add() missing 1 required positional argument: 'constructor'",
    );
    const str = tool(["toString", true]);
    assert.deepEqual(resolveToolArgs(str, [], {}), {});
  });
});
