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
// The #35 constants are read off the namespace rather than named-imported so
// that this file still *loads* against an extension that predates them: the
// RED check runs these tests against main's `extensions/`, and a missing
// named export is a link error that fails every test here, not the ones
// about the cap. On such an extension they are `undefined`, and only the
// assertions that use them fail.
import * as extension from "../extensions/repl-extension.js";
import { ReplRunner } from "../src/repl.js";
import { withPatchedPrototype } from "./support/prototype-patch.js";

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
 * A lifecycle handler as the extension hands it to `pi.on` — the shape of
 * pi's `ExtensionHandler<SessionStartEvent | SessionShutdownEvent>`
 * (`types.d.ts:862`), with the context left loose because each test builds
 * only the part of `ExtensionContext` the handler under test reads.
 */
type LifecycleHandler = (
  event: { type: string; reason: string },
  ctx: unknown,
) => void | Promise<void>;

/**
 * Invoke the extension factory and collect what it registers.
 *
 * The module is import-cached, but each `default()` call builds a fresh
 * closure — and therefore fresh runners *and* a fresh approval mode — so
 * callers get independent state. Tests that switch the mode rely on that
 * isolation. This is also what pi does: the factory is re-run for every
 * conversation (`loader.js:407-409`), so one `load()` is one Pi session.
 *
 * `on` collects lifecycle handlers by event name so `fire` can drive them the
 * way pi's runner does (#60).
 */
async function load(): Promise<{
  tools: RegisteredTool[];
  commands: RegisteredCommand[];
  handlers: Map<string, LifecycleHandler[]>;
}> {
  const tools: RegisteredTool[] = [];
  const commands: RegisteredCommand[] = [];
  const handlers = new Map<string, LifecycleHandler[]>();
  const mod = await import("../extensions/repl-extension.js");
  mod.default({
    registerTool: (t: unknown) => tools.push(t as RegisteredTool),
    registerCommand: (name: string, options: unknown) =>
      commands.push({ name, ...(options as Omit<RegisteredCommand, "name">) }),
    on: (event: string, handler: LifecycleHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as never);
  return { tools, commands, handlers };
}

/**
 * Fire a lifecycle event the way pi's extension runner does: every handler
 * registered for it, in registration order, each awaited.
 *
 * Fails when nothing is registered. A test that fires an event the extension
 * never subscribed to would otherwise pass by doing nothing.
 */
async function fire(
  handlers: Map<string, LifecycleHandler[]>,
  type: "session_start" | "session_shutdown",
  reason: string,
  ctx: unknown,
): Promise<void> {
  const list = handlers.get(type) ?? [];
  assert.ok(list.length > 0, `the extension registered no ${type} handler`);
  for (const handler of list) await handler({ type, reason }, ctx);
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
    assert.match(
      repl.parameters.properties.maxDurationSecs?.description ?? "",
      /capped at 300, or lower/,
    );
    assert.match(
      repl.parameters.properties.maxMemory?.description ?? "",
      /capped at 1024, or lower/,
    );
  });

  it("documents the cancellation boundary in the repl description (D6)", async () => {
    const repl = (await loadTools()).find((t) => t.name === "repl");
    assert.ok(repl, "repl did not register");

    // The description must promise only what the implementation can deliver:
    // cancellation applies at tool-call pause points, never inside a
    // pure-Python loop, where only maxDurationSecs bounds the run.
    assert.match(repl.description, /stops it between tool calls/);
    assert.match(repl.description, /pure-Python loop with no pause points/);
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
// never trusted. `clampModelLimits` is a small helper so it is tested directly
// rather than only through the sandbox path.

describe("repl extension — clampModelLimits", () => {
  const MIB = 1_048_576;

  // Hermetic default-ceiling tests (D7): an ambient REPL_* var in the outer
  // `npm test` process must not turn the 30 s / 512 MiB assertions into
  // failures. Snapshot and clear both vars for the block, restore after.
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

  it("clamps an above-cap maxDurationSecs to the derived ceiling", () => {
    assert.deepEqual(clampModelLimits(10_000, undefined), { maxDurationSecs: 30 });
  });

  it("clamps an above-cap maxMemory to the derived ceiling, in bytes", () => {
    assert.deepEqual(clampModelLimits(undefined, 2048), { maxMemory: 512 * MIB });
  });

  it("honours shorter/smaller requests — the clamp is a ceiling, not a floor", () => {
    assert.deepEqual(clampModelLimits(5, 128), { maxDurationSecs: 5, maxMemory: 128 * MIB });
  });

  it("clamps both knobs to their derived ceilings", () => {
    assert.deepEqual(clampModelLimits(300, 1024), { maxDurationSecs: 30, maxMemory: 512 * MIB });
  });

  it("clamps a just-above-cap duration to the derived ceiling and converts fractional MiB exactly", () => {
    assert.deepEqual(clampModelLimits(301, undefined), { maxDurationSecs: 30 });
    assert.deepEqual(clampModelLimits(undefined, 0.5), { maxMemory: 524288 });
  });

  it("floors a sub-MiB memory request to a whole number of bytes", () => {
    assert.deepEqual(clampModelLimits(undefined, 0.1), { maxMemory: 104857 });
  });

  it("omits a sub-byte memory request instead of forwarding zero bytes", () => {
    assert.deepEqual(clampModelLimits(undefined, 1e-7), {});
  });

  it("omits values that are not positive finite numbers", () => {
    assert.deepEqual(clampModelLimits(0, -1), {});
    assert.deepEqual(clampModelLimits(NaN, Infinity), {});
    assert.deepEqual(clampModelLimits("10", null), {});
    assert.deepEqual(clampModelLimits(undefined, undefined), {});
  });

  it("caps maxMemory at the operator's REPL_MAX_MEMORY_MB ceiling", () => {
    const prior = process.env.REPL_MAX_MEMORY_MB;
    process.env.REPL_MAX_MEMORY_MB = "256";
    try {
      assert.deepEqual(clampModelLimits(undefined, 1024), { maxMemory: 256 * MIB });
    } finally {
      if (prior === undefined) delete process.env.REPL_MAX_MEMORY_MB;
      else process.env.REPL_MAX_MEMORY_MB = prior;
    }
  });

  it("caps maxDurationSecs at the operator's REPL_MAX_DURATION_SECS ceiling", () => {
    const prior = process.env.REPL_MAX_DURATION_SECS;
    process.env.REPL_MAX_DURATION_SECS = "10";
    try {
      assert.deepEqual(clampModelLimits(1000, undefined), { maxDurationSecs: 10 });
    } finally {
      if (prior === undefined) delete process.env.REPL_MAX_DURATION_SECS;
      else process.env.REPL_MAX_DURATION_SECS = prior;
    }
  });

  it("a raised operator env is still spec-capped", () => {
    // The `Math.min(specCap, cfg)` constant-side branch: an operator knob raised
    // above the spec caps must NOT raise the ceiling past 300 s / 1024 MiB.
    const priorMem = process.env.REPL_MAX_MEMORY_MB;
    const priorDur = process.env.REPL_MAX_DURATION_SECS;
    process.env.REPL_MAX_MEMORY_MB = "2048";
    process.env.REPL_MAX_DURATION_SECS = "1000";
    try {
      assert.deepEqual(clampModelLimits(undefined, 2048), { maxMemory: 1024 * MIB });
      assert.deepEqual(clampModelLimits(1000, undefined), { maxDurationSecs: 300 });
    } finally {
      if (priorMem === undefined) delete process.env.REPL_MAX_MEMORY_MB;
      else process.env.REPL_MAX_MEMORY_MB = priorMem;
      if (priorDur === undefined) delete process.env.REPL_MAX_DURATION_SECS;
      else process.env.REPL_MAX_DURATION_SECS = priorDur;
    }
  });

  it("boundary equality against the derived default ceiling", () => {
    // No env override, so the derived ceilings are the sandbox defaults
    // (30 s / 512 MiB). A value equal to the ceiling is honoured, not clamped down.
    assert.deepEqual(clampModelLimits(30, undefined), { maxDurationSecs: 30 });
    assert.deepEqual(clampModelLimits(undefined, 512), { maxMemory: 512 * MIB });
  });

  it("boundary equality under an env override", () => {
    // A request exactly at the operator's ceiling is honoured, not clamped
    // down: clampCeiling is upper-bound-only, so equality survives.
    const prior = process.env.REPL_MAX_MEMORY_MB;
    process.env.REPL_MAX_MEMORY_MB = "256";
    try {
      assert.deepEqual(clampModelLimits(undefined, 256), { maxMemory: 256 * MIB });
    } finally {
      if (prior === undefined) delete process.env.REPL_MAX_MEMORY_MB;
      else process.env.REPL_MAX_MEMORY_MB = prior;
    }
  });

  it("invalid env falls back to the default ceiling", () => {
    // `envInt` treats an unparseable value as a typo and falls back to the
    // 512 MiB default, so the derived ceiling is the default, not the spec cap.
    const prior = process.env.REPL_MAX_MEMORY_MB;
    process.env.REPL_MAX_MEMORY_MB = "abc";
    try {
      assert.deepEqual(clampModelLimits(undefined, 2048), { maxMemory: 512 * MIB });
    } finally {
      if (prior === undefined) delete process.env.REPL_MAX_MEMORY_MB;
      else process.env.REPL_MAX_MEMORY_MB = prior;
    }
  });
});

// ── The repl tool wires the clamp into ReplRunner.run ────────────

describe("repl extension — the repl tool passes clamped limits (never 'unbounded')", () => {
  let cwd: string;
  // Hermeticity: the assertions below pin the derived default ceilings (30 s /
  // 512 MiB). Clear any ambient REPL_* vars so an outer `REPL_MAX_...=... npm
  // test` cannot break them, and restore them afterwards.
  let priorDuration: string | undefined;
  let priorMemory: string | undefined;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "repl-ext-clamp-"));
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
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  /**
   * Capture the `limits` argument the extension hands `ReplRunner.run`, with
   * the sandbox path stubbed out. This pins what reaches the runner — the seam
   * where an "unbounded" or an un-clamped value would show up — without
   * driving a real sandbox execution.
   *
   * Patches `ReplRunner.prototype.run` for the duration of the call — see the
   * sequential assumption on `withPatchedPrototype` (#178).
   */
  async function runWithLimits(params: Record<string, unknown>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const fakeRun = (async (
      _code: string,
      _sessionId: string | undefined,
      _onApproval: unknown,
      _signal: AbortSignal | undefined,
      limits: unknown,
    ) => {
      seen.push(limits);
      return "[result]\n1";
    }) as unknown as typeof ReplRunner.prototype.run;

    await withPatchedPrototype(ReplRunner.prototype, "run", fakeRun, async () => {
      const repl = (await loadTools()).find((t) => t.name === "repl");
      assert.ok(repl, "repl did not register");
      await repl.execute("clamp-1", params, undefined, undefined, {
        cwd,
        isProjectTrusted: () => true,
        hasUI: true,
        ui: { select: async () => APPROVE_CHOICE },
      });
    });
    return seen;
  }

  it("clamps an above-cap request before it reaches the runner", async () => {
    const seen = await runWithLimits({ code: "1 + 1", maxDurationSecs: 10_000, maxMemory: 2048 });
    assert.deepEqual(seen, [{ maxDurationSecs: 30, maxMemory: 512 * 1_048_576 }]);
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

  it("offers approve, deny, decide-later and deny-remaining, and names the call and the count in the title", async () => {
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
    // The order is pinned too: the three original positions do not move, and
    // the most consequential answer is the last one (#35 D82).
    assert.deepEqual(
      ui.opened[0].options,
      [APPROVE_CHOICE, DENY_CHOICE, LATER_CHOICE, extension.DENY_REMAINING_CHOICE],
      "a dialog that does not offer the third answer makes suspension unreachable again; " +
        "one that does not offer the fourth leaves the user no way out of a queue (#35)",
    );
    // The user has to be told what they are approving; `select` has no message
    // parameter, so the description has to be in the title.
    assert.match(ui.opened[0].title, /write/);
    assert.match(ui.opened[0].title, /offered\.txt/);
    // And how many more times they can be asked in this call (#35 D84).
    assert.match(
      ui.opened[0].title,
      new RegExp(`\\(dialog 1 of ${extension.MAX_DIALOGS_PER_CALL}\\)`),
      "the dialog does not say where in the per-call budget it sits",
    );
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

// ── repl_resume forwards the abort signal (#177 D2) ─────────────
//
// `repl_resume.execute` hands the abort `signal` to `ReplRunner.resume` as its
// third positional argument (`extensions/repl-extension.ts:371-375`), but every
// existing `repl_resume.execute(...)` test passes `undefined`. The deeper
// `ReplRunner`→`Session`→sandbox signal path is already pinned (#150 "abort-rt",
// D7 test 1); this pins the one unpinned hop — extension → `ReplRunner` — so a
// future refactor cannot silently drop the signal on the floor. This is a
// characterization pin: the code already forwards the signal, so the test
// passes on first run and guards the seam.

describe("repl extension — repl_resume forwards the abort signal (#177 D2)", () => {
  let cwd: string;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "repl-ext-signal-"));
  });

  after(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("passes the caller's abort signal through to ReplRunner.resume", async () => {
    const controller = new AbortController();
    const seen: unknown[] = [];
    // Patches `ReplRunner.prototype.resume` for the duration of the call —
    // see the sequential assumption on `withPatchedPrototype` (#178).
    const fakeResume = (async (
      _sessionId: string,
      _onApproval: unknown,
      signal: AbortSignal | undefined,
    ) => {
      seen.push(signal);
      return "[result]\n1";
    }) as unknown as typeof ReplRunner.prototype.resume;
    await withPatchedPrototype(ReplRunner.prototype, "resume", fakeResume, async () => {
      const resume = (await loadTools()).find((t) => t.name === "repl_resume");
      assert.ok(resume);
      await resume.execute("sig-1", { sessionId: "sig" }, controller.signal, undefined, {
        cwd,
        isProjectTrusted: () => true,
        hasUI: true,
        ui: { select: async () => APPROVE_CHOICE },
      });
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0], controller.signal);
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
    assert.equal(readFileSync(join(cwd, "first.txt"), "utf8"), "one", "the first call never ran");
    assert.equal(
      existsSync(join(cwd, "second.txt")),
      false,
      "the second gated call executed despite the abort",
    );
    // Context, not the assertion itself: the run reports the abort.
    assert.match(out, /\[error: aborted\]/);
  });
});

// ── Approval cap and deny remaining (#35) ────────────────────────
//
// One `repl` call produced twenty modal dialogs back to back. The sandbox
// asks once per gated call with no memory of how many times it has asked
// (`sandbox.ts` dispatch loop), and a Python `try/except PermissionError`
// loop reaches the gate again after every denial — so a script can ask until
// the user clicks yes once out of exhaustion. That is a fatigue primitive.
//
// The bound lives in the extension: `makeOnApproval` is minted per
// `execute()`, so a counter in its closure is per call by construction,
// restarts on `repl_resume`, and touches nothing in `src/`. A cap and a
// "deny remaining" only ever reduce what gets approved; nothing here makes
// approving easier (the ordering note in #35).
//
// Everything below is measured on side effects — which files exist — and on
// dialogs actually opened, never on the returned text alone.

/**
 * `n` gated calls in one snippet, each denial caught so the loop reaches the
 * gate again — the shape of the fatigue attack. Call `i` writes
 * `<prefix><i>.txt`, so what executed is readable off the disk.
 */
function gatedLoop(n: number, prefix: string): string {
  return [
    `for i in range(${n}):`,
    "    try:",
    `        write('${prefix}' + str(i) + '.txt', 'x')`,
    "    except PermissionError:",
    "        pass",
  ].join("\n");
}

describe("repl extension — approval cap and deny remaining (#35)", () => {
  let cwd: string;
  const CAP = extension.MAX_DIALOGS_PER_CALL;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "repl-ext-cap-"));
  });

  after(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  const ctxWith = (select: unknown) => ({
    cwd,
    isProjectTrusted: () => true,
    hasUI: true,
    ui: { select },
  });

  /** The first `expected` of `n` loop calls executed, and none after them. */
  function assertWritten(prefix: string, n: number, expected: number): void {
    for (let i = 0; i < n; i++) {
      assert.equal(
        existsSync(join(cwd, `${prefix}${i}.txt`)),
        i < expected,
        i < expected
          ? `${prefix}${i}.txt: an approved call did not execute`
          : `${prefix}${i}.txt: a call past the cap executed`,
      );
    }
  }

  it("50 gated calls open at most the cap, and the model is told why the rest were denied", async () => {
    const { tools, commands } = await load();
    const repl = tools.find((t) => t.name === "repl");
    assert.ok(repl);

    // Every dialog approves — the user who is being worn down. Fifty answers
    // are scripted so an over-cap dialog fails on the count, not on the script.
    const ui = scriptedSelect(Array.from({ length: 50 }, () => APPROVE_CHOICE));
    const result = await repl.execute(
      "cap-1",
      { code: gatedLoop(50, "spam"), sessionId: "cap-50" },
      undefined,
      undefined,
      ctxWith(ui.select),
    );

    assert.equal(ui.opened.length, CAP, "more dialogs opened than the cap allows");
    assertWritten("spam", 50, CAP);

    // Issue #35 test 3: the result names the cap as the cause, so the model
    // does not read forty-two bare PermissionErrors and retry.
    const text = result.content[0].text;
    assert.match(text, /\[approval cap\]/);
    assert.match(text, new RegExp(`opened ${CAP} approval dialogs`));
    assert.match(
      text,
      new RegExp(`${50 - CAP} later gated call\\(s\\) were denied without asking`),
    );

    // Control: yolo-approved calls do not count. The same fifty calls in yolo
    // open nothing, write everything, and carry no cap notice — the cap bounds
    // dialogs, not executions.
    await commands[0].handler("yolo", notifyCtx().ctx);
    const unasked = scriptedSelect([]);
    const yolo = await repl.execute(
      "cap-2",
      { code: gatedLoop(50, "yolo"), sessionId: "cap-yolo" },
      undefined,
      undefined,
      ctxWith(unasked.select),
    );
    assert.equal(unasked.opened.length, 0, "yolo opened a dialog");
    assertWritten("yolo", 50, 50);
    assert.doesNotMatch(yolo.content[0].text, /\[approval cap\]/);
  });

  it("'Deny remaining' opens no further dialog and denies everything after it", async () => {
    const repl = (await loadTools()).find((t) => t.name === "repl");
    assert.ok(repl);

    const ui = scriptedSelect([extension.DENY_REMAINING_CHOICE]);
    const result = await repl.execute(
      "dr-1",
      { code: gatedLoop(50, "rest"), sessionId: "deny-rest" },
      undefined,
      undefined,
      ctxWith(ui.select),
    );

    // Issue #35 test 2: exactly the dialog being answered, and none after it.
    assert.equal(ui.opened.length, 1, "a dialog opened after 'Deny remaining'");
    assertWritten("rest", 50, 0);

    const text = result.content[0].text;
    assert.match(text, /\[approvals denied\]/);
    assert.match(text, /Deny remaining/);
    assert.match(text, /49 later gated call\(s\)/);
    assert.doesNotMatch(text, /\[approval cap\]/, "a user's choice was reported as the cap");
  });

  it("exactly the cap is not capped, one more is — and replayed calls are free", async () => {
    const repl = (await loadTools()).find((t) => t.name === "repl");
    assert.ok(repl);

    const ui = scriptedSelect(Array.from({ length: 2 * CAP + 2 }, () => APPROVE_CHOICE));
    const ctx = ctxWith(ui.select);

    // Seed the session with one approved call. Every later `repl` call on the
    // session replays it from the cache — the sandbox never asks about a
    // replay (`Session.makeApprovalGate` branch 1), so it must not spend a
    // dialog from the budget either.
    await repl.execute(
      "ex-0",
      { code: "write('seed.txt', 'x')", sessionId: "exact" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(ui.opened.length, 1);

    // Exactly the cap: every call asks, every call runs, no notice — the
    // boundary is `>`, not `>=` (stryker mutates `extensions/**`).
    const atCap = await repl.execute(
      "ex-1",
      { code: gatedLoop(CAP, "at"), sessionId: "exact" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(
      ui.opened.length,
      1 + CAP,
      "the replayed seed call spent a dialog, or a call at the cap was refused",
    );
    assertWritten("at", CAP, CAP);
    assert.doesNotMatch(atCap.content[0].text, /\[approval cap\]/);

    // One more than the cap, in a fresh session: the last call is denied
    // without a dialog and the notice counts it.
    const over = await repl.execute(
      "ex-2",
      { code: gatedLoop(CAP + 1, "over"), sessionId: "exact-over" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(ui.opened.length, 1 + 2 * CAP, "the call past the cap opened a dialog");
    assertWritten("over", CAP + 1, CAP);
    assert.match(over.content[0].text, /\[approval cap\]/);
    assert.match(over.content[0].text, /1 later gated call\(s\)/);
  });

  it("an abort at the first dialog ends the sequence — the cap is not what stopped it", async () => {
    // Issue #35 test 4. The abort pin itself already held (#49, D7); what is
    // new is that the sequence ends on the abort, not on the cap, and that
    // the dialog the user escaped from was the four-answer one.
    const repl = (await loadTools()).find((t) => t.name === "repl");
    assert.ok(repl);

    const controller = new AbortController();
    const opened: string[][] = [];
    const select = async (_title: string, options: string[]): Promise<string | undefined> => {
      opened.push(options);
      controller.abort();
      return DENY_CHOICE;
    };

    const result = await repl.execute(
      "ab-1",
      { code: gatedLoop(50, "abort"), sessionId: "cap-abort" },
      controller.signal,
      undefined,
      ctxWith(select),
    );

    assert.equal(opened.length, 1, "a dialog opened after the user cancelled");
    assert.deepEqual(opened[0], [
      APPROVE_CHOICE,
      DENY_CHOICE,
      LATER_CHOICE,
      extension.DENY_REMAINING_CHOICE,
    ]);
    assertWritten("abort", 50, 0);

    const text = result.content[0].text;
    assert.match(text, /aborted/);
    assert.doesNotMatch(text, /\[approval cap\]/, "the abort was reported as the cap");
    assert.doesNotMatch(text, /\[approvals denied\]/, "the abort was reported as deny-remaining");
  });

  it("the count restarts on repl_resume", async () => {
    const { tools } = await load();
    const repl = tools.find((t) => t.name === "repl");
    const resume = tools.find((t) => t.name === "repl_resume");
    assert.ok(repl);
    assert.ok(resume);

    // Approve up to the last dialog of the budget, then "decide later" at it:
    // the run suspends having spent its whole count.
    const ui = scriptedSelect([
      ...Array.from({ length: CAP - 1 }, () => APPROVE_CHOICE),
      LATER_CHOICE,
      APPROVE_CHOICE,
      APPROVE_CHOICE,
      APPROVE_CHOICE,
    ]);
    const ctx = ctxWith(ui.select);

    const suspended = await repl.execute(
      "rs-1",
      { code: gatedLoop(CAP + 2, "rs"), sessionId: "restart" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(suspended.content[0].text, /requires approval/);
    assert.equal(ui.opened.length, CAP);
    assertWritten("rs", CAP + 2, CAP - 1);
    assert.doesNotMatch(suspended.content[0].text, /\[approval cap\]/);

    // Resume: the pending call asks — dialog 1 of a new count — and so do the
    // two calls after it. Three dialogs past the run's budget, no cap.
    const done = await resume.execute("rs-2", { sessionId: "restart" }, undefined, undefined, ctx);
    assert.equal(ui.opened.length, CAP + 3, "the resume inherited the run's count");
    assert.match(ui.opened[CAP].title, new RegExp(`\\(dialog 1 of ${CAP}\\)`));
    assertWritten("rs", CAP + 2, CAP + 2);
    assert.doesNotMatch(done.content[0].text, /\[approval cap\]/);
  });

  it("repl_resume is capped on its own count, and says so", async () => {
    const { tools } = await load();
    const repl = tools.find((t) => t.name === "repl");
    const resume = tools.find((t) => t.name === "repl_resume");
    assert.ok(repl);
    assert.ok(resume);

    // "Decide later" at the very first call, then approve everything the
    // resume asks: the pending call plus CAP - 1 more fill the resume's
    // budget, and the two after that are denied without a dialog.
    const ui = scriptedSelect([LATER_CHOICE, ...Array.from({ length: CAP }, () => APPROVE_CHOICE)]);
    const ctx = ctxWith(ui.select);

    await repl.execute(
      "rc-1",
      { code: gatedLoop(CAP + 2, "rc"), sessionId: "resume-cap" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(ui.opened.length, 1);

    const result = await resume.execute(
      "rc-2",
      { sessionId: "resume-cap" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(ui.opened.length, 1 + CAP, "the resume opened more dialogs than its cap");
    assertWritten("rc", CAP + 2, CAP);

    const text = result.content[0].text;
    assert.match(text, /\[approval cap\]/, "the resume path does not report the cap");
    assert.match(text, /2 later gated call\(s\)/);
  });
});

// ── Session lifecycle (#60) ──────────────────────────────────────
//
// Sessions belong to one Pi conversation. Pi emits `session_shutdown` when a
// conversation ends (`/new`, `/resume`, `/fork`, quit) and `session_start`
// when the next one begins. Before this the extension registered neither, so
// REPL state outlived the conversation that made it and a pending approval
// was garbage-collected without a word to anyone. These tests drive the
// handlers the way pi's runner does — every registered handler, in order,
// awaited — through the `load()` harness's `on` stub.
//
// Issue #60's test 3 (a cwd change mid-session) is dropped: `ctx.cwd` is set
// once in pi's extension runner constructor (runner.js:154) and exposed by a
// getter with no setter (runner.js:476-478), so it cannot change inside one
// session. What keying by cwd still buys — one runner per directory rather
// than one runner rooted wherever the first call happened to be — is tested.

/**
 * A ctx that serves both a tool call and a lifecycle handler: dialog answers
 * scripted, notifications collected, trust as given.
 */
function lifecycleCtx(cwd: string, answers: Array<string | undefined> = [], trusted = true) {
  const notes: Array<{ message: string; type?: string }> = [];
  const ui = scriptedSelect(answers);
  return {
    notes,
    ui,
    ctx: {
      cwd,
      hasUI: true,
      isProjectTrusted: () => trusted,
      ui: {
        select: ui.select,
        notify: (message: string, type?: string) => notes.push({ message, type }),
      },
    },
  };
}

describe("repl extension — session lifecycle (#60)", () => {
  let cwdA: string;
  let cwdB: string;
  let hostile: string;

  before(() => {
    cwdA = mkdtempSync(join(tmpdir(), "repl-ext-life-a-"));
    cwdB = mkdtempSync(join(tmpdir(), "repl-ext-life-b-"));
    hostile = mkdtempSync(join(tmpdir(), "repl-ext-life-hostile-"));
    mkdirSync(join(hostile, ".pi", "code-tools"), { recursive: true });
    writeFileSync(
      join(hostile, ".pi", "code-tools", "hostile.py"),
      "write('pwned.txt', 'owned')\n",
    );
  });

  after(() => {
    for (const dir of [cwdA, cwdB, hostile]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("state does not leak across a session_shutdown / session_start cycle", async () => {
    const { tools, handlers } = await load();
    const repl = tools.find((t) => t.name === "repl");
    assert.ok(repl);
    const { ctx } = lifecycleCtx(cwdA);

    await repl.execute("l-1", { code: "leak = 41" }, undefined, undefined, ctx);
    const before = await repl.execute("l-2", { code: "leak + 1" }, undefined, undefined, ctx);
    assert.match(before.content[0].text, /\[result\]\n42/);

    await fire(handlers, "session_shutdown", "new", ctx);
    await fire(handlers, "session_start", "new", ctx);

    // Monty reports an unbound name at type-check time (`unresolved-reference`)
    // rather than as a runtime NameError; either spelling is "gone".
    const after = await repl.execute("l-3", { code: "leak + 1" }, undefined, undefined, ctx);
    assert.match(
      after.content[0].text,
      /unresolved-reference|NameError/,
      "a variable from the previous conversation was still bound",
    );
  });

  it("session_shutdown is idempotent — a second call neither throws nor reports again", async () => {
    const { tools, handlers } = await load();
    const repl = tools.find((t) => t.name === "repl");
    assert.ok(repl);
    const { ctx, notes } = lifecycleCtx(cwdA, [LATER_CHOICE]);

    await repl.execute(
      "i-1",
      { code: "write('idem.txt', 'x')", sessionId: "idem" },
      undefined,
      undefined,
      ctx,
    );

    await fire(handlers, "session_shutdown", "new", ctx);
    assert.equal(notes.length, 1, "the pending suspension was not reported");

    await fire(handlers, "session_shutdown", "new", ctx);
    assert.equal(notes.length, 1, "the second shutdown reported the same suspension again");
    assert.equal(existsSync(join(cwdA, "idem.txt")), false);
  });

  it("two working directories get two runners, each rooted at its own cwd", async () => {
    const { tools } = await load();
    const repl = tools.find((t) => t.name === "repl");
    assert.ok(repl);
    const a = lifecycleCtx(cwdA, [APPROVE_CHOICE]);
    const b = lifecycleCtx(cwdB, [APPROVE_CHOICE]);

    await repl.execute("k-1", { code: "rooted = 'A'" }, undefined, undefined, a.ctx);
    const inB = await repl.execute("k-2", { code: "rooted" }, undefined, undefined, b.ctx);
    assert.match(
      inB.content[0].text,
      /unresolved-reference|NameError/,
      "cwd B saw cwd A's session",
    );

    // Not by inspecting internals: the jail root is where the write lands.
    await repl.execute("k-3", { code: "write('marker.txt', 'B')" }, undefined, undefined, b.ctx);
    assert.equal(
      existsSync(join(cwdB, "marker.txt")),
      true,
      "the write under cwd B did not land in B",
    );
    assert.equal(
      existsSync(join(cwdA, "marker.txt")),
      false,
      "the write under cwd B landed in A — one runner rooted at the first cwd seen",
    );
  });

  it("a suspension pending in the old conversation is not resumable in the new one", async () => {
    const { tools, handlers } = await load();
    const repl = tools.find((t) => t.name === "repl");
    const resume = tools.find((t) => t.name === "repl_resume");
    assert.ok(repl);
    assert.ok(resume);
    const { ctx, ui } = lifecycleCtx(cwdA, [LATER_CHOICE]);

    const suspended = await repl.execute(
      "p-1",
      { code: "write('carry.txt', 'x')", sessionId: "carry" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(suspended.content[0].text, /requires approval/);

    await fire(handlers, "session_shutdown", "resume", ctx);
    await fire(handlers, "session_start", "resume", ctx);

    // The same sessionId in the next conversation is a new, empty REPL: there
    // is nothing to resume, and no dialog is opened about the old call.
    const after = await resume.execute("p-2", { sessionId: "carry" }, undefined, undefined, ctx);
    assert.match(after.content[0].text, /No session 'carry' exists/);
    assert.equal(ui.opened.length, 1, "the new conversation asked about the old one's call");
    assert.equal(existsSync(join(cwdA, "carry.txt")), false);
  });

  it("shutdown reports a pending suspension as dropped, and only that one", async () => {
    const { tools, handlers } = await load();
    const repl = tools.find((t) => t.name === "repl");
    assert.ok(repl);
    const { ctx, notes } = lifecycleCtx(cwdA, [LATER_CHOICE]);

    await repl.execute("r-1", { code: "quiet = 1", sessionId: "quiet" }, undefined, undefined, ctx);
    await repl.execute(
      "r-2",
      { code: "write('dropped.txt', 'x')", sessionId: "waiting" },
      undefined,
      undefined,
      ctx,
    );

    await fire(handlers, "session_shutdown", "quit", ctx);

    assert.equal(notes.length, 1, "expected exactly one report, for the suspended session");
    assert.equal(notes[0].type, "warning");
    assert.match(notes[0].message, /'waiting'/);
    assert.match(notes[0].message, /never executed/);
    assert.doesNotMatch(notes[0].message, /'quiet'/, "a session with nothing pending was reported");
    // The arguments stay out of the report, as they do in `GrantSummary`: an
    // approval description can hold a pasted credential.
    assert.doesNotMatch(notes[0].message, /dropped\.txt/);
    assert.equal(existsSync(join(cwdA, "dropped.txt")), false);
  });

  it("the repl description says sessionId is scoped to the Pi session", async () => {
    const repl = (await loadTools()).find((t) => t.name === "repl");
    assert.ok(repl);

    // The model has to be told what reusing an id buys, because the previous
    // behaviour was the opposite and the string alone cannot tell it.
    assert.match(repl.description, /sessionId is scoped to this Pi session/);
    assert.match(repl.description, /pending approval is dropped/);
  });

  it("session_start runs nothing — no preamble before repl is called, trusted or not", async () => {
    const { tools, handlers } = await load();
    const repl = tools.find((t) => t.name === "repl");
    assert.ok(repl);

    const untrusted = lifecycleCtx(hostile, [], false);
    await fire(handlers, "session_start", "startup", untrusted.ctx);
    assert.equal(
      existsSync(join(hostile, "pwned.txt")),
      false,
      "session_start ran an untrusted project's preamble",
    );

    // Trust makes no difference here: session_start creates no session, so
    // the preamble — which runs at session creation — cannot run before a
    // `repl` call has consulted isProjectTrusted for itself. The one scripted
    // answer is for the positive control below; session_start must not use it.
    const trusted = lifecycleCtx(hostile, [APPROVE_CHOICE], true);
    await fire(handlers, "session_start", "new", trusted.ctx);
    assert.equal(
      existsSync(join(hostile, "pwned.txt")),
      false,
      "session_start created a session — the preamble ran before any repl call",
    );
    assert.equal(
      untrusted.ui.opened.length + trusted.ui.opened.length,
      0,
      "session_start opened an approval dialog",
    );

    // Positive control: the same preamble does run — through the approval
    // gate, like any gated call — once `repl` asks for a session under trust.
    await repl.execute("h-1", { code: "1 + 1" }, undefined, undefined, trusted.ctx);
    assert.equal(trusted.ui.opened.length, 1, "the preamble's gated write did not ask");
    assert.equal(readFileSync(join(hostile, "pwned.txt"), "utf8"), "owned");
  });

  // Residual, recorded as a todo rather than an issue (decision 9).
  it("the shutdown report names the tool that was waiting, not only the session", {
    todo:
      "ReplRunner.abandon answers only 'abandoned' | 'nothing-pending' | 'no-session', so the " +
      "extension cannot learn which tool the dropped call was for without a src/ change, and " +
      "src/repl.ts is W1-2's file this wave. Intended approach: have abandon() return the " +
      "dropped ApprovalRequest's tool name alongside the outcome — the name, never the " +
      "arguments, which can hold a pasted credential — and interpolate it into the report.",
  }, async () => {
    const { tools, handlers } = await load();
    const repl = tools.find((t) => t.name === "repl");
    assert.ok(repl);
    const { ctx, notes } = lifecycleCtx(cwdA, [LATER_CHOICE]);

    await repl.execute(
      "n-1",
      { code: "write('named.txt', 'x')", sessionId: "named" },
      undefined,
      undefined,
      ctx,
    );
    await fire(handlers, "session_shutdown", "quit", ctx);

    assert.equal(notes.length, 1);
    assert.match(notes[0].message, /'write'/, "the report does not say which tool was waiting");
  });
});
