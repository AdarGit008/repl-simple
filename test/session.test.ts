import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session.js";
import { ToolRegistry } from "../src/registry.js";
import { HostToolError } from "../src/types.js";
import { createRLMTools } from "../src/rlm_tools.js";
import type { ApprovalRequest, HostTool, RunOk, RunError, RunSuspended } from "../src/types.js";

// ── Helpers ─────────────────────────────────────────────────────

function ok(result: unknown): asserts result is RunOk {
  assert.equal((result as RunOk).status, "ok");
}

function err(result: unknown): asserts result is RunError {
  assert.equal((result as RunError).status, "error");
}

function suspended(result: unknown): asserts result is RunSuspended {
  assert.equal((result as RunSuspended).status, "suspended");
}

// A tool that tracks invocation count (never cached — always executes)
function makeCounterTool(): HostTool {
  let count = 0;
  return {
    name: "counter",
    description: "Returns incrementing counter",
    params: [],
    returns: "str",
    execute: () => String(++count),
  };
}

// A tool that echoes its argument
function makeEchoTool(): HostTool {
  return {
    name: "echo",
    description: "Echo back",
    params: [{ name: "text", type: "str", description: "Text" }],
    returns: "str",
    execute: (args) => String(args.text),
  };
}

// ── Basic execution ─────────────────────────────────────────────

describe("Session — basic execution", () => {
  it("executes simple Python code", async () => {
    const registry = new ToolRegistry();
    const session = new Session({ registry });

    const result = await session.run("1 + 2");
    ok(result);
    assert.equal(result.output, "3");
  });

  it("variables persist across calls via transcript replay", async () => {
    const registry = new ToolRegistry();
    const session = new Session({ registry });

    await session.run("x = 42");
    const result = await session.run("x");
    ok(result);
    assert.equal(result.output, "42");
  });

  it("multiple variable assignments persist", async () => {
    const registry = new ToolRegistry();
    const session = new Session({ registry });

    await session.run("x = 10");
    await session.run("y = x + 5");
    const result = await session.run("y * 2");
    ok(result);
    assert.equal(result.output, "30");
  });

  it("imports persist across calls", async () => {
    const registry = new ToolRegistry();
    const session = new Session({ registry });

    await session.run("import json");
    const result = await session.run('json.dumps({"a": 1})');
    ok(result);
    // Should return the JSON string (monty should support json module)
    assert.ok(typeof result.output === "string");
  });

  it("print output accumulates in stdout", async () => {
    const registry = new ToolRegistry();
    const session = new Session({ registry });

    const r1 = await session.run('print("hello")');
    ok(r1);
    assert.ok(r1.stdout.includes("hello"));

    const r2 = await session.run('print("world")');
    ok(r2);
    // Replay: both prints fire, so stdout has both
    assert.ok(r2.stdout.includes("hello"));
    assert.ok(r2.stdout.includes("world"));
  });
});

// ── Tool call caching ───────────────────────────────────────────

describe("Session — tool call caching", () => {
  it("caches successful tool calls and replays from cache", async () => {
    // counter tool increments on each real execution.
    // If cached, it returns the same value; otherwise it increments.
    const counter = makeCounterTool();
    const registry = new ToolRegistry([counter]);
    const session = new Session({ registry });

    // First snippet: counter() → 1
    const r1 = await session.run("x = counter()");
    ok(r1);
    // x should be 1
    const r2 = await session.run("x");
    ok(r2);
    assert.equal(r2.output, "1");

    // During replay for third run, counter() from snippet 1 is CACHED → returns "1"
    // So x stays 1, then the new code "counter()" executes fresh → "2"
    const r3 = await session.run("counter()");
    ok(r3);
    assert.equal(r3.output, "2");
  });

  it("does NOT cache calls from failed runs", async () => {
    const counter = makeCounterTool();
    const registry = new ToolRegistry([counter]);
    const session = new Session({ registry });

    // First: successful call → cached
    await session.run("x = counter()"); // counter → 1

    // Second: fails after tool call → tool call from this run is NOT cached
    const r2 = await session.run("y = counter()\nundefined_var");
    err(r2);
    assert.equal(r2.errorKind, "typing");

    // Third: during replay, counter() from snippet 1 is cached → "1"
    // counter() in new code executes fresh → should be 2 (not 3, because
    // the failed run's counter call was not cached)
    const r3 = await session.run("counter()");
    ok(r3);
    assert.equal(r3.output, "2");
  });

  it("caches calls keyed by tool name + args", async () => {
    const echo = makeEchoTool();
    const registry = new ToolRegistry([echo]);
    const session = new Session({ registry });

    // Make two different echo calls
    await session.run('a = echo("hello")');
    await session.run('b = echo("world")');

    // Both should be cached; during replay of run 3, echo("hello") and echo("world")
    // are served from cache; new echo("hello") and echo("world") execute fresh
    const r3 = await session.run('echo("hello") + " " + echo("world")');
    ok(r3);
    assert.equal(r3.output, "hello world");
  });

  it("replayed calls do NOT count in ToolCallTrace of current run", async () => {
    const echo = makeEchoTool();
    const registry = new ToolRegistry([echo]);
    const session = new Session({ registry });

    await session.run('echo("first")'); // 1 real call
    // ToolCallTrace has 1 call

    const r2 = await session.run('echo("second")');
    ok(r2);
    // Replay replays echo("first") + executes echo("second").
    // Only the NEW call (echo("second")) should appear in the trace.
    assert.equal(r2.calls.length, 1);
    assert.equal(r2.calls[0].tool, "echo");
    assert.deepEqual(r2.calls[0].args, ["second"]);
  });
});

// ── Error handling ──────────────────────────────────────────────

describe("Session — error handling", () => {
  it("failed run does NOT add snippet", async () => {
    const registry = new ToolRegistry();
    const session = new Session({ registry });

    const r1 = await session.run("x = 1");
    ok(r1);

    const r2 = await session.run("1 / 0");
    err(r2);

    // x should still be 1 — the failed snippet was dropped
    const r3 = await session.run("x");
    ok(r3);
    assert.equal(r3.output, "1");
  });

  it("syntax error does NOT add snippet", async () => {
    const registry = new ToolRegistry();
    const session = new Session({ registry });

    await session.run("x = 5");
    await session.run("1 +"); // syntax error

    const r3 = await session.run("x");
    ok(r3);
    assert.equal(r3.output, "5");
  });

  it("typing error does NOT add snippet", async () => {
    const registry = new ToolRegistry();
    const session = new Session({ registry });

    await session.run("x = 10");
    await session.run('x: int = "not an int"'); // typing error

    const r3 = await session.run("x");
    ok(r3);
    assert.equal(r3.output, "10");
  });

  it("runtime error in tool call does NOT add snippet", async () => {
    const registry = new ToolRegistry();
    const session = new Session({ registry });

    // Create a snippet that uses undefined_name — will fail at type check
    await session.run("x = 1");
    const r2 = await session.run("undefined_name");
    err(r2);

    // x should still be 1
    const r3 = await session.run("x");
    ok(r3);
    assert.equal(r3.output, "1");
  });
});

// ── Approval / Suspension ───────────────────────────────────────

describe("Session — approval & suspension", () => {
  const gatedTool: HostTool = {
    name: "gated",
    description: "Needs approval",
    params: [{ name: "x", type: "str", description: "Value" }],
    returns: "str",
    requiresApproval: true,
    execute: (args) => `approved: ${args.x}`,
  };

  it("suspends and resumes successfully", async () => {
    const registry = new ToolRegistry([gatedTool]);
    const session = new Session({ registry });

    // Run with approval callback that suspends
    const r1 = await session.run('gated("test")', {
      onApproval: () => "suspend",
    });
    suspended(r1);
    assert.equal(r1.suspendedCall.tool, "gated");

    // Resume with approve
    const r2 = await session.resume({
      onApproval: () => true,
    });
    ok(r2);
    assert.equal(r2.output, "approved: test");
  });

  it("resume with deny → PermissionError", async () => {
    const registry = new ToolRegistry([gatedTool]);
    const session = new Session({ registry });

    await session.run(
      `
try:
    gated("x")
    result = "no-error"
except PermissionError:
    result = "blocked"
result
`,
      { onApproval: () => "suspend" },
    );

    const r2 = await session.resume({
      onApproval: () => false,
    });
    ok(r2);
    assert.equal(r2.output, "blocked");
  });

  it("resume with 'suspend' hands the stored suspension straight back", async () => {
    const registry = new ToolRegistry([gatedTool]);
    const session = new Session({ registry });

    const first = await session.run('gated("x")', { onApproval: () => "suspend" });
    suspended(first);

    const second = await session.resume({ onApproval: () => "suspend" });
    suspended(second);

    // Identity, not equality. Deferring decides nothing, so nothing should
    // happen — and the cheapest proof that no snapshot was restored into a
    // fresh worker is that the object handed back is the one already held.
    // A rebuilt result would be equal and would have cost a full round trip
    // through the sandbox to arrive back where it started.
    assert.equal(second, first, "a deferral rebuilt the suspension instead of returning it");
    assert.equal(second.suspendedCall.tool, "gated");
  });

  it("a denial on resume authorises nothing, even where a grant could be recorded", async () => {
    // `grantUses: 2` is the only configuration where `recordGrant` stores
    // anything at all, and therefore the only one where "does a denial record
    // a grant?" is an observable question. It must not: the next identical
    // call has to ask again rather than ride in on the answer to a question
    // that was refused.
    let executions = 0;
    const counted: HostTool = {
      ...gatedTool,
      execute: (args) => {
        executions++;
        return `approved: ${args.x}`;
      },
    };
    const session = new Session({ registry: new ToolRegistry([counted]) }, undefined, {
      grantUses: 2,
    });

    const code = [
      "try:",
      '    gated("x")',
      "except PermissionError:",
      "    pass",
      'gated("x")',
    ].join("\n");
    suspended(await session.run(code, { onApproval: () => "suspend" }));

    let asked = 0;
    const result = await session.resume({
      onApproval: () => {
        asked++;
        return false;
      },
    });

    err(result);
    // Twice: once for the suspended call, once for the identical call after
    // it. A grant recorded by the denial would have swallowed the second ask.
    assert.equal(asked, 2, "the second identical call was covered by a denial's grant");
    assert.equal(executions, 0, "a denied call executed");
  });

  // The no-callback branch of `resume`, which nothing drove: eight tests pass
  // an `onApproval` and none omitted it, so `decision = false` could be
  // mutated to `true` and the suite stayed green. That mutant fails *open* —
  // a resume with nobody to ask would run the gated call — which is the one
  // direction this branch must never move (#51 test 6).
  //
  // Both shapes of "no callback" are covered because both reach it
  // differently: `ReplRunner` always passes run options and may leave
  // `onApproval` undefined inside them, while a direct caller can pass none
  // at all.

  it("resume with no run options denies the pending call", async () => {
    // The tool is watched, so "denied" means a call that did not happen
    // rather than a message about one that did.
    const executed: string[] = [];
    const registry = new ToolRegistry([
      {
        ...gatedTool,
        execute: (args) => {
          executed.push(String(args.x));
          return `approved: ${args.x}`;
        },
      },
    ]);
    const session = new Session({ registry });

    await session.run('gated("x")', { onApproval: () => "suspend" });
    const denied = await session.resume();

    err(denied);
    assert.match(denied.error, /PermissionError/);
    assert.deepEqual(executed, [], "a resume with nobody to ask ran the call anyway");
  });

  it("resume with run options but no onApproval denies too", async () => {
    const registry = new ToolRegistry([gatedTool]);
    const session = new Session({ registry });

    await session.run('gated("x")', { onApproval: () => "suspend" });

    // The shape `ReplRunner.resume` produces when the extension has no
    // callback to give it.
    const denied = await session.resume({});
    err(denied);
    assert.match(denied.error, /PermissionError/);
  });

  it("abandon() clears suspended state", async () => {
    const registry = new ToolRegistry([gatedTool]);
    const session = new Session({ registry });

    await session.run('gated("test")', {
      onApproval: () => "suspend",
    });

    assert.equal(session.abandon(), true);

    // After abandon, resume should throw (no suspended state)
    await assert.rejects(async () => {
      await session.resume();
    }, /no suspended execution/i);
  });

  it("abandon() returns false when nothing suspended", async () => {
    const registry = new ToolRegistry();
    const session = new Session({ registry });
    assert.equal(session.abandon(), false);
  });

  it("suspended snippet added on resume, state persists without re-approval", async () => {
    const echo = makeEchoTool();
    const registry = new ToolRegistry([gatedTool, echo]);
    const session = new Session({ registry });

    // Code that sets a variable via echo (non-gated) BEFORE the gate.
    await session.run('prefix = echo("before-gate")\ngated("go")', {
      onApproval: () => "suspend",
    });

    // Resume and approve.
    const r2 = await session.resume({
      onApproval: () => true,
    });
    ok(r2);
    assert.equal(r2.output, "approved: go");

    // Replay WITHOUT onApproval — both echo AND gated are cached now.
    // gated("go") no longer triggers the approval gate on replay.
    const r3 = await session.run("prefix");
    ok(r3);
    assert.equal(r3.output, "before-gate");
  });

  it("onApproval decides suspended call + subsequent calls", async () => {
    // resume() calls onApproval for the suspended call first,
    // then for any subsequent gated calls.
    const gatedTool2: HostTool = {
      name: "gated2",
      description: "Another gated tool",
      params: [{ name: "v", type: "str", description: "Value" }],
      returns: "str",
      requiresApproval: true,
      execute: (args) => `second: ${args.v}`,
    };

    const registry = new ToolRegistry([gatedTool, gatedTool2]);
    const session = new Session({ registry });

    // Suspend on gated("first"); gated2("second") is the last expression
    await session.run('gated("first")\ngated2("second")', { onApproval: () => "suspend" });

    // Resume — onApproval receives suspended call ("gated") first,
    // then "gated2" when execution continues.
    const seen: string[] = [];
    const r2 = await session.resume({
      onApproval: (req) => {
        seen.push(req.tool);
        return true; // approve all
      },
    });
    ok(r2);
    // Both tools were seen
    assert.deepEqual(seen, ["gated", "gated2"]);
    assert.equal(r2.output, "second: second");
  });
});

// ── reset ───────────────────────────────────────────────────────

describe("Session — reset", () => {
  it("clears all snippets and cache", async () => {
    const echo = makeEchoTool();
    const registry = new ToolRegistry([echo]);
    const session = new Session({ registry });

    await session.run("x = 5");
    session.reset();

    // x should not exist anymore
    const r2 = await session.run("x");
    err(r2);
  });

  it("clears suspended state", async () => {
    const gatedTool: HostTool = {
      name: "gated",
      description: "Gated",
      params: [],
      returns: "str",
      requiresApproval: true,
      execute: () => "ok",
    };
    const registry = new ToolRegistry([gatedTool]);
    const session = new Session({ registry });

    await session.run("gated()", { onApproval: () => "suspend" });
    session.reset();

    await assert.rejects(async () => {
      await session.resume();
    }, /no suspended/i);
  });
});

// ── Serialization ───────────────────────────────────────────────

describe("Session — dump / load", () => {
  it("round-trips snippets", async () => {
    const registry = new ToolRegistry();
    const s1 = new Session({ registry });

    await s1.run("x = 42");
    await s1.run("y = x + 1");

    const json = s1.dump();
    const s2 = Session.load(json, { registry });

    const result = await s2.run("y");
    ok(result);
    assert.equal(result.output, "43");
  });

  it("round-trips tool call cache", async () => {
    const counter = makeCounterTool();
    const registry = new ToolRegistry([counter]);
    const s1 = new Session({ registry });

    await s1.run("x = counter()"); // counter → 1

    const json = s1.dump();
    const s2 = Session.load(json, { registry });

    // During replay, counter() from cached snippet is cached → returns "1"
    // New counter() call returns "2"
    const r2 = await s2.run("counter()");
    ok(r2);
    assert.equal(r2.output, "2");
  });

  it("round-trips suspended state", async () => {
    const gatedTool: HostTool = {
      name: "gated",
      description: "Needs approval",
      params: [{ name: "x", type: "str", description: "Value" }],
      returns: "str",
      requiresApproval: true,
      execute: (args) => `got ${args.x}`,
    };
    const registry = new ToolRegistry([gatedTool]);
    const s1 = new Session({ registry });

    await s1.run('gated("data")', { onApproval: () => "suspend" });

    const json = s1.dump();
    const s2 = Session.load(json, { registry });

    // Resume from loaded session
    const result = await s2.resume({
      onApproval: () => true,
    });
    ok(result);
    assert.equal(result.output, "got data");
  });

  it("dump is valid JSON parseable by JSON.parse", async () => {
    const registry = new ToolRegistry();
    const session = new Session({ registry });

    await session.run("x = [1, 2, 3]");
    const json = session.dump();

    const parsed = JSON.parse(json);
    assert.equal(parsed.version, 1);
    assert.ok(Array.isArray(parsed.snippets));
    assert.equal(parsed.snippets[0], "x = [1, 2, 3]");
  });

  it("load preserves empty session", async () => {
    const registry = new ToolRegistry();
    const session = new Session({ registry });
    const json = session.dump();

    const restored = Session.load(json, { registry });
    const result = await restored.run("42");
    ok(result);
    assert.equal(result.output, "42");
  });

  it("load with mismatched version → throws", () => {
    const registry = new ToolRegistry();
    assert.throws(
      () => Session.load(JSON.stringify({ version: 999 }), { registry }),
      /Unsupported session version/,
    );
  });

  it("load with missing version → throws", () => {
    const registry = new ToolRegistry();
    assert.throws(() => Session.load(JSON.stringify({ snippets: [] }), { registry }), /version/i);
  });
});

// ── runOpts passthrough ─────────────────────────────────────────

describe("Session — runOpts passthrough", () => {
  it("passes inputs to sandbox", async () => {
    const registry = new ToolRegistry();
    const session = new Session({ registry });

    const result = await session.run("name", {
      inputs: { name: "Alice" },
    });
    ok(result);
    assert.equal(result.output, "Alice");
  });

  it("passes maxStdoutBytes to sandbox", async () => {
    const registry = new ToolRegistry();
    const session = new Session({ registry });

    const result = await session.run('print("A" * 200)', {
      maxStdoutBytes: 10,
    });
    ok(result);
    assert.equal(result.stdoutTruncated, true);
  });

  it("passes signal (abort) to sandbox", async () => {
    const registry = new ToolRegistry();
    const session = new Session({ registry });

    const controller = new AbortController();
    controller.abort();

    const result = await session.run("1 + 1", {
      signal: controller.signal,
    });
    err(result);
    assert.equal(result.errorKind, "aborted");
  });
});

// ── HostToolError passthrough ───────────────────────────────────

describe("Session — HostToolError passthrough", () => {
  it("tool throwing HostToolError surfaces as Python exception", async () => {
    const fragile: HostTool = {
      name: "fragile",
      description: "Fails",
      params: [],
      returns: "str",
      execute: () => {
        throw new HostToolError("ValueError", "bad input");
      },
    };
    const registry = new ToolRegistry([fragile]);
    const session = new Session({ registry });

    const result = await session.run(
      `
try:
    fragile()
    result = "no-error"
except ValueError as e:
    result = str(e)
result
`,
    );
    ok(result);
    assert.equal(result.output, "bad input");
  });
});

// ── SUBMIT in Session ───────────────────────────────────────────

describe("Session — SUBMIT", () => {
  const rlmOpts = {
    onLLMQuery: async (p: string) => `llm:${p}`,
    onRLMQuery: async (q: string) => `rlm:${q}`,
  };

  function makeRegistry(extraTools: HostTool[] = []): ToolRegistry {
    return new ToolRegistry([...createRLMTools(rlmOpts), ...extraTools]);
  }

  it("SUBMIT terminates the run and returns ok with answer", async () => {
    const registry = makeRegistry();
    const session = new Session({ registry });

    const result = await session.run('SUBMIT("done")');
    ok(result);
    assert.equal(result.output, "done");
  });

  it("SUBMIT snippet is appended to session on success", async () => {
    const registry = makeRegistry();
    const session = new Session({ registry });

    await session.run("x = 42");
    const result = await session.run("SUBMIT(str(x))");
    ok(result);
    assert.equal(result.output, "42");
  });

  it("Session replay with SUBMIT: prior SUBMIT re-executes (not cached)", async () => {
    let llmCalls = 0;
    const opts = {
      onLLMQuery: async (p: string) => {
        llmCalls++;
        return `llm:${p}`;
      },
      onRLMQuery: async (q: string) => `rlm:${q}`,
    };
    const registry = new ToolRegistry([...createRLMTools(opts)]);
    const session = new Session({ registry });

    // Run 1: llm_query then SUBMIT
    const r1 = await session.run('response = llm_query("q1")\nSUBMIT(response)');
    ok(r1);
    assert.equal(r1.output, "llm:q1");
    assert.equal(llmCalls, 1);

    // Run 2: same code — replay executes prior snippets, then re-runs
    // During replay of snippet 1, llm_query is served from cache (no callback).
    // But SUBMIT is NOT in cache — it re-executes and terminates.
    // The new snippet never runs because replay terminates at SUBMIT.
    // Actually: session concatenates all prior snippets + new code.
    // Snippet 1 + Snippet 2 = the same code twice.
    // During replay of snippet 1: llm_query → cache hit, SUBMIT → cache miss → throws → ok.
    // Execution terminates at SUBMIT, new snippet (snippet 2 copy) never runs.
    const r2 = await session.run('response = llm_query("q2")\nSUBMIT(response)');
    ok(r2);
    // Output comes from snippet 1's SUBMIT (replayed), which had answer "llm:q1"
    assert.equal(r2.output, "llm:q1");
    // llm_query in snippet 1 was served from cache, so llmCalls stays 1
    assert.equal(llmCalls, 1);
  });

  it("SUBMIT after tool call captures both in calls", async () => {
    const echo: HostTool = {
      name: "echo",
      description: "echo",
      params: [{ name: "text", type: "str", description: "" }],
      returns: "str",
      execute: (args) => String(args.text),
    };
    const registry = makeRegistry([echo]);
    const session = new Session({ registry });

    const result = await session.run('x = echo("hi")\nSUBMIT(x)');
    ok(result);
    assert.equal(result.output, "hi");
    // Both calls should appear
    const echoCalls = result.calls.filter((c) => c.tool === "echo");
    const submitCalls = result.calls.filter((c) => c.tool === "SUBMIT");
    assert.equal(echoCalls.length, 1);
    assert.equal(submitCalls.length, 1);
    assert.equal(submitCalls[0].ok, true);
  });

  it("Session dump/load preserves SUBMIT-less state", async () => {
    const registry = makeRegistry();
    const session = new Session({ registry });

    // Run a snippet that doesn't SUBMIT
    await session.run("x = 99");
    const dump = session.dump();

    const restored = Session.load(dump, { registry });
    const result = await restored.run("SUBMIT(str(x))");
    ok(result);
    assert.equal(result.output, "99");
  });

  it("SUBMIT with llm_query in same run", async () => {
    const registry = makeRegistry();
    const session = new Session({ registry });

    const result = await session.run('answer = llm_query("what is 2+2?")\nSUBMIT(answer)');
    ok(result);
    assert.equal(result.output, "llm:what is 2+2?");
  });

  it("SUBMIT error (syntax error before SUBMIT) does not append snippet", async () => {
    const registry = makeRegistry();
    const session = new Session({ registry });

    const result = await session.run('invalid syntax!!!\nSUBMIT("never")');
    const err = result as RunError;
    assert.equal(err.status, "error");
    assert.equal(err.errorKind, "syntax");

    // Session should be empty — snippet was not appended
    const dump = JSON.parse(session.dump());
    assert.equal(dump.snippets.length, 0);
  });
});

// ── Approval grants (#44) ───────────────────────────────────────

/**
 * One approval used to mean unlimited silent re-execution: the gate matched a
 * position-independent `Set` of every key ever executed, so approving
 * `bash("date")` once bought every later `bash("date")` in the session, with
 * no ceiling and no expiry.
 *
 * What replaces it: a call is auto-approved only when it is the *replay* of
 * one already executed — which runs nothing — or when a grant from an approval
 * given earlier in the same call has uses left. `DEFAULT_GRANT_USES` is 1, so
 * in the shipped configuration the second branch never fires and every
 * execution is approved on its own.
 *
 * These are the six tests #44 asks for. Test 4 is the one protecting the fix
 * from itself.
 */
describe("Session — approval grants are scoped and counted (#44)", () => {
  /** A gated tool that counts what it actually ran, not what it was asked. */
  function makeGatedCounter(name = "gated") {
    let executions = 0;
    const tool: HostTool = {
      name,
      description: "Gated; counts real executions",
      params: [{ name: "v", type: "str", description: "Value" }],
      returns: "str",
      requiresApproval: true,
      execute: (args) => `${name}:${args.v}:${++executions}`,
    };
    return { tool, executions: () => executions };
  }

  it("1 — the measured loop prompts on every new execution", async () => {
    // #44's reproduction, in the shape it was measured: approve the call once,
    // then run it three more times from a *later* call. That measured 0
    // prompts and 3 real executions.
    const { tool, executions } = makeGatedCounter();
    const session = new Session({ registry: new ToolRegistry([tool]) });

    const prompts: string[] = [];
    const onApproval = (req: ApprovalRequest) => {
      prompts.push(req.tool);
      return true;
    };

    ok(await session.run('gated("x")', { onApproval }));
    assert.equal(prompts.length, 1);

    const loop = await session.run('[gated("x") for _ in range(3)]', { onApproval });
    ok(loop);

    assert.equal(executions(), 4, "all three iterations must really run");
    assert.equal(prompts.length, 4, "3 executions must not cost 1 prompt — or 0");
  });

  it("1b — and identical executions within one call are not free either", async () => {
    const { tool, executions } = makeGatedCounter();
    const session = new Session({ registry: new ToolRegistry([tool]) });

    const prompts: string[] = [];
    const result = await session.run('[gated("x") for _ in range(3)]', {
      onApproval: (req) => {
        prompts.push(req.tool);
        return true;
      },
    });

    ok(result);
    assert.equal(executions(), 3, "all three iterations must really run");
    assert.equal(prompts.length, 3, "and each must have been approved on its own");
  });

  it("2 — a grant does not survive into the next repl call", async () => {
    const { tool, executions } = makeGatedCounter();
    const session = new Session({ registry: new ToolRegistry([tool]) });

    const prompts: string[] = [];
    const onApproval = (req: ApprovalRequest) => {
      prompts.push(req.tool);
      return true;
    };

    ok(await session.run('gated("x")', { onApproval }));
    assert.equal(prompts.length, 1);

    // Same tool, same arguments, new call. The replayed copy of the first
    // snippet is served from the cache silently; the *new* execution asks.
    ok(await session.run('gated("x")', { onApproval }));
    assert.equal(prompts.length, 2, "the second call must ask again");
    assert.equal(executions(), 2, "and must have executed exactly once more");
  });

  it("3 — the use count is enforced: the N+1th execution re-prompts", async () => {
    const { tool, executions } = makeGatedCounter();
    const session = new Session({ registry: new ToolRegistry([tool]) }, undefined, {
      grantUses: 2,
    });

    const prompts: string[] = [];
    const result = await session.run('[gated("x") for _ in range(3)]', {
      onApproval: (req) => {
        prompts.push(req.tool);
        return true;
      },
    });

    ok(result);
    assert.equal(executions(), 3);
    // Approve → runs, and covers one more. The third exhausts the grant.
    assert.equal(prompts.length, 2, "one approval covers exactly two executions at grantUses: 2");
  });

  it("3b — grantUses below 1 is refused, not clamped", () => {
    const { tool } = makeGatedCounter();
    const opts = { registry: new ToolRegistry([tool]) };
    assert.throws(() => new Session(opts, undefined, { grantUses: 0 }), RangeError);
    assert.throws(() => new Session(opts, undefined, { grantUses: 1.5 }), RangeError);
  });

  it("4 — a genuine positional replay auto-approves, with no callback and no re-execution", async () => {
    const { tool, executions } = makeGatedCounter();
    const session = new Session({ registry: new ToolRegistry([tool]) });

    const first = await session.run('v = gated("x")', { onApproval: () => true });
    ok(first);
    assert.equal(executions(), 1);

    // No onApproval at all. The replay must not ask — and must not run.
    const second = await session.run("v");
    ok(second);
    assert.equal(second.output, "gated:x:1", "the replayed value came from the cache");
    assert.equal(executions(), 1, "replay must not re-execute the tool");
  });

  it("5 — no callback still denies, and nothing executes", async () => {
    const { tool, executions } = makeGatedCounter();
    const session = new Session({ registry: new ToolRegistry([tool]) });

    const result = await session.run('gated("x")');
    err(result);
    assert.match(result.error, /PermissionError/);
    assert.equal(executions(), 0);
  });

  it("6 — outstanding grants are reported, and reset revokes them", async () => {
    const first = makeGatedCounter("gated");
    const second = makeGatedCounter("gated2");
    const session = new Session(
      { registry: new ToolRegistry([first.tool, second.tool]) },
      undefined,
      { grantUses: 2 },
    );

    // Suspend on the first call; approve it on resume, which leaves a grant
    // with one use left; then suspend again on the second tool. A grant is
    // outstanding only while a call is paused like this.
    suspended(await session.run('gated("a")\ngated2("b")', { onApproval: () => "suspend" }));
    suspended(
      await session.resume({
        onApproval: (req) => (req.tool === "gated" ? true : "suspend"),
      }),
    );

    assert.deepEqual(session.outstandingGrants(), [{ tool: "gated", remaining: 1 }]);

    // reset() hands back what it revoked, and leaves nothing behind.
    assert.deepEqual(session.reset(), [{ tool: "gated", remaining: 1 }]);
    assert.deepEqual(session.outstandingGrants(), []);
  });

  it("a completed call leaves no grant behind", async () => {
    const { tool } = makeGatedCounter();
    const session = new Session({ registry: new ToolRegistry([tool]) }, undefined, {
      grantUses: 5,
    });

    ok(await session.run('gated("x")', { onApproval: () => true }));
    assert.deepEqual(session.outstandingGrants(), [], "grants die with the call that made them");
  });

  it("abandoning a suspension revokes its grants", async () => {
    const first = makeGatedCounter("gated");
    const second = makeGatedCounter("gated2");
    const session = new Session(
      { registry: new ToolRegistry([first.tool, second.tool]) },
      undefined,
      { grantUses: 2 },
    );

    suspended(await session.run('gated("a")\ngated2("b")', { onApproval: () => "suspend" }));
    suspended(
      await session.resume({ onApproval: (req) => (req.tool === "gated" ? true : "suspend") }),
    );
    assert.equal(session.outstandingGrants().length, 1);

    assert.equal(session.abandon(), true);
    assert.deepEqual(session.outstandingGrants(), []);
  });
});

// ── A suspension does not outlive its call (#129) ────────────────

/**
 * #129: `run` used to leave `this.suspended` alone, so a suspension survived
 * any number of later calls and `resume()` then pushed its snippet *after*
 * newer ones. The measured consequence was a session that silently rewound —
 * `v` went back to 1 after being set to 2 — while a side effect from the
 * abandoned code reached the disk.
 *
 * The fix abandons rather than refuses: deferring means "not now", and a new
 * `run` is the caller moving on. What makes that honest instead of silent is
 * the notice on the result, so it is tested as hard as the discard itself.
 */
describe("Session — a suspension does not outlive its call (#129)", () => {
  /** A gated tool that counts what it actually ran. */
  function makeGatedCounter(name = "gated") {
    let executions = 0;
    const tool: HostTool = {
      name,
      description: "Gated; counts real executions",
      params: [{ name: "v", type: "str", description: "Value" }],
      returns: "str",
      requiresApproval: true,
      execute: (args) => `${name}:${args.v}:${++executions}`,
    };
    return { tool, executions: () => executions };
  }

  it("the session does not rewind: snippets stay in execution order", async () => {
    // #129's reproduction. `v = 1` belongs to code the caller moved past; it
    // must not replay after `v = 2`.
    const { tool } = makeGatedCounter();
    const session = new Session({ registry: new ToolRegistry([tool]) });

    suspended(await session.run("v = 1\ngated(str(v))", { onApproval: () => "suspend" }));

    const moved = await session.run("v = 2\nv", { onApproval: () => "suspend" });
    ok(moved);
    assert.equal(moved.output, "2");

    const after = await session.run("v");
    ok(after);
    assert.equal(after.output, "2", "v rewound to 1 — the suspended snippet replayed last");
  });

  it("the stale call never executes, and cannot be resumed", async () => {
    const { tool, executions } = makeGatedCounter();
    const session = new Session({ registry: new ToolRegistry([tool]) });

    suspended(await session.run('gated("stale")', { onApproval: () => "suspend" }));
    ok(await session.run("1 + 1"));

    assert.equal(session.isSuspended(), false);
    await assert.rejects(async () => {
      await session.resume({ onApproval: () => true });
    }, /no suspended execution/i);
    assert.equal(executions(), 0, "the abandoned call reached the tool");
  });

  it("says what it dropped, naming the call the dialog showed", async () => {
    const { tool } = makeGatedCounter();
    const session = new Session({ registry: new ToolRegistry([tool]) });

    const pending = await session.run('gated("x")', { onApproval: () => "suspend" });
    suspended(pending);

    const next = await session.run("1 + 1");
    ok(next);
    assert.equal(next.discardedSuspension?.tool, "gated");
    assert.equal(next.discardedSuspension?.description, pending.suspendedCall.description);
  });

  it("carries the notice on an errored run too — the discard happened either way", async () => {
    const { tool } = makeGatedCounter();
    const session = new Session({ registry: new ToolRegistry([tool]) });

    suspended(await session.run('gated("x")', { onApproval: () => "suspend" }));

    const broken = await session.run("raise ValueError('boom')");
    err(broken);
    assert.equal(broken.discardedSuspension?.tool, "gated");
  });

  it("a run that suspends again reports the old discard, and stores a clean suspension", async () => {
    const first = makeGatedCounter("gated");
    const second = makeGatedCounter("gated2");
    const session = new Session({ registry: new ToolRegistry([first.tool, second.tool]) });

    suspended(await session.run('gated("old")', { onApproval: () => "suspend" }));

    const again = await session.run('gated2("new")', { onApproval: () => "suspend" });
    suspended(again);
    assert.equal(again.discardedSuspension?.tool, "gated", "the old discard is not reported");
    assert.equal(again.suspendedCall.tool, "gated2", "the new suspension is the pending one");

    // The stored state describes itself, not the call before it.
    const resumed = await session.resume({ onApproval: () => true });
    ok(resumed);
    assert.equal(resumed.output, "gated2:new:1");
    assert.equal(resumed.discardedSuspension, undefined, "the notice leaked into the resume");
    assert.equal(first.executions(), 0, "the discarded call ran on resume");
  });

  it("adds nothing when there was no suspension to discard", async () => {
    const session = new Session({ registry: new ToolRegistry() });

    const clean = await session.run("1 + 1");
    ok(clean);
    assert.equal(clean.discardedSuspension, undefined);
  });

  it("revokes the grants the discarded suspension was holding", async () => {
    const first = makeGatedCounter("gated");
    const second = makeGatedCounter("gated2");
    const session = new Session(
      { registry: new ToolRegistry([first.tool, second.tool]) },
      undefined,
      { grantUses: 2 },
    );

    suspended(await session.run('gated("a")\ngated2("b")', { onApproval: () => "suspend" }));
    suspended(
      await session.resume({ onApproval: (req) => (req.tool === "gated" ? true : "suspend") }),
    );
    assert.equal(session.outstandingGrants().length, 1, "precondition: a grant is live");

    ok(await session.run("1 + 1"));
    assert.deepEqual(session.outstandingGrants(), [], "a grant outlived the call it belonged to");
  });
});
