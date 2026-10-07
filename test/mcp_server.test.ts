import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { LlmClient } from "../src/rlm.js";
import {
  CLAUDE_PROJECT_DIR_VAR,
  MCP_TOOL_NAMES,
  ROOT_VAR,
  SERVER_NAME,
  TRUST_VAR,
  configFromEnv,
  createReplMcpServer,
  type ReplMcpServer,
  type ReplMcpServerOptions,
} from "../src/mcp_server.js";
import { REPO_ROOT } from "./support/pack-fixture.js";
// Sets PI_OFFLINE=1 so no bridged tool reaches the network mid-run (#91).
import "./support/bridge-tools.js";

/**
 * The MCP server, driven the way Claude Code drives it — through the MCP
 * SDK's `Client`, over a linked in-memory transport pair — so every assertion
 * here is about what a model actually receives. No key, no network: the
 * `rlm` loop gets an injected canned `LlmClient`.
 */

// ── Store hygiene (#198) ─────────────────────────────────────────

const STORE_VAR = "REPL_PREAMBLE_STORE_DIR";
const previousStoreDir = process.env[STORE_VAR];
const testStoreDir = mkdtempSync(join(tmpdir(), "repl-mcp-store-"));
process.env[STORE_VAR] = testStoreDir;
after(() => {
  if (previousStoreDir === undefined) delete process.env[STORE_VAR];
  else process.env[STORE_VAR] = previousStoreDir;
  rmSync(testStoreDir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────

interface Harness {
  client: Client;
  replServer: ReplMcpServer;
  warnings: string[];
  root: string;
  close(): Promise<void>;
}

async function connect(overrides: Partial<ReplMcpServerOptions> = {}): Promise<Harness> {
  const root = overrides.root ?? mkdtempSync(join(tmpdir(), "repl-mcp-root-"));
  const warnings: string[] = [];
  const replServer = createReplMcpServer({
    root,
    trustProject: false,
    llmClient: cannedLlm([]),
    warn: (message) => warnings.push(message),
    ...overrides,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-server-test", version: "0.0.0" });
  await replServer.server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    replServer,
    warnings,
    root,
    async close() {
      await client.close();
      await replServer.close();
      if (overrides.root === undefined) rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The text content of a tool result, joined, plus its error flag. */
async function call(
  h: Harness,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const result = await h.client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return {
    text: content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join(""),
    isError: result.isError === true,
  };
}

/** The approval id a suspended result hands the model. */
function approvalIdOf(text: string): string {
  const match = /approvalId: ([0-9a-f]{8})\b/.exec(text);
  assert.ok(match, `expected an approvalId in:\n${text}`);
  return match[1];
}

/** An `LlmClient` that answers from a queue and records every query. */
function cannedLlm(
  replies: string[],
): LlmClient & { queries: Array<{ system: string; n: number }> } {
  const queue = [...replies];
  const queries: Array<{ system: string; n: number }> = [];
  return {
    queries,
    async query(systemPrompt, messages) {
      queries.push({ system: systemPrompt, n: messages.length });
      const next = queue.shift();
      if (next === undefined) throw new Error("canned LLM ran out of replies");
      return next;
    },
  };
}

function saveToolFile(root: string, name: string, source: string): void {
  const dir = join(root, ".pi", "code-tools");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.py`), source);
}

// ── configFromEnv ────────────────────────────────────────────────

describe("configFromEnv", () => {
  it("roots at the cwd when nothing else is set, and is untrusted by default", () => {
    const cfg = configFromEnv({}, "/some/where");
    assert.equal(cfg.root, resolve("/some/where"));
    assert.equal(cfg.trustProject, false);
  });

  it("prefers CLAUDE_PROJECT_DIR over the cwd — Claude Code sets it for MCP servers", () => {
    const cfg = configFromEnv({ [CLAUDE_PROJECT_DIR_VAR]: "/proj" }, "/elsewhere");
    assert.equal(cfg.root, resolve("/proj"));
  });

  it("prefers an explicit REPL_MCP_ROOT over both", () => {
    const cfg = configFromEnv(
      { [ROOT_VAR]: "/explicit", [CLAUDE_PROJECT_DIR_VAR]: "/proj" },
      "/elsewhere",
    );
    assert.equal(cfg.root, resolve("/explicit"));
  });

  it("ignores blank values rather than rooting at the empty string", () => {
    const cfg = configFromEnv({ [ROOT_VAR]: "  ", [CLAUDE_PROJECT_DIR_VAR]: "" }, "/cwd");
    assert.equal(cfg.root, resolve("/cwd"));
  });

  it("trusts the project only on an explicit opt-in", () => {
    for (const yes of ["1", "true", "TRUE", " yes "]) {
      assert.equal(configFromEnv({ [TRUST_VAR]: yes }, "/c").trustProject, true, yes);
    }
    for (const no of ["0", "false", "", "no", "maybe"]) {
      assert.equal(configFromEnv({ [TRUST_VAR]: no }, "/c").trustProject, false, no);
    }
  });
});

// ── Registration ─────────────────────────────────────────────────

describe("MCP server — registration", () => {
  let h: Harness;
  before(async () => {
    h = await connect();
  });
  after(() => h.close());

  it("identifies itself as repl-simple at the package version", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    const info = h.client.getServerVersion();
    assert.equal(info?.name, SERVER_NAME);
    assert.equal(SERVER_NAME, "repl-simple");
    assert.equal(info?.version, pkg.version);
  });

  it("registers exactly the five pi tools, under the same names", async () => {
    const { tools } = await h.client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...MCP_TOOL_NAMES].sort());
    assert.deepEqual([...MCP_TOOL_NAMES].sort(), [
      "repl",
      "repl_abandon",
      "repl_reset",
      "repl_resume",
      "rlm",
    ]);
  });

  it("describes the Python-side host tools in the repl description, gated ones marked", async () => {
    const { tools } = await h.client.listTools();
    const repl = tools.find((tool) => tool.name === "repl");
    assert.ok(repl?.description);
    // The names come from the runner's own registry, not a typed list.
    assert.match(repl.description, /read_file\(/);
    assert.match(repl.description, /list_files\(/);
    assert.match(repl.description, /bash\(.*\) \[approval\]/);
    assert.match(repl.description, /write\(.*\) \[approval\]/);
    assert.doesNotMatch(repl.description, /\bread\(/, "the bridged read is not in a repl session");
    assert.match(repl.description, /save_tool/);
  });

  it("declares the input schemas a model needs: repl.code and repl_resume.approvalId are required", async () => {
    const { tools } = await h.client.listTools();
    const schema = (name: string) =>
      tools.find((tool) => tool.name === name)?.inputSchema as {
        properties: Record<string, unknown>;
        required?: string[];
      };
    assert.deepEqual(schema("repl").required, ["code"]);
    assert.deepEqual(Object.keys(schema("repl").properties).sort(), [
      "code",
      "maxDurationSecs",
      "maxMemory",
      "sessionId",
    ]);
    assert.deepEqual(schema("repl_resume").required, ["approvalId"]);
    assert.deepEqual(Object.keys(schema("repl_resume").properties).sort(), [
      "approvalId",
      "decision",
      "sessionId",
    ]);
    assert.deepEqual(schema("rlm").required, ["question"]);
    assert.deepEqual(Object.keys(schema("rlm").properties).sort(), [
      "budget",
      "maxDepth",
      "maxIterations",
      "question",
    ]);
  });

  it("annotates rlm as read-only and repl as not", async () => {
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.get("rlm")?.annotations?.readOnlyHint, true);
    assert.equal(byName.get("repl")?.annotations?.readOnlyHint, false);
    assert.equal(byName.get("repl_resume")?.annotations?.readOnlyHint, false);
  });
});

// ── repl ─────────────────────────────────────────────────────────

describe("MCP server — repl", () => {
  let h: Harness;
  before(async () => {
    h = await connect();
    writeFileSync(join(h.root, "data.csv"), "label,value\na,1\nb,5\nc,3\n");
  });
  after(() => h.close());

  it("keeps state across calls on one sessionId", async () => {
    const first = await call(h, "repl", { code: "x = 41", sessionId: "s1" });
    assert.equal(first.isError, false);
    const second = await call(h, "repl", { code: "x + 1", sessionId: "s1" });
    assert.match(second.text, /\[result\]\n42$/);
  });

  it("defaults sessionId to 'default'", async () => {
    await call(h, "repl", { code: "y = 7" });
    const result = await call(h, "repl", { code: "y", sessionId: "default" });
    assert.match(result.text, /\[result\]\n7$/);
  });

  it("refuses `import subprocess` with a typing error, as text", async () => {
    const result = await call(h, "repl", { code: "import subprocess", sessionId: "s2" });
    assert.match(result.text, /\[error: typing\]/);
  });

  it("read_file is jailed to the root: /etc/passwd is refused with PermissionError text", async () => {
    const result = await call(h, "repl", {
      code: 'read_file("/etc/passwd")',
      sessionId: "s2",
    });
    assert.match(result.text, /\[error: runtime\]/);
    assert.match(result.text, /PermissionError/);
    assert.doesNotMatch(result.text, /root:x:0:0/);
  });

  it("read_file resolves relative to the root", async () => {
    const result = await call(h, "repl", {
      code: 'rows = read_file("data.csv").strip().split("\\n")[1:]\nsum(int(r.split(",")[1]) for r in rows)',
      sessionId: "s3",
    });
    assert.match(result.text, /\[result\]\n9$/);
  });

  it("stdout and the result both arrive", async () => {
    const result = await call(h, "repl", { code: 'print("hi")\n1 + 1', sessionId: "s4" });
    assert.equal(result.text, "hi\n\n[result]\n2");
  });

  it("clamps a model-supplied limit rather than trusting it", async () => {
    // 9999 s is above the 300 s ceiling; the run still completes, which is
    // all a clamp test can see from outside without waiting out a timeout.
    const result = await call(h, "repl", {
      code: "2 + 2",
      sessionId: "s5",
      maxDurationSecs: 9999,
      maxMemory: 99999,
    });
    assert.match(result.text, /\[result\]\n4$/);
  });

  it("rejects a call with no code at the schema, as an error result naming the field", async () => {
    // The SDK validates arguments before the handler runs and answers with an
    // error result rather than a protocol error, so the model can correct it.
    const result = await h.client.callTool({ name: "repl", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /code/);
  });
});

// ── Approvals ────────────────────────────────────────────────────

describe("MCP server — approvals suspend and resume", () => {
  let h: Harness;
  before(async () => {
    h = await connect();
  });
  after(() => h.close());

  it("a gated call suspends; the result names the call, mints an approvalId, and says how to resume", async () => {
    const result = await call(h, "repl", {
      code: 'out = bash("echo approved-run")\nprint("after:", out.strip())',
      sessionId: "a1",
    });
    assert.equal(result.isError, false);
    assert.match(result.text, /Tool 'bash' requires approval/);
    assert.match(result.text, /bash\(command="echo approved-run"/);
    const id = approvalIdOf(result.text);
    assert.match(result.text, /has NOT run/);
    assert.match(result.text, new RegExp(`repl_resume\\(sessionId='a1', approvalId='${id}'\\)`));
    assert.match(result.text, /permission/i);
    assert.match(result.text, /repl_abandon\(sessionId='a1'\)/);
    assert.doesNotMatch(result.text, /after:/, "the code after the gate must not have run");
  });

  it("repl_resume with a stale or wrong approvalId resumes nothing and says which call is pending", async () => {
    const result = await call(h, "repl_resume", { sessionId: "a1", approvalId: "00000000" });
    assert.equal(result.isError, true);
    assert.match(result.text, /Nothing ran/);
    assert.match(result.text, /bash\(command="echo approved-run"/);
    const id = approvalIdOf(result.text);
    assert.notEqual(id, "00000000");
  });

  it("repl_resume with the right approvalId runs the call and the code after it", async () => {
    const pending = await call(h, "repl_resume", { sessionId: "a1", approvalId: "00000000" });
    const id = approvalIdOf(pending.text);
    const result = await call(h, "repl_resume", { sessionId: "a1", approvalId: id });
    assert.equal(result.isError, false);
    assert.match(result.text, /^\[approved\]/);
    assert.match(result.text, /after: approved-run/);
    assert.doesNotMatch(result.text, /approvalId:/, "nothing is pending any more");
  });

  it("after a decided approval, repl_resume says nothing is pending", async () => {
    const result = await call(h, "repl_resume", { sessionId: "a1", approvalId: "00000000" });
    assert.equal(result.isError, true);
    assert.match(result.text, /no approval pending/i);
    assert.match(result.text, /Nothing was resumed/);
  });

  it("repl_resume on an unknown session says so", async () => {
    const result = await call(h, "repl_resume", { sessionId: "never", approvalId: "00000000" });
    assert.equal(result.isError, true);
    assert.match(result.text, /no approval pending/i);
  });

  it("decision='deny' refuses the call: Python sees PermissionError and the run continues", async () => {
    const paused = await call(h, "repl", {
      code: 'try:\n    bash("echo should-not-run")\nexcept PermissionError as e:\n    print("denied:", type(e).__name__)\n"done"',
      sessionId: "a2",
    });
    const id = approvalIdOf(paused.text);
    const result = await call(h, "repl_resume", {
      sessionId: "a2",
      approvalId: id,
      decision: "deny",
    });
    assert.equal(result.isError, false);
    assert.match(result.text, /^\[denied\]/);
    assert.match(result.text, /denied: PermissionError/);
    assert.match(result.text, /\[result\]\ndone$/);
    assert.doesNotMatch(
      result.text,
      /should-not-run\n/,
      "the command's own output must not appear",
    );
  });

  it("every gated call gets its own approval: a second one suspends again with a new id", async () => {
    const paused = await call(h, "repl", {
      code: 'a = bash("echo one").strip()\nb = bash("echo two").strip()\nprint(a, b)',
      sessionId: "a3",
    });
    const first = approvalIdOf(paused.text);
    const again = await call(h, "repl_resume", { sessionId: "a3", approvalId: first });
    assert.match(again.text, /Tool 'bash' requires approval/);
    assert.match(again.text, /bash\(command="echo two"/);
    const second = approvalIdOf(again.text);
    assert.notEqual(second, first, "a new suspension is a new decision");
    // The first id is spent.
    const stale = await call(h, "repl_resume", { sessionId: "a3", approvalId: first });
    assert.equal(stale.isError, true);
    const done = await call(h, "repl_resume", { sessionId: "a3", approvalId: second });
    assert.match(done.text, /one two/);
  });

  it("repl_abandon drops the pending call without running it, and says so", async () => {
    const paused = await call(h, "repl", {
      code: 'bash("echo should-not-run")\nprint("after")',
      sessionId: "a4",
    });
    approvalIdOf(paused.text);
    const result = await call(h, "repl_abandon", { sessionId: "a4" });
    assert.equal(result.isError, false);
    assert.match(result.text, /abandoned/);
    assert.match(result.text, /dropped/);
    const resume = await call(h, "repl_resume", { sessionId: "a4", approvalId: "00000000" });
    assert.match(resume.text, /no approval pending/i);
    // The session lives on.
    const next = await call(h, "repl", { code: "3 * 3", sessionId: "a4" });
    assert.match(next.text, /\[result\]\n9$/);
  });

  it("repl_abandon distinguishes nothing-pending from no-session", async () => {
    const idle = await call(h, "repl_abandon", { sessionId: "a4" });
    assert.match(idle.text, /no pending approval/);
    const none = await call(h, "repl_abandon", { sessionId: "ghost" });
    assert.match(none.text, /No session 'ghost' exists/);
  });

  it("running new code while a call is pending discards it, and the approval id dies with it", async () => {
    const paused = await call(h, "repl", { code: 'bash("echo stale")', sessionId: "a5" });
    const id = approvalIdOf(paused.text);
    const next = await call(h, "repl", { code: "1", sessionId: "a5" });
    assert.match(next.text, /^\[discarded\]/);
    const resume = await call(h, "repl_resume", { sessionId: "a5", approvalId: id });
    assert.equal(resume.isError, true);
    assert.match(resume.text, /no approval pending/i);
  });

  it("ANTHROPIC_API_KEY in the server process never reaches an approved bash", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-secret-do-not-leak";
    try {
      const paused = await call(h, "repl", {
        code: 'print(bash("printenv ANTHROPIC_API_KEY || echo key=unset"))',
        sessionId: "a6",
      });
      const id = approvalIdOf(paused.text);
      const result = await call(h, "repl_resume", { sessionId: "a6", approvalId: id });
      assert.match(result.text, /key=unset/);
      assert.doesNotMatch(result.text, /do-not-leak/);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});

// ── repl_reset ───────────────────────────────────────────────────

describe("MCP server — repl_reset", () => {
  let h: Harness;
  before(async () => {
    h = await connect();
  });
  after(() => h.close());

  it("clears a session's state and reports it", async () => {
    await call(h, "repl", { code: "z = 1", sessionId: "r1" });
    const reset = await call(h, "repl_reset", { sessionId: "r1" });
    assert.match(reset.text, /Session 'r1' reset\./);
    assert.match(reset.text, /No approval grants were outstanding/);
    const after = await call(h, "repl", { code: "z", sessionId: "r1" });
    assert.match(after.text, /\[error: typing\]/);
  });

  it("does not claim to have reset a session that never existed", async () => {
    const reset = await call(h, "repl_reset", { sessionId: "nope" });
    assert.match(reset.text, /No session 'nope' exists/);
    assert.doesNotMatch(reset.text, /grants/);
  });

  it("drops a pending approval with the session", async () => {
    const paused = await call(h, "repl", { code: 'bash("echo x")', sessionId: "r2" });
    const id = approvalIdOf(paused.text);
    await call(h, "repl_reset", { sessionId: "r2" });
    const resume = await call(h, "repl_resume", { sessionId: "r2", approvalId: id });
    assert.equal(resume.isError, true);
  });
});

// ── Project trust ────────────────────────────────────────────────

describe("MCP server — project trust", () => {
  it("is untrusted by default: saved tools in .pi/code-tools do not load", async () => {
    const h = await connect();
    try {
      saveToolFile(h.root, "greet", 'def greet():\n    return "hi"\n');
      const result = await call(h, "repl", { code: "greet()", sessionId: "t1" });
      assert.match(result.text, /\[error: typing\]/);
      assert.doesNotMatch(result.text, /\[result\]\nhi/);
    } finally {
      await h.close();
    }
  });

  it("trustProject: true wires the runner's trust gate, and an accepted set then loads", async () => {
    const h = await connect({ trustProject: true });
    try {
      saveToolFile(h.root, "greet", 'def greet():\n    return "hi"\n');
      // Trust is not consent to the files (#198): nothing unapproved loads,
      // and the server has no dialog to ask on, so the set is withheld...
      const before = await call(h, "repl", { code: "greet()", sessionId: "t2" });
      assert.match(before.text, /\[error: typing\]/);
      // ...until it is accepted. This is the library's own acceptance path;
      // the point here is only that the server's trust option reached it.
      const accepted = await h.replServer.runner.acceptPreamble();
      assert.equal(accepted.status, "accepted");
      const after = await call(h, "repl", { code: "greet()", sessionId: "t3" });
      assert.match(after.text, /\[result\]\nhi$/);
    } finally {
      await h.close();
    }
  });

  it("an untrusted runner refuses acceptPreamble, so no env knob but the trust one can load code", async () => {
    const h = await connect();
    try {
      saveToolFile(h.root, "greet", 'def greet():\n    return "hi"\n');
      assert.equal((await h.replServer.runner.acceptPreamble()).status, "untrusted");
    } finally {
      await h.close();
    }
  });
});

// ── rlm ──────────────────────────────────────────────────────────

describe("MCP server — rlm", () => {
  it("runs the loop against the injected LlmClient and renders the result as untrusted", async () => {
    const llm = cannedLlm(['```python\nSUBMIT("b")\n```']);
    const h = await connect({ llmClient: llm });
    try {
      writeFileSync(join(h.root, "data.csv"), "label,value\na,1\nb,5\n");
      const result = await call(h, "rlm", { question: "largest label?" });
      assert.equal(result.isError, false);
      assert.match(result.text, /^\[RLM inner-model output — untrusted\]/);
      assert.match(result.text, /status: ok/);
      assert.match(result.text, /answerSource: submitted/);
      assert.match(result.text, /answer: b$/);
      assert.equal(llm.queries.length, 1);
      assert.match(llm.queries[0].system, /read_file/, "the loop's registry has the readers");
    } finally {
      await h.close();
    }
  });

  it("refuses an empty question", async () => {
    const h = await connect();
    try {
      const result = await call(h, "rlm", { question: "   " });
      assert.equal(result.isError, true);
      assert.match(result.text, /non-empty question/);
    } finally {
      await h.close();
    }
  });

  it("reports a failing LlmClient as a result, not a crash, with the error redacted into the text", async () => {
    const llm: LlmClient = {
      async query() {
        throw new Error("401 authentication_error: invalid x-api-key");
      },
    };
    const h = await connect({ llmClient: llm });
    try {
      const result = await call(h, "rlm", { question: "anything" });
      assert.match(result.text, /status: error/);
      assert.match(result.text, /authentication_error/);
      // The server is still up.
      const next = await call(h, "repl", { code: "1 + 1" });
      assert.match(next.text, /\[result\]\n2$/);
    } finally {
      await h.close();
    }
  });

  it("clamps the model-supplied knobs: iterations stop at the ceiling, not at the request", async () => {
    // Twenty-four non-submitting replies; the ceiling is 20, so the loop must
    // end at max_iterations having asked twenty times for code plus once for
    // the synthesised answer — twenty-one, never the twenty-four it could have
    // consumed.
    const llm = cannedLlm(Array.from({ length: 24 }, () => "```python\n1\n```"));
    const h = await connect({ llmClient: llm });
    try {
      const result = await call(h, "rlm", { question: "q", maxIterations: 50 });
      assert.match(result.text, /status: max_iterations/);
      assert.ok(llm.queries.length <= 21, `asked ${llm.queries.length} times`);
    } finally {
      await h.close();
    }
  });
});

// ── Lifecycle ────────────────────────────────────────────────────

describe("MCP server — close", () => {
  it("close() abandons and releases every session the server was handed", async () => {
    const h = await connect();
    await call(h, "repl", { code: 'bash("echo pending")', sessionId: "c1" });
    await call(h, "repl", { code: "1", sessionId: "c2" });
    assert.equal(h.replServer.runner.liveSessionCount(), 2);
    await h.close();
    assert.equal(h.replServer.runner.liveSessionCount(), 0);
  });
});
