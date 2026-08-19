import { after, before, describe, it } from "node:test";
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

// ── lineOffset wiring: preamble + prior snippets are the prefix (#77) ──
//
// `Session.run` assembles preamble + prior snippets + new code, so the
// sandbox numbers every diagnostic from the top of the assembled transcript.
// The session must tell the sandbox how many lines it prepended
// (`RunOptions.lineOffset`), computed from the parts actually assembled — a
// diagnostic on line K of the latest snippet is reported as line K, and
// neither preamble nor earlier-snippet source ever reaches the caller
// (issue test 3).

describe("Session — lineOffset wiring (#77 issue test 3)", () => {
  // Unique marker tokens, one in the preamble and one in the prior snippet:
  // a diagnostic that leaks prefix source will contain one of them. Distinct
  // from each other so a leak is attributable to the part that leaked.
  const PREAMBLE_MARKER = "PREAMBLE_MARKER_77";
  const PRIOR_MARKER = "PRIOR_SNIPPET_MARKER_77";

  // 3 lines. The marker line sits directly above the stacked snippets in the
  // assembled transcript, so it is the first thing an excerpt leaks.
  const preamble = [
    "# session preamble",
    `${PREAMBLE_MARKER} = "preamble source must never reach the caller"`,
    "pre_offset = 1",
  ].join("\n");

  /** A session whose preamble + one prior snippet stack 5 prefix lines. */
  async function sessionWithStack(): Promise<Session> {
    const session = new Session({ registry: new ToolRegistry() }, preamble);
    // 2 lines; succeeds, so it stacks into every later run's prefix.
    ok(await session.run(`first = 1\n${PRIOR_MARKER} = "prior"`));
    return session;
  }

  it("reports a syntax error on line K of the latest snippet as line K (issue test 3)", async () => {
    const session = await sessionWithStack();

    // Latest snippet: syntax error on its own line 2 — assembled line 7.
    const result = await session.run("ok = 1\n1 +");
    err(result);
    assert.equal(result.errorKind, "syntax");
    assert.match(
      result.error,
      / --> <repl>:2:/,
      "the diagnostic location is line 2 of the latest snippet, not the assembled line 7",
    );
    assert.match(result.error, /^2 \| 1 \+$/m, "the excerpt line is the latest snippet's line 2");
    assert.doesNotMatch(result.error, new RegExp(PREAMBLE_MARKER), "preamble source leaked");
    assert.doesNotMatch(result.error, new RegExp(PRIOR_MARKER), "prior-snippet source leaked");
  });

  it("reports a runtime error on line K of the latest snippet as line K", async () => {
    const session = await sessionWithStack();

    // Latest snippet: raise on its own line 2 — assembled line 7.
    const result = await session.run('ok = 1\nraise ValueError("boom")');
    err(result);
    assert.equal(result.errorKind, "runtime");
    assert.match(result.error, /^ValueError: boom$/m, "the <type>: msg heading is preserved");
    assert.match(
      result.error,
      /File "<python-input-0>", line 2, in <module>/,
      "the raising frame is line 2 of the latest snippet",
    );
    assert.ok(
      result.error.includes('raise ValueError("boom")'),
      "the surviving frame keeps its source preview",
    );
    assert.doesNotMatch(result.error, new RegExp(PREAMBLE_MARKER), "preamble source leaked");
    assert.doesNotMatch(result.error, new RegExp(PRIOR_MARKER), "prior-snippet source leaked");
  });
});

// ── lineOffset through suspension and resume (#77) ──────────────
//
// `runInSandbox` corrects diagnostics on the resume paths too — the dispatch
// loop and `resumeInSession` pass `runOpts.lineOffset` into
// `classifyResumeError` at every resume. The session owns the offset
// (`Session.run` computes it), so a resumed run whose remaining code raises
// must get the same correction: user-relative line numbers, no preamble or
// prior-snippet source. The resumed transcript is the same one `run()`
// assembled (preamble + prior snippets + the suspended snippet), so
// `Session.resume` must pass the offset `run()` would have computed.

describe("Session — lineOffset through the suspended-resume path (#77)", () => {
  // Unique markers, distinct from the issue-test ones above so a leak is
  // attributable to this describe's parts.
  const PREAMBLE_MARKER = "RESUME_PREAMBLE_MARKER_77";
  const PRIOR_MARKER = "RESUME_PRIOR_SNIPPET_MARKER_77";

  // 3 lines — the same stack shape as the issue test above.
  const preamble = [
    "# resume-path preamble",
    `${PREAMBLE_MARKER} = "preamble source must never reach the caller"`,
    "pre_offset = 1",
  ].join("\n");

  const gated: HostTool = {
    name: "gated_resume",
    description: "Needs approval",
    params: [{ name: "x", type: "str", description: "Value" }],
    returns: "str",
    requiresApproval: true,
    execute: (args) => `approved: ${args.x}`,
  };

  it("reports a runtime error raised after resume at the latest snippet's line", async () => {
    const session = new Session({ registry: new ToolRegistry([gated]) }, preamble);
    // 2 lines; succeeds, so it stacks into the prefix of the suspended run.
    ok(await session.run(`first = 1\n${PRIOR_MARKER} = "prior"`));

    // Latest snippet: the gated call on line 1 suspends; line 2 raises once
    // the resume approves it. Assembled position: line 7 (3 preamble + 2
    // prior + 2 own).
    suspended(await session.run('gated_resume("x")\ny = 1 / 0', { onApproval: () => "suspend" }));

    const result = await session.resume({ onApproval: () => true });
    err(result);
    assert.equal(result.errorKind, "runtime");
    assert.match(
      result.error,
      /^ZeroDivisionError: division by zero$/m,
      "the <type>: msg heading is preserved",
    );
    assert.match(
      result.error,
      /File "<python-input-0>", line 2, in <module>/,
      "the raising frame is line 2 of the latest snippet, not the assembled line 7",
    );
    assert.ok(result.error.includes("y = 1 / 0"), "the surviving frame keeps its source preview");
    assert.doesNotMatch(result.error, new RegExp(PREAMBLE_MARKER), "preamble source leaked");
    assert.doesNotMatch(result.error, new RegExp(PRIOR_MARKER), "prior-snippet source leaked");
  });
});

// ── prefixLineCount is incrementally maintained (#145 D28) ─────────
//
// `Session.prefixLineCount` used to re-split the preamble and every prior
// snippet on each `run()`/`resume()`, so a session's N runs cost O(n²)
// split calls. #145 item 8 replaces that with a running total maintained on
// append/reset/load. This test observes the split-call count on the strings
// the session owns: the O(n²) version grows quadratically with N, the
// incremental one stays linear (bounded by a small multiple of N).

describe("Session — prefixLineCount is incrementally maintained (#145 D28)", () => {
  it("does not re-split every prior snippet on each run", async () => {
    const preamble = "# preamble\n# second preamble line";
    const session = new Session({ registry: new ToolRegistry() }, preamble);

    // The strings `prefixLineCount` splits are exactly the ones we own here:
    // the preamble and each code string handed to `run()`. Watching them by
    // reference counts *its* splits without noise from the sandbox, which
    // only ever sees the joined transcript (a different string).
    const watched = new Set<string>([preamble]);

    const N = 60;
    const codes: string[] = [];
    for (let i = 0; i < N; i++) {
      const code = `x${i} = ${i}`;
      codes.push(code);
      watched.add(code);
    }

    const originalSplit = String.prototype.split as unknown as (...args: unknown[]) => string[];
    let splitCount = 0;
    String.prototype.split = function (this: string, ...args: unknown[]): string[] {
      if (watched.has(this)) splitCount += 1;
      return originalSplit.apply(this, args);
    };

    try {
      for (const code of codes) {
        ok(await session.run(code));
      }
    } finally {
      String.prototype.split = originalSplit;
    }

    // Linear: at most a small constant multiple of N. The O(n²) version
    // performs N(N+1)/2 splits on these strings (1830 for N=60).
    assert.ok(
      splitCount <= 3 * N,
      `expected split calls to stay linear, got ${splitCount} for ${N} runs`,
    );
  });
});

// ── prefixLineTotal counter-site pins (#145 D28 guards) ─────────
//
// Three of the five `prefixLineTotal` update sites produce a count no test
// reads as a line number: the `resume()` ok-branch append, the `reset()`
// re-seed, and the `load()` accumulation. Each is correct by inspection, but
// a mutation that neuters one (`+=` → `=`, or a dropped re-seed/accumulation)
// leaves the suite green because every existing round-trip test asserts only
// output strings. These guards drive each site through a *subsequent
// erroring run* and assert the offset the running total yields: a syntax
// error on line 2 of the latest snippet must be reported as line 2, never
// the assembled line. Guards — GREEN immediately.

describe("Session — prefixLineTotal counter-site pins (#145 D28 guards)", () => {
  // 3 lines — every test below stacks snippets on top of this preamble.
  const preamble = ["# pin preamble", "pin_offset = 1", "pin_offset += 1"].join("\n");

  it("(a) resume()'s ok-branch append feeds the next run's lineOffset", async () => {
    const gated: HostTool = {
      name: "gated_pin_resume",
      description: "Needs approval",
      params: [{ name: "x", type: "str", description: "Value" }],
      returns: "str",
      requiresApproval: true,
      execute: (args) => `approved: ${args.x}`,
    };
    const session = new Session({ registry: new ToolRegistry([gated]) }, preamble);

    // 2 prior lines stack into the prefix (total 5).
    ok(await session.run("first = 1\nsecond = 2"));

    // A 2-line snippet suspends on line 1; approving resumes and appends it
    // (total 7). If resume's append is neutered to `=`, the total becomes 2.
    suspended(
      await session.run('gated_pin_resume("x")\nresumed = 1', { onApproval: () => "suspend" }),
    );
    ok(await session.resume({ onApproval: () => true }));

    // Subsequent erroring run: the syntax error is on line 2 of the latest
    // snippet — assembled line 3 + 2 + 2 + 2 = 9, so lineOffset must be 7.
    const result = await session.run("ok = 1\n1 +");
    err(result);
    assert.equal(result.errorKind, "syntax");
    assert.match(result.error, / --> <repl>:2:/);
    assert.match(result.error, /^2 \| 1 \+$/m);
  });

  it("(b) reset() re-seeds the count from the preamble", async () => {
    const session = new Session({ registry: new ToolRegistry() }, preamble);

    // Stack a 2-line snippet so the total (5) no longer equals the preamble (3).
    ok(await session.run("first = 1\nsecond = 2"));

    session.reset();

    // After reset only the preamble (3 lines) is the prefix. The syntax error
    // is on line 2 of the latest snippet — assembled line 3 + 2 = 5, so
    // lineOffset must be 3, not the pre-reset 5 nor a neutered 0.
    const result = await session.run("ok = 1\n1 +");
    err(result);
    assert.equal(result.errorKind, "syntax");
    assert.match(result.error, / --> <repl>:2:/);
    assert.match(result.error, /^2 \| 1 \+$/m);
  });

  it("(c) load() accumulates restored snippet lines into the count", async () => {
    const s1 = new Session({ registry: new ToolRegistry() }, preamble);
    ok(await s1.run("first = 1\nsecond = 2")); // 2 lines → total 5
    ok(await s1.run("third = 3\nfourth = 4")); // 2 lines → total 7

    const restored = Session.load(s1.dump(), { registry: new ToolRegistry() }, preamble);

    // The restored prefix is preamble (3) + two 2-line snippets (4) = 7. The
    // syntax error is on line 2 of the latest snippet — assembled line 9.
    const result = await restored.run("ok = 1\n1 +");
    err(result);
    assert.equal(result.errorKind, "syntax");
    assert.match(result.error, / --> <repl>:2:/);
    assert.match(result.error, /^2 \| 1 \+$/m);
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

// ── a resumed run honours the suspended run's limits (#177) ─────────
//
// `Session.run` persists the raw `RunOptions` granted to a `repl` call into
// `suspendedRunOpts` (src/session.ts:366), so the clamped limits the caller
// was given survive the suspension. `Session.resume` re-affirms them via the
// one merge field `limits: runOpts?.limits ?? this.suspendedRunOpts?.limits`
// (D1, D4).

describe("Session — a resumed run honours the suspended run's limits (#177)", () => {
  // The invariant is preserved by Monty's snapshot restore at the sandbox layer and
  // re-affirmed by `Session.resume` forwarding `suspendedRunOpts.limits`; the tests guard
  // the acceptance invariant, the one-line fix being library-layer hardening (maxWallClockSecs + #84 seam).
  const MIB = 1_048_576;

  const gatedTool: HostTool = {
    name: "gated_limits",
    description: "Needs approval",
    params: [{ name: "x", type: "str", description: "Value" }],
    returns: "str",
    requiresApproval: true,
    execute: (args) => `approved: ${args.x}`,
  };

  // Hermetic default-ceiling tests (D6): an ambient REPL_* var in the outer
  // `npm test` process must not turn the 512 MiB default into a different
  // figure. Snapshot and clear both vars for the block, restore after.
  let priorDuration: string | undefined;
  let priorMemory: string | undefined;

  before(() => {
    priorDuration = process.env.REPL_MAX_DURATION_SECS;
    priorMemory = process.env.REPL_MAX_MEMORY_MB;
    delete process.env.REPL_MAX_DURATION_SECS;
    delete process.env.REPL_MAX_MEMORY_MB;
  });

  after(() => {
    if (priorDuration === undefined) delete process.env.REPL_MAX_DURATION_SECS;
    else process.env.REPL_MAX_DURATION_SECS = priorDuration;
    if (priorMemory === undefined) delete process.env.REPL_MAX_MEMORY_MB;
    else process.env.REPL_MAX_MEMORY_MB = priorMemory;
  });

  it("resumed run honours the suspended below-default maxMemory ceiling", async () => {
    const registry = new ToolRegistry([gatedTool]);
    const session = new Session({ registry });

    // The gated call suspends before the 128 MiB allocation runs. Resuming
    // with no limits must still enforce the 32 MiB ceiling the original call
    // was granted — not the 512 MiB `limitsConfig()` default. (`bytes`, not
    // `bytearray`: the latter is not a builtin in this sandbox.)
    suspended(
      await session.run('gated_limits("x")\nbig = bytes(128 * 1024 * 1024)', {
        onApproval: () => "suspend",
        limits: { maxMemory: 32 * MIB },
      }),
    );

    const result = await session.resume({ onApproval: () => true });
    err(result);
    assert.equal(result.errorKind, "memory");
  });

  it("a tightened REPL_MAX_MEMORY_MB survives into resume (D5/D6)", async () => {
    const registry = new ToolRegistry([gatedTool]);
    const session = new Session({ registry });

    // The operator tightened the ceiling to 256 MiB; the run is granted that
    // clamped value and suspends on the gated call. Deleting the env var
    // before resume is the point: the unfixed resume re-reads `limitsConfig()`
    // and gets 512 MiB, so the 320 MiB allocation succeeds. The fixed resume
    // re-applies the persisted 256 MiB and the allocation fails.
    process.env.REPL_MAX_MEMORY_MB = "256";
    suspended(
      await session.run('gated_limits("x")\nbig = bytes(320 * 1024 * 1024)', {
        onApproval: () => "suspend",
        limits: { maxMemory: 256 * MIB },
      }),
    );
    delete process.env.REPL_MAX_MEMORY_MB;

    const result = await session.resume({ onApproval: () => true });
    err(result);
    assert.equal(result.errorKind, "memory");
  });
});

// ── a resumed run honours the suspended host wall-clock budget (#177) ──
//
// The memory tests above are preserved by Monty's snapshot restore; the
// `Session.resume` merge field `limits: runOpts?.limits ?? this.suspendedRunOpts?.limits`
// (D1, D4) has one observable effect left: the host-side `maxWallClockSecs`
// knob, which Monty does not snapshot. It is enforced by `withHostDeadline`
// (src/sandbox.ts) as a wall-clock budget over the whole run, host-tool time
// included — so a host tool that parks the host long past the budget trips
// `"timeout"`, while one inside the default 300 s finishes `"ok"`.

describe("Session — a resumed run honours the suspended host wall-clock budget (#177)", () => {
  // A gated tool: suspends before the expensive continuation runs.
  const gated: HostTool = {
    name: "gated_wallclock",
    description: "Needs approval",
    params: [{ name: "x", type: "str", description: "Value" }],
    returns: "str",
    requiresApproval: true,
    execute: (args) => `approved: ${args.x}`,
  };

  // A host tool that blocks the host for five seconds. It is host time, not
  // interpreter compute: Monty's `maxDurationSecs` clock does not advance while
  // the worker awaits it, so only `maxWallClockSecs` (via `withHostDeadline`)
  // can bound it.
  const blocker: HostTool = {
    name: "block_5s",
    description: "Blocks the host event loop for five seconds",
    params: [],
    returns: "str",
    execute: () => new Promise((resolve) => setTimeout(() => resolve("unblocked"), 5_000)),
  };

  it("a resumed run honours the suspended host wall-clock budget (#177)", async () => {
    const registry = new ToolRegistry([gated, blocker]);
    const session = new Session({ registry });

    // The gated call suspends before the 5 s block runs. The original call was
    // granted a 2 s host wall-clock budget; resuming with no limits must still
    // enforce it, so the 5 s block overruns and the host deadline returns
    // "timeout" — not "ok" under the 300 s default (which is what the unfixed
    // resume sees).
    suspended(
      await session.run('gated_wallclock("x")\nblock_5s()', {
        onApproval: () => "suspend",
        limits: { maxWallClockSecs: 2 },
      }),
    );

    const result = await session.resume({ onApproval: () => true });
    err(result);
    assert.equal(result.errorKind, "timeout");
  });

  it("an explicit maxWallClockSecs on resume wins over the suspended value (#177 D4)", async () => {
    // A precedence pin, not the merge: `resume` spreads `...runOpts`, so the
    // explicit `{ maxWallClockSecs: 2 }` is forwarded whether or not the
    // `limits` merge field exists. This test is green with AND without the fix;
    // it pins the D4 contract that an explicit 2 s outranks the suspended 300 s.
    const registry = new ToolRegistry([gated, blocker]);
    const session = new Session({ registry });

    suspended(
      await session.run('gated_wallclock("x")\nblock_5s()', {
        onApproval: () => "suspend",
        limits: { maxWallClockSecs: 300 },
      }),
    );

    const result = await session.resume({
      onApproval: () => true,
      limits: { maxWallClockSecs: 2 },
    });
    err(result);
    assert.equal(result.errorKind, "timeout");
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
