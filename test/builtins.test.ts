import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostToolError, type HostTool } from "../src/types.js";
import {
  createBuiltinTools,
  isBlockedAddress,
  __resetEverPrivateForTests,
  __everPrivateSizeForTests,
  EVER_PRIVATE_MAX_ENTRIES,
  type BuiltinToolsOptions,
} from "../src/builtins.js";

// ── Helpers ─────────────────────────────────────────────────────

/** Find a tool by name in a HostTool[] array */
function findTool(tools: HostTool[], name: string): HostTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found`);
  return tool;
}

/**
 * Every hostname resolves to one public address.
 *
 * `http_get` resolves before it fetches, so a test with a mock `fetch` and a
 * real resolver would still touch the network — and would fail closed on a
 * machine with no DNS. Every `http_get` test injects a resolver for that
 * reason; the ones about the policy inject one that answers what the case is
 * about.
 */
const PUBLIC_LOOKUP = async () => ["93.184.216.34"];

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
    return createBuiltinTools({ root: "/tmp", lookupImpl: PUBLIC_LOOKUP, ...opts });
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
    const mockFetch: typeof fetch = async (_url) => new Response("ok", { status: 200 });
    const tools = makeTools({ fetchImpl: mockFetch });
    const httpGet = findTool(tools, "http_get");
    const result = await httpGet.execute({ url: "http://example.com" });
    assert.equal(result, "ok");
  });

  it("throws OSError for non-2xx response", async () => {
    const mockFetch: typeof fetch = async (_url) => new Response("Not Found", { status: 404 });
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
  const bytes = (s: string) => Buffer.byteLength(s, "utf8");

  async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "repl-simple-builtins-"));
    try {
      await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("read_file honours the byte ceiling, marker included", async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, "big.txt"), "0123456789".repeat(5000));
      const tools = createBuiltinTools({ root, maxFileBytes: 2048 });
      const result = await findTool(tools, "read_file").execute({
        path: "big.txt",
      });
      assert.ok(bytes(result) <= 2048, `got ${bytes(result)} bytes for a 2048 cap`);
      assert.ok(result.includes("elided"), "the marker must state what went");
    });
  });

  it("read_file keeps both ends of the file", async () => {
    await withRoot(async (root) => {
      await writeFile(
        join(root, "big.txt"),
        `HEAD_MARKER\n${"filler\n".repeat(20000)}TAIL_MARKER\n`,
      );
      const tools = createBuiltinTools({ root, maxFileBytes: 4096 });
      const result = await findTool(tools, "read_file").execute({
        path: "big.txt",
      });
      assert.ok(result.startsWith("HEAD_MARKER"), "head lost");
      assert.ok(result.trimEnd().endsWith("TAIL_MARKER"), "tail lost");
    });
  });

  it("read_file never cuts a character in half (M5)", async () => {
    // Before: `read_file` on 50 x "é" with maxFileBytes 11 returned 13 bytes
    // ending in U+FFFD — the byte cut landed mid-character.
    await withRoot(async (root) => {
      await writeFile(join(root, "accents.txt"), "é".repeat(50));
      for (const cap of [10, 11, 12, 64, 200, 1024]) {
        const tools = createBuiltinTools({ root, maxFileBytes: cap });
        const result = await findTool(tools, "read_file").execute({
          path: "accents.txt",
        });
        assert.ok(!result.includes("\uFFFD"), `cap ${cap}: truncation introduced U+FFFD`);
        assert.ok(bytes(result) <= cap, `cap ${cap}: got ${bytes(result)} bytes`);
      }
    });
  });

  it("read_file does not truncate when the file fits", async () => {
    await withRoot(async (root) => {
      await writeFile(join(root, "small.txt"), "hi");
      const tools = createBuiltinTools({ root, maxFileBytes: 100 });
      const result = await findTool(tools, "read_file").execute({
        path: "small.txt",
      });
      assert.equal(result, "hi");
    });
  });

  it("read_file default maxFileBytes is 256 KiB", async () => {
    await withRoot(async (root) => {
      const content = "A".repeat(256 * 1024);
      await writeFile(join(root, "exact.txt"), content);
      const tools = createBuiltinTools({ root });
      const result = await findTool(tools, "read_file").execute({
        path: "exact.txt",
      });
      assert.equal(result, content);
    });
  });

  it("read_file truncates beyond the default 256 KiB", async () => {
    await withRoot(async (root) => {
      const content = "A".repeat(256 * 1024 + 1);
      await writeFile(join(root, "huge.txt"), content);
      const tools = createBuiltinTools({ root });
      const result = await findTool(tools, "read_file").execute({
        path: "huge.txt",
      });
      assert.ok(result.includes("elided"));
      assert.ok(bytes(result) <= 256 * 1024);
      assert.ok(!result.includes(content));
    });
  });

  it("http_get honours the byte ceiling and marks where it cut", async () => {
    const mockFetch: typeof fetch = async () => new Response("B".repeat(100_000), { status: 200 });
    const tools = createBuiltinTools({
      root: "/tmp",
      maxHttpBytes: 2048,
      fetchImpl: mockFetch,
      lookupImpl: PUBLIC_LOOKUP,
    });
    const result = await findTool(tools, "http_get").execute({
      url: "https://example.com",
    });
    assert.ok(bytes(result) <= 2048, `got ${bytes(result)} bytes for a 2048 cap`);
    // Head-only: the read stops at the budget, so there is no true total to
    // report and the marker says where it cut instead.
    assert.match(result, /truncated at 2\.0KB/);
    assert.ok(result.startsWith("B"));
  });

  it("http_get does not truncate when the response fits", async () => {
    const mockFetch: typeof fetch = async () => new Response("small body", { status: 200 });
    const tools = createBuiltinTools({
      root: "/tmp",
      maxHttpBytes: 2048,
      fetchImpl: mockFetch,
      lookupImpl: PUBLIC_LOOKUP,
    });
    const result = await findTool(tools, "http_get").execute({
      url: "https://example.com",
    });
    assert.equal(result, "small body");
  });

  it("http_get default maxHttpBytes is 256 KiB", async () => {
    const content = "B".repeat(256 * 1024);
    const mockFetch: typeof fetch = async () => new Response(content, { status: 200 });
    const tools = createBuiltinTools({
      root: "/tmp",
      fetchImpl: mockFetch,
      lookupImpl: PUBLIC_LOOKUP,
    });
    const result = await findTool(tools, "http_get").execute({
      url: "https://example.com",
    });
    assert.equal(result, content);
  });

  it("http_get truncates beyond the default 256 KiB", async () => {
    const content = "B".repeat(256 * 1024 + 1);
    const mockFetch: typeof fetch = async () => new Response(content, { status: 200 });
    const tools = createBuiltinTools({
      root: "/tmp",
      fetchImpl: mockFetch,
      lookupImpl: PUBLIC_LOOKUP,
    });
    const result = await findTool(tools, "http_get").execute({
      url: "https://example.com",
    });
    assert.ok(result.includes("truncated at"));
    assert.ok(bytes(result) <= 256 * 1024);
    assert.ok(!result.includes(content));
  });
});

// ── http_get — egress policy (#42) ───────────────────────────────

describe("isBlockedAddress", () => {
  const blocked = [
    "127.0.0.1",
    "127.255.255.254",
    "0.0.0.0",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.0.0.1",
    "192.0.2.7",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "fc00::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::7f00:1",
    "64:ff9b::127.0.0.1",
    "2002:7f00:1::",
  ];

  const allowed = [
    "93.184.216.34",
    "8.8.8.8",
    "172.32.0.1",
    "172.15.255.255",
    "100.63.255.255",
    "100.128.0.1",
    "192.1.0.1",
    "198.20.0.1",
    "223.255.255.255",
    "2606:2800:220:1:248:1893:25c8:1946",
    "::ffff:93.184.216.34",
    "2002:5db8:d822::",
    "64:ff9b::93.184.216.34",
  ];

  for (const address of blocked) {
    it(`blocks ${address}`, () => {
      assert.equal(isBlockedAddress(address), true);
    });
  }

  for (const address of allowed) {
    it(`allows ${address}`, () => {
      assert.equal(isBlockedAddress(address), false);
    });
  }

  it("blocks anything that is not an address at all", () => {
    // Reached only if a resolver hands back something unparseable; refusing is
    // the answer that cannot leak.
    assert.equal(isBlockedAddress("not-an-ip"), true);
    assert.equal(isBlockedAddress(""), true);
  });

  it("ignores an IPv6 zone id", () => {
    assert.equal(isBlockedAddress("fe80::1%eth0"), true);
  });
});

describe("http_get — gating", () => {
  it("requires approval when no allowlist is configured", () => {
    const tools = createBuiltinTools({ root: "/tmp", httpAllowlist: [] });
    assert.equal(findTool(tools, "http_get").requiresApproval, true);
  });

  it("does not require approval when an allowlist is configured", () => {
    const tools = createBuiltinTools({ root: "/tmp", httpAllowlist: ["api.example.com"] });
    assert.equal(findTool(tools, "http_get").requiresApproval, false);
  });

  it("reads the allowlist from REPL_HTTP_ALLOWLIST", () => {
    const previous = process.env.REPL_HTTP_ALLOWLIST;
    process.env.REPL_HTTP_ALLOWLIST = " api.example.com , ,*.internal.dev ";
    try {
      const tools = createBuiltinTools({ root: "/tmp" });
      assert.equal(findTool(tools, "http_get").requiresApproval, false);
    } finally {
      if (previous === undefined) delete process.env.REPL_HTTP_ALLOWLIST;
      else process.env.REPL_HTTP_ALLOWLIST = previous;
    }
  });

  it("an explicit empty allowlist beats the environment", () => {
    const previous = process.env.REPL_HTTP_ALLOWLIST;
    process.env.REPL_HTTP_ALLOWLIST = "api.example.com";
    try {
      const tools = createBuiltinTools({ root: "/tmp", httpAllowlist: [] });
      assert.equal(findTool(tools, "http_get").requiresApproval, true);
    } finally {
      if (previous === undefined) delete process.env.REPL_HTTP_ALLOWLIST;
      else process.env.REPL_HTTP_ALLOWLIST = previous;
    }
  });

  it("read-only file tools stay ungated", () => {
    const tools = createBuiltinTools({ root: "/tmp" });
    assert.ok(!findTool(tools, "read_file").requiresApproval);
    assert.ok(!findTool(tools, "list_files").requiresApproval);
  });
});

describe("http_get — allowlist", () => {
  const okFetch: typeof fetch = async () => new Response("body", { status: 200 });

  function allowlisted(allowlist: string[]) {
    const tools = createBuiltinTools({
      root: "/tmp",
      httpAllowlist: allowlist,
      fetchImpl: okFetch,
      lookupImpl: PUBLIC_LOOKUP,
    });
    return findTool(tools, "http_get");
  }

  it("allows an exact host", async () => {
    assert.equal(
      await allowlisted(["api.example.com"]).execute({ url: "https://api.example.com/x" }),
      "body",
    );
  });

  it("matches the host case-insensitively", async () => {
    assert.equal(
      await allowlisted(["API.Example.COM"]).execute({ url: "https://api.example.com/x" }),
      "body",
    );
  });

  it("ignores the port", async () => {
    assert.equal(
      await allowlisted(["api.example.com"]).execute({ url: "https://api.example.com:8443/x" }),
      "body",
    );
  });

  it("a '*.' entry matches a subdomain", async () => {
    assert.equal(
      await allowlisted(["*.example.com"]).execute({ url: "https://a.b.example.com/" }),
      "body",
    );
  });

  it("a '*.' entry matches the bare domain too", async () => {
    assert.equal(
      await allowlisted(["*.example.com"]).execute({ url: "https://example.com/" }),
      "body",
    );
  });

  it("refuses a host that is not on the list", async () => {
    await assertRefused(
      allowlisted(["api.example.com"]).execute({ url: "https://evil.example.net/" }),
      /not on the http_get allowlist/,
    );
  });

  it("a '*.' entry does not match a suffix that is not a subdomain", async () => {
    await assertRefused(
      allowlisted(["*.example.com"]).execute({ url: "https://notexample.com/" }),
      /not on the http_get allowlist/,
    );
  });

  it("an allowlisted host that resolves privately is still refused", async () => {
    const tools = createBuiltinTools({
      root: "/tmp",
      httpAllowlist: ["api.example.com"],
      fetchImpl: okFetch,
      lookupImpl: async () => ["10.0.0.5"],
    });
    await assertRefused(
      findTool(tools, "http_get").execute({ url: "https://api.example.com/" }),
      /private or reserved/,
    );
  });
});

/** Assert a promise rejects with a `PermissionError` matching `pattern`. */
async function assertRefused(result: unknown, pattern: RegExp): Promise<void> {
  try {
    await result;
    assert.fail("expected the request to be refused");
  } catch (e) {
    assert.ok(e instanceof HostToolError, `expected HostToolError, got ${e}`);
    assert.equal((e as HostToolError).pythonType, "PermissionError");
    assert.match((e as Error).message, pattern);
  }
}

describe("http_get — direct destinations", () => {
  const okFetch: typeof fetch = async () => new Response("INTERNAL", { status: 200 });

  function tool(lookupImpl?: (h: string) => Promise<string[]>) {
    const tools = createBuiltinTools({
      root: "/tmp",
      fetchImpl: okFetch,
      lookupImpl: lookupImpl ?? PUBLIC_LOOKUP,
    });
    return findTool(tools, "http_get");
  }

  for (const url of [
    "http://127.0.0.1:8080/secret",
    "http://localhost.localdomain.example/", // resolved, see below
    "http://169.254.169.254/latest/meta-data/",
    "http://10.1.2.3/",
    "http://192.168.0.1/",
    "http://[::1]/",
    "http://[fe80::1]/",
  ]) {
    it(`refuses ${url}`, async () => {
      // The one hostname here resolves to loopback; the rest are literals and
      // never reach a resolver at all.
      await assertRefused(
        tool(async (h) => (h.endsWith(".example") ? ["127.0.0.1"] : ["93.184.216.34"])).execute({
          url,
        }),
        /private or reserved/,
      );
    });
  }

  it("refuses a name whose second address is private", async () => {
    // Every address is validated, not just the first: a name that answers with
    // one public and one private address is a name that reaches the private one.
    await assertRefused(
      tool(async () => ["93.184.216.34", "127.0.0.1"]).execute({ url: "http://dual.example.com/" }),
      /private or reserved/,
    );
  });

  it("does not resolve a literal address", async () => {
    let resolverCalls = 0;
    const t = tool(async () => {
      resolverCalls++;
      return ["93.184.216.34"];
    });
    assert.equal(await t.execute({ url: "http://93.184.216.34/" }), "INTERNAL");
    assert.equal(resolverCalls, 0);
  });

  it("the default resolver is wired up: 'localhost' is refused", async () => {
    // No `lookupImpl`, so this goes through the real `dns.lookup` — the one the
    // shipped tool uses. `localhost` comes from the hosts file, so the test
    // needs no network, and whether it answers 127.0.0.1 or ::1 the verdict is
    // the same.
    const tools = createBuiltinTools({ root: "/tmp", fetchImpl: okFetch });
    await assertRefused(
      findTool(tools, "http_get").execute({ url: "http://localhost:9/" }),
      /private or reserved/,
    );
  });

  it("reports a resolver failure as OSError", async () => {
    const t = tool(async () => {
      throw new Error("ENOTFOUND");
    });
    await assert.rejects(
      async () => t.execute({ url: "http://nope.example.com/" }),
      (e: unknown) => {
        assert.ok(e instanceof HostToolError);
        assert.equal((e as HostToolError).pythonType, "OSError");
        assert.match((e as Error).message, /cannot resolve/);
        return true;
      },
    );
  });

  it("reports an empty resolver answer as OSError", async () => {
    const t = tool(async () => []);
    await assert.rejects(
      async () => t.execute({ url: "http://nope.example.com/" }),
      (e: unknown) => {
        assert.match((e as Error).message, /no addresses/);
        return true;
      },
    );
  });

  it("rejects a string that passes the scheme test but is not a URL", async () => {
    await assert.rejects(
      async () => tool().execute({ url: "http://" }),
      (e: unknown) => {
        assert.equal((e as HostToolError).pythonType, "ValueError");
        assert.match((e as Error).message, /not a valid URL/);
        return true;
      },
    );
  });
});

describe("http_get — ever-private memory", () => {
  const okFetch: typeof fetch = async () => new Response("body", { status: 200 });

  function tool(lookupImpl: (h: string) => Promise<string[]>) {
    return findTool(
      createBuiltinTools({ root: "/tmp", fetchImpl: okFetch, lookupImpl }),
      "http_get",
    );
  }

  afterEach(() => {
    __resetEverPrivateForTests();
  });

  it("refuses a hostname that resolves to a private address", async () => {
    const httpGet = tool(async () => ["127.0.0.1"]);
    await assertRefused(
      httpGet.execute({ url: "http://flip.example.com/" }),
      /private or reserved/,
    );
  });

  it("still refuses a hostname that once resolved private, even when it later resolves public", async () => {
    const answers = ["127.0.0.1", "93.184.216.34"];
    let lookups = 0;
    const httpGet = tool(async () => {
      lookups++;
      return [answers.shift() ?? "93.184.216.34"];
    });

    await assertRefused(
      httpGet.execute({ url: "http://flip.example.com/" }),
      /private or reserved/,
    );

    // The same hostname now answers public — but it is remembered and refused
    // before a second lookup, so the rebinding window stays closed.
    await assertRefused(
      httpGet.execute({ url: "http://flip.example.com/" }),
      /previously resolved/,
    );
    assert.equal(lookups, 1, "the second call must be refused before resolving again");
  });

  it("refuses and remembers a hostname resolving to a mapped private IPv4 (::ffff:127.0.0.1)", async () => {
    // `::ffff:127.0.0.1` is a spelling of loopback that walks past a v4-only
    // list; it must be recognized as blocked AND remembered process-lifetime.
    let lookups = 0;
    const httpGet = tool(async () => {
      lookups++;
      return ["::ffff:127.0.0.1"];
    });

    await assertRefused(
      httpGet.execute({ url: "http://mapped.example.com/" }),
      /private or reserved/,
    );
    await assertRefused(
      httpGet.execute({ url: "http://mapped.example.com/" }),
      /previously resolved/,
    );
    assert.equal(lookups, 1, "the second call must be refused before resolving again");
  });

  it("normalizes the ever-private key: every spelling maps to one entry", async () => {
    const seen: string[] = [];
    const httpGet = tool(async (h) => {
      seen.push(h);
      return seen.length === 1 ? ["127.0.0.1"] : ["93.184.216.34"];
    });

    // Record under one spelling: `Example.COM.` resolves private.
    await assertRefused(httpGet.execute({ url: "http://Example.COM./" }), /private or reserved/);

    // Any other spelling is refused from memory, before a new lookup happens.
    for (const spelling of ["example.com", "EXAMPLE.COM.", "example.com."]) {
      await assertRefused(httpGet.execute({ url: `http://${spelling}/` }), /previously resolved/);
    }

    assert.equal(seen.length, 1, "every other spelling must be refused before lookup");
  });

  it("a stable public hostname with a trailing dot still fetches", async () => {
    const seen: string[] = [];
    const httpGet = tool(async (h) => {
      seen.push(h);
      return ["93.184.216.34"];
    });

    assert.equal(await httpGet.execute({ url: "http://stable.example.com./" }), "body");
    // `lookupImpl` receives the normalized hostname: the trailing dot is stripped.
    assert.deepEqual(seen, ["stable.example.com", "stable.example.com"]);
  });

  it("__resetEverPrivateForTests empties the ever-private set", async () => {
    const httpGet = tool(async () => ["127.0.0.1"]);
    await assertRefused(
      httpGet.execute({ url: "http://flip.example.com/" }),
      /private or reserved/,
    );
    assert.ok(__everPrivateSizeForTests() > 0, "the memory must hold the refused hostname");

    __resetEverPrivateForTests();
    assert.equal(__everPrivateSizeForTests(), 0);
  });
});

describe("http_get — ever-private saturation (L1)", () => {
  afterEach(() => {
    __resetEverPrivateForTests();
  });

  it("caps the ever-private set and fails closed at saturation", async () => {
    let fetches = 0;
    const fetchImpl: typeof fetch = async () => {
      fetches++;
      return new Response("body", { status: 200 });
    };
    const httpGet = findTool(
      createBuiltinTools({
        root: "/tmp",
        fetchImpl,
        lookupImpl: async () => ["127.0.0.1"],
      }),
      "http_get",
    );

    // Drive the real recording path to saturation: each distinct hostname
    // resolves private, is refused, and is remembered process-lifetime.
    for (let i = 0; i < EVER_PRIVATE_MAX_ENTRIES; i++) {
      await assertRefused(
        httpGet.execute({ url: `http://host${i}.example.com/` }),
        /private or reserved/,
      );
    }

    // (a) the set is exactly at the cap — it never exceeded it.
    assert.equal(__everPrivateSizeForTests(), EVER_PRIVATE_MAX_ENTRIES);

    // (b) the next distinct private-resolving hostname fails closed with a
    // distinct "saturated" error and is never fetched.
    await assertRefused(
      httpGet.execute({ url: "http://overflow.example.com/" }),
      /ever-private memory saturated/,
    );
    assert.equal(__everPrivateSizeForTests(), EVER_PRIVATE_MAX_ENTRIES);
    assert.equal(fetches, 0, "nothing may be fetched once the memory is saturated");

    // An already-recorded hostname is still refused at saturation: membership
    // is checked before any lookup, unaffected by the cap.
    await assertRefused(
      httpGet.execute({ url: "http://host0.example.com/" }),
      /previously resolved/,
    );
    assert.equal(fetches, 0);
  });

  it("fails closed at saturation when a private address appears in the second lookup", async () => {
    // The test above resolves private on the first lookup, so it throws before
    // a second lookup ever runs. This one drives a distinct hostname
    // public-then-private, so the fail-closed throw in the *second*-lookup loop
    // is what refuses the request.
    let fetches = 0;
    const fetchImpl: typeof fetch = async () => {
      fetches++;
      return new Response("body", { status: 200 });
    };
    let overflowLookups = 0;
    const httpGet = findTool(
      createBuiltinTools({
        root: "/tmp",
        fetchImpl,
        lookupImpl: async (h: string) => {
          if (h !== "overflow.example.com") return ["127.0.0.1"];
          overflowLookups++;
          return overflowLookups === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
        },
      }),
      "http_get",
    );

    // Fill the set to the cap: every host${i} resolves private on its first
    // lookup, is refused, and is remembered process-lifetime.
    for (let i = 0; i < EVER_PRIVATE_MAX_ENTRIES; i++) {
      await assertRefused(
        httpGet.execute({ url: `http://host${i}.example.com/` }),
        /private or reserved/,
      );
    }
    assert.equal(__everPrivateSizeForTests(), EVER_PRIVATE_MAX_ENTRIES);

    // The distinct hostname answers public first, then private: recording the
    // private address fails closed because the memory is already saturated.
    await assertRefused(
      httpGet.execute({ url: "http://overflow.example.com/" }),
      /ever-private memory saturated/,
    );
    assert.equal(overflowLookups, 2, "the second lookup must be the saturated one");
    assert.equal(__everPrivateSizeForTests(), EVER_PRIVATE_MAX_ENTRIES);
    assert.equal(fetches, 0, "nothing may be fetched once the memory is saturated");
  });
});

describe("http_get — two-lookups-agree", () => {
  const okFetch: typeof fetch = async () => new Response("body", { status: 200 });

  function tool(lookupImpl: (h: string) => Promise<string[]>) {
    return findTool(
      createBuiltinTools({ root: "/tmp", fetchImpl: okFetch, lookupImpl }),
      "http_get",
    );
  }

  afterEach(() => {
    __resetEverPrivateForTests();
  });

  it("refuses when two consecutive lookups disagree", async () => {
    const answers = [["93.184.216.34"], ["8.8.8.8"]];
    let lookups = 0;
    const httpGet = tool(async () => {
      lookups++;
      return answers.shift() ?? ["8.8.8.8"];
    });

    await assertRefused(httpGet.execute({ url: "http://flip.example.com/" }), /rebinding detected/);
    assert.equal(lookups, 2);
  });

  it("remembers a hostname whose SECOND lookup is private", async () => {
    // A rebinding resolver answers public to the first lookup and private to the
    // second. The set comparison refuses that call ("rebinding detected"), and the
    // blocked address the second lookup revealed must be remembered — otherwise a
    // later call answering public to BOTH lookups would walk straight through.
    const answers = [
      ["93.184.216.34"], // call 1, lookup 1
      ["127.0.0.1"], //     call 1, lookup 2 — the rebinding answer
      ["93.184.216.34"], // call 2, lookup 1 (must never happen)
      ["93.184.216.34"], // call 2, lookup 2 (must never happen)
    ];
    let lookups = 0;
    const httpGet = tool(async () => {
      lookups++;
      return answers.shift() ?? ["93.184.216.34"];
    });

    await assertRefused(httpGet.execute({ url: "http://flip.example.com/" }), /rebinding detected/);

    // Now the same hostname answers public to both lookups — but it is remembered
    // and refused before any new lookup happens.
    await assertRefused(
      httpGet.execute({ url: "http://flip.example.com/" }),
      /previously resolved/,
    );
    assert.equal(lookups, 2, "the second call must be refused before resolving again");
  });

  it("refuses a mixed second lookup and remembers the private address", async () => {
    // First lookup public only; second lookup public + private. The two sets
    // differ in size, so `sameAddressSet`'s size-mismatch early return refuses
    // the call as rebinding — and the private address the mixed set revealed
    // must be remembered, so a later call answering public to both lookups is
    // refused from memory.
    const answers = [
      ["93.184.216.34"], //              call 1, lookup 1
      ["93.184.216.34", "127.0.0.1"], // call 1, lookup 2 — mixed
      ["93.184.216.34"], //              call 2, lookup 1 (must never run)
      ["93.184.216.34"], //              call 2, lookup 2 (must never run)
    ];
    let lookups = 0;
    const httpGet = tool(async () => {
      lookups++;
      return answers.shift() ?? ["93.184.216.34"];
    });

    await assertRefused(
      httpGet.execute({ url: "http://mixed.example.com/" }),
      /rebinding detected/,
    );

    await assertRefused(
      httpGet.execute({ url: "http://mixed.example.com/" }),
      /previously resolved/,
    );
    assert.equal(lookups, 2, "the second call must be refused before resolving again");
  });

  it("proceeds when the same set returns in a different order", async () => {
    const answers = [
      ["93.184.216.34", "8.8.8.8"],
      ["8.8.8.8", "93.184.216.34"],
    ];
    let lookups = 0;
    const httpGet = tool(async () => {
      lookups++;
      return answers.shift() ?? ["8.8.8.8", "93.184.216.34"];
    });

    assert.equal(await httpGet.execute({ url: "http://stable.example.com/" }), "body");
    assert.equal(lookups, 2);
  });

  it("second lookup returning an empty set is refused", async () => {
    // Fail closed: a resolver that answers public then hands back no addresses
    // must be refused (as an OSError), not hang and not surface an unhandled error.
    let lookups = 0;
    const httpGet = tool(async () => {
      lookups++;
      return lookups === 1 ? ["93.184.216.34"] : [];
    });

    await assert.rejects(
      async () => httpGet.execute({ url: "http://empty.example.com/" }),
      (e: unknown) => {
        assert.ok(e instanceof HostToolError);
        assert.equal((e as HostToolError).pythonType, "OSError");
        assert.match((e as Error).message, /no addresses/);
        return true;
      },
    );
    assert.equal(lookups, 2);
  });
});

describe("http_get — redirects", () => {
  /** A fetch that answers from a table and records every URL it was handed. */
  function routed(routes: Record<string, Response | (() => Response)>) {
    const seen: string[] = [];
    const impl: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push(url);
      assert.equal(init?.redirect, "manual", "redirects must not be followed by fetch");
      const route = routes[url];
      if (!route) throw new Error(`unrouted: ${url}`);
      return typeof route === "function" ? route() : route;
    };
    return { impl, seen };
  }

  const redirect = (location: string, status = 302) =>
    new Response("redirecting", { status, headers: { location } });

  function toolFor(
    impl: typeof fetch,
    lookupImpl: (h: string) => Promise<string[]> = PUBLIC_LOOKUP,
  ) {
    return findTool(createBuiltinTools({ root: "/tmp", fetchImpl: impl, lookupImpl }), "http_get");
  }

  it("refuses a redirect into loopback", async () => {
    const { impl, seen } = routed({
      "http://public.example.com/": redirect("http://127.0.0.1:9000/secret"),
    });
    await assertRefused(
      toolFor(impl).execute({ url: "http://public.example.com/" }),
      /private or reserved/,
    );
    assert.deepEqual(seen, ["http://public.example.com/"], "the internal hop must not be fetched");
  });

  it("refuses at the third hop of public → public → loopback", async () => {
    const { impl, seen } = routed({
      "http://a.example.com/": redirect("http://b.example.com/"),
      "http://b.example.com/": redirect("http://internal.example.com/"),
      "http://internal.example.com/": new Response("SECRET", { status: 200 }),
    });
    const lookupImpl = async (h: string) =>
      h === "internal.example.com" ? ["127.0.0.1"] : ["93.184.216.34"];
    await assertRefused(
      toolFor(impl, lookupImpl).execute({ url: "http://a.example.com/" }),
      /private or reserved/,
    );
    assert.deepEqual(seen, ["http://a.example.com/", "http://b.example.com/"]);
  });

  it("follows a redirect that stays public", async () => {
    const { impl, seen } = routed({
      "http://a.example.com/": redirect("http://b.example.com/final"),
      "http://b.example.com/final": new Response("arrived", { status: 200 }),
    });
    assert.equal(await toolFor(impl).execute({ url: "http://a.example.com/" }), "arrived");
    assert.equal(seen.length, 2);
  });

  it("resolves a relative Location against the current hop", async () => {
    const { impl } = routed({
      "http://a.example.com/one/two": redirect("../three"),
      "http://a.example.com/three": new Response("arrived", { status: 200 }),
    });
    assert.equal(await toolFor(impl).execute({ url: "http://a.example.com/one/two" }), "arrived");
  });

  it("refuses a redirect that leaves http(s)", async () => {
    const { impl } = routed({
      "http://a.example.com/": redirect("file:///etc/passwd"),
    });
    await assert.rejects(
      async () => toolFor(impl).execute({ url: "http://a.example.com/" }),
      (e: unknown) => {
        assert.equal((e as HostToolError).pythonType, "ValueError");
        assert.match((e as Error).message, /only http\(s\)/);
        return true;
      },
    );
  });

  it("reports an unusable Location as OSError", async () => {
    const { impl } = routed({ "http://a.example.com/": redirect("http://[") });
    await assert.rejects(
      async () => toolFor(impl).execute({ url: "http://a.example.com/" }),
      (e: unknown) => {
        assert.match((e as Error).message, /unusable location/);
        return true;
      },
    );
  });

  it("gives up after too many hops", async () => {
    const routes: Record<string, Response | (() => Response)> = {};
    for (let i = 0; i < 12; i++) {
      routes[`http://h${i}.example.com/`] = () => redirect(`http://h${i + 1}.example.com/`);
    }
    const { impl, seen } = routed(routes);
    await assert.rejects(
      async () => toolFor(impl).execute({ url: "http://h0.example.com/" }),
      (e: unknown) => {
        assert.match((e as Error).message, /too many redirects/);
        return true;
      },
    );
    assert.equal(seen.length, 6, "MAX_REDIRECT_HOPS + the original request");
  });

  it("treats a 3xx without a Location as the error status it is", async () => {
    const { impl } = routed({
      "http://a.example.com/": new Response("no location", { status: 302 }),
    });
    await assert.rejects(
      async () => toolFor(impl).execute({ url: "http://a.example.com/" }),
      (e: unknown) => {
        assert.match((e as Error).message, /HTTP 302/);
        return true;
      },
    );
  });

  it("does not treat a 200 with a Location header as a redirect", async () => {
    const { impl, seen } = routed({
      "http://a.example.com/": new Response("done", {
        status: 200,
        headers: { location: "http://127.0.0.1/" },
      }),
    });
    assert.equal(await toolFor(impl).execute({ url: "http://a.example.com/" }), "done");
    assert.equal(seen.length, 1);
  });
});

describe("http_get — timeout", () => {
  it("aborts a request that never answers", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        // `AbortSignal.timeout`'s timer is unref'd, so it is not by itself a
        // reason for the process to stay alive. A real hanging request holds an
        // open socket, which is; a mock that touches nothing leaves the loop
        // empty, and node 22's test runner then reports the still-pending
        // promise instead of letting the deadline fire. This stands in for the
        // socket.
        const socket = setTimeout(() => {}, 5_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(socket);
          reject(init.signal?.reason);
        });
      });
    const tools = createBuiltinTools({
      root: "/tmp",
      fetchImpl: hanging,
      lookupImpl: PUBLIC_LOOKUP,
      httpTimeoutSecs: 0.05,
    });
    await assert.rejects(
      async () => findTool(tools, "http_get").execute({ url: "http://slow.example.com/" }),
      (e: unknown) => {
        assert.ok(e instanceof HostToolError);
        assert.equal((e as HostToolError).pythonType, "TimeoutError");
        assert.match((e as Error).message, /timed out/);
        return true;
      },
    );
  });

  it("one deadline covers the whole redirect chain", async () => {
    // Each hop answers instantly, so only a budget spanning all of them can end
    // this; a per-hop timer would let it run forever.
    const impl: typeof fetch = async (input, init) => {
      await new Promise((r) => setTimeout(r, 15));
      if (init?.signal?.aborted) throw init.signal.reason;
      const n = Number(/h(\d+)/.exec(String(input))?.[1] ?? 0);
      return new Response("", {
        status: 302,
        headers: { location: `http://h${n + 1}.example.com/` },
      });
    };
    const tools = createBuiltinTools({
      root: "/tmp",
      fetchImpl: impl,
      lookupImpl: PUBLIC_LOOKUP,
      httpTimeoutSecs: 0.03,
    });
    await assert.rejects(
      async () => findTool(tools, "http_get").execute({ url: "http://h0.example.com/" }),
      (e: unknown) => {
        assert.equal((e as HostToolError).pythonType, "TimeoutError");
        return true;
      },
    );
  });

  it("reads REPL_HTTP_TIMEOUT_SECS", async () => {
    const previous = process.env.REPL_HTTP_TIMEOUT_SECS;
    process.env.REPL_HTTP_TIMEOUT_SECS = "not a number";
    try {
      // Unparseable falls back to the default rather than to zero, which would
      // abort every request before it started.
      const tools = createBuiltinTools({
        root: "/tmp",
        fetchImpl: async () => new Response("ok", { status: 200 }),
        lookupImpl: PUBLIC_LOOKUP,
      });
      assert.equal(
        await findTool(tools, "http_get").execute({ url: "http://a.example.com/" }),
        "ok",
      );
    } finally {
      if (previous === undefined) delete process.env.REPL_HTTP_TIMEOUT_SECS;
      else process.env.REPL_HTTP_TIMEOUT_SECS = previous;
    }
  });

  it("surfaces a body-stream timeout as TimeoutError", async () => {
    const failing =
      (error: unknown): typeof fetch =>
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(error);
            },
          }),
          { status: 200 },
        );
    const tools = createBuiltinTools({
      root: "/tmp",
      fetchImpl: failing(new DOMException("aborted", "TimeoutError")),
      lookupImpl: PUBLIC_LOOKUP,
    });
    await assert.rejects(
      async () => findTool(tools, "http_get").execute({ url: "http://a.example.com/" }),
      (e: unknown) => {
        assert.equal((e as HostToolError).pythonType, "TimeoutError");
        return true;
      },
    );

    const broken = createBuiltinTools({
      root: "/tmp",
      fetchImpl: failing(new Error("connection reset")),
      lookupImpl: PUBLIC_LOOKUP,
    });
    await assert.rejects(
      async () => findTool(broken, "http_get").execute({ url: "http://a.example.com/" }),
      (e: unknown) => {
        assert.equal((e as HostToolError).pythonType, "OSError");
        assert.match((e as Error).message, /connection reset/);
        return true;
      },
    );
  });
});
