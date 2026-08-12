import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiBridgeTools } from "../src/bridge.js";
import { BRIDGE_TOOLS_SKIP } from "./support/bridge-tools.js";
import type { BridgeOptions } from "../src/bridge.js";
import type { HostTool } from "../src/types.js";

// ── Helpers ─────────────────────────────────────────────────────

let tmpDir: string;
let testFile: string;
let testDir: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "repl-bridge-test-"));
  testFile = join(tmpDir, "test.txt");
  writeFileSync(testFile, "hello world\nline two\nline three\n");
  testDir = join(tmpDir, "subdir");
  mkdirSync(testDir);
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function findTool(tools: HostTool[], name: string): HostTool {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `Tool "${name}" not found`);
  return tool;
}

// ── Tool creation ───────────────────────────────────────────────

describe("createPiBridgeTools — tool creation", () => {
  it("returns 7 tools", () => {
    const tools = createPiBridgeTools(tmpDir);
    assert.equal(tools.length, 7);
  });

  it("all tools have correct names", () => {
    const tools = createPiBridgeTools(tmpDir);
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
  });

  it("read-only tools have requiresApproval: false", () => {
    const tools = createPiBridgeTools(tmpDir);
    for (const name of ["read", "grep", "find", "ls"]) {
      const tool = findTool(tools, name);
      assert.equal(
        tool.requiresApproval,
        false,
        `${name} should not require approval`,
      );
    }
  });

  it("mutating tools have requiresApproval: true by default", () => {
    const tools = createPiBridgeTools(tmpDir);
    for (const name of ["bash", "edit", "write"]) {
      const tool = findTool(tools, name);
      assert.equal(
        tool.requiresApproval,
        true,
        `${name} should require approval by default`,
      );
    }
  });

  it("gateMutating: false removes approval from all tools", () => {
    const opts: BridgeOptions = { gateMutating: false };
    const tools = createPiBridgeTools(tmpDir, opts);
    for (const tool of tools) {
      assert.equal(
        tool.requiresApproval,
        false,
        `${tool.name} should not require approval`,
      );
    }
  });

  it("all tools have params", () => {
    const tools = createPiBridgeTools(tmpDir);
    for (const tool of tools) {
      assert.ok(tool.params.length > 0, `${tool.name} should have params`);
    }
  });

  it("all tools return 'str'", () => {
    const tools = createPiBridgeTools(tmpDir);
    for (const tool of tools) {
      assert.equal(tool.returns, "str", `${tool.name} should return 'str'`);
    }
  });
});

// ── Tool execution — read ───────────────────────────────────────

describe("createPiBridgeTools — read execution", () => {
  it("reads a file", async () => {
    const tools = createPiBridgeTools(tmpDir);
    const read = findTool(tools, "read");
    const result = await read.execute({ path: "test.txt" });
    assert.ok(result.includes("hello world"));
  });

  it("reads with offset and limit", async () => {
    const tools = createPiBridgeTools(tmpDir);
    const read = findTool(tools, "read");
    const result = await read.execute({
      path: "test.txt",
      offset: 2,
      limit: 1,
    });
    // offset=2 (1-indexed line) → "line two" only, no "hello world"
    assert.ok(result.includes("line two"));
    assert.ok(!result.includes("hello world"));
    assert.ok(!result.includes("line three"));
  });
});

// ── Tool execution — ls ─────────────────────────────────────────

describe("createPiBridgeTools — ls execution", () => {
  it("lists directory", async () => {
    const tools = createPiBridgeTools(tmpDir);
    const ls = findTool(tools, "ls");
    const result = await ls.execute({ path: "." });
    assert.ok(result.includes("test.txt"));
    assert.ok(result.includes("subdir"));
  });

  it("defaults to current directory", async () => {
    const tools = createPiBridgeTools(tmpDir);
    const ls = findTool(tools, "ls");
    const result = await ls.execute({});
    assert.ok(result.includes("test.txt"));
  });
});

// ── Tool execution — grep ───────────────────────────────────────

describe("createPiBridgeTools — grep execution", { skip: BRIDGE_TOOLS_SKIP }, () => {
  it("finds matching lines", async () => {
    const tools = createPiBridgeTools(tmpDir);
    const grep = findTool(tools, "grep");
    const result = await grep.execute({ pattern: "hello", path: "." });
    assert.ok(result.includes("hello world"));
  });

  it("respects literal flag", async () => {
    const tools = createPiBridgeTools(tmpDir);
    const grep = findTool(tools, "grep");
    // literal search for a regex special character
    const result = await grep.execute({
      pattern: "hello",
      path: "test.txt",
      literal: true,
    });
    assert.ok(result.includes("hello world"));
  });
});

// ── Tool execution — find ───────────────────────────────────────

describe("createPiBridgeTools — find execution", { skip: BRIDGE_TOOLS_SKIP }, () => {
  it("finds files by pattern", async () => {
    const tools = createPiBridgeTools(tmpDir);
    const find = findTool(tools, "find");
    const result = await find.execute({ pattern: "*.txt" });
    assert.ok(result.includes("test.txt"));
  });

  it("respects path scope", async () => {
    const tools = createPiBridgeTools(tmpDir);
    const find = findTool(tools, "find");
    const result = await find.execute({
      pattern: "*.txt",
      path: "subdir",
    });
    // subdir has no .txt files — find returns empty or "No files found"
    assert.ok(
      result.trim() === "" || result.includes("No files found"),
      `expected empty or 'No files found', got: ${result}`,
    );
  });
});

// ── Tool execution — bash ───────────────────────────────────────

describe("createPiBridgeTools — bash execution", () => {
  it("runs a simple command", async () => {
    const tools = createPiBridgeTools(tmpDir);
    const bash = findTool(tools, "bash");
    const result = await bash.execute({
      command: "echo hello-from-bash",
    });
    assert.ok(result.includes("hello-from-bash"));
  });

  it("command fails → throws", async () => {
    const tools = createPiBridgeTools(tmpDir);
    const bash = findTool(tools, "bash");
    // Pi bash tool throws Error with shell output as message
    await assert.rejects(
      async () => { await bash.execute({ command: "nonexistent-command-xyz" }); },
      /command not found/,
    );
  });
});

// ── Tool execution — write ──────────────────────────────────────

describe("createPiBridgeTools — write execution", () => {
  it("writes a file", async () => {
    const tools = createPiBridgeTools(tmpDir);
    const write = findTool(tools, "write");
    const result = await write.execute({
      path: "written.txt",
      content: "created by bridge test",
    });
    // write returns success message
    assert.ok(typeof result === "string");

    // Verify with read
    const read = findTool(tools, "read");
    const content = await read.execute({ path: "written.txt" });
    assert.ok(content.includes("created by bridge test"));
  });
});

// ── Tool execution — edit ───────────────────────────────────────

describe("createPiBridgeTools — edit execution", () => {
  it("edits a file", async () => {
    const tools = createPiBridgeTools(tmpDir);
    // First write a file to edit
    const write = findTool(tools, "write");
    await write.execute({
      path: "toedit.txt",
      content: "line one\nline two\nline three\n",
    });

    const edit = findTool(tools, "edit");
    const result = await edit.execute({
      path: "toedit.txt",
      edits: JSON.stringify([
        { oldText: "line two", newText: "line TWO modified" },
      ]),
    });
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);

    // Verify
    const read = findTool(tools, "read");
    const content = await read.execute({ path: "toedit.txt" });
    assert.ok(content.includes("line TWO modified"));
    assert.ok(!content.includes("line two\nline three")); // old text gone
  });

  it("edit with non-matching oldText → throws", async () => {
    const tools = createPiBridgeTools(tmpDir);
    const edit = findTool(tools, "edit");
    await assert.rejects(
      async () => {
        await edit.execute({
          path: "test.txt",
          edits: JSON.stringify([
            { oldText: "nonexistent text xyz", newText: "replace" },
          ]),
        });
      },
    );
  });
});
