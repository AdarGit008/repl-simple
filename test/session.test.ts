import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Session } from "../src/session.js";
import { ToolRegistry } from "../src/registry.js";
import { HostToolError } from "../src/types.js";
import { createRLMTools } from "../src/rlm_tools.js";
import { REDACTED } from "../src/redact.js";
import { withPatchedPrototype } from "./support/prototype-patch.js";
import type { ApprovalRequest, HostTool, RunOk, RunError, RunSuspended } from "../src/types.js";

// ── Helpers ─────────────────────────────────────────────────────

// The replay caps and the dump bound, as docs/session-replay.md states them
// (#62 A17, #63). Spelled here rather than imported so this file still loads
// against a `src/` that predates them and every test below fails on its own
// — the numbers are part of the contract, and a drift is a failing test.
const MAX_SNIPPETS = 256;
const MAX_CACHE_ENTRIES = 1024;
const MAX_DUMP_BYTES = 1_048_576;

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

  it("print output is this call's, not the transcript's (#61)", async () => {
    const registry = new ToolRegistry();
    const session = new Session({ registry });

    const r1 = await session.run('print("hello")');
    ok(r1);
    assert.equal(r1.stdout, "hello\n");

    const r2 = await session.run('print("world")');
    ok(r2);
    // Replay re-executes the first print, but its output belongs to the
    // first call and is dropped at the byte mark (D121).
    assert.equal(r2.stdout, "world\n");
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
    const countingSplit = function (this: string, ...args: unknown[]): string[] {
      if (watched.has(this)) splitCount += 1;
      return originalSplit.apply(this, args);
    } as unknown as typeof String.prototype.split;

    // The shared helper (#178) restores the prototype in `finally`, and its
    // sequential assumption holds: `node:test` runs this file's tests one at
    // a time, so nothing else observes the patched method while we await.
    await withPatchedPrototype(String.prototype, "split", countingSplit, async () => {
      for (const code of codes) {
        ok(await session.run(code));
      }
    });

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
    // clamped value and suspends on the gated call. Deleting the env var before
    // resume proves the grant survives independent of `limitsConfig()`: Monty's
    // snapshot restore preserves the granted memory ceiling across the
    // suspend/resume boundary. This is an acceptance test of an invariant Monty
    // already guarantees, not a discriminator of the `Session.resume` merge.
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

  it("a nested re-suspension still honours the suspended host wall-clock budget (#177)", async () => {
    const registry = new ToolRegistry([gated, blocker]);
    const session = new Session({ registry });

    // Two gates in a row: the first suspends on `run`; the first `resume`
    // approves it and immediately re-suspends on the second. Only the second
    // `resume` reaches the 5 s block, so the 2 s host wall-clock budget must
    // survive the nested re-suspension — the re-suspend branch re-persists the
    // merged limits (src/session.ts). If it stored the raw caller runOpts, the
    // second resume would read the 300 s default and the block would finish
    // "ok".
    suspended(
      await session.run('gated_wallclock("a")\ngated_wallclock("b")\nblock_5s()', {
        onApproval: () => "suspend",
        limits: { maxWallClockSecs: 2 },
      }),
    );

    // Approve gate A, but answer gate B with "suspend" so the run pauses again
    // instead of proceeding straight to the block. The gate re-consults
    // `onApproval` for every gated call, so a plain `() => true` would approve
    // B too and skip the re-suspension.
    suspended(
      await session.resume({
        onApproval: (req) => (req.args[0] === "b" ? "suspend" : true),
      }),
    );

    const result = await session.resume({ onApproval: () => true });
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
    assert.equal(parsed.version, 2);
    assert.ok(Array.isArray(parsed.snippets));
    assert.equal(parsed.snippets[0], "x = [1, 2, 3]");
    // The stdout mark rides beside the snippets, one figure each (D121).
    assert.deepEqual(parsed.stdoutBytes, [0]);
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

// ── resume carries what it was suspended with (#84, #38) ─────────
//
// `Session.run` stores the options a run suspended with. `Session.resume` read
// back only `limits` (#177) and spread the caller's fresh options for the
// rest, so a resume through `ReplRunner` — which passes `{ onApproval, signal,
// limits }` and nothing more — ran without the mount and the byte caps the
// suspended run was given. `resumeSuspended` reads `mount`, `maxStdoutBytes`
// and `maxOutputBytes` from what it is handed, so each is asserted by its
// effect after the resume, never by inspecting a field. The rule is
// caller-wins: `caller ?? suspended` (D74, matching #177 D4).

describe("Session — resume carries what it was suspended with (#84, #38)", () => {
  const gated: HostTool = {
    name: "gated_carry",
    description: "Needs approval",
    params: [{ name: "x", type: "str", description: "Value" }],
    returns: "str",
    requiresApproval: true,
    execute: (args) => `approved: ${args.x}`,
  };

  /** A temp dir holding one known file, cleaned up by the caller. */
  function mountFixture(content = "MOUNTED\n"): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "session-mount-"));
    writeFileSync(join(dir, "note.txt"), content);
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  const size = (s: string) => Buffer.byteLength(s, "utf8");

  it("a mounted file is readable after a suspend/approve/resume round trip (#38 test 1, #84 test 2)", async () => {
    // Mounts are lost twice by two mechanisms (#38's pinned comment): Monty's
    // load needs them handed back (fixed at `resumeSuspended`), and the session
    // has to remember what to hand. This passes only when both hold.
    const { dir, cleanup } = mountFixture();
    try {
      const session = new Session({ registry: new ToolRegistry([gated]) });
      suspended(
        await session.run('gated_carry("x")\nopen("/data/note.txt").read()', {
          onApproval: () => "suspend",
          mount: { "/data": dir },
        }),
      );

      // The shape `ReplRunner.resume` produces: no mount of its own.
      const result = await session.resume({ onApproval: () => true });
      ok(result);
      assert.equal(result.output, "MOUNTED\n");
    } finally {
      cleanup();
    }
  });

  it("the suspended run's maxStdoutBytes caps stdout printed after the resume", async () => {
    const session = new Session({ registry: new ToolRegistry([gated]) });
    // Nothing is printed before the gate, so `truncatedBefore` cannot carry
    // the flag across: only a cap in force *after* the resume can set it.
    suspended(
      await session.run('gated_carry("x")\nprint("A" * 5000)', {
        onApproval: () => "suspend",
        maxStdoutBytes: 10,
      }),
    );

    const result = await session.resume({ onApproval: () => true });
    ok(result);
    assert.equal(
      result.stdoutTruncated,
      true,
      "the 32 KiB default replaced the suspended run's 10-byte cap",
    );
    assert.ok(size(result.stdout) <= 10, `${size(result.stdout)} bytes against a 10-byte cap`);
  });

  it("the suspended run's maxOutputBytes caps the value produced after the resume", async () => {
    const session = new Session({ registry: new ToolRegistry([gated]) });
    suspended(
      await session.run('gated_carry("x")\n"X" * 1000', {
        onApproval: () => "suspend",
        maxOutputBytes: 64,
      }),
    );

    const result = await session.resume({ onApproval: () => true });
    ok(result);
    assert.equal(
      result.outputTruncated,
      true,
      "the 16 KiB default replaced the suspended run's 64-byte cap",
    );
    assert.ok(size(result.output) <= 64, `${size(result.output)} bytes against a 64-byte cap`);
  });

  it("a nested re-suspension still carries the mount (the re-suspend branch re-stores it)", async () => {
    // Two gates: the first suspends on `run`; the first `resume` approves it
    // and re-suspends on the second; only the second `resume` reaches the read.
    // If the re-suspend branch stored the raw caller options, the second
    // resume would have no mount to hand back.
    const { dir, cleanup } = mountFixture();
    try {
      const session = new Session({ registry: new ToolRegistry([gated]) });
      suspended(
        await session.run('gated_carry("a")\ngated_carry("b")\nopen("/data/note.txt").read()', {
          onApproval: () => "suspend",
          mount: { "/data": dir },
        }),
      );
      suspended(
        await session.resume({
          onApproval: (req) => (req.args[0] === "b" ? "suspend" : true),
        }),
      );

      const result = await session.resume({ onApproval: () => true });
      ok(result);
      assert.equal(result.output, "MOUNTED\n");
    } finally {
      cleanup();
    }
  });

  it("dump()/load() carries the suspension, and none of the run's options (#84 test 5, D129)", async () => {
    // A dump carries the run's *state*, not the host's *policy*. Mounts are
    // host paths and a capability, `limits` can say "unbounded", the byte
    // caps are the host's: none of them is written, and a dump that names
    // them is refused rather than narrowed — the "narrowed on load" branch
    // is gone. The resume caller supplies them, as `resumeSuspended`'s own
    // callers always had to (D129; W1-2 flagged the host paths for this).
    const { dir, cleanup } = mountFixture();
    try {
      const registry = new ToolRegistry([gated]);
      const controller = new AbortController();
      const s1 = new Session({ registry });
      suspended(
        await s1.run('gated_carry("x")\nopen("/data/note.txt").read()', {
          onApproval: () => "suspend",
          mount: { "/data": dir },
          maxStdoutBytes: 10,
          signal: controller.signal,
        }),
      );

      const json = s1.dump();
      const parsed = JSON.parse(json);
      assert.ok(!("suspendedRunOpts" in parsed), "the dump persisted the run's options");
      assert.ok(!json.includes(dir), "the dump persisted a host path");

      // Whatever an older or hand-edited dump carries in that slot — a
      // signal serialised as `{}`, a mount pointing at the root — is rejected
      // by name, never narrowed into something the sandbox could act on.
      for (const suspendedRunOpts of [{ signal: {} }, { mount: { "/": "/" } }, {}]) {
        assert.throws(
          () => Session.load(JSON.stringify({ ...parsed, suspendedRunOpts }), { registry }),
          /Invalid session dump: .*suspendedRunOpts/,
        );
      }

      // Restored without a mount: the read is refused inside the sandbox
      // (the documented outcome of a restore without its mounts).
      const unmounted = await Session.load(json, { registry }).resume({ onApproval: () => true });
      err(unmounted);
      assert.match(unmounted.error, /PermissionError/, "a mount came from the file");

      // Restored with a fresh caller mount: the caller's is what mounts.
      const mounted = await Session.load(json, { registry }).resume({
        onApproval: () => true,
        mount: { "/data": dir },
      });
      ok(mounted);
      assert.equal(mounted.output, "MOUNTED\n");
    } finally {
      cleanup();
    }
  });

  it("an explicit mount on the resume wins over the suspended one (D74, caller-wins)", async () => {
    // A precedence pin, green with and without the merge: `resume` spreads
    // the caller's options, so an explicit mount is forwarded either way.
    // It pins the direction — a suspended-wins merge would read FROM_A.
    const a = mountFixture("FROM_A\n");
    const b = mountFixture("FROM_B\n");
    try {
      const session = new Session({ registry: new ToolRegistry([gated]) });
      suspended(
        await session.run('gated_carry("x")\nopen("/data/note.txt").read()', {
          onApproval: () => "suspend",
          mount: { "/data": a.dir },
        }),
      );

      const result = await session.resume({ onApproval: () => true, mount: { "/data": b.dir } });
      ok(result);
      assert.equal(result.output, "FROM_B\n");
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it("an explicit maxStdoutBytes on the resume wins over the suspended one (D74)", async () => {
    const session = new Session({ registry: new ToolRegistry([gated]) });
    suspended(
      await session.run('gated_carry("x")\nprint("A" * 5000)', {
        onApproval: () => "suspend",
        maxStdoutBytes: 10,
      }),
    );

    const result = await session.resume({ onApproval: () => true, maxStdoutBytes: 100_000 });
    ok(result);
    assert.equal(result.stdoutTruncated, false, "the suspended 10-byte cap outranked the caller's");
    assert.ok(result.stdout.includes("A".repeat(5000)));
  });

  it("inputs survive a suspension through the snapshot, not through the options (#84 test 3)", async () => {
    // `feedStart` binds inputs as globals, so they are in the snapshot; a
    // resume never re-supplies them and needs nothing carried. Pinned so the
    // "not carried, by design" comment at `resume()` stays true.
    const session = new Session({ registry: new ToolRegistry([gated]) });
    suspended(
      await session.run('gated_carry("x")\nname', {
        onApproval: () => "suspend",
        inputs: { name: "Alice" },
      }),
    );

    const result = await session.resume({ onApproval: () => true });
    ok(result);
    assert.equal(result.output, "Alice");
  });

  it("the suspended run's signal and onApproval are not carried: both come from the caller (#84 test 4)", async () => {
    // The run's turn ends when it suspends. Its signal is aborted here to
    // prove a stale one is not handed forward, and its callback — which would
    // answer "suspend" again — must not be consulted a second time.
    const session = new Session({ registry: new ToolRegistry([gated]) });
    const controller = new AbortController();
    let asked = 0;
    suspended(
      await session.run('gated_carry("x")', {
        onApproval: () => {
          asked++;
          return "suspend";
        },
        signal: controller.signal,
      }),
    );
    controller.abort();

    const result = await session.resume({ onApproval: () => true });
    ok(result);
    assert.equal(result.output, "approved: x");
    assert.equal(asked, 1, "the suspended run's onApproval was consulted again on resume");
  });
});

// ── resume on an aborted or throwing continuation (#47 residuals) ──
//
// Bucket 5's two undelivered residuals (PR #107 "does not close #50"; PR #151
// INFO #1): `Session.resume` awaited `onApproval` before any abort check, so a
// pre-aborted resume still opened a dialog for a call the user had cancelled;
// and it cleared the suspension only on the success path, so a continuation
// that threw left the session pinned to it.

describe("Session — resume on an aborted or throwing continuation leaves the session usable (#47)", () => {
  let executions = 0;
  const gated: HostTool = {
    name: "gated_47",
    description: "Needs approval",
    params: [{ name: "x", type: "str", description: "Value" }],
    returns: "str",
    requiresApproval: true,
    execute: (args) => {
      executions++;
      return `approved: ${args.x}`;
    },
  };

  /** Restores whatever the env held, including "was not set at all". */
  async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      return await fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("a resume whose signal is already aborted never asks onApproval (#47 residual 1)", async () => {
    const session = new Session({ registry: new ToolRegistry([gated]) });
    suspended(await session.run('gated_47("x")', { onApproval: () => "suspend" }));
    executions = 0;

    const controller = new AbortController();
    controller.abort();
    let asked = 0;
    const result = await session.resume({
      signal: controller.signal,
      onApproval: () => {
        asked++;
        return true;
      },
    });

    err(result);
    assert.equal(result.errorKind, "aborted");
    assert.equal(asked, 0, "a dialog was opened for a call the user had already cancelled");
    assert.equal(executions, 0, "the gated call ran on an aborted resume");
    // The call is over, as it is when the extension's own guard denies it.
    assert.equal(session.isSuspended(), false);
  });

  it("a continuation that throws clears the suspension, so run() is clean and resume() says so (#47 residual 2)", async () => {
    const session = new Session({ registry: new ToolRegistry([gated]) });
    suspended(await session.run('gated_47("x")', { onApproval: () => "suspend" }));

    // A 1 MB ceiling is below any live node process, so `assertMemoryHeadroom`
    // throws out of `resumeSuspended` before anything runs — the one throw a
    // caller can provoke deterministically.
    await withEnv({ REPL_MEMORY_CEILING_MB: "1" }, async () => {
      await assert.rejects(
        () => session.resume({ onApproval: () => true }),
        (e: Error) => e.name === "SandboxMemoryError",
      );
    });

    assert.equal(
      session.isSuspended(),
      false,
      "the session stayed pinned to a failed continuation",
    );
    await assert.rejects(
      () => session.resume({ onApproval: () => true }),
      /no suspended execution/i,
    );

    const after = await session.run("1 + 1");
    ok(after);
    assert.equal(after.output, "2");
    assert.equal(
      after.discardedSuspension,
      undefined,
      "run() reported discarding a suspension that had already ended",
    );
  });

  it("a continuation that throws revokes the grants the call was holding", async () => {
    // `grantUses: 2` is the only configuration that leaves a grant behind;
    // suspend on the second tool so one is outstanding when the throw lands.
    const second: HostTool = { ...gated, name: "gated_47b" };
    const session = new Session({ registry: new ToolRegistry([gated, second]) }, undefined, {
      grantUses: 2,
    });
    suspended(await session.run('gated_47("a")\ngated_47b("b")', { onApproval: () => "suspend" }));
    suspended(
      await session.resume({ onApproval: (req) => (req.tool === "gated_47" ? true : "suspend") }),
    );
    assert.equal(session.outstandingGrants().length, 1, "precondition: a grant is live");

    await withEnv({ REPL_MEMORY_CEILING_MB: "1" }, async () => {
      await assert.rejects(
        () => session.resume({ onApproval: () => true }),
        (e: Error) => e.name === "SandboxMemoryError",
      );
    });

    assert.deepEqual(session.outstandingGrants(), [], "a grant outlived the call that threw");
  });
});

// ── the two clocks across a suspension (#38) ─────────────────────
//
// `src/types.ts` used to say suspension resets the sandbox clock. Measured
// (ship report): the compute budget is cumulative and travels *inside* the
// snapshot — limit and elapsed both — so a resume can neither lift nor reset
// it; the host wall clock is per-segment and restarts on every resume
// (maintainer decision 1). One pin per clock, both load-independent; the
// calibrated cumulative assertion is a `todo` (D77).

describe("Session — the two clocks across a suspension (#38)", () => {
  const gate: HostTool = {
    name: "gate_38",
    description: "Needs approval",
    params: [],
    returns: "str",
    requiresApproval: true,
    execute: () => "ok",
  };

  /** Host time, not compute: Monty's clock does not advance while it waits. */
  function napTool(ms: number): HostTool {
    return {
      name: "nap",
      description: "Sleeps on the host",
      params: [],
      returns: "str",
      execute: () => new Promise((resolve) => setTimeout(() => resolve("napped"), ms)),
    };
  }

  it("the host wall clock restarts on every resume (decision 1: per-segment)", async () => {
    // Deterministic on the side that matters (D132). The run spends 2.5 s of
    // host time before the gate, under a 5 s budget it cannot breach. The
    // resume asks for a 2 s budget (caller-wins) and has nothing left to do
    // but return the gated call's value: per-segment, that trivial
    // continuation has the whole 2 s; a budget that spanned the suspension
    // would already be 0.5 s in the past and time out before anything ran.
    // The earlier shape — 1.2 s + 1.2 s under 2 s — left 0.8 s of slack on
    // each side and depended on the host being quiet.
    const session = new Session({ registry: new ToolRegistry([gate, napTool(2500)]) });
    suspended(
      await session.run("nap()\ngate_38()", {
        onApproval: () => "suspend",
        limits: { maxWallClockSecs: 5 },
      }),
    );

    const result = await session.resume({
      onApproval: () => true,
      limits: { maxWallClockSecs: 2 },
    });
    ok(result);
    assert.equal(result.output, "ok");
  });

  it("the snapshot pins the compute budget: a resume cannot lift it, so a gated-tool loop is bounded by the run that started it (#38 test 3)", async () => {
    // The suspended run had 0.2 s of compute. The resume asks for 60 s and
    // loops forever: it must die at the snapshot's 0.2 s by Monty's own
    // `TimeoutError` — not at 60 s, and not by the host wall clock.
    const session = new Session({ registry: new ToolRegistry([gate]) });
    suspended(
      await session.run("gate_38()\ni = 0\nwhile True:\n    i += 1", {
        onApproval: () => "suspend",
        limits: { maxDurationSecs: 0.2 },
      }),
    );

    const started = Date.now();
    const result = await session.resume({
      onApproval: () => true,
      limits: { maxDurationSecs: 60, maxWallClockSecs: 30 },
    });
    err(result);
    assert.equal(result.errorKind, "timeout");
    assert.match(
      result.error,
      /time limit exceeded/,
      "the breach must be the sandbox's, not the host's",
    );
    assert.ok(Date.now() - started < 10_000, `returned in ${Date.now() - started}ms`);
  });

  it("the compute budget is cumulative across a suspension (#38 test 2)", {
    todo:
      "timing-calibrated: the only Session-level observable is breach-or-not, so this cannot be " +
      "both load-robust and discriminating (iteration cost swung 111→165 ns on this shared host). " +
      "Intended gate: promote to a plain test once it passes 20/20 under `npm run test:contained`. " +
      "Measured 2026-09-08: a 493 ms burn under 0.5 s breached 16 ms into the resume; a 30 ms " +
      "burn under 0.1 s breached at 100.00 ms total on a resume passed 60 s.",
  }, async () => {
    // Self-calibrating against the sandbox's own clock: count how far one
    // loop body gets in 0.2 s of compute, then burn 0.4 B before the gate
    // and 0.8 B after it. Cumulative → the resume times out; per-segment →
    // it completes. The loop body is identical in all three runs.
    const loop = (n: number) =>
      `total = 0\nfor j in range(${n}):\n    total += j\n    if j % 10000 == 0:\n        print("t")`;
    const calibration = new Session({ registry: new ToolRegistry() });
    const probe = await calibration.run(loop(1_000_000_000), {
      limits: { maxDurationSecs: 0.2, maxWallClockSecs: 30 },
    });
    err(probe);
    assert.equal(probe.errorKind, "timeout");
    const ticks = probe.stdout.split("t").length - 1;
    assert.ok(ticks > 0, "calibration produced no ticks");
    const iterationsPerSecond = (ticks * 10_000) / 0.2;

    const budget = 1;
    const session = new Session({ registry: new ToolRegistry([gate]) });
    suspended(
      await session.run(
        `${loop(Math.round(0.4 * budget * iterationsPerSecond))}\ngate_38()\n${loop(
          Math.round(0.8 * budget * iterationsPerSecond),
        )}\ntotal`,
        { onApproval: () => "suspend", limits: { maxDurationSecs: budget, maxWallClockSecs: 30 } },
      ),
    );

    const result = await session.resume({ onApproval: () => true });
    err(result);
    assert.equal(result.errorKind, "timeout");
    assert.match(result.error, /time limit exceeded/);
  });
});

// ── stdout is this call's, not the transcript's (#61) ─────────────
//
// Replay re-executes every prior snippet, so every prior print fires again
// and `stdout` used to carry the whole transcript: `alpha`, `alpha\nbeta`,
// `alpha\nbeta\ngamma` (measured). Past the cap the stale output filled the
// budget. The session now keeps a byte mark — how much the retained prefix
// printed — and the sandbox drops that many leading bytes before `onPrint`
// and the accumulator see anything, so the truncation budget applies to the
// delta by construction (D121). Bytes, not callbacks: a prefix ending in a
// partial line merges with the next call's first print into one callback on
// replay, and a callback count would swallow it.

describe("Session — stdout is this call's, not the transcript's (#61)", () => {
  const gate: HostTool = {
    name: "gate_61",
    description: "Needs approval",
    params: [],
    returns: "str",
    requiresApproval: true,
    execute: () => "g",
  };

  it("1 — three runs each return only their own output", async () => {
    const session = new Session({ registry: new ToolRegistry() });
    const outs: string[] = [];
    for (const word of ["alpha", "beta", "gamma"]) {
      const result = await session.run(`print("${word}")`);
      ok(result);
      outs.push(result.stdout);
    }
    assert.deepEqual(outs, ["alpha\n", "beta\n", "gamma\n"]);
  });

  it("2 — a 300 KB print followed by a small one returns only the small line, untruncated", async () => {
    // The destructive case: the replayed 300 KB used to fill the budget and
    // the only line the caller asked for arrived, if at all, in the tail.
    const session = new Session({ registry: new ToolRegistry() });
    ok(await session.run('print("Z" * 300000)'));
    const result = await session.run('print("IMPORTANT-NEW-OUTPUT")');
    ok(result);
    assert.equal(result.stdout, "IMPORTANT-NEW-OUTPUT\n");
    assert.equal(result.stdoutTruncated, false, "the replayed 300 KB counted against the budget");
  });

  it("3 — a run that prints nothing returns empty stdout, not the previous run's", async () => {
    const session = new Session({ registry: new ToolRegistry() });
    ok(await session.run('print("alpha")'));
    const result = await session.run("x = 1");
    ok(result);
    assert.equal(result.stdout, "");
  });

  it("4 — the delta is what gets truncated, not the accumulated transcript", async () => {
    const session = new Session({ registry: new ToolRegistry() });
    const first = await session.run('print("A" * 40000)');
    ok(first);
    assert.equal(first.stdoutTruncated, true, "precondition: the prefix alone exceeds 32 KiB");

    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    const second = await session.run('for i in range(10):\n    print("line", i)');
    ok(second);
    assert.equal(second.stdoutTruncated, false, "the prefix's 40 KB was charged to this call");
    assert.equal(second.stdout, `${lines.join("\n")}\n`);
  });

  it("5 — reset() resets the mark", async () => {
    const session = new Session({ registry: new ToolRegistry() });
    ok(await session.run('print("alpha")'));
    session.reset();
    // A stale mark would swallow `beta`; no mark at all would re-emit it on
    // the run after.
    const beta = await session.run('print("beta")');
    ok(beta);
    assert.equal(beta.stdout, "beta\n");
    const gamma = await session.run('print("gamma")');
    ok(gamma);
    assert.equal(gamma.stdout, "gamma\n");
  });

  it("a suspend/resume call reports its whole output once, and the next call none of it", async () => {
    // The resume re-accumulates the pre-gate stdout so the *call* reports
    // everything it printed; the segment counts must add up to the call's
    // total once, not twice — a double count would swallow the next call's
    // first bytes.
    const session = new Session({ registry: new ToolRegistry([gate]) });
    const paused = await session.run('print("a")\ngate_61()\nprint("b")', {
      onApproval: () => "suspend",
    });
    suspended(paused);
    assert.equal(paused.stdout, "a\n");

    const finished = await session.resume({ onApproval: () => true });
    ok(finished);
    assert.equal(finished.stdout, "a\nb\n", "the resumed call must report the whole call's output");

    const next = await session.run('print("c")');
    ok(next);
    assert.equal(next.stdout, "c\n");
  });

  it("a prefix ending in a partial line is cut at the mark, not at a callback (bytes, not entries)", async () => {
    // Run 1 prints `x` with no newline: one callback, flushed at the end of
    // the run. On replay that `x` merges with run 2's `y\n` into a single
    // callback `xy\n`. Skipping a callback would lose `y`; skipping one byte
    // keeps it.
    const session = new Session({ registry: new ToolRegistry() });
    const first = await session.run('print("x", end="")');
    ok(first);
    assert.equal(first.stdout, "x");
    const second = await session.run('print("y")');
    ok(second);
    assert.equal(second.stdout, "y\n");
  });

  it("the live onPrint stream sees only this call's output", async () => {
    const session = new Session({ registry: new ToolRegistry() });
    ok(await session.run('print("alpha")'));
    const streamed: string[] = [];
    ok(await session.run('print("beta")', { onPrint: (text) => streamed.push(text) }));
    assert.deepEqual(streamed, ["beta\n"], "the terminal was shown the replayed output again");
  });

  it("the mark survives dump()/load()", async () => {
    const registry = new ToolRegistry();
    const s1 = new Session({ registry });
    ok(await s1.run('print("alpha")'));
    const s2 = Session.load(s1.dump(), { registry });
    const result = await s2.run('print("beta")');
    ok(result);
    assert.equal(result.stdout, "beta\n");
  });
});

// ── Cache and replay semantics, recovered (#62 A14–A17) ───────────
//
// The four defects' original text is lost; each is recovered from the code
// and written down in docs/session-replay.md. One RED→GREEN test per
// defect (A15's fix is documentation plus one note; its test pins the
// documented semantics and the note), and pins for what was already right.

describe("Session — cache and replay semantics recovered (#62 A14–A17)", () => {
  /** A non-gated tool that counts real executions. */
  function makeCounter(name = "counter"): { tool: HostTool; count: () => number } {
    let count = 0;
    return {
      tool: {
        name,
        description: "Counts real executions",
        params: [],
        returns: "str",
        execute: () => String(++count),
      },
      count: () => count,
    };
  }

  /** A gated tool that counts real executions. */
  function makeGated(name = "gated"): { tool: HostTool; executions: () => number } {
    let executions = 0;
    return {
      tool: {
        name,
        description: "Gated; counts real executions",
        params: [{ name: "v", type: "str", description: "Value" }],
        returns: "str",
        requiresApproval: true,
        execute: (args) => `${name}:${args.v}:${++executions}`,
      },
      executions: () => executions,
    };
  }

  it("A14 — a call made before the gate is cached across the suspension: it neither re-executes nor drifts", async () => {
    // Measured before the fix: the counter ran 3 times and `n` read 2, then
    // 3 — the pre-gate entries were dropped at the suspension, so every
    // later replay re-executed the call and the variable followed it.
    const counter = makeCounter();
    const gated = makeGated();
    const session = new Session({ registry: new ToolRegistry([counter.tool, gated.tool]) });

    suspended(await session.run('n = int(counter())\ngated("x")', { onApproval: () => "suspend" }));
    ok(await session.resume({ onApproval: () => true }));

    for (let i = 0; i < 2; i++) {
      const read = await session.run("n");
      ok(read);
      assert.equal(read.output, "1", `n drifted on read ${i + 1}`);
      assert.equal(counter.count(), 1, "the pre-gate call re-executed on replay");
    }
    assert.equal(gated.executions(), 1);
  });

  it("A14 — a nested re-suspension accumulates the pre-gate entries", async () => {
    const counter = makeCounter();
    const gated = makeGated();
    const session = new Session({ registry: new ToolRegistry([counter.tool, gated.tool]) });

    suspended(
      await session.run('n = int(counter())\ngated("a")\nm = int(counter())\ngated("b")', {
        onApproval: () => "suspend",
      }),
    );
    suspended(
      await session.resume({ onApproval: (req) => (req.args[0] === "b" ? "suspend" : true) }),
    );
    ok(await session.resume({ onApproval: () => true }));
    assert.equal(counter.count(), 2, "precondition: each counter ran once");

    const sum = await session.run("n + m");
    ok(sum);
    assert.equal(sum.output, "3");
    assert.equal(counter.count(), 2, "a pre-gate call re-executed on replay");
    assert.equal(gated.executions(), 2);
  });

  it("A14 — the pre-gate entries survive a dump()/load() between the suspension and its resume", async () => {
    const counter = makeCounter();
    const gated = makeGated();
    const registry = new ToolRegistry([counter.tool, gated.tool]);
    const s1 = new Session({ registry });
    suspended(await s1.run('n = int(counter())\ngated("x")', { onApproval: () => "suspend" }));

    const json = s1.dump();
    assert.equal(JSON.parse(json).suspended.preGateCache.length, 1, "the dump dropped them");

    const s2 = Session.load(json, { registry });
    ok(await s2.resume({ onApproval: () => true }));
    const read = await s2.run("n");
    ok(read);
    assert.equal(read.output, "1");
    assert.equal(counter.count(), 1, "the restored pre-gate call re-executed on replay");
  });

  it("A15 — a later run that omits an input a retained snippet was given fails with a note naming it", async () => {
    // Inputs are per-call (decision 12). Without them the replayed snippet
    // fails at the type check on a prefix line the caller cannot see; the
    // session knows which names its snippets ran with and says so.
    const session = new Session({ registry: new ToolRegistry() });
    ok(await session.run("y = name", { inputs: { name: "Alice" } }));

    const result = await session.run("y");
    err(result);
    assert.match(result.error, /inputs are per-call/);
    assert.match(result.error, /\bname\b/);
  });

  it("A15 — inputs are per-call: a replayed snippet reads the current call's value, and a dump holds none", async () => {
    // The documented semantics, pinned: changing an input changes what the
    // earlier snippet computed, and no value ever reaches a dump.
    const session = new Session({ registry: new ToolRegistry() });
    ok(await session.run("y = name", { inputs: { name: "Alice" } }));
    const read = await session.run("y", { inputs: { name: "Bob" } });
    ok(read);
    assert.equal(read.output, "Bob");
    assert.ok(!session.dump().includes("Alice"), "an input value reached the dump");
    assert.ok(!session.dump().includes("Bob"), "an input value reached the dump");
  });

  it("A16 — a failed snippet leaves no replayed state, and its trace is its own", async () => {
    // Its calls are not cached, its bindings are gone, its side effects
    // happened and the trace says so — and the trace carries *only* this
    // call's calls, not the replayed prior ones (measured: `[["a"],["b"]]`).
    const counter = makeCounter();
    const session = new Session({ registry: new ToolRegistry([counter.tool, makeEchoTool()]) });
    ok(await session.run('echo("a")'));

    const failed = await session.run('z = int(counter())\necho("b")\nraise ValueError("boom")');
    err(failed);
    assert.deepEqual(
      failed.calls.map((c) => c.args),
      [[], ["b"]],
      "the error trace reported the replayed prior call",
    );
    assert.equal(counter.count(), 1, "the call really ran");

    const gone = await session.run("z");
    err(gone);
    const fresh = await session.run("counter()");
    ok(fresh);
    assert.equal(fresh.output, "2", "the failed snippet's call was cached and replayed");
    assert.equal(JSON.parse(session.dump()).snippets.length, 2, "the failed snippet was retained");
  });

  it("A16 — a suspended call's trace, and so the resumed call's, is its own", async () => {
    const gated = makeGated();
    const session = new Session({ registry: new ToolRegistry([gated.tool, makeEchoTool()]) });
    ok(await session.run('echo("a")'));

    const paused = await session.run('echo("b")\ngated("x")', { onApproval: () => "suspend" });
    suspended(paused);
    assert.deepEqual(
      paused.calls.map((c) => c.args),
      [["b"]],
    );

    const finished = await session.resume({ onApproval: () => true });
    ok(finished);
    assert.deepEqual(
      finished.calls.map((c) => c.args),
      [["b"], ["x"]],
    );
  });

  /** A v2 dump with `n` one-line snippets and no cache. */
  function snippetsDump(n: number): string {
    const snippets = Array.from({ length: n }, (_, i) => `a${i} = ${i}`);
    return JSON.stringify({
      version: 2,
      snippets,
      stdoutBytes: snippets.map(() => 0),
      callCache: [],
    });
  }

  /** A v2 dump whose one snippet made `n` cached `echo` calls. */
  function cacheDump(n: number): string {
    return JSON.stringify({
      version: 2,
      snippets: [`for i in range(${n}):\n    echo(str(i))`],
      stdoutBytes: [0],
      callCache: Array.from({ length: n }, (_, i) => ({
        key: `echo::{"text":"${i}"}`,
        result: String(i),
      })),
    });
  }

  it("A17 — the snippet after the cap is refused before anything runs, naming the cap and the way out", async () => {
    const counter = makeCounter();
    const registry = new ToolRegistry([counter.tool]);

    const full = Session.load(snippetsDump(MAX_SNIPPETS), { registry });
    const refused = await full.run("counter()");
    err(refused);
    assert.equal(refused.errorKind, "unavailable");
    assert.match(refused.error, new RegExp(`\\b${MAX_SNIPPETS}\\b`));
    assert.match(refused.error, /reset/i);
    assert.equal(counter.count(), 0, "the refused call ran");
    assert.equal(JSON.parse(full.dump()).snippets.length, MAX_SNIPPETS, "a snippet was appended");

    // One below the cap: the run that reaches it is kept; the next is not.
    const nearly = Session.load(snippetsDump(MAX_SNIPPETS - 1), { registry });
    ok(await nearly.run("z = 1"));
    err(await nearly.run("z"));

    // The way out works.
    full.reset();
    ok(await full.run("counter()"));
  });

  it("A17 — the cache entry after the cap is refused inside the run, before the tool executes", async () => {
    let executions = 0;
    const echo: HostTool = {
      ...makeEchoTool(),
      execute: (args) => {
        executions++;
        return String(args.text);
      },
    };
    const registry = new ToolRegistry([echo]);

    const session = Session.load(cacheDump(MAX_CACHE_ENTRIES - 1), { registry });
    // The entry that reaches the cap is kept; only the one past it is refused.
    ok(await session.run('echo("new")'));
    assert.equal(executions, 1, "replayed entries executed");

    const refused = await session.run('echo("again")');
    err(refused);
    assert.equal(refused.errorKind, "runtime");
    assert.match(refused.error, new RegExp(`\\b${MAX_CACHE_ENTRIES}\\b`));
    assert.match(refused.error, /reset/i);
    assert.equal(executions, 1, "the refused call executed — its side effect happened");
    const dump = JSON.parse(session.dump());
    assert.equal(dump.snippets.length, 2, "the refused snippet was appended");
    assert.equal(dump.callCache.length, MAX_CACHE_ENTRIES);
  });

  it("A17 — load() refuses a dump beyond either cap", () => {
    const registry = new ToolRegistry([makeEchoTool()]);
    assert.throws(
      () => Session.load(snippetsDump(MAX_SNIPPETS + 1), { registry }),
      new RegExp(`Invalid session dump: .*snippets.*${MAX_SNIPPETS}`),
    );
    assert.throws(
      () => Session.load(cacheDump(MAX_CACHE_ENTRIES + 1), { registry }),
      new RegExp(`Invalid session dump: .*callCache.*${MAX_CACHE_ENTRIES}`),
    );
  });
});

// ── Persistence hardening (#63) ───────────────────────────────────
//
// `Session.dump()` / `load()` are a public export. Measured before this
// change: `load()` checked only `version`; `snippets: 5` threw a TypeError
// from inside the constructor, `callCache: "zzz"` was accepted and blew up
// on the next run, an extra key was accepted; and a dump whose `callCache`
// named a `bash` call ran `print(out)` to `ok` with the file's `FAKE-OUTPUT`
// and no dialog. The invariant this block protects: a persisted session must
// never be able to grant an approval a human did not grant.

describe("Session — persistence hardening (#63)", () => {
  const gated: HostTool = {
    name: "gate_63",
    description: "Needs approval",
    params: [{ name: "x", type: "str", description: "Value" }],
    returns: "str",
    requiresApproval: true,
    execute: (args) => `g:${args.x}`,
  };

  const base = { version: 2, snippets: [] as string[], stdoutBytes: [] as number[], callCache: [] };
  const validSuspended = {
    snapshot: "QUJD",
    suspendedCall: { tool: "gate_63", args: ["x"], kwargs: {}, description: 'gate_63(x="x")' },
    stdout: "",
    stdoutTruncated: false,
    calls: [],
    stdoutBytes: 0,
    preGateCache: [],
  };
  const withSuspension = (suspended: unknown) => ({
    ...base,
    suspended,
    suspendedCode: 'gate_63("x")',
  });

  it("1 — a malformed dump is rejected with an error naming the field, never coerced or thrown through", () => {
    const registry = new ToolRegistry([gated]);
    const cases: Array<[string, string, RegExp]> = [
      ["null", "null", /object/],
      ["array", "[]", /object/],
      ["not JSON", "{", /Invalid session JSON/],
      [
        "version 1 (pre-bump)",
        JSON.stringify({ version: 1, snippets: [], callCache: [] }),
        /Unsupported session version: 1 \(expected 2\)/,
      ],
      ["version as a string", JSON.stringify({ ...base, version: "2" }), /version/],
      [
        "missing snippets",
        JSON.stringify({ version: 2, stdoutBytes: [], callCache: [] }),
        /snippets/,
      ],
      ["snippets: 5", JSON.stringify({ ...base, snippets: 5 }), /snippets/],
      [
        "snippets[1] not a string",
        JSON.stringify({ ...base, snippets: ["a", 1], stdoutBytes: [0, 0] }),
        /snippets\[1\]/,
      ],
      [
        "stdoutBytes length mismatch",
        JSON.stringify({ ...base, snippets: ["a"], stdoutBytes: [] }),
        /stdoutBytes/,
      ],
      [
        "stdoutBytes negative",
        JSON.stringify({ ...base, snippets: ["a"], stdoutBytes: [-1] }),
        /stdoutBytes\[0\]/,
      ],
      [
        "stdoutBytes fractional",
        JSON.stringify({ ...base, snippets: ["a"], stdoutBytes: [1.5] }),
        /stdoutBytes\[0\]/,
      ],
      ["callCache: 'zzz'", JSON.stringify({ ...base, callCache: "zzz" }), /callCache/],
      [
        "callCache entry missing result",
        JSON.stringify({ ...base, callCache: [{ key: "k" }] }),
        /callCache\[0\]/,
      ],
      [
        "callCache entry with an extra key",
        JSON.stringify({ ...base, callCache: [{ key: "k", result: "r", restored: true }] }),
        /callCache\[0\].*restored/,
      ],
      ["extra top-level key", JSON.stringify({ ...base, evil: 1 }), /evil/],
      [
        "__proto__ key",
        '{"version":2,"snippets":[],"stdoutBytes":[],"callCache":[],"__proto__":{"x":1}}',
        /__proto__/,
      ],
      [
        "suspended without suspendedCode",
        JSON.stringify({ ...base, suspended: validSuspended }),
        /suspendedCode/,
      ],
      [
        "suspendedCode without suspended",
        JSON.stringify({ ...base, suspendedCode: "x" }),
        /suspendedCode/,
      ],
      [
        "snapshot not base64",
        JSON.stringify(withSuspension({ ...validSuspended, snapshot: "!!!!" })),
        /snapshot.*base64/,
      ],
      [
        "snapshot with a bad length",
        JSON.stringify(withSuspension({ ...validSuspended, snapshot: "QUJDR" })),
        /snapshot/,
      ],
      [
        "suspendedCall.args not an array",
        JSON.stringify(
          withSuspension({
            ...validSuspended,
            suspendedCall: { ...validSuspended.suspendedCall, args: "x" },
          }),
        ),
        /suspendedCall\.args/,
      ],
      [
        "suspendedCall missing description",
        JSON.stringify(
          withSuspension({
            ...validSuspended,
            suspendedCall: { tool: "gate_63", args: [], kwargs: {} },
          }),
        ),
        /suspendedCall\.description/,
      ],
      [
        "calls[0].durationMs a string",
        JSON.stringify(
          withSuspension({
            ...validSuspended,
            calls: [{ tool: "t", args: [], kwargs: {}, durationMs: "1", ok: true }],
          }),
        ),
        /calls\[0\]\.durationMs/,
      ],
      [
        "suspended.stdoutBytes missing",
        JSON.stringify(withSuspension({ ...validSuspended, stdoutBytes: undefined })),
        /suspended\.stdoutBytes/,
      ],
      [
        "suspended.preGateCache missing",
        JSON.stringify(withSuspension({ ...validSuspended, preGateCache: undefined })),
        /preGateCache/,
      ],
      [
        "suspendedRunOpts present",
        JSON.stringify({ ...base, suspendedRunOpts: {} }),
        /suspendedRunOpts/,
      ],
      [
        "suspended not an object",
        JSON.stringify({ ...base, suspended: 5, suspendedCode: "x" }),
        /suspended must be an object/,
      ],
      [
        "suspendedCode not a string",
        JSON.stringify({ ...base, suspended: validSuspended, suspendedCode: 5 }),
        /suspendedCode must be a string/,
      ],
      [
        "snapshot empty",
        JSON.stringify(withSuspension({ ...validSuspended, snapshot: "" })),
        /snapshot/,
      ],
      [
        "stdoutTruncated not a boolean",
        JSON.stringify(withSuspension({ ...validSuspended, stdoutTruncated: "no" })),
        /suspended\.stdoutTruncated/,
      ],
      [
        "suspendedCall.kwargs not an object",
        JSON.stringify(
          withSuspension({
            ...validSuspended,
            suspendedCall: { ...validSuspended.suspendedCall, kwargs: [] },
          }),
        ),
        /suspendedCall\.kwargs/,
      ],
      [
        "calls[0] with an extra key",
        JSON.stringify(
          withSuspension({
            ...validSuspended,
            calls: [{ tool: "t", args: [], kwargs: {}, durationMs: 1, ok: true, extra: 1 }],
          }),
        ),
        /calls\[0\].*extra/,
      ],
      ["a redacted export", JSON.stringify({ ...base, redacted: true }), /redacted export/],
    ];

    for (const [label, json, expected] of cases) {
      assert.throws(
        () => Session.load(json, { registry }),
        (e: unknown) =>
          e instanceof Error &&
          !(e instanceof TypeError) &&
          expected.test(e.message) &&
          (label === "not JSON" ||
            label.startsWith("version 1") ||
            /^Invalid session dump/.test(e.message)),
        `${label}: expected a clear rejection matching ${expected}`,
      );
    }
  });

  it("1b — a well-formed dump with a suspension loads, so the table above is rejecting shape, not suspensions", () => {
    const registry = new ToolRegistry([gated]);
    const session = Session.load(JSON.stringify(withSuspension(validSuspended)), { registry });
    assert.equal(session.isSuspended(), true);
  });

  it("2 — an oversize dump is refused before it is parsed, fast", () => {
    const registry = new ToolRegistry([gated]);
    // 100 MB of base64 alphabet: well-formed as far as any parser could tell,
    // and refused on its byte length alone.
    const big = "A".repeat(100 * 1024 * 1024);
    const json = `{"version":2,"snippets":[],"stdoutBytes":[],"callCache":[],"suspendedCode":"x","suspended":{"snapshot":"${big}","suspendedCall":{"tool":"gate_63","args":[],"kwargs":{},"description":"d"},"stdout":"","stdoutTruncated":false,"calls":[],"stdoutBytes":0,"preGateCache":[]}}`;
    const started = performance.now();
    assert.throws(
      () => Session.load(json, { registry }),
      new RegExp(`Invalid session dump: .*${MAX_DUMP_BYTES}`),
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2000, `refusing 100 MB took ${elapsed.toFixed(0)} ms`);
  });

  it("3 — a poisoned callCache neither executes a gated tool nor suppresses its prompt", async () => {
    let executions = 0;
    const bash: HostTool = {
      name: "bash",
      description: "Gated",
      params: [{ name: "cmd", type: "str", description: "Command" }],
      returns: "str",
      requiresApproval: true,
      execute: () => {
        executions++;
        return "REAL";
      },
    };
    const registry = new ToolRegistry([bash]);
    const poisoned = JSON.stringify({
      ...base,
      snippets: ['out = bash("rm -rf /")'],
      stdoutBytes: [0],
      callCache: [{ key: 'bash::{"cmd":"rm -rf /"}', result: "FAKE-OUTPUT" }],
    });

    let asked = 0;
    const session = Session.load(poisoned, { registry });
    const result = await session.run("print(out)", {
      onApproval: () => {
        asked++;
        return false;
      },
    });
    err(result);
    assert.match(result.error, /PermissionError/);
    assert.equal(asked, 1, "the file's entry suppressed the prompt");
    assert.equal(executions, 0, "the file's entry ran the tool");
    assert.ok(!result.stdout.includes("FAKE-OUTPUT"), "the file's result was served as output");
  });

  it("3b — a restored gated entry the user approves runs for real, its real result replaces the file's, and only then does it replay silently", async () => {
    let executions = 0;
    const counting: HostTool = {
      ...gated,
      execute: (args) => `g:${args.x}:${++executions}`,
    };
    const registry = new ToolRegistry([counting]);
    const s1 = new Session({ registry });
    ok(await s1.run('v = gate_63("x")', { onApproval: () => true }));
    assert.equal(executions, 1);

    const s2 = Session.load(s1.dump(), { registry });
    let asked = 0;
    const first = await s2.run("v", {
      onApproval: () => {
        asked++;
        return true;
      },
    });
    ok(first);
    assert.equal(asked, 1, "a restored gated entry replayed without asking");
    assert.equal(executions, 2, "the approved call did not run for real");
    assert.equal(first.output, "g:x:2", "the file's result was served instead of the real one");

    // Now the session's own: no callback, no prompt, no execution.
    const second = await s2.run("v");
    ok(second);
    assert.equal(second.output, "g:x:2");
    assert.equal(executions, 2);
    assert.equal(JSON.parse(s2.dump()).callCache[0].result, "g:x:2");
  });

  it("3c — a restored suspension is described by its arguments, not by what the file says", async () => {
    // Measured: a dump whose description said `gate(x='harmless')` while its
    // args said `x` showed `harmless` in the dialog and ran `x`.
    const registry = new ToolRegistry([gated]);
    const s1 = new Session({ registry });
    const truth = await s1.run('gate_63("x")', { onApproval: () => "suspend" });
    suspended(truth);

    const parsed = JSON.parse(s1.dump());
    parsed.suspended.suspendedCall.description = "gate_63(x='harmless')";
    const s2 = Session.load(JSON.stringify(parsed), { registry });

    let shown = "";
    const result = await s2.resume({
      onApproval: (req) => {
        shown = req.description;
        return true;
      },
    });
    ok(result);
    assert.equal(shown, truth.suspendedCall.description);
    assert.doesNotMatch(shown, /harmless/);
  });

  it("4 — a round trip keeps snippets, results, the suspension and the mark, and drops the grants", async () => {
    let executions = 0;
    const counting: HostTool = {
      ...gated,
      execute: (args) => `g:${args.x}:${++executions}`,
    };
    const second: HostTool = { ...gated, name: "gate_63b" };
    const boom: HostTool = {
      name: "boom",
      description: "Fails",
      params: [],
      returns: "str",
      execute: () => {
        throw new HostToolError("RuntimeError", "boom");
      },
    };
    const registry = new ToolRegistry([counting, second, boom]);
    const s1 = new Session({ registry }, undefined, { grantUses: 3 });

    ok(await s1.run('print("kept")\nk = 1', { onApproval: () => true }));
    // A failed call and an approved call before the pending gate, so the
    // suspension's trace carries `error` and `approved` through the round trip.
    suspended(
      await s1.run(
        'try:\n    boom()\nexcept RuntimeError:\n    pass\ngate_63("a")\ngate_63b("b")',
        { onApproval: () => "suspend" },
      ),
    );
    suspended(
      await s1.resume({ onApproval: (req) => (req.tool === "gate_63" ? true : "suspend") }),
    );
    assert.deepEqual(s1.outstandingGrants(), [{ tool: "gate_63", remaining: 2 }], "precondition");

    const s2 = Session.load(s1.dump(), { registry });
    assert.deepEqual(s2.outstandingGrants(), [], "a grant survived into the restored session");
    assert.equal(s2.isSuspended(), true, "the suspension did not survive");

    const resumed = await s2.resume({ onApproval: () => true });
    ok(resumed);
    assert.equal(resumed.output, "g:b");
    assert.deepEqual(
      resumed.calls.map((c) => [c.tool, c.ok, c.approved]),
      [
        ["boom", false, undefined],
        ["gate_63", true, true],
        ["gate_63b", true, true],
      ],
      "the trace did not survive the round trip",
    );

    const read = await s2.run("k", { onApproval: () => true });
    ok(read);
    assert.equal(read.output, "1", "the snippets did not survive");
    assert.equal(read.stdout, "", "the mark did not survive");
  });

  it("5 — dumpRedacted() masks secrets and cuts values, omits the snapshot, and is not loadable; dump() stays verbatim", async () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz0123";
    const leak: HostTool = {
      name: "leak",
      description: "Returns a secret and a lot of bytes",
      params: [],
      returns: "str",
      execute: () => `token=${token} then ${"B".repeat(10000)}`,
    };
    const boom: HostTool = {
      name: "boom",
      description: "Fails with a secret in the message",
      params: [],
      returns: "str",
      execute: () => {
        throw new HostToolError("RuntimeError", `PASSWORD=hunter2 rejected`);
      },
    };
    const registry = new ToolRegistry([leak, gated, boom]);
    const session = new Session({ registry });
    ok(await session.run("x = leak()"));
    ok(await session.run('secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456"'));
    suspended(
      await session.run('try:\n    boom()\nexcept RuntimeError:\n    pass\ngate_63("x")', {
        onApproval: () => "suspend",
      }),
    );

    const verbatim = session.dump();
    assert.ok(verbatim.includes(token), "the replay cache must hold what the tool returned");
    assert.ok(verbatim.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456"));
    assert.equal(typeof JSON.parse(verbatim).suspended.snapshot, "string");

    const exported = session.dumpRedacted();
    assert.ok(!exported.includes(token), "the export leaked the token");
    assert.ok(!exported.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456"));
    assert.ok(!exported.includes("hunter2"), "the export leaked a trace error's secret");
    const red = JSON.parse(exported);
    assert.equal(red.redacted, true);
    assert.equal(red.suspended.calls[0].tool, "boom");
    assert.ok(red.suspended.calls[0].error.includes(REDACTED));
    assert.ok(!("args" in red.suspended.calls[0]), "the export carried call arguments");
    assert.equal(red.version, 2);
    assert.ok(red.callCache[0].result.includes(REDACTED));
    assert.ok(
      Buffer.byteLength(red.callCache[0].result) <= 4096,
      `${Buffer.byteLength(red.callCache[0].result)} bytes against a 4 KiB export budget`,
    );
    assert.match(
      red.callCache[0].result,
      /truncated at/,
      "a redaction cut states where, not how much",
    );
    assert.ok(red.snippets[1].includes(REDACTED));
    assert.ok(!("snapshot" in red.suspended), "the export carried the opaque snapshot");
    assert.equal(red.suspended.tool, "gate_63");
    assert.throws(() => Session.load(exported, { registry }), /redacted export/);
  });

  it("6 — dump() refuses to write a dump over the bound", async () => {
    const big: HostTool = {
      name: "big",
      description: "Returns just over the bound",
      params: [],
      returns: "str",
      execute: () => "A".repeat(MAX_DUMP_BYTES + 1000),
    };
    const session = new Session({ registry: new ToolRegistry([big]) });
    ok(await session.run("b = big()"));
    assert.throws(() => session.dump(), new RegExp(`${MAX_DUMP_BYTES}`));
  });
});

// ── Calls are serialised per session (D131) ───────────────────────
//
// Measured: two concurrent `resume()` calls on one suspension both returned
// `ok` and the gated tool executed twice from one approval; two concurrent
// `run()` calls assembled prefixes that did not include each other. A queue
// makes concurrent calls behave exactly as sequential ones.

describe("Session — calls are serialised per session (D131)", () => {
  it("two concurrent resumes execute the approved call once; the loser learns nothing was pending", async () => {
    let executions = 0;
    const gated: HostTool = {
      name: "gate_131",
      description: "Needs approval",
      params: [],
      returns: "str",
      requiresApproval: true,
      execute: () => `g:${++executions}`,
    };
    const session = new Session({ registry: new ToolRegistry([gated]) });
    suspended(await session.run("gate_131()", { onApproval: () => "suspend" }));

    const settled = await Promise.allSettled([
      session.resume({ onApproval: () => true }),
      session.resume({ onApproval: () => true }),
    ]);
    assert.equal(executions, 1, "one approval executed the call more than once");
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    ok((fulfilled[0] as PromiseFulfilledResult<unknown>).value);
    assert.match(String((rejected[0] as PromiseRejectedResult).reason), /no suspended execution/i);
  });

  it("two concurrent runs stack in order, so the second sees the first's bindings", async () => {
    const session = new Session({ registry: new ToolRegistry() });
    const [first, second] = await Promise.all([session.run("x = 1"), session.run("y = x + 1")]);
    ok(first);
    ok(second);
    const read = await session.run("y");
    ok(read);
    assert.equal(read.output, "2");
  });
});

// ── Residual: a denied restored gated call derails the cursor ─────
//
// Recorded in docs/session-replay.md as a known limit, and here as the
// property that is missing (decision 9). When the user denies a *restored*
// gated entry during replay, the gate raises `PermissionError` without
// telling the caching registry, so the cursor stays on the denied entry and
// every later call in the prefix mismatches: non-gated ones execute for real
// (their side effect repeats), gated ones ask. A key mismatch always behaved
// this way; the restored-entry rule (D128) makes it reachable from a
// single denial rather than from edited code.

describe("Session — a denied restored gated call should not derail the replay (residual)", () => {
  it("later non-gated entries are still served from the restored cache after a denial", {
    todo:
      "the gate and the cursor do not talk: a denial raises PermissionError in Python without " +
      "advancing the replay cursor past the denied entry, so the next entry mismatches and " +
      "executes for real. Intended approach: have `willReplayKey` hand the gate a `skip()` for " +
      "the entry it refused to treat as a replay, so a denial consumes the entry and the cursor " +
      "stays aligned; the denied call itself must still not execute.",
  }, async () => {
    let echoExecutions = 0;
    const echo: HostTool = {
      ...makeEchoTool(),
      execute: (args) => {
        echoExecutions++;
        return String(args.text);
      },
    };
    const gated: HostTool = {
      name: "gate_res",
      description: "Needs approval",
      params: [{ name: "x", type: "str", description: "Value" }],
      returns: "str",
      requiresApproval: true,
      execute: (args) => `g:${args.x}`,
    };
    const registry = new ToolRegistry([echo, gated]);
    const dump = JSON.stringify({
      version: 2,
      snippets: ['try:\n    gate_res("x")\nexcept PermissionError:\n    pass\nv = echo("kept")'],
      stdoutBytes: [0],
      callCache: [
        { key: 'gate_res::{"x":"x"}', result: "g:x" },
        { key: 'echo::{"text":"kept"}', result: "kept" },
      ],
    });
    const session = Session.load(dump, { registry });

    const result = await session.run("v", { onApproval: () => false });
    ok(result);
    assert.equal(result.output, "kept");
    assert.equal(echoExecutions, 0, "the non-gated entry after the denial executed for real");
  });
});
