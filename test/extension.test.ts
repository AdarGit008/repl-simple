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

// ── repl_reset surfaces the approval state (#44) ─────────────────

describe("repl extension — repl_reset reports approvals", () => {
  let cwd: string;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "repl-ext-reset-"));
  });

  after(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("names the mode and says nothing is outstanding", async () => {
    const { tools } = await load();
    const reset = tools.find((t) => t.name === "repl_reset");
    assert.ok(reset);

    const result = await reset.execute("r-1", {}, undefined, undefined, {
      cwd,
      hasUI: true,
      ui: { confirm: async () => true },
    });

    const text = result.content[0].text;
    assert.match(text, /reset/);
    assert.match(text, /Approval mode: strict/);
    assert.match(text, /No approval grants were outstanding/);
  });
});
