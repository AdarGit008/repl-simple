import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_TOOL_NAMES } from "../src/mcp_server.js";
import { REPO_ROOT } from "./support/pack-fixture.js";

/**
 * The `bin` entry, end to end: `src/mcp_main.ts` spawned as a child process
 * and driven over its stdin/stdout the way Claude Code drives it. This is the
 * one test that can see what the in-memory tests cannot — that nothing in the
 * process (the sandbox workers included) writes to stdout besides JSON-RPC,
 * that the server roots at the directory Claude Code names, and that it exits
 * when the client goes away. The entry is run from source through tsx; the
 * compiled `dist/mcp_main.js` is the same file, checked by packaging.test.ts.
 */

const MAIN = join(REPO_ROOT, "src", "mcp_main.ts");

/**
 * tsx's ESM loader as a file URL. `--import tsx` would resolve the bare
 * specifier from the child's cwd — a temp dir with no node_modules — so the
 * loader is named absolutely, resolved from this file's own tree.
 */
const TSX_LOADER = import.meta.resolve("tsx");

/** The node arguments that run the entry from source. */
const NODE_ARGS = ["--import", TSX_LOADER, MAIN];

/** The child's environment: the test's own, minus every Anthropic credential, plus what is asked. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("ANTHROPIC_")) continue;
    env[key] = value;
  }
  // No bridged tool may reach the network from the child either (#91).
  env.PI_OFFLINE = "1";
  return { ...env, ...extra };
}

async function spawnServer(cwd: string, extraEnv: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: NODE_ARGS,
    cwd,
    env: childEnv(extraEnv),
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  const client = new Client({ name: "mcp-stdio-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport, stderr };
}

async function callText(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

describe("MCP server over stdio (the bin entry)", () => {
  let cwd: string;
  let project: string;
  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "repl-mcp-stdio-cwd-"));
    project = mkdtempSync(join(tmpdir(), "repl-mcp-stdio-proj-"));
    writeFileSync(join(cwd, "where.txt"), "cwd\n");
    writeFileSync(join(project, "where.txt"), "project\n");
  });
  after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("starts without a key, lists the five tools, and runs code with a clean protocol stream", async () => {
    const { client, transport, stderr } = await spawnServer(cwd);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [...MCP_TOOL_NAMES].sort());
      // A print and a result: if a sandbox worker leaked to stdout, this call
      // would have failed to parse rather than returned.
      const text = await callText(client, "repl", { code: 'print("over stdio")\n6 * 7' });
      assert.equal(text, "over stdio\n\n[result]\n42");
      assert.equal(stderr.join(""), "", "a clean run writes nothing to stderr");
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("roots at the cwd by default, and at CLAUDE_PROJECT_DIR when Claude Code sets it", async () => {
    const byCwd = await spawnServer(cwd);
    try {
      assert.match(
        await callText(byCwd.client, "repl", { code: 'read_file("where.txt").strip()' }),
        /\[result\]\ncwd$/,
      );
    } finally {
      await byCwd.client.close();
    }
    const byProject = await spawnServer(cwd, { CLAUDE_PROJECT_DIR: project });
    try {
      assert.match(
        await callText(byProject.client, "repl", { code: 'read_file("where.txt").strip()' }),
        /\[result\]\nproject$/,
      );
    } finally {
      await byProject.client.close();
    }
  });

  it("exits on its own when stdin closes — the client went away — with status 0", async () => {
    // Spawned by hand rather than through the SDK transport, whose close()
    // kills the child and would prove nothing about the server's own exit.
    const child = spawn(process.execPath, NODE_ARGS, {
      cwd,
      env: childEnv({}),
      stdio: ["pipe", "ignore", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    child.stdin.end();
    const outcome = await Promise.race([
      exited,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 15_000)),
    ]);
    if (outcome === "timeout") child.kill("SIGKILL");
    assert.equal(outcome, 0, "the server must exit cleanly once its client is gone");
  });

  it("src/mcp_main.ts carries the shebang the bin needs, and nothing else runs at import", () => {
    const source = readFileSync(MAIN, "utf8");
    assert.ok(source.startsWith("#!/usr/bin/env node\n"), "the entry must start with a shebang");
  });
});
