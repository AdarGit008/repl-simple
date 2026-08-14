import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
    const calls = { confirm: 0 };
    return {
      calls,
      ctx: {
        cwd,
        hasUI,
        ui: {
          confirm: async () => {
            calls.confirm++;
            return approved;
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

    // Never even asked: hasUI === false short-circuits before ctx.ui.confirm.
    assert.equal(calls.confirm, 0, "confirm was called with hasUI false");

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
    assert.equal(calls.confirm, 1, "expected exactly one approval prompt");
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

    const confirms = { count: 0 };
    const ctx = {
      cwd,
      hasUI: true,
      ui: {
        confirm: async () => {
          confirms.count++;
          return true;
        },
      },
    };

    await commands[0].handler("yolo", notifyCtx().ctx);
    await repl.execute("y-1", { code: "write('yolo.txt', 'x')" }, undefined, undefined, ctx);

    assert.equal(existsSync(join(cwd, "yolo.txt")), true, "yolo did not run the gated write");
    assert.equal(confirms.count, 0, "yolo must not open a dialog");

    // And back. The toggle has to work in both directions or it is a one-way
    // door dressed up as a setting.
    await commands[0].handler("strict", notifyCtx().ctx);
    await repl.execute("y-2", { code: "write('strict.txt', 'x')" }, undefined, undefined, ctx);

    assert.equal(confirms.count, 1, "strict must ask again");
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
      { cwd, hasUI: false, ui: { confirm: async () => true } },
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
 * A `ui.confirm` that reproduces the bug above: no user answer ever settles
 * it, and opening a second one orphans the first. Only `opts.signal` and
 * `opts.timeout` can settle a dialog here — which is exactly the property the
 * real component has, and exactly why the extension passes both.
 */
function clobberingConfirm() {
  const opened: DialogOpts[] = [];
  const timers: NodeJS.Timeout[] = [];

  const confirm = (_title: string, _message: string, opts?: DialogOpts): Promise<boolean> => {
    opened.push({ signal: opts?.signal, timeout: opts?.timeout });
    return new Promise<boolean>((resolve) => {
      if (opts?.signal?.aborted) {
        resolve(false);
        return;
      }
      opts?.signal?.addEventListener("abort", () => resolve(false), { once: true });
      if (opts?.timeout && opts.timeout > 0) {
        timers.push(setTimeout(() => resolve(false), opts.timeout));
      }
    });
  };

  const dispose = () => {
    for (const t of timers) clearTimeout(t);
  };

  return { opened, confirm, dispose };
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
    const ui = clobberingConfirm();
    const controller = new AbortController();

    // What is asserted is the bound the dialog was opened with — waiting the
    // real default out would take five minutes — so the call is abandoned
    // through its signal rather than left dangling and holding a worker.
    const pending = repl.execute(
      "d-1",
      { code: "write('default.txt', 'x')", sessionId: "hang-default" },
      controller.signal,
      undefined,
      { cwd, hasUI: true, ui: { confirm: ui.confirm } },
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
    const ui = clobberingConfirm();

    const result = await withDeadline(
      repl.execute(
        "t-1",
        { code: "write('timeout.txt', 'x')", sessionId: "hang-timeout" },
        undefined,
        undefined,
        { cwd, hasUI: true, ui: { confirm: ui.confirm } },
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
    const ui = clobberingConfirm();
    const controller = new AbortController();

    const pending = repl.execute(
      "a-1",
      { code: "write('abort.txt', 'x')", sessionId: "hang-abort" },
      controller.signal,
      undefined,
      { cwd, hasUI: true, ui: { confirm: ui.confirm } },
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
    const ui = clobberingConfirm();
    const ctx = { cwd, hasUI: true, ui: { confirm: ui.confirm } };

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

  const ctx = () => ({ cwd, hasUI: true, ui: { confirm: async () => true } });

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

    const ctx = () => ({ cwd, hasUI: true, ui: { confirm: async () => true } });

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
