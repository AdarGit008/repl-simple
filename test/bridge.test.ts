import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createPiBridgeTools } from "../src/bridge.js";
import { createBuiltinTools } from "../src/builtins.js";
import { BRIDGE_TOOLS_SKIP } from "./support/bridge-tools.js";
import type { BridgeOptions } from "../src/bridge.js";
import { HostToolError, type HostTool } from "../src/types.js";

// ── Helpers ─────────────────────────────────────────────────────

let tmpDir: string;
let testFile: string;
let testDir: string;

// A second temp tree standing in for everything the jail exists to keep out:
// ~/.ssh, ~/.aws, a sibling checkout. Both trees live under tmpdir(), so a
// relative `..` from the root reaches it — the traversal a real attempt makes.
let outsideDir: string;
let outsideFile: string;

/** Sentinel that must never reach a tool result, whichever tool is asked. */
const SECRET = "BEGIN-OPENSSH-PRIVATE-KEY-marker";

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "repl-bridge-test-"));
  testFile = join(tmpDir, "test.txt");
  writeFileSync(testFile, "hello world\nline two\nline three\n");
  testDir = join(tmpDir, "subdir");
  mkdirSync(testDir);

  outsideDir = mkdtempSync(join(tmpdir(), "repl-bridge-outside-"));
  outsideFile = join(outsideDir, "secret.txt");
  writeFileSync(outsideFile, `${SECRET}\n`);

  // Links out — the attack a prefix check on the *given* path lets through.
  symlinkSync(outsideFile, join(tmpDir, "escape-link"));
  symlinkSync(outsideDir, join(tmpDir, "escape-dir"));
  // Links in — ordinary use, which a jail that breaks it gets turned off for.
  symlinkSync(testFile, join(tmpDir, "inside-link"));
  symlinkSync(testDir, join(tmpDir, "inside-dir"));
  // Not `.txt`: "find respects path scope" below asserts subdir has none.
  writeFileSync(join(testDir, "nested.md"), "hello from the subdir\n");
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

function findTool(tools: HostTool[], name: string): HostTool {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `Tool "${name}" not found`);
  return tool;
}

// ── Jail helpers ────────────────────────────────────────────────

/** Every read tool, with args aimed at `path`, in the shape each one takes. */
const READ_TOOLS = ["read", "grep", "find", "ls"] as const;

/** `read`/`grep` want a file; `find`/`ls` want a directory. */
function argsFor(tool: string, filePath: string, dirPath: string): Record<string, unknown> {
  switch (tool) {
    case "read":
      return { path: filePath };
    case "grep":
      return { pattern: SECRET, path: filePath };
    case "find":
      return { pattern: "*", path: dirPath };
    default:
      return { path: dirPath };
  }
}

/** Assert the call is refused *as a jail refusal*, not as some later failure. */
async function assertRefused(tool: HostTool, args: Record<string, unknown>): Promise<void> {
  try {
    const result = await tool.execute(args);
    assert.fail(`${tool.name} should have been refused, got: ${result}`);
  } catch (e) {
    assert.ok(e instanceof HostToolError, `${tool.name}: expected HostToolError, got ${e}`);
    assert.equal((e as HostToolError).pythonType, "PermissionError", tool.name);
    assert.match(
      (e as HostToolError).message,
      /outside the project root/,
      "the refusal must say why, or the model just retries",
    );
  }
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
    assert.deepEqual(names, ["bash", "edit", "find", "grep", "ls", "read", "write"]);
  });

  it("read-only tools have requiresApproval: false", () => {
    const tools = createPiBridgeTools(tmpDir);
    for (const name of ["read", "grep", "find", "ls"]) {
      const tool = findTool(tools, name);
      assert.equal(tool.requiresApproval, false, `${name} should not require approval`);
    }
  });

  it("mutating tools have requiresApproval: true by default", () => {
    const tools = createPiBridgeTools(tmpDir);
    for (const name of ["bash", "edit", "write"]) {
      const tool = findTool(tools, name);
      assert.equal(tool.requiresApproval, true, `${name} should require approval by default`);
    }
  });

  it("gateMutating: false removes approval from all tools", () => {
    const opts: BridgeOptions = { gateMutating: false };
    const tools = createPiBridgeTools(tmpDir, opts);
    for (const tool of tools) {
      assert.equal(tool.requiresApproval, false, `${tool.name} should not require approval`);
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

// ── The cwd jail (#43) ──────────────────────────────────────────

describe("createPiBridgeTools — the cwd jail", () => {
  it("refuses an absolute path outside the root, for every read tool", async () => {
    const tools = createPiBridgeTools(tmpDir);
    for (const name of READ_TOOLS) {
      await assertRefused(findTool(tools, name), argsFor(name, outsideFile, outsideDir));
    }
  });

  it("refuses a '..' traversal, for every read tool", async () => {
    const tools = createPiBridgeTools(tmpDir);
    const upToFile = relative(tmpDir, outsideFile);
    const upToDir = relative(tmpDir, outsideDir);
    assert.ok(upToFile.startsWith(".."), `expected a traversal, got '${upToFile}'`);
    for (const name of READ_TOOLS) {
      await assertRefused(findTool(tools, name), argsFor(name, upToFile, upToDir));
    }
  });

  it("refuses a symlink pointing outside the root, for every read tool", async () => {
    // The one a prefix check on the given path passes: 'escape-link' is
    // inside the root by every measure except the one that matters.
    const tools = createPiBridgeTools(tmpDir);
    for (const name of READ_TOOLS) {
      await assertRefused(findTool(tools, name), argsFor(name, "escape-link", "escape-dir"));
    }
  });

  it("still reads inside the root, symlinks included", { skip: BRIDGE_TOOLS_SKIP }, async () => {
    const tools = createPiBridgeTools(tmpDir);

    // Directly.
    assert.match(await findTool(tools, "read").execute({ path: "test.txt" }), /hello world/);
    assert.match(await findTool(tools, "ls").execute({ path: "subdir" }), /nested\.md/);
    assert.match(
      await findTool(tools, "grep").execute({ pattern: "hello", path: "test.txt" }),
      /hello world/,
    );
    assert.match(await findTool(tools, "find").execute({ pattern: "*.txt" }), /test\.txt/);

    // And through an in-repo symlink, which resolves inside the root and so
    // must survive the realpath check that kills 'escape-link'.
    assert.match(await findTool(tools, "read").execute({ path: "inside-link" }), /hello world/);
    assert.match(await findTool(tools, "ls").execute({ path: "inside-dir" }), /nested\.md/);
    assert.match(
      await findTool(tools, "grep").execute({ pattern: "hello", path: "inside-link" }),
      /hello world/,
    );
    assert.match(
      await findTool(tools, "find").execute({ pattern: "*.md", path: "inside-dir" }),
      /nested\.md/,
    );
  });

  it("breaks the read half of the exfiltration chain", async () => {
    // #42 closed the egress half. Either alone breaks the chain; both are
    // tested so neither can regress back into a working path on its own.
    const tools = [...createPiBridgeTools(tmpDir), ...createBuiltinTools({ root: tmpDir })];
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["read", { path: outsideFile }],
      ["read", { path: "escape-link" }],
      ["grep", { pattern: SECRET, path: "escape-dir" }],
      ["ls", { path: "escape-dir" }],
      ["find", { pattern: "secret.txt", path: "escape-dir" }],
      ["read_file", { path: "escape-link" }],
      ["list_files", { path: "escape-dir" }],
    ];

    for (const [name, args] of attempts) {
      const tool = findTool(tools, name);
      let output: string;
      try {
        output = await tool.execute(args);
      } catch (e) {
        assert.ok(e instanceof HostToolError, `${name}: expected HostToolError, got ${e}`);
        assert.equal((e as HostToolError).pythonType, "PermissionError", name);
        continue;
      }
      assert.fail(`${name} reached outside the root and returned: ${output}`);
    }
  });

  it("is one implementation, shared by both readers", async () => {
    // Asserted by construction rather than by behaviour: two jails that agree
    // today are two jails that can disagree tomorrow, and the one nobody
    // exercises is the one that will be wrong.
    const srcDir = new URL("../src/", import.meta.url);
    const files = (await readdir(srcDir)).filter((f) => f.endsWith(".ts"));
    const definers: string[] = [];
    const importers: string[] = [];

    for (const file of files) {
      const text = await readFile(new URL(file, srcDir), "utf-8");
      if (text.includes("export function createPathJail")) definers.push(file);
      if (text.includes('from "./pathjail.js"')) importers.push(file);
      if (file !== "pathjail.ts") {
        assert.doesNotMatch(
          text,
          /realpath/,
          `${file} resolves symlinks itself — the jail check belongs in pathjail.ts`,
        );
      }
    }

    assert.deepEqual(definers, ["pathjail.ts"], "exactly one jail may exist");
    for (const reader of ["bridge.ts", "builtins.ts"]) {
      assert.ok(
        importers.includes(reader),
        `${reader} must use the shared jail — bypassing it is how #43 happened`,
      );
    }
  });

  it("works when cwd is itself reached through a symlink", async () => {
    // What macOS does to every temp dir: cwd is `/var/folders/…`, its real
    // path is `/private/var/folders/…`. The tools are built on the former and
    // the jail hands back the latter, so a check against one spelling only
    // refuses the root's own files. Run everywhere, not just on the mac leg.
    const linked = join(outsideDir, "root-link");
    symlinkSync(tmpDir, linked);
    const tools = createPiBridgeTools(linked);

    assert.match(await findTool(tools, "read").execute({ path: "test.txt" }), /hello world/);
    assert.match(await findTool(tools, "ls").execute({ path: "." }), /test\.txt/);
    await assertRefused(findTool(tools, "read"), { path: "escape-link" });
  });

  it("refuses a path that is not a string", async () => {
    // Monty hands the registry dynamically-typed values, so `path` can arrive
    // as anything. Refuse it here rather than letting `resolve()` stringify
    // something surprising into a path.
    const read = findTool(createPiBridgeTools(tmpDir), "read");
    try {
      await read.execute({ path: 42 });
      assert.fail("expected a refusal");
    } catch (e) {
      assert.ok(e instanceof HostToolError);
      assert.equal((e as HostToolError).pythonType, "TypeError");
    }
  });

  it("jails the files grep opens for context", { skip: BRIDGE_TOOLS_SKIP }, async () => {
    // Context lines are read through `operations`, not by ripgrep, so this is
    // the path the second layer is actually on.
    const grep = findTool(createPiBridgeTools(tmpDir), "grep");
    const result = await grep.execute({ pattern: "line two", path: "test.txt", context: 1 });
    assert.match(result, /hello world/, "the line before the match");
    assert.match(result, /line three/, "the line after it");
  });

  it("does not list entries that lead outside the root", async () => {
    // The second layer: pi builds these paths itself, entry by entry, so the
    // argument jail never sees them. An `ls` that renders 'escape-dir/' is an
    // advertisement for a path that cannot be followed.
    const listing = await findTool(createPiBridgeTools(tmpDir), "ls").execute({ path: "." });
    assert.ok(!listing.includes("escape-dir"), `escape-dir listed:\n${listing}`);
    assert.ok(!listing.includes("escape-link"), `escape-link listed:\n${listing}`);
    assert.match(listing, /inside-dir\//, "an in-root symlink is ordinary use");
    assert.match(listing, /test\.txt/);
  });

  it("hands caller-supplied operations canonical, in-root paths only", async () => {
    // BridgeOptions.ls stays a real seam: the jail composes with a caller's
    // operations rather than replacing them, and what reaches them is already
    // resolved.
    const seen: string[] = [];
    const opts: BridgeOptions = {
      ls: {
        operations: {
          exists: (p) => {
            seen.push(p);
            return true;
          },
          stat: (p) => ({ isDirectory: () => !p.endsWith(".txt") }),
          readdir: () => ["from-the-caller.txt"],
        },
      },
    };
    const ls = findTool(createPiBridgeTools(tmpDir, opts), "ls");

    const result = await ls.execute({ path: "inside-dir" });
    assert.match(result, /from-the-caller\.txt/, "the caller's operations still run");
    for (const p of seen) {
      assert.ok(p.startsWith("/"), `not resolved: ${p}`);
      assert.ok(!p.includes("inside-dir"), `not canonical — symlink survived: ${p}`);
    }

    seen.length = 0;
    await assertRefused(ls, { path: "escape-dir" });
    assert.deepEqual(seen, [], "a refused path must never reach the caller's operations");
  });

  it("gateReads puts the read tools behind approval too", () => {
    const ungated = createPiBridgeTools(tmpDir);
    for (const name of READ_TOOLS) {
      assert.equal(findTool(ungated, name).requiresApproval, false, `${name} default`);
    }

    const gated = createPiBridgeTools(tmpDir, { gateReads: true });
    for (const name of READ_TOOLS) {
      assert.equal(findTool(gated, name).requiresApproval, true, `${name} with gateReads`);
    }
    // Orthogonal to the mutating gate, so a caller can raise one without the other.
    const readsOnly = createPiBridgeTools(tmpDir, { gateReads: true, gateMutating: false });
    assert.equal(findTool(readsOnly, "read").requiresApproval, true);
    assert.equal(findTool(readsOnly, "bash").requiresApproval, false);
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
    await assert.rejects(async () => {
      await bash.execute({ command: "nonexistent-command-xyz" });
    }, /command not found/);
  });

  it("gives a command with no timeout one anyway", async () => {
    // Pi's schema says "no default timeout" and means it: without this, `sleep
    // 99999` is awaited forever, hanging the run and holding its pooled worker
    // for as long as it lasts (#32 item 3). The sandbox's own `maxDurationSecs`
    // cannot help — its clock stops while the interpreter is suspended on this
    // very call.
    //
    // Asserted at the seam where it matters, on what pi is actually handed,
    // rather than by waiting two minutes for it to fire.
    const seen: Array<number | undefined> = [];
    const recording: BridgeOptions = {
      bash: {
        operations: {
          exec: async (_command, _cwd, opts) => {
            seen.push(opts.timeout);
            return { exitCode: 0 };
          },
        },
      },
    };
    const bash = findTool(createPiBridgeTools(tmpDir, recording), "bash");

    await bash.execute({ command: "true" });
    await bash.execute({ command: "true", timeout: 5 });

    assert.deepEqual(seen, [120, 5], "default when unset; the caller's own when set");
    assert.equal(
      bash.params.find((p) => p.name === "timeout")?.description,
      "Timeout in seconds. Default 120.",
      "a default the model is not told about is one it cannot reason about",
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
      edits: JSON.stringify([{ oldText: "line two", newText: "line TWO modified" }]),
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
    await assert.rejects(async () => {
      await edit.execute({
        path: "test.txt",
        edits: JSON.stringify([{ oldText: "nonexistent text xyz", newText: "replace" }]),
      });
    });
  });
});
