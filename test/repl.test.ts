import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReplRunner } from "../src/repl.js";
import type { ApprovalRequest, ApprovalDecision } from "../src/types.js";

// ── Helpers ─────────────────────────────────────────────────────

let tmpDir: string;

function makeTempDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "repl-test-"));
  return tmpDir;
}

function cleanup(): void {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
}

/** Always-deny approval callback. */
async function deny(_req: ApprovalRequest): Promise<ApprovalDecision> {
  return false;
}

/** Always-approve approval callback. */
async function approve(_req: ApprovalRequest): Promise<ApprovalDecision> {
  return true;
}

// ── Basic execution ──────────────────────────────────────────────

describe("ReplRunner — basic execution", () => {
  let runner: ReplRunner;

  before(() => {
    const cwd = makeTempDir();
    runner = new ReplRunner(cwd);
  });

  after(cleanup);

  it("evaluates a simple expression", async () => {
    const out = await runner.run("1 + 2");
    assert.ok(out.includes("[result]"));
    assert.ok(out.includes("3"));
  });

  it("captures print() output", async () => {
    const out = await runner.run('print("hello")');
    assert.ok(out.includes("hello"));
  });

  it("returns last expression value", async () => {
    const out = await runner.run("x = 5\nx * 2");
    assert.ok(out.includes("10"));
  });

  it("returns None for no expression", async () => {
    const out = await runner.run("x = 42");
    assert.ok(out.includes("[result]"));
    assert.ok(out.includes("None"));
  });
});

// ── Session persistence ──────────────────────────────────────────

describe("ReplRunner — session persistence", () => {
  let runner: ReplRunner;

  before(() => {
    const cwd = makeTempDir();
    runner = new ReplRunner(cwd);
  });

  after(cleanup);

  it("persists variables across runs on same sessionId", async () => {
    await runner.run("x = 42");
    const out = await runner.run("print(x)");
    assert.ok(out.includes("42"));
  });

  it("persists function definitions", async () => {
    await runner.run("def greet(name):\n    return f'Hello, {name}'");
    const out = await runner.run("greet('World')");
    assert.ok(out.includes("Hello, World"));
  });

  it("persists imports", async () => {
    await runner.run("import json");
    const out = await runner.run("json.dumps({'key': 'value'})");
    assert.ok(out.includes('"key"'));
    assert.ok(out.includes('"value"'));
  });

  it("isolates different sessionIds", async () => {
    await runner.run("x = 100", "session-a");
    // Different session should not have x defined
    const out = await runner.run(
      "try:\n    print(x)\nexcept NameError as e:\n    print('NameError:', e)",
      "session-b",
    );
    assert.ok(out.includes("NameError"));
  });
});

// ── Bridge tools ─────────────────────────────────────────────────

describe("ReplRunner — bridge tools", () => {
  let runner: ReplRunner;
  let cwd: string;

  before(() => {
    cwd = makeTempDir();
    // Create a known file for read/grep/find tests
    writeFileSync(join(cwd, "hello.txt"), "hello world\n");
    runner = new ReplRunner(cwd);
  });

  after(cleanup);

  it("can list directory with ls()", async () => {
    const out = await runner.run("ls('.')");
    assert.ok(out.includes("hello.txt"));
  });

  it("can read a file with read()", async () => {
    const out = await runner.run("read('hello.txt')");
    assert.ok(out.includes("hello world"));
  });

  it("can find files with find()", async () => {
    const out = await runner.run("find('*.txt')");
    assert.ok(out.includes("hello.txt"));
  });

  it("can grep files with grep()", async () => {
    const out = await runner.run("grep('hello', 'hello.txt')");
    assert.ok(out.includes("hello"));
  });
});

// ── Builtin tools ────────────────────────────────────────────────

describe("ReplRunner — builtin tools", () => {
  let runner: ReplRunner;
  let cwd: string;

  before(() => {
    cwd = makeTempDir();
    writeFileSync(join(cwd, "data.txt"), "builtin test\n");
    runner = new ReplRunner(cwd);
  });

  after(cleanup);

  it("can list directory with list_files()", async () => {
    const out = await runner.run("list_files('.')");
    assert.ok(out.includes("data.txt"));
  });

  it("can read a file with read_file()", async () => {
    const out = await runner.run("read_file('data.txt')");
    assert.ok(out.includes("builtin test"));
  });
});

// ── Error handling ──────────────────────────────────────────────

describe("ReplRunner — error handling", () => {
  let runner: ReplRunner;

  before(() => {
    const cwd = makeTempDir();
    runner = new ReplRunner(cwd);
  });

  after(cleanup);

  it("reports syntax errors", async () => {
    const out = await runner.run("def broken(");
    assert.ok(out.includes("[error: syntax]"));
    assert.ok(!out.includes("[result]"));
  });

  it("reports runtime errors", async () => {
    const out = await runner.run("raise ValueError('test error')");
    assert.ok(out.includes("[error: runtime]"));
    assert.ok(out.includes("test error"));
  });

  it("reports NameError for undefined variables", async () => {
    const out = await runner.run("undefined_var");
    assert.ok(out.includes("[error:"));
  });

  it("reports typing errors", async () => {
    const out = await runner.run("x: int = 'not an int'");
    assert.ok(out.includes("[error: typing]"));
  });

  it("includes stdout before error", async () => {
    const out = await runner.run('print("before crash")\nraise Exception("boom")');
    assert.ok(out.includes("before crash"));
    assert.ok(out.includes("[error:"));
    assert.ok(out.includes("boom"));
  });
});

// ── Reset ────────────────────────────────────────────────────────

describe("ReplRunner — reset", () => {
  let runner: ReplRunner;

  before(() => {
    const cwd = makeTempDir();
    runner = new ReplRunner(cwd);
  });

  after(cleanup);

  it("clears session state on reset", async () => {
    await runner.run("x = 42");
    runner.reset("default");

    // After reset, x is undefined — Monty catches at type-check time
    const out = await runner.run("print(x)");
    assert.ok(out.includes("[error:"));
    assert.ok(out.includes("not defined"));
  });

  it("reset of non-existent session does not throw", () => {
    // Should not throw
    runner.reset("non-existent-session");
  });
});

// ── Abandon ──────────────────────────────────────────────────────

describe("ReplRunner — abandon", () => {
  let runner: ReplRunner;

  before(() => {
    const cwd = makeTempDir();
    runner = new ReplRunner(cwd);
  });

  after(cleanup);

  it("returns false when no suspension exists", () => {
    assert.equal(runner.abandon("default"), false);
  });
});

// ── Default sessionId ────────────────────────────────────────────

describe("ReplRunner — default sessionId", () => {
  let runner: ReplRunner;

  before(() => {
    const cwd = makeTempDir();
    runner = new ReplRunner(cwd);
  });

  after(cleanup);

  it("uses 'default' sessionId when none provided", async () => {
    await runner.run("counter = 1");
    const out = await runner.run("counter");
    assert.ok(out.includes("1"));
  });
});
