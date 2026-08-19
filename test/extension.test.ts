import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  APPROVE_CHOICE,
  DENY_CHOICE,
  LATER_CHOICE,
  clampModelLimits,
} from "../extensions/repl-extension.js";
import { ReplRunner } from "../src/repl.js";

/**
 * Tests for `extensions/repl-extension.ts` — the only file a consumer of this
 * package actually loads, and until now the only one with no tests at all.
 *
 * Covers registration, parameter schemas, and the headless fail-closed
 * approval path. Loading is covered separately by `extension-loader.test.ts`,
 * which drives pi's real loader; this file imports the module directly.
 *
 * See issue #22.
 */

const EXPECTED_TOOLS = ["repl", "repl_resume", "repl_reset", "repl_abandon"];

/** The subset of a registered tool this file needs, kept loose on purpose. */
type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: {
    type: string;
    required?: string[];
    properties: Record<string, { type: string; description?: string }>;
  };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
};

/** The subset of a registered command this file needs. */
type RegisteredCommand = {
  name: string;
  description?: string;
  handler: (
    args: string,
    ctx: { ui: { notify: (m: string, t?: string) => void } },
  ) => Promise<void>;
};

/**
 * Invoke the extension factory and collect what it registers.
 *
 * The module is import-cached, but each `default()` call builds a fresh
 * closure — and therefore a fresh `ReplRunner` *and* a fresh approval mode —
 * so callers get an independent runner and are not exposed to the cwd caching
 * in `getRunner` (#60). Tests that switch the mode rely on that isolation.
 */
async function load(): Promise<{ tools: RegisteredTool[]; commands: RegisteredCommand[] }> {
  const tools: RegisteredTool[] = [];
  const commands: RegisteredCommand[] = [];
  const mod = await import("../extensions/repl-extension.js");
  mod.default({
    registerTool: (t: unknown) => tools.push(t as RegisteredTool),
    registerCommand: (name: string, options: unknown) =>
      commands.push({ name, ...(options as Omit<RegisteredCommand, "name">) }),
  } as never);
  return { tools, commands };
}

async function loadTools(): Promise<RegisteredTool[]> {
  return (await load()).tools;
}

/** Collects what a command told the user, so handlers can be asserted on. */
function notifyCtx() {
  const notes: Array<{ message: string; type?: string }> = [];
  return {
    notes,
    ctx: { ui: { notify: (message: string, type?: string) => notes.push({ message, type }) } },
  };
}

// ── Registration ─────────────────────────────────────────────────

describe("repl extension — registration", () => {
  it("registers exactly the four repl tools", async () => {
    const tools = await loadTools();

    // Assert the set, so a deleted registration and an unexpected extra one
    // both fail.
    assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
  });

  it("gives every tool a label, a description and an execute", async () => {
    for (const tool of await loadTools()) {
      assert.ok(tool.label, `${tool.name} has no label`);
      assert.ok(tool.description, `${tool.name} has no description`);
      assert.equal(typeof tool.execute, "function", `${tool.name} has no execute`);
    }
  });
});

// ── Parameter schemas ────────────────────────────────────────────
//
// Schema drift here silently breaks the model's ability to call the tool, and
// nothing else in the suite looks at it.

describe("repl extension — parameter schemas", () => {
  it("repl takes code (required) and sessionId (optional)", async () => {
    const repl = (await loadTools()).find((t) => t.name === "repl");
    assert.ok(repl, "repl did not register");

    assert.equal(repl.parameters.properties.code?.type, "string");
    assert.equal(repl.parameters.properties.sessionId?.type, "string");
    assert.deepEqual(repl.parameters.required, ["code"]);
  });

  it("repl also takes optional maxDurationSecs and maxMemory, capped", async () => {
    const repl = (await loadTools()).find((t) => t.name === "repl");
    assert.ok(repl, "repl did not register");

    assert.equal(repl.parameters.properties.maxDurationSecs?.type, "number");
    assert.equal(repl.parameters.properties.maxMemory?.type, "number");
    // Still only `code` is required — the limits are optional and defaulted.
    assert.deepEqual(repl.parameters.required, ["code"]);
    // The descriptions must name the caps, or the model is told it may ask
    // for more than the clamp will grant.
    assert.match(repl.parameters.properties.maxDurationSecs?.description ?? "", /300/);
    assert.match(repl.parameters.properties.maxMemory?.description ?? "", /1024/);
  });

  it("the other three take sessionId (optional) and require nothing", async () => {
    const tools = await loadTools();

    for (const name of ["repl_resume", "repl_reset", "repl_abandon"]) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} did not register`);

      assert.equal(
        tool.parameters.properties.sessionId?.type,
        "string",
        `${name} does not accept sessionId`,
      );
      assert.deepEqual(
        tool.parameters.required ?? [],
        [],
        `${name} must not require any parameter`,
      );
    }
  });
});

// ── Model limit clamp (D3) ───────────────────────────────────────
//
// The extension is the model boundary, so a model-supplied limit is clamped,
// never trusted. `clampModelLimits` is a pure helper so it is tested directly
// rather than only through the sandbox path.

describe("repl extension — clampModelLimits", () => {
  const MIB = 1_048_576;

  it("clamps an above-cap maxDurationSecs to 300", () => {
    assert.deepEqual(clampModelLimits(10_000, undefined), { maxDurationSecs: 300 });
  });

  it("clamps an above-cap maxMemory to 1024 MiB, in bytes", () => {
    assert.deepEqual(clampModelLimits(undefined, 2048), { maxMemory: 1024 * MIB });
  });

  it("honours shorter/smaller requests — the clamp is a ceiling, not a floor", () => {
    assert.deepEqual(clampModelLimits(5, 128), { maxDurationSecs: 5, maxMemory: 128 * MIB });
  });

  it("leaves a value exactly at the cap untouched", () => {
    assert.deepEqual(clampModelLimits(300, 1024), { maxDurationSecs: 300, maxMemory: 1024 * MIB });
  });

  it("omits values that are not positive finite numbers", () => {
    assert.deepEqual(clampModelLimits(0, -1), {});
    assert.deepEqual(clampModelLimits(NaN, Infinity), {});
    assert.deepEqual(clampModelLimits("10", null), {});
    assert.deepEqual(clampModelLimits(undefined, undefined), {});
  });
});

// ── The repl tool wires the clamp into ReplRunner.run ────────────

describe("repl extension — the repl tool passes clamped limits (never 'unbounded')", () => {
  let cwd: string;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "repl-ext-clamp-"));
  });

  after(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  /**
   * Capture the `limits` argument the extension hands `ReplRunner.run`, with
   * the sandbox path stubbed out. This pins what reaches the runner — the seam
   * where an "unbounded" or an un-clamped value would show up — without
   * driving a real sandbox execution.
   */
  async function runWithLimits(params: Record<string, unknown>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const originalRun = ReplRunner.prototype.run;
    ReplRunner.prototype.run = (async (
      _code: string,
      _sessionId: string | undefined,
      _onApproval: unknown,
      _signal: AbortSignal | undefined,
      limits: unknown,
    ) => {
      seen.push(limits);
      return "[result]\n1";
    }) as unknown as typeof ReplRunner.prototype.run;

    try {
      const repl = (await loadTools()).find((t) => t.name === "repl");
      assert.ok(repl, "repl did not register");
      await repl.execute("clamp-1", params, undefined, undefined, {
        cwd,
        isProjectTrusted: () => true,
        hasUI: true,
        ui: { select: async () => APPROVE_CHOICE },
      });
    } finally {
      ReplRunner.prototype.run = originalRun;
    }
    return seen;
  }

  it("clamps an above-cap request before it reaches the runner", async () => {
    const seen = await runWithLimits({ code: "1 + 1", maxDurationSecs: 10_000, maxMemory: 2048 });
    assert.deepEqual(seen, [{ maxDurationSecs: 300, maxMemory: 1024 * 1_048_576 }]);
  });

  it("never emits 'unbounded', even with no limits supplied", async () => {
    const seen = await runWithLimits({ code: "1 + 1" });
    assert.equal(seen.length, 1);
    assert.notEqual(seen[0], "unbounded");
    assert.deepEqual(seen[0], {});
  });

  it("honours a below-cap request un-raised", async () => {
    const seen = await runWithLimits({ code: "1 + 1", maxDurationSecs: 5, maxMemory: 128 });
    assert.deepEqual(seen, [{ maxDurationSecs: 5, maxMemory: 128 * 1_048_576 }]);
  });
});

// ── Headless approval fails closed ───────────────────────────────
//
// `makeOnApproval` returns false when `ctx.hasUI === false`. The review found
// this correct in all four code paths and it is protected by nothing.
//
// Pinned deliberately now, ahead of bucket 5 (#51) rewriting `makeOnApproval`
// to use `ctx.ui.select` and return "suspend". That rewrite must not be allowed
// to regress fail-closed behaviour, and this is what will catch it.

describe("repl extension — headless approval", () => {
  let cwd: string;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "repl-ext-test-"));
  });

  after(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  function makeCtx(hasUI: boolean, approved: boolean) {
    const calls = { asked: 0 };
    return {
      calls,
      ctx: {
        cwd,
        isProjectTrusted: () => true,
        hasUI,
        ui: {
          select: async () => {
            calls.asked++;
            return approved ? APPROVE_CHOICE : DENY_CHOICE;
          },
        },
      },
    };
  }

  it("denies a gated call with no UI, without prompting or writing", async () => {
    const repl = (await loadTools()).find((t) => t.name === "repl");
    assert.ok(repl);

    const { ctx, calls } = makeCtx(false, true);
    const result = await repl.execute(
      "call-1",
      { code: "write('denied.txt', 'should not exist')" },
      undefined,
      undefined,
      ctx,
    );

    // The side effect is the assertion that matters. A test checking only the
    // returned message would pass against a `write` broken for other reasons.
    assert.equal(
      existsSync(join(cwd, "denied.txt")),
      false,
      "the gated write executed despite there being no UI to approve it",
    );

    // Never even asked: hasUI === false short-circuits before ctx.ui.select.
    assert.equal(calls.asked, 0, "the dialog opened with hasUI false");

    // And the model is told why, rather than the failure being silent.
    const text = result.content[0].text;
    assert.match(text, /PermissionError/);
    assert.match(text, /write/);
  });

  it("performs the same call when a UI approves it", async () => {
    const repl = (await loadTools()).find((t) => t.name === "repl");
    assert.ok(repl);

    const { ctx, calls } = makeCtx(true, true);
    await repl.execute(
      "call-2",
      { code: "write('approved.txt', 'written')" },
      undefined,
      undefined,
      ctx,
    );

    // The positive control. Without it the test above would still pass if
    // `write` were gated into uselessness, or never reached at all.
    assert.equal(
      existsSync(join(cwd, "approved.txt")),
      true,
      "an approved gated write did not happen",
    );
    assert.equal(calls.asked, 1, "expected exactly one approval prompt");
  });
});

// ── Approval mode (#44) ──────────────────────────────────────────

/**
 * `strict` is the default, and the escape hatch from it is a decision the user
 * makes deliberately — a command they type — rather than one inferred from a
 * click on a dialog that never offered it.
 *
 * The mode lives in the factory closure, so it is per-process and dies with
 * it. A fresh `load()` is a fresh process as far as these tests are concerned.
 */
describe("repl extension — approval mode", () => {
  let cwd: string;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "repl-ext-mode-"));
  });

  after(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("registers /repl-approvals", async () => {
    const { commands } = await load();
    assert.deepEqual(
      commands.map((c) => c.name),
      ["repl-approvals"],
    );
    assert.ok(commands[0].description, "the command needs a description to be discoverable");
  });

  it("reports the mode, and starts strict", async () => {
    const { commands } = await load();
    const { ctx, notes } = notifyCtx();

    await commands[0].handler("", ctx);

    assert.equal(notes.length, 1);
    assert.match(notes[0].message, /strict/);
  });

  it("rejects an unknown mode without changing anything", async () => {
    const { commands } = await load();
    const { ctx, notes } = notifyCtx();

    await commands[0].handler("yolo-ish", ctx);
    assert.equal(notes[0].type, "error");

    await commands[0].handler("", ctx);
    assert.match(notes[1].message, /strict/);
  });

  it("yolo runs a gated call without a prompt; strict puts the dialog back", async () => {
    const { tools, commands } = await load();
    const repl = tools.find((t) => t.name === "repl");
    assert.ok(repl);

    const dialogs = { count: 0 };
    const ctx = {
      cwd,
      isProjectTrusted: () => true,
      hasUI: true,
      ui: {
        select: async () => {
          dialogs.count++;
          return APPROVE_CHOICE;
        },
      },
    };

    await commands[0].handler("yolo", notifyCtx().ctx);
    await repl.execute("y-1", { code: "write('yolo.txt', 'x')" }, undefined, undefined, ctx);

    assert.equal(existsSync(join(cwd, "yolo.txt")), true, "yolo did not run the gated write");
    assert.equal(dialogs.count, 0, "yolo must not open a dialog");

    // And back. The toggle has to work in both directions or it is a one-way
    // door dressed up as a setting.
    await commands[0].handler("strict", notifyCtx().ctx);
    await repl.execute("y-2", { code: "write('strict.txt', 'x')" }, undefined, undefined, ctx);

    assert.equal(dialogs.count, 1, "strict must ask again");
    assert.equal(existsSync(join(cwd, "strict.txt")), true);
  });

  it("yolo does not apply headless — no UI still denies", async () => {
    const { tools, commands } = await load();
    const repl = tools.find((t) => t.name === "repl");
    assert.ok(repl);

    await commands[0].handler("yolo", notifyCtx().ctx);

    const result = await repl.execute(
      "y-3",
      { code: "write('headless-yolo.txt', 'x')" },
      undefined,
      undefined,
      {
        cwd,
        isProjectTrusted: () => true,
        hasUI: false,
        ui: { select: async () => APPROVE_CHOICE },
      },
    );

    assert.equal(
      existsSync(join(cwd, "headless-yolo.txt")),
      false,
      "a headless run approved a gated write because a mode was set in-process",
    );
    assert.match(result.content[0].text, /PermissionError/);
  });
});

// ── Concurrency and dialog lifetime (#49) ────────────────────────
//
// `ToolDefinition.executionMode` defaults to `parallel`, so two `repl` calls
// in one assistant message run at the same time. Pi's dialog cannot survive
// that: `showExtensionSelector` assigns `this.extensionSelector` before
// disposing what was there, and `disposeActiveSelector()` only touches the
// *built-in* selector slot — so the second dialog orphans the first without
// invoking its `onSelect`/`onCancel`, and the first `await ctx.ui.confirm`
// never resolves. Abort does not rescue it either: the agent loop still awaits
// every in-flight tool, so Escape becomes a permanent no-op.
//
// The tests below drive the defect rather than the declaration — an assertion
// that `executionMode` is set would pass against a dialog that still hangs.

/** Deadline wrapper: turns "this never settled" into a failure, not a hang. */
async function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Poll until `predicate` holds, or give up. */
async function waitFor(predicate: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${what} within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

type DialogOpts = { signal?: AbortSignal; timeout?: number };

/**
 * A `ui.select` that reproduces the bug above: no user answer ever settles
 * it, and opening a second one orphans the first. Only `opts.signal` and
 * `opts.timeout` can settle a dialog here — which is exactly the property the
 * real component has, and exactly why the extension passes both.
 *
 * A dismissed `select` resolves `undefined` rather than the `false` its
 * `confirm` predecessor returned. That difference is the point of #51: the
 * extension is what turns "no answer" into a denial, and this fake hands it
 * the ambiguous value so the mapping is under test rather than assumed.
 */
function clobberingSelect() {
  const opened: DialogOpts[] = [];
  const timers: NodeJS.Timeout[] = [];

  const select = (
    _title: string,
    _options: string[],
    opts?: DialogOpts,
  ): Promise<string | undefined> => {
    opened.push({ signal: opts?.signal, timeout: opts?.timeout });
    return new Promise<string | undefined>((resolve) => {
      if (opts?.signal?.aborted) {
        resolve(undefined);
        return;
      }
      opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
      if (opts?.timeout && opts.timeout > 0) {
        timers.push(setTimeout(() => resolve(undefined), opts.timeout));
      }
    });
  };

  const dispose = () => {
    for (const t of timers) clearTimeout(t);
  };

  return { opened, select, dispose };
}

describe("repl extension — a dialog always settles (#49)", () => {
  let cwd: string;
  let priorTimeout: string | undefined;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "repl-ext-hang-"));
    priorTimeout = process.env.REPL_APPROVAL_TIMEOUT_MS;
  });

  after(() => {
    if (priorTimeout === undefined) delete process.env.REPL_APPROVAL_TIMEOUT_MS;
    else process.env.REPL_APPROVAL_TIMEOUT_MS = priorTimeout;
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("declares executionMode sequential on all four tools", async () => {
    // Cheap guard against someone removing it later without understanding
    // why it is there. The three tests below are the reason.
    for (const tool of await loadTools()) {
      assert.equal(
        (tool as unknown as { executionMode?: string }).executionMode,
        "sequential",
        `${tool.name} would run concurrently with other tool calls`,
      );
    }
  });

  it("bounds the dialog by default, without being asked to", async () => {
    delete process.env.REPL_APPROVAL_TIMEOUT_MS;

    const repl = (await loadTools()).find((t) => t.name === "repl");
    assert.ok(repl);
    const ui = clobberingSelect();
    const controller = new AbortController();

    // What is asserted is the bound the dialog was opened with — waiting the
    // real default out would take five minutes — so the call is abandoned
    // through its signal rather than left dangling and holding a worker.
    const pending = repl.execute(
      "d-1",
      { code: "write('default.txt', 'x')", sessionId: "hang-default" },
      controller.signal,
      undefined,
      { cwd, isProjectTrusted: () => true, hasUI: true, ui: { select: ui.select } },
    );

    await waitFor(() => ui.opened.length === 1, 15_000, "no dialog opened");
    assert.equal(ui.opened[0].timeout, 300_000, "the dialog was opened unbounded");

    controller.abort();
    await withDeadline(pending, 15_000, "the abandoned repl call never returned");
    ui.dispose();
  });

  it("settles on the dialog timeout, denying", async () => {
    process.env.REPL_APPROVAL_TIMEOUT_MS = "200";

    const repl = (await loadTools()).find((t) => t.name === "repl");
    assert.ok(repl);
    const ui = clobberingSelect();

    const result = await withDeadline(
      repl.execute(
        "t-1",
        { code: "write('timeout.txt', 'x')", sessionId: "hang-timeout" },
        undefined,
        undefined,
        { cwd, isProjectTrusted: () => true, hasUI: true, ui: { select: ui.select } },
      ),
      15_000,
      "the repl call never returned",
    );

    assert.equal(ui.opened[0]?.timeout, 200);
    assert.match(result.content[0].text, /PermissionError/);
    assert.equal(
      existsSync(join(cwd, "timeout.txt")),
      false,
      "an expired dialog approved the write it never asked about",
    );

    ui.dispose();
  });

  it("settles on abort, so Escape is not a no-op", async () => {
    // Unbounded on purpose: with no timeout, the signal is the only thing
    // that can settle this dialog, which is what the test is for.
    process.env.REPL_APPROVAL_TIMEOUT_MS = "0";

    const repl = (await loadTools()).find((t) => t.name === "repl");
    assert.ok(repl);
    const ui = clobberingSelect();
    const controller = new AbortController();

    const pending = repl.execute(
      "a-1",
      { code: "write('abort.txt', 'x')", sessionId: "hang-abort" },
      controller.signal,
      undefined,
      { cwd, isProjectTrusted: () => true, hasUI: true, ui: { select: ui.select } },
    );

    await waitFor(() => ui.opened.length === 1, 15_000, "no dialog opened");
    assert.equal(ui.opened[0].timeout, undefined, "the timeout was not opted out of");
    assert.ok(ui.opened[0].signal, "the dialog was opened without a signal");

    controller.abort();

    const result = await withDeadline(pending, 15_000, "the aborted repl call never returned");

    // Either shape is a settled promise with a decision in it: the denial
    // reaches the sandbox, or the abort cuts the run off first.
    assert.match(result.content[0].text, /PermissionError|aborted/);
    assert.equal(
      existsSync(join(cwd, "abort.txt")),
      false,
      "an aborted call wrote the file it was asking permission for",
    );

    ui.dispose();
  });

  it("settles both calls when two dialogs are open at once", async () => {
    // The defect itself. Two gated calls, concurrent, on the clobbering
    // dialog: the first is orphaned the moment the second opens, and only the
    // timeout can settle it.
    process.env.REPL_APPROVAL_TIMEOUT_MS = "200";

    const repl = (await loadTools()).find((t) => t.name === "repl");
    assert.ok(repl);
    const ui = clobberingSelect();
    const ctx = { cwd, isProjectTrusted: () => true, hasUI: true, ui: { select: ui.select } };

    const results = await withDeadline(
      Promise.all([
        repl.execute(
          "p-1",
          { code: "write('par-a.txt', 'x')", sessionId: "hang-par-a" },
          undefined,
          undefined,
          ctx,
        ),
        repl.execute(
          "p-2",
          { code: "write('par-b.txt', 'x')", sessionId: "hang-par-b" },
          undefined,
          undefined,
          ctx,
        ),
      ]),
      30_000,
      "a concurrent repl call was left dangling",
    );

    assert.equal(results.length, 2);
    for (const r of results) {
      assert.match(r.content[0].text, /PermissionError/);
    }
    assert.equal(ui.opened.length, 2, "both calls should have asked");

    ui.dispose();
  });
});

// ── repl_reset surfaces the approval state (#44) ─────────────────

describe("repl extension — repl_reset reports approvals", () => {
  let cwd: string;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "repl-ext-reset-"));
  });

  after(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  const ctx = () => ({
    cwd,
    isProjectTrusted: () => true,
    hasUI: true,
    ui: { select: async () => APPROVE_CHOICE },
  });

  it("names the mode and says nothing is outstanding", async () => {
    const { tools } = await load();
    const repl = tools.find((t) => t.name === "repl");
    const reset = tools.find((t) => t.name === "repl_reset");
    assert.ok(repl);
    assert.ok(reset);

    // The session has to exist for a reset to be about anything — this test
    // used to reset a session that was never created and assert it said
    // "reset", which is the [N12] defect stated as an expectation (#48).
    await repl.execute("r-0", { code: "x = 1" }, undefined, undefined, ctx());

    const result = await reset.execute("r-1", {}, undefined, undefined, ctx());

    const text = result.content[0].text;
    assert.match(text, /Session 'default' reset/);
    assert.match(text, /Approval mode: strict/);
    assert.match(text, /No approval grants were outstanding/);
  });

  it("does not claim to have reset a session that never existed ([N12])", async () => {
    const { tools } = await load();
    const reset = tools.find((t) => t.name === "repl_reset");
    assert.ok(reset);

    const result = await reset.execute(
      "r-2",
      { sessionId: "never-ran" },
      undefined,
      undefined,
      ctx(),
    );

    const text = result.content[0].text;
    assert.match(text, /No session 'never-ran' exists/);
    assert.doesNotMatch(text, /'never-ran' reset/);
    // Nothing was held, so there is nothing to report about grants.
    assert.doesNotMatch(text, /grants/);
    assert.match(text, /Approval mode: strict/);
  });
});

// ── repl_abandon tells the two empty states apart (#48) ──────────

describe("repl extension — repl_abandon distinguishes its empty states", () => {
  let cwd: string;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "repl-ext-abandon-"));
  });

  after(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("says 'no such session' and 'nothing pending' differently", async () => {
    const { tools } = await load();
    const repl = tools.find((t) => t.name === "repl");
    const abandon = tools.find((t) => t.name === "repl_abandon");
    assert.ok(repl);
    assert.ok(abandon);

    const ctx = () => ({
      cwd,
      isProjectTrusted: () => true,
      hasUI: true,
      ui: { select: async () => APPROVE_CHOICE },
    });

    const unknown = await abandon.execute(
      "a-1",
      { sessionId: "never-ran" },
      undefined,
      undefined,
      ctx(),
    );
    assert.match(unknown.content[0].text, /No session 'never-ran' exists/);

    await repl.execute("a-2", { code: "x = 1" }, undefined, undefined, ctx());
    const quiet = await abandon.execute("a-3", {}, undefined, undefined, ctx());

    assert.match(quiet.content[0].text, /no pending approval/i);
    assert.doesNotMatch(
      quiet.content[0].text,
      /No session/,
      "the session exists — saying otherwise sends the model to create it again",
    );
  });
});

// ── Suspension is reachable (#51) ────────────────────────────────
//
// `status: "suspended"` was designed, typed and implemented, and then thrown
// away twice on the way to the user: `makeOnApproval` could only answer
// `boolean`, and `Session.resume` narrowed whatever it was given with
// `d === true`. Either layer alone was enough to make "decide later"
// unreachable, so these tests drive the whole seam — the real extension, the
// real sandbox, and a real file on disk — rather than one side of it.

/**
 * A `ui.select` that answers with a scripted sequence of choices.
 *
 * `undefined` is a legal answer and means the dialog was dismissed — Escape,
 * the timeout, or an abort. An unscripted dialog throws rather than defaulting,
 * because a test that opened one more dialog than it meant to is a test whose
 * subject has changed.
 */
function scriptedSelect(answers: Array<string | undefined>) {
  const opened: Array<{ title: string; options: string[] }> = [];
  let next = 0;

  const select = async (title: string, options: string[]): Promise<string | undefined> => {
    opened.push({ title, options });
    if (next >= answers.length) throw new Error(`unscripted approval dialog: ${title}`);
    return answers[next++];
  };

  return { opened, select, answered: () => next };
}

describe("repl extension — suspension is reachable (#51)", () => {
  let cwd: string;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "repl-ext-suspend-"));
  });

  after(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("offers approve, deny and decide-later, and names the call in the title", async () => {
    const repl = (await loadTools()).find((t) => t.name === "repl");
    assert.ok(repl);

    const ui = scriptedSelect([DENY_CHOICE]);
    await repl.execute(
      "s-0",
      { code: "write('offered.txt', 'x')", sessionId: "offered" },
      undefined,
      undefined,
      { cwd, isProjectTrusted: () => true, hasUI: true, ui: { select: ui.select } },
    );

    assert.equal(ui.opened.length, 1);
    assert.deepEqual(
      ui.opened[0].options,
      [APPROVE_CHOICE, DENY_CHOICE, LATER_CHOICE],
      "a dialog that does not offer the third answer makes suspension unreachable again",
    );
    // The user has to be told what they are approving; `select` has no message
    // parameter, so the description has to be in the title.
    assert.match(ui.opened[0].title, /write/);
    assert.match(ui.opened[0].title, /offered\.txt/);
  });

  it("decide later → repl_resume → approve completes the call", async () => {
    const { tools } = await load();
    const repl = tools.find((t) => t.name === "repl");
    const resume = tools.find((t) => t.name === "repl_resume");
    assert.ok(repl);
    assert.ok(resume);

    // Decide later at the first dialog, again at the second — the answer has
    // to survive `Session.resume` too, not only `makeOnApproval` — and approve
    // at the third.
    const ui = scriptedSelect([LATER_CHOICE, LATER_CHOICE, APPROVE_CHOICE]);
    const ctx = { cwd, isProjectTrusted: () => true, hasUI: true, ui: { select: ui.select } };

    const suspended = await repl.execute(
      "s-1",
      { code: "write('round-trip.txt', 'v1')", sessionId: "rt" },
      undefined,
      undefined,
      ctx,
    );

    assert.match(suspended.content[0].text, /requires approval/);
    assert.match(
      suspended.content[0].text,
      /repl_resume\(sessionId='rt'\)/,
      "the model cannot resume a session it is not told the name of (#48)",
    );
    assert.equal(
      existsSync(join(cwd, "round-trip.txt")),
      false,
      "a suspended call is a call that has not run",
    );

    // Still undecided: the session stays suspended and nothing has happened.
    const again = await resume.execute("s-2", { sessionId: "rt" }, undefined, undefined, ctx);
    assert.match(
      again.content[0].text,
      /requires approval/,
      "a second 'decide later' was collapsed into a denial",
    );
    assert.equal(existsSync(join(cwd, "round-trip.txt")), false);

    const done = await resume.execute("s-3", { sessionId: "rt" }, undefined, undefined, ctx);

    assert.doesNotMatch(done.content[0].text, /PermissionError/);
    assert.equal(
      readFileSync(join(cwd, "round-trip.txt"), "utf8"),
      "v1",
      "the approved call never ran",
    );
    assert.equal(ui.answered(), 3, "expected exactly three dialogs");
  });

  it("decide later → repl_resume → deny raises PermissionError and leaves the session usable", async () => {
    const { tools } = await load();
    const repl = tools.find((t) => t.name === "repl");
    const resume = tools.find((t) => t.name === "repl_resume");
    assert.ok(repl);
    assert.ok(resume);

    const ui = scriptedSelect([LATER_CHOICE, DENY_CHOICE]);
    const ctx = { cwd, isProjectTrusted: () => true, hasUI: true, ui: { select: ui.select } };

    await repl.execute(
      "d-1",
      { code: "write('denied-later.txt', 'v1')", sessionId: "deny-rt" },
      undefined,
      undefined,
      ctx,
    );

    const denied = await resume.execute("d-2", { sessionId: "deny-rt" }, undefined, undefined, ctx);

    assert.match(denied.content[0].text, /PermissionError/);
    assert.equal(existsSync(join(cwd, "denied-later.txt")), false);

    // A denial ends the call, not the session (#50). Nothing is left pending,
    // and the next snippet runs — with no dialog, so the script does not need
    // a fourth answer.
    const after = await repl.execute(
      "d-3",
      { code: "2 + 3", sessionId: "deny-rt" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(after.content[0].text, /\[result\]\n5/);
    assert.doesNotMatch(after.content[0].text, /discarded/i);
  });

  it("decide later → repl_abandon discards the call and the session continues", async () => {
    const { tools } = await load();
    const repl = tools.find((t) => t.name === "repl");
    const abandon = tools.find((t) => t.name === "repl_abandon");
    assert.ok(repl);
    assert.ok(abandon);

    const ui = scriptedSelect([LATER_CHOICE]);
    const ctx = { cwd, isProjectTrusted: () => true, hasUI: true, ui: { select: ui.select } };

    await repl.execute(
      "b-1",
      { code: "kept = 7\nwrite('abandoned.txt', 'v1')", sessionId: "aband" },
      undefined,
      undefined,
      ctx,
    );

    const dropped = await abandon.execute("b-2", { sessionId: "aband" }, undefined, undefined, ctx);
    assert.match(dropped.content[0].text, /discarded|abandoned/i);

    // The snippet never completed, so `kept` is not part of the session — but
    // the session itself is fine and takes new code.
    const after = await repl.execute(
      "b-3",
      { code: "kept = 8\nkept", sessionId: "aband" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(after.content[0].text, /\[result\]\n8/);
    assert.equal(
      existsSync(join(cwd, "abandoned.txt")),
      false,
      "an abandoned call ran its side effect anyway",
    );
  });

  it("a dismissed dialog denies — Escape is not 'decide later' and not 'yes'", async () => {
    const { tools } = await load();
    const repl = tools.find((t) => t.name === "repl");
    const abandon = tools.find((t) => t.name === "repl_abandon");
    assert.ok(repl);
    assert.ok(abandon);

    const ui = scriptedSelect([undefined]);
    const ctx = { cwd, isProjectTrusted: () => true, hasUI: true, ui: { select: ui.select } };

    const result = await repl.execute(
      "e-1",
      { code: "write('escaped.txt', 'v1')", sessionId: "escape" },
      undefined,
      undefined,
      ctx,
    );

    assert.match(result.content[0].text, /PermissionError/);
    assert.equal(
      existsSync(join(cwd, "escaped.txt")),
      false,
      "a dismissed dialog approved the call it never asked about",
    );

    // And it is a decision, not a deferral: nothing is left waiting.
    const pending = await abandon.execute(
      "e-2",
      { sessionId: "escape" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(pending.content[0].text, /no pending approval/i);
  });

  it("a headless resume still denies, with no dialog to ask (M22's sibling)", async () => {
    const { tools } = await load();
    const repl = tools.find((t) => t.name === "repl");
    const resume = tools.find((t) => t.name === "repl_resume");
    assert.ok(repl);
    assert.ok(resume);

    const ui = scriptedSelect([LATER_CHOICE]);

    await repl.execute(
      "h-1",
      { code: "write('headless-resume.txt', 'v1')", sessionId: "headless" },
      undefined,
      undefined,
      { cwd, isProjectTrusted: () => true, hasUI: true, ui: { select: ui.select } },
    );

    // Same session, now with nobody at the terminal. `hasUI === false`
    // short-circuits before any dialog, on the resume path as on the run path.
    const denied = await resume.execute("h-2", { sessionId: "headless" }, undefined, undefined, {
      cwd,
      isProjectTrusted: () => true,
      hasUI: false,
      ui: { select: ui.select },
    });

    assert.match(denied.content[0].text, /PermissionError/);
    assert.equal(existsSync(join(cwd, "headless-resume.txt")), false);
    assert.equal(ui.answered(), 1, "a headless resume opened a dialog");
  });
});

// ── Project trust gates the preamble (#53) ───────────────────────

/**
 * The end-to-end shape of #53, through the tool a model actually calls.
 *
 * `.pi/code-tools/*.py` executes before user code on every run with full
 * host-tool access and no approval, and `.pi/` travels with a clone — so a
 * hostile repository only had to be opened. `ctx.isProjectTrusted()` is the
 * gate; these two tests are the same repository on either side of it.
 */
describe("repl extension — project trust gates the preamble (#53)", () => {
  let cwd: string;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "repl-ext-trust-"));
    mkdirSync(join(cwd, ".pi", "code-tools"), { recursive: true });
    // The side effect is the assertion. A test that only read the returned
    // message would pass against a preamble broken for unrelated reasons.
    writeFileSync(join(cwd, ".pi", "code-tools", "hostile.py"), "write('pwned.txt', 'owned')\n");
  });

  after(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  function trustCtx(trusted: boolean) {
    const dialogs = { count: 0 };
    return {
      dialogs,
      ctx: {
        cwd,
        isProjectTrusted: () => trusted,
        hasUI: true,
        ui: {
          select: async () => {
            dialogs.count++;
            return APPROVE_CHOICE;
          },
        },
      },
    };
  }

  it("does not run an untrusted project's saved tools, and says so", async () => {
    const repl = (await loadTools()).find((t) => t.name === "repl");
    assert.ok(repl);

    const { ctx, dialogs } = trustCtx(false);
    const result = await repl.execute("t-1", { code: "1 + 1" }, undefined, undefined, ctx);

    assert.equal(
      existsSync(join(cwd, "pwned.txt")),
      false,
      "an untrusted project's preamble executed through the real tool",
    );
    assert.equal(dialogs.count, 0, "the hostile preamble reached the approval dialog");
    assert.match(result.content[0].text, /preamble withheld/);
    assert.match(result.content[0].text, /hostile/);
  });

  it("runs the same tools once the project is trusted", async () => {
    const repl = (await loadTools()).find((t) => t.name === "repl");
    assert.ok(repl);

    const { ctx } = trustCtx(true);
    const result = await repl.execute("t-2", { code: "1 + 1" }, undefined, undefined, ctx);

    assert.equal(readFileSync(join(cwd, "pwned.txt"), "utf8"), "owned");
    assert.doesNotMatch(result.content[0].text, /preamble withheld/);
  });
});

// ── End-to-end abort between gated host calls (D7 test 1) ────────
//
// The signal is already plumbed end to end (`ReplRunner.run` → `Session.run` →
// sandbox), and the `#49` tests above abort at the approval *dialog* before any
// host tool has run. This pins the other half of the abort contract: an abort
// that lands **between pause points** — after a gated host tool has executed
// and returned, before a later gated call runs — stops the later call from
// ever being dispatched.
//
// The abort is raised inside the approval callback for the FIRST gated call
// (that callback is a pause point), which then approves the call in flight.
// The sandbox notices `signal.aborted` at the top of its next dispatch-loop
// iteration — after the first `write` has executed and resumed Python — and
// returns `aborted` before the second `write` reaches the gate. The assertion
// is the side-effect counter, not the status string: one approval asked, the
// first file written, the second file absent.

describe("repl extension — abort between gated host calls (D7 test 1)", () => {
  let cwd: string;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "repl-ext-abort-mid-"));
  });

  after(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("stops a later gated call once the run is aborted after the first returns", async () => {
    const runner = new ReplRunner(cwd);

    const controller = new AbortController();
    const prompts: string[] = [];
    const out = await runner.run(
      "write('first.txt', 'one')\nwrite('second.txt', 'two')",
      "abort-mid",
      async (req) => {
        prompts.push(req.tool);
        // Abort at the first pause point, approve the call in flight, and let
        // the loop notice the abort on its next iteration — after the first
        // write has executed and returned.
        controller.abort();
        return true;
      },
      controller.signal,
    );

    // The discriminating assertions are the side effects, not the status: the
    // first gated call really ran, the second never reached the approval gate
    // (let alone executed).
    assert.deepEqual(prompts, ["write"], "the second gated call was dispatched to the gate");
    assert.equal(
      readFileSync(join(cwd, "first.txt"), "utf8"),
      "one",
      "the first call never ran",
    );
    assert.equal(
      existsSync(join(cwd, "second.txt")),
      false,
      "the second gated call executed despite the abort",
    );
    // Context, not the assertion itself: the run reports the abort.
    assert.match(out, /\[error: aborted\]/);
  });
});
