import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostToolError, type HostTool } from "../src/types.js";
import {
  createBuiltinTools,
  type BuiltinToolsOptions,
} from "../src/builtins.js";

// ── Helpers ─────────────────────────────────────────────────────

/** Find a tool by name in a HostTool[] array */
function findTool(tools: HostTool[], name: string): HostTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool;
}

// ── createBuiltinTools — structure ──────────────────────────────

describe("createBuiltinTools — structure", () => {
  it("returns array of 3 HostTools by default", () => {
    const tools = createBuiltinTools({ root: "/tmp" });
    assert.equal(tools.length, 3);
  });

  it("each tool is a HostTool with required fields", () => {
    const tools = createBuiltinTools({ root: "/tmp" });
    for (const tool of tools) {
      assert.equal(typeof tool.name, "string");
      assert.ok(tool.name.length > 0);
      assert.equal(typeof tool.description, "string");
      assert.ok(Array.isArray(tool.params));
      assert.ok(tool.returns === "str" || tool.returns === "void");
      assert.equal(typeof tool.execute, "function");
    }
  });

  it("tool names are read_file, list_files, http_get", () => {
    const tools = createBuiltinTools({ root: "/tmp" });
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["http_get", "list_files", "read_file"]);
  });

  it("order is read_file, list_files, http_get", () => {
    const tools = createBuiltinTools({ root: "/tmp" });
    assert.equal(tools[0].name, "read_file");
    assert.equal(tools[1].name, "list_files");
    assert.equal(tools[2].name, "http_get");
  });

  it("readFile: false omits read_file", () => {
    const tools = createBuiltinTools({ root: "/tmp", readFile: false });
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("read_file"));
    assert.equal(tools.length, 2);
  });

  it("listFiles: false omits list_files", () => {
    const tools = createBuiltinTools({ root: "/tmp", listFiles: false });
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("list_files"));
    assert.equal(tools.length, 2);
  });

  it("readFile: false + listFiles: false leaves only http_get", () => {
    const tools = createBuiltinTools({
      root: "/tmp",
      readFile: false,
      listFiles: false,
    });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "http_get");
  });

  it("read_file params are correct", () => {
    const tools = createBuiltinTools({ root: "/tmp" });
    const tool = findTool(tools, "read_file");
    assert.equal(tool.params.length, 1);
    assert.equal(tool.params[0].name, "path");
    assert.equal(tool.params[0].type, "str");
    assert.equal(tool.params[0].optional, undefined);
    assert.equal(typeof tool.params[0].description, "string");
  });

  it("list_files params are correct", () => {
    const tools = createBuiltinTools({ root: "/tmp" });
    const tool = findTool(tools, "list_files");
    assert.equal(tool.params.length, 1);
    assert.equal(tool.params[0].name, "path");
    assert.equal(tool.params[0].type, "str");
    assert.equal(tool.params[0].optional, true);
  });

  it("http_get params are correct", () => {
    const tools = createBuiltinTools({ root: "/tmp" });
    const tool = findTool(tools, "http_get");
    assert.equal(tool.params.length, 1);
    assert.equal(tool.params[0].name, "url");
    assert.equal(tool.params[0].type, "str");
    assert.equal(tool.params[0].optional, undefined);
  });

  it("all tools declare returns: 'str'", () => {
    const tools = createBuiltinTools({ root: "/tmp" });
    for (const tool of tools) {
      assert.equal(tool.returns, "str");
    }
  });
});

// ── read_file — integration ─────────────────────────────────────

describe("read_file — integration", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "repl-simple-builtins-"));
    await writeFile(join(root, "hello.txt"), "Hello, world!");
    await writeFile(join(root, "subdir-file.txt"), "nested content");
    // No mkdir needed for just files
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads file contents from workspace root", async () => {
    const tools = createBuiltinTools({ root });
    const readFile = findTool(tools, "read_file");
    const result = await readFile.execute({ path: "hello.txt" });
    assert.equal(result, "Hello, world!");
  });

  it("throws FileNotFoundError for missing file", async () => {
    const tools = createBuiltinTools({ root });
    const readFile = findTool(tools, "read_file");
    try {
      await readFile.execute({ path: "nonexistent.txt" });
      assert.fail("expected HostToolError");
    } catch (e) {
      assert.ok(e instanceof HostToolError);
      assert.equal((e as HostToolError).pythonType, "FileNotFoundError");
    }
  });

  it("throws PermissionError for absolute path", async () => {
    const tools = createBuiltinTools({ root });
    const readFile = findTool(tools, "read_file");
    try {
      await readFile.execute({ path: "/etc/passwd" });
      assert.fail("expected HostToolError");
    } catch (e) {
      assert.ok(e instanceof HostToolError);
      assert.equal((e as HostToolError).pythonType, "PermissionError");
    }
  });

  it("throws PermissionError for '../' escape", async () => {
    const tools = createBuiltinTools({ root });
    const readFile = findTool(tools, "read_file");
    try {
      await readFile.execute({ path: "../escape.txt" });
      assert.fail("expected HostToolError");
    } catch (e) {
      assert.ok(e instanceof HostToolError);
      assert.equal((e as HostToolError).pythonType, "PermissionError");
    }
  });

  it("throws IsADirectoryError for directory path", async () => {
    const tools = createBuiltinTools({ root });
    const readFile = findTool(tools, "read_file");
    // root itself is a directory
    try {
      await readFile.execute({ path: "." });
      assert.fail("expected HostToolError");
    } catch (e) {
      assert.ok(e instanceof HostToolError);
      assert.equal((e as HostToolError).pythonType, "IsADirectoryError");
    }
  });

  it("throws PermissionError for symlink pointing outside root", async () => {
    const tools = createBuiltinTools({ root });
    const readFile = findTool(tools, "read_file");
    await symlink("/etc/passwd", join(root, "escape-link"));
    try {
      await readFile.execute({ path: "escape-link" });
      assert.fail("expected HostToolError");
    } catch (e) {
      assert.ok(e instanceof HostToolError);
      assert.equal((e as HostToolError).pythonType, "PermissionError");
    }
  });
});

// ── list_files — integration ────────────────────────────────────

describe("list_files — integration", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "repl-simple-builtins-"));
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");
    await mkdir(join(root, "subdir"));
    await writeFile(join(root, "subdir", "c.txt"), "c");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists entries with trailing '/' for directories, newline-separated", async () => {
    const tools = createBuiltinTools({ root });
    const listFiles = findTool(tools, "list_files");
    const result = await listFiles.execute({ path: "." });
    assert.equal(typeof result, "string");
    const entries = result.split("\n");
    assert.ok(entries.includes("a.txt"));
    assert.ok(entries.includes("b.txt"));
    assert.ok(entries.includes("subdir/"));
  });

  it("returns sorted entries", async () => {
    const tools = createBuiltinTools({ root });
    const listFiles = findTool(tools, "list_files");
    const result = await listFiles.execute({ path: "." });
    const entries = result.split("\n");
    // Verify sorted
    for (let i = 1; i < entries.length; i++) {
      assert.ok(entries[i - 1] <= entries[i], `not sorted: ${entries[i - 1]} > ${entries[i]}`);
    }
  });

  it("defaults to '.' when no path arg provided", async () => {
    const tools = createBuiltinTools({ root });
    const listFiles = findTool(tools, "list_files");
    const result = await listFiles.execute({});
    assert.equal(typeof result, "string");
    // Should contain entries from root
    assert.ok(result.length > 0);
  });

  it("lists subdirectory contents", async () => {
    const tools = createBuiltinTools({ root });
    const listFiles = findTool(tools, "list_files");
    const result = await listFiles.execute({ path: "subdir" });
    assert.equal(result, "c.txt");
  });

  it("throws NotADirectoryError for non-directory path", async () => {
    const tools = createBuiltinTools({ root });
    const listFiles = findTool(tools, "list_files");
    try {
      await listFiles.execute({ path: "a.txt" });
      assert.fail("expected HostToolError");
    } catch (e) {
      assert.ok(e instanceof HostToolError);
      assert.equal((e as HostToolError).pythonType, "NotADirectoryError");
    }
  });
});

// ── http_get — unit (mock fetch) ─────────────────────────────────

describe("http_get — unit", () => {
  function makeTools(opts?: Partial<BuiltinToolsOptions>) {
    return createBuiltinTools({ root: "/tmp", ...opts });
  }

  it("returns response body text via mock fetchImpl", async () => {
    const mockFetch: typeof fetch = async (_url) =>
      new Response("mock response body", { status: 200 });
    const tools = makeTools({ fetchImpl: mockFetch });
    const httpGet = findTool(tools, "http_get");
    const result = await httpGet.execute({ url: "https://example.com/api" });
    assert.equal(result, "mock response body");
  });

  it("throws ValueError for non-http URL", async () => {
    const tools = makeTools();
    const httpGet = findTool(tools, "http_get");
    try {
      await httpGet.execute({ url: "ftp://files.example.com" });
      assert.fail("expected HostToolError");
    } catch (e) {
      assert.ok(e instanceof HostToolError);
      assert.equal((e as HostToolError).pythonType, "ValueError");
    }
  });

  it("accepts http:// URLs", async () => {
    const mockFetch: typeof fetch = async (_url) =>
      new Response("ok", { status: 200 });
    const tools = makeTools({ fetchImpl: mockFetch });
    const httpGet = findTool(tools, "http_get");
    const result = await httpGet.execute({ url: "http://example.com" });
    assert.equal(result, "ok");
  });

  it("throws OSError for non-2xx response", async () => {
    const mockFetch: typeof fetch = async (_url) =>
      new Response("Not Found", { status: 404 });
    const tools = makeTools({ fetchImpl: mockFetch });
    const httpGet = findTool(tools, "http_get");
    try {
      await httpGet.execute({ url: "https://example.com/missing" });
      assert.fail("expected HostToolError");
    } catch (e) {
      assert.ok(e instanceof HostToolError);
      assert.equal((e as HostToolError).pythonType, "OSError");
    }
  });

  it("throws OSError for network failure", async () => {
    const mockFetch: typeof fetch = async (_url) => {
      throw new Error("connection refused");
    };
    const tools = makeTools({ fetchImpl: mockFetch });
    const httpGet = findTool(tools, "http_get");
    try {
      await httpGet.execute({ url: "https://example.com" });
      assert.fail("expected HostToolError");
    } catch (e) {
      assert.ok(e instanceof HostToolError);
      assert.equal((e as HostToolError).pythonType, "OSError");
    }
  });

  it("requires url to be a string", async () => {
    const tools = makeTools();
    const httpGet = findTool(tools, "http_get");
    try {
      await httpGet.execute({ url: 12345 });
      assert.fail("expected HostToolError");
    } catch (e) {
      assert.ok(e instanceof HostToolError);
      assert.equal((e as HostToolError).pythonType, "TypeError");
    }
  });
});

// ── Truncation ──────────────────────────────────────────────────

describe("Truncation", () => {
  const TRUNCATION_MARKER = "\n[...truncated]";

  it("read_file truncates beyond maxFileBytes with truncation marker", async () => {
    // Create a temp dir with a file larger than 10 bytes
    const root = await mkdtemp(join(tmpdir(), "repl-simple-builtins-"));
    try {
      await writeFile(join(root, "big.txt"), "0123456789ABCDEF"); // 16 bytes
      const tools = createBuiltinTools({ root, maxFileBytes: 10 });
      const readFile = findTool(tools, "read_file");
      const result = await readFile.execute({ path: "big.txt" });
      assert.ok(result.includes(TRUNCATION_MARKER));
      // Should be exactly 10 chars + truncation marker
      // marker includes leading newline from source port
      assert.ok(result.startsWith("0123456789"));
      assert.ok(result.endsWith("[...truncated]"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("read_file does not truncate when file is smaller than maxFileBytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "repl-simple-builtins-"));
    try {
      await writeFile(join(root, "small.txt"), "hi");
      const tools = createBuiltinTools({ root, maxFileBytes: 100 });
      const readFile = findTool(tools, "read_file");
      const result = await readFile.execute({ path: "small.txt" });
      assert.equal(result, "hi");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("http_get truncates beyond maxHttpBytes with truncation marker", async () => {
    const longBody = "A".repeat(50);
    const mockFetch: typeof fetch = async (_url) =>
      new Response(longBody, { status: 200 });
    const tools = createBuiltinTools({
      root: "/tmp",
      maxHttpBytes: 20,
      fetchImpl: mockFetch,
    });
    const httpGet = findTool(tools, "http_get");
    const result = await httpGet.execute({ url: "https://example.com" });
    assert.ok(result.includes(TRUNCATION_MARKER));
  });

  it("http_get does not truncate when response is smaller than maxHttpBytes", async () => {
    const mockFetch: typeof fetch = async (_url) =>
      new Response("short", { status: 200 });
    const tools = createBuiltinTools({
      root: "/tmp",
      maxHttpBytes: 100,
      fetchImpl: mockFetch,
    });
    const httpGet = findTool(tools, "http_get");
    const result = await httpGet.execute({ url: "https://example.com" });
    assert.equal(result, "short");
  });

  it("read_file default maxFileBytes is 256 KiB", async () => {
    const root = await mkdtemp(join(tmpdir(), "repl-simple-builtins-"));
    try {
      // Write a file just under 256 KiB — should not be truncated
      const content = "A".repeat(256 * 1024 - 1);
      await writeFile(join(root, "big.txt"), content);
      const tools = createBuiltinTools({ root });
      const readFile = findTool(tools, "read_file");
      const result = await readFile.execute({ path: "big.txt" });
      assert.equal(result, content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("read_file truncates beyond default maxFileBytes (256 KiB)", async () => {
    const root = await mkdtemp(join(tmpdir(), "repl-simple-builtins-"));
    try {
      // Write a file just over 256 KiB — should be truncated
      const content = "A".repeat(256 * 1024 + 1);
      await writeFile(join(root, "huge.txt"), content);
      const tools = createBuiltinTools({ root });
      const readFile = findTool(tools, "read_file");
      const result = await readFile.execute({ path: "huge.txt" });
      assert.ok(result.includes(TRUNCATION_MARKER));
      assert.ok(!result.includes(content));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("http_get default maxHttpBytes is 256 KiB", async () => {
    const content = "B".repeat(256 * 1024 - 1);
    const mockFetch: typeof fetch = async (_url) =>
      new Response(content, { status: 200 });
    const tools = createBuiltinTools({ root: "/tmp", fetchImpl: mockFetch });
    const httpGet = findTool(tools, "http_get");
    const result = await httpGet.execute({ url: "https://example.com" });
    assert.equal(result, content);
  });

  it("http_get truncates beyond default maxHttpBytes (256 KiB)", async () => {
    const content = "B".repeat(256 * 1024 + 1);
    const mockFetch: typeof fetch = async (_url) =>
      new Response(content, { status: 200 });
    const tools = createBuiltinTools({ root: "/tmp", fetchImpl: mockFetch });
    const httpGet = findTool(tools, "http_get");
    const result = await httpGet.execute({ url: "https://example.com" });
    assert.ok(result.includes(TRUNCATION_MARKER));
    assert.ok(!result.includes(content));
  });
});
