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

/**
 * Invoke the extension factory and collect what it registers.
 *
 * The module is import-cached, but each `default()` call builds a fresh
 * closure — and therefore a fresh `ReplRunner` — so callers get an independent
 * runner and are not exposed to the cwd caching in `getRunner` (#60).
 */
async function loadTools(): Promise<RegisteredTool[]> {
  const tools: RegisteredTool[] = [];
  const mod = await import("../extensions/repl-extension.js");
  mod.default({ registerTool: (t: unknown) => tools.push(t as RegisteredTool) } as never);
  return tools;
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
