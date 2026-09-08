import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveToolArgs } from "../src/sandbox.js";
import { HostToolError, type HostTool } from "../src/types.js";

// ── resolveToolArgs — the contract #65 builds on (#85, D136) ─────
//
// `resolveToolArgs` (src/sandbox.ts) is the one place a Python call's
// positional and keyword arguments become the flat record every host tool's
// `execute` receives. It is exported, called on both dispatch paths and on
// resume, and until this file it had no direct test: its behaviour was
// reachable only through whole sandbox runs. The matrix below is what #65
// (required-parameter enforcement) will change — the `missing` and surplus
// rows pin *today's* behaviour and say so, so the flip is a decision here and
// not a surprise elsewhere.
//
// These pass on main by design: the function is not changed in this chunk.
// The file lives apart from test/sandbox.test.ts because that file belongs to
// the wave-2 sandbox chunk.

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

// ── Missing arguments — today's behaviour, pinned ───────────────
//
// #65 / W3-1 will make a missing *required* parameter a TypeError at this
// layer. Until then the key is simply absent — `optional` is not consulted
// here — and the tool's `execute` decides. When #65 lands, the two tests
// marked "flips" change with it; the optional-parameter one stays.

describe("resolveToolArgs — missing arguments (today's behaviour, pinned)", () => {
  it("a missing required parameter is left out of the record (flips under #65)", () => {
    const resolved = resolveToolArgs(AB, [], { b: 2 });
    assert.deepEqual(resolved, { b: 2 });
    assert.equal(Object.hasOwn(resolved, "a"), false, "no key at all, not an undefined value");
  });

  it("nothing at all resolves to an empty record, not a throw (flips under #65)", () => {
    assert.deepEqual(resolveToolArgs(AB, [], {}), {});
  });

  it("a missing optional parameter is left out — the caller supplies the default", () => {
    assert.deepEqual(resolveToolArgs(AB, [1], {}), { a: 1 });
  });

  it("an explicit undefined keyword counts as provided", () => {
    const resolved = resolveToolArgs(AB, [1], { b: undefined });
    assert.equal(Object.hasOwn(resolved, "b"), true);
    assert.equal(resolved.b, undefined);
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

// ── Residual (todo, decision 9) ─────────────────────────────────

describe("resolveToolArgs — residual", () => {
  it("a parameter named like an Object.prototype member is not seen as a provided keyword", {
    todo:
      "`param.name in kwargs` walks the prototype chain, so an empty kwargs object 'has' " +
      "`constructor` / `toString` / `valueOf`: a positional for such a parameter is refused as " +
      "a duplicate and the keyword lookup hands back the prototype member. Fix: `Object.hasOwn` " +
      "in src/sandbox.ts resolveToolArgs (not owned this wave).",
  }, () => {
    const ctor = tool(["constructor"]);
    assert.deepEqual(resolveToolArgs(ctor, [1], {}), { constructor: 1 });
    assert.deepEqual(resolveToolArgs(ctor, [], {}), {});
  });
});
